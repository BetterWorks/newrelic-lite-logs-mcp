import { describe, expect, it } from "vitest";
import { buildZeroResultDiagnostics, extractKeysetFieldNames, extractQueryFieldReferences, selectFieldMapping } from "../src/log-discovery.js";
import type { NewRelicClient } from "../src/newrelic.js";

describe("log discovery helpers", () => {
  it("extracts fields from keyset-like payloads", () => {
    const rows = [
      {
        keyset: {
          stringKeys: ["service.name", "environment", "cloud.region"],
          numericKeys: ["durationMs"],
          nested: {
            booleanKeys: ["feature.enabled"],
          },
        },
      },
    ];

    expect(extractKeysetFieldNames(rows)).toEqual([
      "cloud.region",
      "durationMs",
      "environment",
      "feature.enabled",
      "service.name",
    ]);
  });

  it("chooses likely service and environment fields", () => {
    const mapping = selectFieldMapping(["entity.name", "environment", "hostname"]);
    expect(mapping.service).toBe("entity.name");
    expect(mapping.environment).toBe("environment");
    expect(mapping.host).toBe("hostname");
  });

  it("extracts likely query field references", () => {
    expect(extractQueryFieldReferences("SELECT * FROM Log WHERE kubernetes.podName = 'x' AND cloud.region = 'us'")).toEqual([
      "cloud.region",
      "kubernetes.podName",
    ]);
  });
});

describe("zero-result diagnostics", () => {
  it("flags missing schema fields when logs exist", async () => {
    const responses = new Map<string, Array<Record<string, unknown>>>([
      ["SELECT count(*) AS totalLogs, latest(timestamp) AS latestLogTimestamp FROM Log SINCE 24 hours ago LIMIT 1", [{ totalLogs: 20, latestLogTimestamp: 123 }]],
      ["SELECT keyset() FROM Log SINCE 24 hours ago LIMIT 1", [{ keyset: { stringKeys: ["service.name", "environment"] } }]],
      ["SELECT count(*) AS count FROM Log WHERE service.name IS NOT NULL FACET service.name SINCE 24 hours ago LIMIT 10", [{ count: 10, "service.name": "feedback-api" }]],
      ["SELECT count(*) AS count FROM Log WHERE environment IS NOT NULL FACET environment SINCE 24 hours ago LIMIT 10", [{ count: 20, environment: "prod" }]],
    ]);

    const client: NewRelicClient = {
      accountId: 1867676,
      authMode: "api_key_only",
      verboseLogs: false,
      runNrql: async (query) => responses.get(query) ?? [],
    };

    const diagnostics = await buildZeroResultDiagnostics(client, "SELECT * FROM Log WHERE kubernetes.podName = 'engage-api-jobs'", {
      since: "24 hours ago",
    });

    expect(diagnostics.missingFields).toContain("kubernetes.podName");
    expect(diagnostics.probableCause).toMatch(/not present/i);
    expect(diagnostics.suggestions.join(" ")).toMatch(/discover_log_schema/i);
  });
});