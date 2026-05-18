import type { NewRelicClient } from "./newrelic.js";
import { quoteNrql } from "./security.js";

const DEFAULT_SINCE = "1 hour ago";
const DEFAULT_LIMIT = 20;

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface ServiceHealthData {
  throughputRpm: number | null;
  errorPct: number | null;
  p95Ms: number | null;
  apdexScore: number | null;
}

export interface HealthFinding {
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface ServiceHealthResult {
  summary: string;
  data: ServiceHealthData;
  findings: HealthFinding[];
  recommendations: string[];
  metadata: { accountId: number; entityName: string; since: string };
}

export interface TopErrorEntry {
  errorClass: string;
  count: number;
  sample: string | null;
  firstSeen: string | number | null;
  lastSeen: string | number | null;
}

export interface TopErrorsResult {
  summary: string;
  errors: TopErrorEntry[];
  metadata: { accountId: number; entityName: string; since: string };
}

export interface SlowTransactionEntry {
  name: string;
  p95Ms: number | null;
  p99Ms: number | null;
  requestCount: number;
  errorPct: number | null;
}

export interface SlowTransactionsResult {
  summary: string;
  transactions: SlowTransactionEntry[];
  metadata: { accountId: number; entityName: string; since: string };
}

export interface LogErrorEntry {
  group: string;
  count: number;
  sample: string | null;
  lastSeen: string | number | null;
}

export interface LogErrorsResult {
  summary: string;
  groups: LogErrorEntry[];
  metadata: { accountId: number; since: string; until: string | undefined };
}

export interface IncidentEntry {
  issueId: string;
  priority: string;
  title: string;
  state: string;
  createdAt: string | number | null;
}

export interface IncidentsResult {
  summary: string;
  incidents: IncidentEntry[];
  metadata: { accountId: number; since: string };
}

export interface InvestigationResult {
  summary: string;
  findings: HealthFinding[];
  data: {
    health: ServiceHealthData | null;
    topErrors: TopErrorEntry[];
    slowTransactions: SlowTransactionEntry[];
    incidents: IncidentEntry[];
  };
  recommendations: string[];
  metadata: {
    accountId: number;
    entityName: string;
    since: string;
    fetched: string[];
    missing: string[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeTimestamp(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

async function safeRunNrql(
  client: NewRelicClient,
  query: string,
  accountId?: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    return await client.runNrql(query, accountId);
  } catch {
    return [];
  }
}

// ─── Service health summary ───────────────────────────────────────────────────

export async function getServiceHealthSummary(
  client: NewRelicClient,
  options: { entityName: string; accountId?: number; since?: string },
): Promise<ServiceHealthResult> {
  const since = options.since ?? DEFAULT_SINCE;
  const name = quoteNrql(options.entityName);

  const [throughputRows, errorRows, latencyRows, apdexRows] = await Promise.all([
    safeRunNrql(client, `SELECT rate(count(*), 1 minute) AS rpm FROM Transaction WHERE appName = ${name} SINCE ${since} LIMIT 1`, options.accountId),
    safeRunNrql(client, `SELECT percentage(count(*), WHERE error IS true) AS errorPct FROM Transaction WHERE appName = ${name} SINCE ${since} LIMIT 1`, options.accountId),
    safeRunNrql(client, `SELECT percentile(duration * 1000, 95) AS p95Ms FROM Transaction WHERE appName = ${name} SINCE ${since} LIMIT 1`, options.accountId),
    safeRunNrql(client, `SELECT apdex(duration) AS apdexScore FROM Transaction WHERE appName = ${name} SINCE ${since} LIMIT 1`, options.accountId),
  ]);

  const throughputRpm = safeNumber(throughputRows[0]?.rpm);
  const errorPct = safeNumber(errorRows[0]?.errorPct);
  const p95Ms = safeNumber(latencyRows[0]?.p95Ms);
  const apdexScore = safeNumber(apdexRows[0]?.apdexScore);

  const findings: HealthFinding[] = [];

  if (errorPct !== null) {
    if (errorPct >= 5) {
      findings.push({ type: "error_rate", severity: "critical", message: `Error rate is ${round2(errorPct)}% (threshold: 5%)` });
    } else if (errorPct >= 1) {
      findings.push({ type: "error_rate", severity: "warning", message: `Error rate is ${round2(errorPct)}% (threshold: 1%)` });
    }
  }

  if (p95Ms !== null) {
    if (p95Ms >= 3000) {
      findings.push({ type: "latency", severity: "critical", message: `P95 latency is ${round2(p95Ms)}ms (threshold: 3000ms)` });
    } else if (p95Ms >= 1000) {
      findings.push({ type: "latency", severity: "warning", message: `P95 latency is ${round2(p95Ms)}ms (threshold: 1000ms)` });
    }
  }

  if (apdexScore !== null) {
    if (apdexScore < 0.7) {
      findings.push({ type: "apdex", severity: "critical", message: `Apdex score is ${round2(apdexScore)} (threshold: 0.7)` });
    } else if (apdexScore < 0.9) {
      findings.push({ type: "apdex", severity: "warning", message: `Apdex score is ${round2(apdexScore)} (threshold: 0.9)` });
    }
  }

  const noData = throughputRpm === null && errorPct === null && p95Ms === null;
  const recommendations: string[] = [];

  if (findings.some((f) => f.type === "error_rate")) {
    recommendations.push(`Run get_top_errors for ${options.entityName} to identify error classes.`);
  }
  if (findings.some((f) => f.type === "latency")) {
    recommendations.push(`Run get_slow_transactions for ${options.entityName} to identify slow endpoints.`);
  }
  if (noData) {
    recommendations.push(`No Transaction data found for '${options.entityName}'. Verify the name matches the APM application name in New Relic.`);
  }

  let summary: string;
  if (noData) {
    summary = `No APM data found for '${options.entityName}' in the last ${since}.`;
  } else {
    const parts: string[] = [];
    if (errorPct !== null) parts.push(`error rate ${round2(errorPct)}%`);
    if (throughputRpm !== null) parts.push(`${round2(throughputRpm)} rpm`);
    if (p95Ms !== null) parts.push(`P95 ${round2(p95Ms)}ms`);
    if (apdexScore !== null) parts.push(`apdex ${round2(apdexScore)}`);
    const critical = findings.filter((f) => f.severity === "critical").length;
    const warning = findings.filter((f) => f.severity === "warning").length;
    const status = critical > 0 ? "unhealthy" : warning > 0 ? "degraded" : "healthy";
    summary = `'${options.entityName}' is ${status}: ${parts.join(", ")}.`;
  }

  return {
    summary,
    data: { throughputRpm, errorPct, p95Ms, apdexScore },
    findings,
    recommendations,
    metadata: { accountId: options.accountId ?? client.accountId, entityName: options.entityName, since },
  };
}

// ─── Top errors ───────────────────────────────────────────────────────────────

export async function getTopErrors(
  client: NewRelicClient,
  options: { entityName: string; accountId?: number; since?: string; limit?: number },
): Promise<TopErrorsResult> {
  const since = options.since ?? DEFAULT_SINCE;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
  const name = quoteNrql(options.entityName);

  const rows = await safeRunNrql(
    client,
    `SELECT count(*) AS count, latest(errorMessage) AS sample, earliest(timestamp) AS firstSeen, latest(timestamp) AS lastSeen FROM TransactionError WHERE appName = ${name} SINCE ${since} FACET error.class LIMIT ${limit}`,
    options.accountId,
  );

  const errors: TopErrorEntry[] = rows.map((row) => ({
    errorClass: safeString(row["error.class"] ?? row.facet) ?? "(unknown)",
    count: safeNumber(row.count) ?? 0,
    sample: safeString(row.sample),
    firstSeen: safeTimestamp(row.firstSeen),
    lastSeen: safeTimestamp(row.lastSeen),
  }));

  return {
    summary: errors.length === 0
      ? `No errors found for '${options.entityName}' in the last ${since}.`
      : `Found ${errors.length} error class(es) for '${options.entityName}'. Top: ${errors[0].errorClass} (${errors[0].count} occurrences).`,
    errors,
    metadata: { accountId: options.accountId ?? client.accountId, entityName: options.entityName, since },
  };
}

// ─── Slow transactions ────────────────────────────────────────────────────────

export async function getSlowTransactions(
  client: NewRelicClient,
  options: { entityName: string; accountId?: number; since?: string; limit?: number },
): Promise<SlowTransactionsResult> {
  const since = options.since ?? DEFAULT_SINCE;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
  const name = quoteNrql(options.entityName);

  const rows = await safeRunNrql(
    client,
    `SELECT percentile(duration * 1000, 95) AS p95Ms, percentile(duration * 1000, 99) AS p99Ms, count(*) AS requestCount, percentage(count(*), WHERE error IS true) AS errorPct FROM Transaction WHERE appName = ${name} SINCE ${since} FACET name LIMIT ${limit}`,
    options.accountId,
  );

  const transactions: SlowTransactionEntry[] = rows
    .map((row) => ({
      name: safeString(row.name ?? row.facet) ?? "(unknown)",
      p95Ms: safeNumber(row.p95Ms),
      p99Ms: safeNumber(row.p99Ms),
      requestCount: safeNumber(row.requestCount) ?? 0,
      errorPct: safeNumber(row.errorPct),
    }))
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));

  return {
    summary: transactions.length === 0
      ? `No transaction data found for '${options.entityName}' in the last ${since}.`
      : `Found ${transactions.length} transaction(s). Slowest: '${transactions[0].name}' at P95 ${transactions[0].p95Ms}ms.`,
    transactions,
    metadata: { accountId: options.accountId ?? client.accountId, entityName: options.entityName, since },
  };
}

// ─── Summarize log errors ─────────────────────────────────────────────────────

export async function summarizeLogErrors(
  client: NewRelicClient,
  options: { entityName?: string; logTable?: string; since?: string; until?: string; limit?: number; accountId?: number },
): Promise<LogErrorsResult> {
  const since = options.since ?? DEFAULT_SINCE;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 200);
  const table = options.logTable ?? "Log";

  const filters: string[] = [
    "(level IN ('ERROR', 'FATAL', 'error', 'fatal') OR severity IN ('ERROR', 'FATAL', 'error', 'fatal'))",
  ];

  if (options.entityName) {
    const name = quoteNrql(options.entityName);
    filters.push(`(entity.name = ${name} OR service.name = ${name})`);
  }

  const where = filters.join(" AND ");
  const timeClause = options.until ? `SINCE ${since} UNTIL ${options.until}` : `SINCE ${since}`;

  const rows = await safeRunNrql(
    client,
    `SELECT count(*) AS count, latest(message) AS sample, latest(timestamp) AS lastSeen FROM ${table} WHERE ${where} ${timeClause} FACET message LIMIT ${limit}`,
    options.accountId,
  );

  const groups: LogErrorEntry[] = rows.map((row) => ({
    group: safeString(row.message ?? row.facet) ?? "(unknown)",
    count: safeNumber(row.count) ?? 0,
    sample: safeString(row.sample),
    lastSeen: safeTimestamp(row.lastSeen),
  }));

  return {
    summary: groups.length === 0
      ? `No log errors found${options.entityName ? ` for '${options.entityName}'` : ""} in the last ${since}.`
      : `Found ${groups.length} error pattern(s)${options.entityName ? ` for '${options.entityName}'` : ""}. Most frequent: ${groups[0].group.slice(0, 100)}.`,
    groups,
    metadata: { accountId: options.accountId ?? client.accountId, since, until: options.until },
  };
}

// ─── Active incidents ─────────────────────────────────────────────────────────

export async function listActiveIncidents(
  client: NewRelicClient,
  options: { accountId?: number; since?: string; limit?: number },
): Promise<IncidentsResult> {
  const since = options.since ?? "24 hours ago";
  const limit = Math.min(options.limit ?? 50, 200);

  const rows = await safeRunNrql(
    client,
    `SELECT issueId, priority, title, state, createdAt FROM NrAiIssue WHERE state = 'ACTIVATED' SINCE ${since} LIMIT ${limit}`,
    options.accountId,
  );

  const incidents: IncidentEntry[] = rows.map((row) => ({
    issueId: safeString(row.issueId) ?? "(unknown)",
    priority: safeString(row.priority) ?? "UNKNOWN",
    title: safeString(row.title) ?? "(no title)",
    state: safeString(row.state) ?? "ACTIVATED",
    createdAt: safeTimestamp(row.createdAt),
  }));

  return {
    summary: incidents.length === 0
      ? `No active incidents in the last ${since}.`
      : `Found ${incidents.length} active incident(s). Priorities: ${[...new Set(incidents.map((i) => i.priority))].join(", ")}.`,
    incidents,
    metadata: { accountId: options.accountId ?? client.accountId, since },
  };
}

// ─── Composite investigation ──────────────────────────────────────────────────

export async function investigateServiceIssue(
  client: NewRelicClient,
  options: { entityName: string; accountId?: number; since?: string; limit?: number },
): Promise<InvestigationResult> {
  const since = options.since ?? DEFAULT_SINCE;
  const limit = Math.min(options.limit ?? 10, 50);

  const [healthResult, errorsResult, txResult, logsResult, incidentsResult] = await Promise.allSettled([
    getServiceHealthSummary(client, { entityName: options.entityName, accountId: options.accountId, since }),
    getTopErrors(client, { entityName: options.entityName, accountId: options.accountId, since, limit }),
    getSlowTransactions(client, { entityName: options.entityName, accountId: options.accountId, since, limit }),
    summarizeLogErrors(client, { entityName: options.entityName, accountId: options.accountId, since, limit }),
    listActiveIncidents(client, { accountId: options.accountId, since: "24 hours ago" }),
  ]);

  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const errors = errorsResult.status === "fulfilled" ? errorsResult.value.errors : [];
  const transactions = txResult.status === "fulfilled" ? txResult.value.transactions : [];
  const logGroups = logsResult.status === "fulfilled" ? logsResult.value.groups : [];
  const incidents = incidentsResult.status === "fulfilled" ? incidentsResult.value.incidents : [];

  const fetched: string[] = [];
  const missing: string[] = [];

  if (healthResult.status === "fulfilled") fetched.push("service_health"); else missing.push("service_health");
  if (errorsResult.status === "fulfilled") fetched.push("top_errors"); else missing.push("top_errors");
  if (txResult.status === "fulfilled") fetched.push("slow_transactions"); else missing.push("slow_transactions");
  if (logsResult.status === "fulfilled") fetched.push("log_errors"); else missing.push("log_errors");
  if (incidentsResult.status === "fulfilled") fetched.push("incidents"); else missing.push("incidents");

  const allFindings: HealthFinding[] = [...(health?.findings ?? [])];

  if (incidents.length > 0) {
    allFindings.push({
      type: "incident",
      severity: incidents.some((i) => i.priority === "CRITICAL") ? "critical" : "warning",
      message: `${incidents.length} active incident(s): ${incidents.map((i) => i.title).slice(0, 3).join("; ")}`,
    });
  }

  if (errors.length > 0) {
    allFindings.push({
      type: "top_error",
      severity: errors[0].count > 100 ? "critical" : "warning",
      message: `Top error: ${errors[0].errorClass} (${errors[0].count} occurrences)`,
    });
  }

  const recommendations: string[] = [...(health?.recommendations ?? [])];

  if (errors.length > 0) {
    recommendations.push(`Investigate ${errors[0].errorClass} — ${errors[0].count} occurrences since ${since}.`);
    if (errors[0].sample) {
      recommendations.push(`Sample message: ${errors[0].sample.slice(0, 150)}`);
    }
  }

  if (transactions.length > 0 && (transactions[0].p95Ms ?? 0) > 1000) {
    recommendations.push(`Slow transaction: '${transactions[0].name}' at P95 ${transactions[0].p95Ms}ms.`);
  }

  if (logGroups.length > 0) {
    recommendations.push(`Check logs — top pattern: ${logGroups[0].group.slice(0, 100)} (${logGroups[0].count} occurrences).`);
  }

  if (incidents.length > 0) {
    recommendations.push(`Review ${incidents.length} active incident(s) in New Relic AI.`);
  }

  const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
  const warningCount = allFindings.filter((f) => f.severity === "warning").length;

  let summary: string;
  if (allFindings.length === 0) {
    summary = `'${options.entityName}': No critical issues detected in the last ${since}.`;
  } else if (criticalCount > 0) {
    summary = `'${options.entityName}' has ${criticalCount} critical issue(s) and ${warningCount} warning(s). Immediate investigation recommended.`;
  } else {
    summary = `'${options.entityName}' has ${warningCount} warning(s). Investigation recommended.`;
  }

  return {
    summary,
    findings: allFindings,
    data: {
      health: health?.data ?? null,
      topErrors: errors.slice(0, limit),
      slowTransactions: transactions.slice(0, limit),
      incidents,
    },
    recommendations,
    metadata: {
      accountId: options.accountId ?? client.accountId,
      entityName: options.entityName,
      since,
      fetched,
      missing,
    },
  };
}
