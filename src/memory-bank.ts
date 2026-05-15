/**
 * Memory bank — persistent local cache of New Relic account structure.
 *
 * The file is stored at NR_MEMORY_BANK_PATH (env) or ~/.newrelic-mcp/context.json.
 * It records all log-like event types, their schemas, custom fields, and sample
 * values so that an AI agent can construct correct queries without querying
 * the account on every call.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { NewRelicClient } from "./newrelic.js";
import type { MemoryBank, MemoryBankTable } from "./types.js";

// ─── Standard NR log fields ─────────────────────────────────────────────────
// These are present in almost every log event type and are not considered
// "custom" fields for the purposes of schema discovery.
const STANDARD_FIELDS = new Set([
  "timestamp",
  "message",
  "level",
  "severity",
  "logtype",
  "hostname",
  "host",
  "host.name",
  "host.id",
  "service.name",
  "entity.name",
  "entity.guid",
  "entity.type",
  "trace.id",
  "span.id",
  "traceId",
  "spanId",
  "log.file.path",
  "log.file.name",
  "thread.name",
  "newrelic.source",
  "newrelic.logs.age",
  "instrumentation.name",
  "instrumentation.provider",
  "instrumentation.version",
  "plugin.type",
  "plugin.version",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isLogLikeTable(name: string): boolean {
  // Exclude known internal/system NR event types even if they contain "log".
  if (
    /^NrAudit|^NrIntegration|^NrMTD|^NrUsage|^NrConsumption|^NrdbQuery|^SystemSample|^ProcessSample|^NetworkSample|^StorageSample|^ContainerSample|^K8sSample/i.test(
      name,
    )
  ) {
    return false;
  }

  return /log/i.test(name);
}

/** Run a NRQL query, returning an empty array on any error (so discovery never crashes). */
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

/** Pull field names out of a keyset() result which can have various shapes. */
function parseKeysetRows(rows: Array<Record<string, unknown>>): string[] {
  const fields: string[] = [];

  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            fields.push(item);
          } else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).key === "string") {
            fields.push((item as Record<string, unknown>).key as string);
          }
        }
      } else if (typeof value === "string" && value.trim()) {
        // Sometimes keyset returns a single comma-joined string
        for (const f of value.split(",")) {
          const trimmed = f.trim();
          if (trimmed) fields.push(trimmed);
        }
      }
    }
  }

  return [...new Set(fields)].filter(Boolean).sort();
}

/** Sample top distinct values for a single field in a given table. */
async function sampleFieldValues(
  client: NewRelicClient,
  tableName: string,
  field: string,
  since: string,
  accountId?: number,
): Promise<string[]> {
  const rows = await safeRunNrql(
    client,
    `SELECT count(*) AS c FROM ${tableName} WHERE ${field} IS NOT NULL FACET \`${field}\` SINCE ${since} LIMIT 10`,
    accountId,
  );

  const values: string[] = [];
  for (const row of rows) {
    const direct = row[field];
    const facet = row.facet;
    const raw = direct ?? facet;
    if (raw !== undefined && raw !== null) {
      const str = String(raw).trim();
      if (str) values.push(str);
    }
  }

  return [...new Set(values)].slice(0, 8);
}

// ─── Table discovery ─────────────────────────────────────────────────────────

async function discoverTable(
  client: NewRelicClient,
  tableName: string,
  accountId?: number,
): Promise<MemoryBankTable> {
  // Try 7-day window first, fall back to 30 days if empty.
  let since = "7 days ago";
  let statsRows = await safeRunNrql(
    client,
    `SELECT count(*) AS rows, latest(timestamp) AS latest, earliest(timestamp) AS earliest FROM ${tableName} SINCE ${since} LIMIT 1`,
    accountId,
  );

  let estimatedRows = Number(statsRows[0]?.rows ?? 0);

  if (estimatedRows === 0) {
    since = "30 days ago";
    statsRows = await safeRunNrql(
      client,
      `SELECT count(*) AS rows, latest(timestamp) AS latest, earliest(timestamp) AS earliest FROM ${tableName} SINCE ${since} LIMIT 1`,
      accountId,
    );
    estimatedRows = Number(statsRows[0]?.rows ?? 0);
  }

  const stats = statsRows[0] ?? {};

  // Fetch keyset.
  const keysetRows = await safeRunNrql(
    client,
    `SELECT keyset() FROM ${tableName} SINCE ${since} LIMIT 1`,
    accountId,
  );
  const fields = parseKeysetRows(keysetRows);
  const customFields = fields.filter((f) => !STANDARD_FIELDS.has(f));

  // Sample top values for up to 6 custom fields (run in parallel).
  const fieldsToSample = customFields.slice(0, 6);
  const sampleArrays = await Promise.all(
    fieldsToSample.map((field) => sampleFieldValues(client, tableName, field, since, accountId)),
  );

  const fieldSamples: Record<string, string[]> = {};
  for (let i = 0; i < fieldsToSample.length; i++) {
    if (sampleArrays[i].length > 0) {
      fieldSamples[fieldsToSample[i]] = sampleArrays[i];
    }
  }

  return {
    name: tableName,
    fields,
    customFields,
    fieldSamples,
    estimatedRows,
    windowUsed: since,
    latestTimestamp: (stats.latest as string | null) ?? null,
    earliestTimestamp: (stats.earliest as string | null) ?? null,
  };
}

// ─── Agent hint builder ───────────────────────────────────────────────────────

function buildAgentHint(bank: Omit<MemoryBank, "agentHint">): string {
  const tables = Object.values(bank.tables);

  if (tables.length === 0) {
    return (
      `Account ${bank.accountId}: no log tables discovered. ` +
      `The standard 'Log' event type may be empty or not yet ingesting data. ` +
      `Run build_memory_bank again after logs start flowing.`
    );
  }

  const sortedTables = [...tables].sort((a, b) => b.estimatedRows - a.estimatedRows);

  const tableLines = sortedTables.map((t) => {
    const rowInfo = t.estimatedRows > 0 ? `~${t.estimatedRows.toLocaleString()} rows/${t.windowUsed}` : "no recent data";

    const fieldInfo =
      t.customFields.length > 0 ? `custom fields: ${t.customFields.slice(0, 10).join(", ")}` : "no custom fields beyond standard set";

    const sampleLines = Object.entries(t.fieldSamples)
      .slice(0, 4)
      .map(([field, values]) => `  ${field}: [${values.slice(0, 4).join(", ")}]`)
      .join("\n");

    return [`  • ${t.name} — ${rowInfo}, ${fieldInfo}`, sampleLines ? `    sample values:\n${sampleLines}` : ""].filter(Boolean).join("\n");
  });

  const allTableNames = sortedTables.map((t) => t.name).join(", ");

  const customFieldSummary =
    bank.globalCustomFields.length > 0
      ? `\nShared custom fields across tables: ${bank.globalCustomFields.slice(0, 12).join(", ")}.`
      : "";

  return [
    `New Relic account ${bank.accountId} — log infrastructure summary (built ${bank.builtAt}):`,
    ``,
    `Log tables found:`,
    ...tableLines,
    ``,
    `Primary table (most data): ${bank.primaryTable}`,
    `All log tables: ${allTableNames}${customFieldSummary}`,
    ``,
    `INSTRUCTIONS FOR AI AGENT:`,
    `1. Always query FROM ${bank.primaryTable} unless the user specifies a different environment/region.`,
    `2. To query multiple tables at once: FROM ${allTableNames.split(", ").slice(0, 3).join(", ")}`,
    `3. Use the custom fields and sample values above to build WHERE clauses.`,
    `4. If a query returns zero results, check that you are using the correct table name and field names from this context.`,
    `5. The MCP server auto-loads this memory bank for query routing. Run build_memory_bank again when infra changes.`,
  ].join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getMemoryBankPath(): string {
  return process.env.NR_MEMORY_BANK_PATH ?? resolve(homedir(), ".newrelic-mcp", "context.json");
}

export async function readMemoryBank(): Promise<MemoryBank | null> {
  const filePath = getMemoryBankPath();
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as MemoryBank;
  } catch {
    return null;
  }
}

export async function writeMemoryBank(bank: MemoryBank): Promise<string> {
  const filePath = getMemoryBankPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(bank, null, 2), "utf8");
  return filePath;
}

/**
 * Full discovery pass:
 * 1. SHOW EVENT TYPES → find all log-like tables
 * 2. For each table: row counts, keyset, field samples
 * 3. Write result to memory bank file
 */
export async function buildMemoryBank(
  client: NewRelicClient,
  options: { accountId?: number } = {},
): Promise<{ bank: MemoryBank; filePath: string }> {
  const accountId = options.accountId ?? client.accountId;

  // Step 1: discover event types.
  const eventTypeRows = await safeRunNrql(client, "SHOW EVENT TYPES", accountId);
  const allTypes = eventTypeRows
    .map((row) => (row.type ?? row.eventType ?? row.name) as string | undefined)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  let logTables = allTypes.filter(isLogLikeTable);

  // Always include the standard Log table if SHOW EVENT TYPES returned nothing.
  if (logTables.length === 0) {
    logTables = ["Log"];
  }

  // Step 2: discover each table in parallel.
  const tableResults = await Promise.all(logTables.map((name) => discoverTable(client, name, accountId)));

  const tables: Record<string, MemoryBankTable> = {};
  for (const t of tableResults) {
    tables[t.name] = t;
  }

  // Step 3: pick primary table (highest row count; fall back to "Log").
  const sortedByRows = Object.values(tables).sort((a, b) => b.estimatedRows - a.estimatedRows);
  const primaryTable = sortedByRows[0]?.name ?? "Log";

  // Step 4: collect global custom fields (union across all tables).
  const fieldFreq = new Map<string, number>();
  for (const t of Object.values(tables)) {
    for (const f of t.customFields) {
      fieldFreq.set(f, (fieldFreq.get(f) ?? 0) + 1);
    }
  }
  const globalCustomFields = [...fieldFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  const partial: Omit<MemoryBank, "agentHint"> = {
    version: "1",
    builtAt: new Date().toISOString(),
    accountId,
    authMode: client.authMode,
    logTables,
    primaryTable,
    tables,
    globalCustomFields,
  };

  const bank: MemoryBank = { ...partial, agentHint: buildAgentHint(partial) };
  const filePath = await writeMemoryBank(bank);

  return { bank, filePath };
}
