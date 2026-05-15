import { NewRelicClient } from "./newrelic.js";
import { injectWindowAndLimit } from "./security.js";
import { AccountContext, FieldMapping, InfraContext, SchemaDiscoveryResult, ZeroResultDiagnostics } from "./types.js";

const FIELD_CANDIDATES: Record<keyof FieldMapping, string[]> = {
  service: ["service.name", "entity.name", "serviceName", "appName", "app.name"],
  environment: ["environment", "deployment.environment", "env", "labels.environment"],
  region: ["cloud.region", "region", "awsRegion"],
  cluster: ["k8s.cluster.name", "kubernetes.clusterName", "clusterName"],
  pod: ["k8s.pod.name", "kubernetes.podName", "podName", "pod_name"],
  host: ["hostname", "host", "host.name"],
};

interface DiscoveryOptions {
  accountId?: number;
  since?: string;
  until?: string;
  limit?: number;
}

function withDefaultWindow(options: DiscoveryOptions): DiscoveryOptions {
  if (options.since || options.until) {
    return options;
  }

  return {
    ...options,
    since: "24 hours ago",
  };
}

function normalizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((row) => row && typeof row === "object");
}

async function runWindowedQuery(client: NewRelicClient, query: string, options: DiscoveryOptions = {}): Promise<Array<Record<string, unknown>>> {
  const windowedOptions = withDefaultWindow(options);
  const normalized = injectWindowAndLimit(query, windowedOptions.since, windowedOptions.until, windowedOptions.limit);
  return normalizeRows(await client.runNrql(normalized, options.accountId));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function extractStrings(value: unknown, collector: string[]): void {
  if (typeof value === "string") {
    collector.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractStrings(item, collector);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/keys$/i.test(key) && Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string") {
            collector.push(item);
          } else {
            extractStrings(item, collector);
          }
        }
        continue;
      }

      extractStrings(nested, collector);
    }
  }
}

export function extractKeysetFieldNames(rows: Array<Record<string, unknown>>): string[] {
  const collector: string[] = [];
  for (const row of rows) {
    extractStrings(row, collector);
  }

  return uniqueStrings(collector.filter((value) => /[A-Za-z_][A-Za-z0-9_.-]*/.test(value)));
}

export function selectFieldMapping(availableFields: string[]): FieldMapping {
  const mapping: FieldMapping = {};

  for (const [target, candidates] of Object.entries(FIELD_CANDIDATES) as Array<[keyof FieldMapping, string[]]>) {
    mapping[target] = candidates.find((candidate) => availableFields.includes(candidate));
  }

  return mapping;
}

function extractFacetValue(row: Record<string, unknown>, field: string): string | undefined {
  const direct = row[field];
  if (direct !== undefined && direct !== null && String(direct).trim()) {
    return String(direct);
  }

  const facet = row.facet;
  if (facet !== undefined && facet !== null && String(facet).trim()) {
    return String(facet);
  }

  return undefined;
}

async function fetchTopValues(client: NewRelicClient, field: string, options: DiscoveryOptions = {}): Promise<string[]> {
  const rows = await runWindowedQuery(client, `SELECT count(*) AS count FROM Log WHERE ${field} IS NOT NULL FACET ${field}`, {
    ...options,
    limit: Math.min(options.limit ?? 10, 20),
  });

  return uniqueStrings(
    rows
      .map((row) => extractFacetValue(row, field))
      .filter((value): value is string => Boolean(value)),
  ).slice(0, Math.min(options.limit ?? 10, 10));
}

export async function getAccountContext(client: NewRelicClient, options: DiscoveryOptions = {}): Promise<AccountContext> {
  const windowedOptions = withDefaultWindow(options);
  const rows = await runWindowedQuery(client, "SELECT count(*) AS totalLogs, latest(timestamp) AS latestLogTimestamp FROM Log", {
    ...windowedOptions,
    limit: 1,
  });

  const row = rows[0] ?? {};
  return {
    accountId: options.accountId ?? client.accountId,
    authMode: client.authMode,
    totalLogsInWindow: Number(row.totalLogs ?? 0),
    latestLogTimestamp: (row.latestLogTimestamp as string | number | null | undefined) ?? null,
    since: windowedOptions.since,
    until: windowedOptions.until,
  };
}

export async function discoverLogSchema(client: NewRelicClient, options: DiscoveryOptions = {}): Promise<SchemaDiscoveryResult> {
  const accountContext = await getAccountContext(client, options);
  const keysetRows = accountContext.totalLogsInWindow > 0
    ? await runWindowedQuery(client, "SELECT keyset() FROM Log", { ...options, limit: 1 })
    : [];
  const availableFields = extractKeysetFieldNames(keysetRows);
  const fieldMapping = selectFieldMapping(availableFields);
  const topValues: Record<string, string[]> = {};

  for (const [label, field] of Object.entries(fieldMapping) as Array<[keyof FieldMapping, string | undefined]>) {
    if (!field) {
      continue;
    }

    topValues[label] = await fetchTopValues(client, field, options);
  }

  const suggestions: string[] = [];
  if (accountContext.totalLogsInWindow === 0) {
    suggestions.push("No logs were found in this account and time window. Try a wider window or confirm the account id.");
  }

  if (!fieldMapping.service) {
    suggestions.push("No obvious service field was detected. Use discover_log_schema before filtering by service or pod names.");
  }

  if (availableFields.length === 0) {
    suggestions.push("Recent log schema could not be inferred from keyset(). The account may have a very small or restricted log corpus.");
  }

  return {
    summary: `Detected ${availableFields.length} recent log fields in account ${accountContext.accountId}.`,
    accountContext,
    availableFields,
    fieldMapping,
    topValues,
    suggestions,
  };
}

export function extractQueryFieldReferences(query: string): string[] {
  const dottedFields = [...query.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+\b/g)].map((match) => match[0]);
  const simpleFields = ["environment", "hostname", "region", "serviceName", "podName"].filter((field) => new RegExp(`(?<!\\.)\\b${field}\\b(?!\\.)`).test(query));
  return uniqueStrings([...dottedFields, ...simpleFields]);
}

export async function buildZeroResultDiagnostics(client: NewRelicClient, query: string, options: DiscoveryOptions = {}): Promise<ZeroResultDiagnostics> {
  const schema = await discoverLogSchema(client, { ...options, limit: 10 });
  const queryFields = extractQueryFieldReferences(query);
  const missingFields = queryFields.filter((field) => !schema.availableFields.includes(field));
  const suggestions = [...schema.suggestions];

  let probableCause = "Logs exist in the selected window, but this query matched no rows.";
  if (schema.accountContext.totalLogsInWindow === 0) {
    probableCause = "No logs were found for this account and time window. This usually means the account is wrong, the window is too narrow, or ingestion is absent.";
  } else if (missingFields.length > 0) {
    probableCause = "The query references fields that are not present in recent logs for this account.";
    suggestions.unshift(`Missing fields detected: ${missingFields.join(", ")}. Use discover_log_schema to inspect the actual log schema.`);
  } else {
    suggestions.unshift("The account has logs in this window, so zero results likely means the filter values or target entity name are incorrect.");
  }

  if (Object.keys(schema.topValues).length > 0) {
    const valueHints = Object.entries(schema.topValues)
      .filter(([, values]) => values.length > 0)
      .map(([label, values]) => `${label}: ${values.slice(0, 5).join(", ")}`);

    if (valueHints.length > 0) {
      suggestions.push(`Recent log values detected: ${valueHints.join(" | ")}`);
    }
  }

  return {
    probableCause,
    missingFields,
    availableFieldSample: schema.availableFields.slice(0, 25),
    suggestions,
  };
}

export async function discoverInfraContext(client: NewRelicClient, options: DiscoveryOptions = {}): Promise<InfraContext> {
  const schema = await discoverLogSchema(client, options);
  const fieldMapping = schema.fieldMapping;

  return {
    generatedAt: new Date().toISOString(),
    accountId: schema.accountContext.accountId,
    services: fieldMapping.service ? await fetchTopValues(client, fieldMapping.service, { ...options, limit: 25 }) : [],
    hosts: fieldMapping.host ? await fetchTopValues(client, fieldMapping.host, { ...options, limit: 25 }) : [],
    clusters: fieldMapping.cluster ? await fetchTopValues(client, fieldMapping.cluster, { ...options, limit: 25 }) : [],
    environments: fieldMapping.environment ? await fetchTopValues(client, fieldMapping.environment, { ...options, limit: 25 }) : [],
    regions: fieldMapping.region ? await fetchTopValues(client, fieldMapping.region, { ...options, limit: 25 }) : [],
    pods: fieldMapping.pod ? await fetchTopValues(client, fieldMapping.pod, { ...options, limit: 25 }) : [],
    fieldMapping,
    source: "newrelic.logs",
  };
}