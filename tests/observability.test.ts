import { describe, expect, it } from "vitest";
import type { NewRelicClient } from "../src/newrelic.js";
import {
  getServiceHealthSummary,
  getTopErrors,
  getSlowTransactions,
  summarizeLogErrors,
  listActiveIncidents,
  investigateServiceIssue,
} from "../src/observability.js";

function makeClient(responses: Map<string, Array<Record<string, unknown>>>): NewRelicClient {
  return {
    accountId: 1867676,
    authMode: "api_key_only",
    verboseLogs: false,
    runNrql: async (query) => {
      for (const [pattern, rows] of responses) {
        if (query.includes(pattern)) return rows;
      }
      return [];
    },
    runNerdGraph: async () => { throw new Error("Not implemented in this test"); },
  };
}

const emptyClient = makeClient(new Map());

describe("getServiceHealthSummary", () => {
  it("returns healthy summary when metrics are within thresholds", async () => {
    const client = makeClient(new Map([
      ["rate(count(*), 1 minute)", [{ rpm: 120 }]],
      ["percentage(count(*), WHERE error IS true)", [{ errorPct: 0.5 }]],
      ["percentile(duration * 1000, 95)", [{ p95Ms: 250 }]],
      ["apdex(duration)", [{ apdexScore: 0.95 }]],
    ]));

    const result = await getServiceHealthSummary(client, { entityName: "checkout-api" });

    expect(result.summary).toMatch(/healthy/i);
    expect(result.findings).toHaveLength(0);
    expect(result.data.errorPct).toBe(0.5);
    expect(result.data.throughputRpm).toBe(120);
    expect(result.metadata.entityName).toBe("checkout-api");
  });

  it("returns critical finding when error rate exceeds 5%", async () => {
    const client = makeClient(new Map([
      ["percentage(count(*), WHERE error IS true)", [{ errorPct: 7.8 }]],
      ["rate(count(*), 1 minute)", []],
      ["percentile(duration * 1000, 95)", []],
      ["apdex(duration)", []],
    ]));

    const result = await getServiceHealthSummary(client, { entityName: "checkout-api" });

    expect(result.findings.some((f) => f.severity === "critical" && f.type === "error_rate")).toBe(true);
    expect(result.summary).toMatch(/unhealthy/i);
    expect(result.recommendations.some((r) => /get_top_errors/i.test(r))).toBe(true);
  });

  it("returns warning finding for P95 latency between 1000ms and 3000ms", async () => {
    const client = makeClient(new Map([
      ["percentile(duration * 1000, 95)", [{ p95Ms: 1500 }]],
      ["percentage(count(*), WHERE error IS true)", []],
      ["rate(count(*), 1 minute)", []],
      ["apdex(duration)", []],
    ]));

    const result = await getServiceHealthSummary(client, { entityName: "payment-api" });

    expect(result.findings.some((f) => f.severity === "warning" && f.type === "latency")).toBe(true);
  });

  it("returns no-data summary when queries return empty", async () => {
    const result = await getServiceHealthSummary(emptyClient, { entityName: "unknown-service" });

    expect(result.summary).toMatch(/no apm data/i);
    expect(result.data.throughputRpm).toBeNull();
    expect(result.recommendations.some((r) => /verify the name/i.test(r))).toBe(true);
  });
});

describe("getTopErrors", () => {
  it("returns error entries from TransactionError facet", async () => {
    const client = makeClient(new Map([
      ["TransactionError", [
        { "error.class": "TimeoutError", count: 231, sample: "Connection timed out", firstSeen: 1000, lastSeen: 2000 },
        { "error.class": "NullPointerException", count: 45, sample: "null ref", firstSeen: 1000, lastSeen: 1500 },
      ]],
    ]));

    const result = await getTopErrors(client, { entityName: "checkout-api" });

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].errorClass).toBe("TimeoutError");
    expect(result.errors[0].count).toBe(231);
    expect(result.errors[0].sample).toBe("Connection timed out");
    expect(result.summary).toMatch(/TimeoutError/);
  });

  it("returns empty summary when no errors found", async () => {
    const result = await getTopErrors(emptyClient, { entityName: "quiet-service" });

    expect(result.errors).toHaveLength(0);
    expect(result.summary).toMatch(/no errors/i);
  });
});

describe("getSlowTransactions", () => {
  it("sorts transactions by P95 descending", async () => {
    const client = makeClient(new Map([
      ["Transaction", [
        { name: "WebTransaction/checkout", p95Ms: 850, p99Ms: 1200, requestCount: 500, errorPct: 0.2 },
        { name: "WebTransaction/search", p95Ms: 3500, p99Ms: 4000, requestCount: 1000, errorPct: 0.1 },
      ]],
    ]));

    const result = await getSlowTransactions(client, { entityName: "checkout-api" });

    expect(result.transactions[0].name).toBe("WebTransaction/search");
    expect(result.transactions[0].p95Ms).toBe(3500);
    expect(result.summary).toMatch(/WebTransaction\/search/);
  });

  it("returns empty summary when no transaction data", async () => {
    const result = await getSlowTransactions(emptyClient, { entityName: "no-data-service" });

    expect(result.transactions).toHaveLength(0);
    expect(result.summary).toMatch(/no transaction data/i);
  });
});

describe("summarizeLogErrors", () => {
  it("returns grouped error log patterns", async () => {
    const client = makeClient(new Map([
      ["Log", [
        { message: "Connection refused to DB", count: 150, sample: "Connection refused", lastSeen: 2000 },
        { message: "Redis timeout", count: 32, sample: "Timeout after 5000ms", lastSeen: 1800 },
      ]],
    ]));

    const result = await summarizeLogErrors(client, { since: "1 hour ago" });

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].group).toBe("Connection refused to DB");
    expect(result.groups[0].count).toBe(150);
    expect(result.summary).toMatch(/2 error pattern/i);
  });

  it("returns empty when no error logs", async () => {
    const result = await summarizeLogErrors(emptyClient, { since: "1 hour ago" });

    expect(result.groups).toHaveLength(0);
    expect(result.summary).toMatch(/no log errors/i);
  });

  it("includes entityName filter in summary when provided", async () => {
    const result = await summarizeLogErrors(emptyClient, { entityName: "my-service", since: "1 hour ago" });

    expect(result.summary).toContain("my-service");
  });
});

describe("listActiveIncidents", () => {
  it("returns active incidents from NrAiIssue", async () => {
    const client = makeClient(new Map([
      ["NrAiIssue", [
        { issueId: "issue-1", priority: "CRITICAL", title: "Error rate spike", state: "ACTIVATED", createdAt: 1000 },
        { issueId: "issue-2", priority: "HIGH", title: "Latency degraded", state: "ACTIVATED", createdAt: 2000 },
      ]],
    ]));

    const result = await listActiveIncidents(client, {});

    expect(result.incidents).toHaveLength(2);
    expect(result.incidents[0].issueId).toBe("issue-1");
    expect(result.incidents[0].priority).toBe("CRITICAL");
    expect(result.summary).toMatch(/2 active incident/i);
  });

  it("returns empty summary when no active incidents", async () => {
    const result = await listActiveIncidents(emptyClient, {});

    expect(result.incidents).toHaveLength(0);
    expect(result.summary).toMatch(/no active incidents/i);
  });
});

describe("investigateServiceIssue", () => {
  it("aggregates findings from all sub-tools", async () => {
    const client = makeClient(new Map([
      ["percentage(count(*), WHERE error IS true)", [{ errorPct: 7.8 }]],
      ["rate(count(*), 1 minute)", [{ rpm: 100 }]],
      ["percentile(duration * 1000, 95)", [{ p95Ms: 250 }]],
      ["apdex(duration)", [{ apdexScore: 0.95 }]],
      ["TransactionError", [{ "error.class": "TimeoutError", count: 231, sample: "timed out", firstSeen: 1000, lastSeen: 2000 }]],
      ["Transaction", []],
      ["Log", []],
      ["NrAiIssue", []],
    ]));

    const result = await investigateServiceIssue(client, { entityName: "checkout-api" });

    expect(result.summary).toMatch(/checkout-api/);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.data.health).not.toBeNull();
    expect(result.metadata.fetched).toContain("service_health");
    expect(result.metadata.entityName).toBe("checkout-api");
  });

  it("still returns a result when all sub-tools return empty data", async () => {
    const result = await investigateServiceIssue(emptyClient, { entityName: "unknown-service" });

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toMatch(/no critical issues/i);
    expect(result.metadata.fetched.length).toBeGreaterThan(0);
  });

  it("includes incident findings when active incidents exist", async () => {
    const client = makeClient(new Map([
      ["NrAiIssue", [{ issueId: "i1", priority: "CRITICAL", title: "DB down", state: "ACTIVATED", createdAt: 1000 }]],
    ]));

    const result = await investigateServiceIssue(client, { entityName: "my-service" });

    expect(result.findings.some((f) => f.type === "incident" && f.severity === "critical")).toBe(true);
    expect(result.recommendations.some((r) => /active incident/i.test(r))).toBe(true);
  });
});
