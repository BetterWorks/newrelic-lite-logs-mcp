import { z } from "zod";
import { AuthMode } from "./types.js";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NEW_RELIC_API_KEY: optionalNonEmptyString,
  NEW_RELIC_COOKIE: optionalNonEmptyString,
  NEW_RELIC_DEFAULT_AUTH_MODE: z.enum(["api_key_only", "cookie"]).optional(),
  NEW_RELIC_ACCOUNT_ID: z.coerce.number().int().positive(),
  NEW_RELIC_VERBOSE_LOGS: z.string().optional(),
});

export interface NewRelicClient {
  accountId: number;
  authMode: AuthMode;
  verboseLogs: boolean;
  runNrql: (query: string, accountIdOverride?: number) => Promise<Array<Record<string, unknown>>>;
}

export function buildClientFromEnv(): NewRelicClient {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid env configuration: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }

  const env = parsed.data;
  const desiredMode = env.NEW_RELIC_DEFAULT_AUTH_MODE ?? "api_key_only";
  const authMode: AuthMode = desiredMode;

  if (authMode === "api_key_only" && !env.NEW_RELIC_API_KEY) {
    throw new Error("Missing NEW_RELIC_API_KEY for api_key_only mode.");
  }

  if (authMode === "cookie" && !env.NEW_RELIC_COOKIE) {
    throw new Error("Missing NEW_RELIC_COOKIE for cookie mode.");
  }

  const runNrql = async (query: string, accountIdOverride?: number): Promise<Array<Record<string, unknown>>> => {
    const accountId = accountIdOverride ?? env.NEW_RELIC_ACCOUNT_ID;
    const body = {
      query: `query NrqlQuery($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql) { results } } } }`,
      variables: {
        accountId,
        nrql: query,
      },
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };

    if (authMode === "api_key_only" && env.NEW_RELIC_API_KEY) {
      headers["Api-Key"] = env.NEW_RELIC_API_KEY;
    }

    if (authMode === "cookie" && env.NEW_RELIC_COOKIE) {
      headers.Cookie = env.NEW_RELIC_COOKIE;
      headers.Origin = "https://one.newrelic.com";
      headers.Referer = "https://one.newrelic.com/";
      headers["newrelic-requesting-services"] = "nr1-ui";
    }

    const response = await fetch("https://api.newrelic.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`New Relic request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    const json = (await response.json()) as {
      data?: { actor?: { account?: { nrql?: { results?: Array<Record<string, unknown>> } } } };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`New Relic GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    return json.data?.actor?.account?.nrql?.results ?? [];
  };

  return {
    accountId: env.NEW_RELIC_ACCOUNT_ID,
    authMode,
    verboseLogs: env.NEW_RELIC_VERBOSE_LOGS === "1",
    runNrql,
  };
}
