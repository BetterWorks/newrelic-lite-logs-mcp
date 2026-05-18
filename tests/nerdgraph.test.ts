import { describe, expect, it } from "vitest";
import type { NewRelicClient } from "../src/newrelic.js";
import { searchEntities } from "../src/nerdgraph.js";

function makeNerdGraphClient(response: unknown): NewRelicClient {
  return {
    accountId: 1867676,
    authMode: "api_key_only",
    verboseLogs: false,
    runNrql: async () => [],
    runNerdGraph: async () => response as never,
  };
}

describe("searchEntities", () => {
  it("returns entities from NerdGraph entitySearch response", async () => {
    const client = makeNerdGraphClient({
      actor: {
        entitySearch: {
          results: {
            entities: [
              { guid: "GUID1", name: "checkout-api", entityType: "APPLICATION", domain: "APM", accountId: 1867676, permalink: "https://one.newrelic.com/redirect/entity/GUID1" },
              { guid: "GUID2", name: "checkout-worker", entityType: "APPLICATION", domain: "APM", accountId: 1867676, permalink: null },
            ],
          },
        },
      },
    });

    const result = await searchEntities(client, { name: "checkout" });

    expect(result).toHaveLength(2);
    expect(result[0].guid).toBe("GUID1");
    expect(result[0].name).toBe("checkout-api");
    expect(result[0].domain).toBe("APM");
    expect(result[1].permalink).toBeNull();
  });

  it("returns empty array when no entities found", async () => {
    const client = makeNerdGraphClient({
      actor: { entitySearch: { results: { entities: [] } } },
    });

    const result = await searchEntities(client, { name: "nonexistent-service-xyz" });

    expect(result).toHaveLength(0);
  });

  it("returns empty array when NerdGraph response is missing nested data", async () => {
    const client = makeNerdGraphClient({ actor: {} });

    const result = await searchEntities(client, { name: "checkout" });

    expect(result).toHaveLength(0);
  });

  it("throws when no search parameters are provided", async () => {
    const client = makeNerdGraphClient({});

    await expect(searchEntities(client, {})).rejects.toThrow(/at least one search parameter/i);
  });

  it("builds query with type and domain filters", async () => {
    let capturedVariables: Record<string, unknown> | undefined;
    const client: NewRelicClient = {
      accountId: 1867676,
      authMode: "api_key_only",
      verboseLogs: false,
      runNrql: async () => [],
      runNerdGraph: async (_doc, vars) => {
        capturedVariables = vars;
        return { actor: { entitySearch: { results: { entities: [] } } } } as never;
      },
    };

    await searchEntities(client, { type: "APPLICATION", domain: "APM" });

    expect(capturedVariables?.q).toContain("type = 'APPLICATION'");
    expect(capturedVariables?.q).toContain("domain = 'APM'");
  });

  it("propagates NerdGraph errors", async () => {
    const client: NewRelicClient = {
      accountId: 1867676,
      authMode: "api_key_only",
      verboseLogs: false,
      runNrql: async () => [],
      runNerdGraph: async () => { throw new Error("New Relic GraphQL error: unauthorized"); },
    };

    await expect(searchEntities(client, { name: "checkout" })).rejects.toThrow(/unauthorized/i);
  });
});
