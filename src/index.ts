#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildZeroResultDiagnostics, discoverInfraContext, discoverLogSchema, getAccountContext } from "./log-discovery.js";
import { buildMemoryBank, getMemoryBankPath, readMemoryBank } from "./memory-bank.js";
import { buildClientFromEnv } from "./newrelic.js";
import {
  decodePageToken,
  encodePageToken,
  enforceReadOnlyQuery,
  ensureTimeBound,
  injectWindowAndLimit,
  normalizeQuery,
  redactObject,
  withOffset,
} from "./security.js";
import { DryRunResult, QueryResult } from "./types.js";

const MAX_LIMIT = 5000;

const searchLogsSchema = z.object({
  query: z.string().min(1),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  pageToken: z.string().optional(),
});

const getErrorLogsSchema = z.object({
  accountId: z.number().int().positive().optional(),
  serviceName: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  pageToken: z.string().optional(),
});

const summarizePatternsSchema = z.object({
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const discoverInfraSchema = z.object({
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  outputPath: z.string().optional(),
});

const discoverLogSchemaSchema = z.object({
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

const accountContextSchema = z.object({
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

const dryRunSchema = z.object({
  query: z.string().min(1),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

const buildMemoryBankSchema = z.object({
  accountId: z.number().int().positive().optional(),
});

const client = buildClientFromEnv();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function routeQueryWithMemoryBank(rawQuery: string): Promise<{ query: string; note?: string }> {
  const bank = await readMemoryBank();
  if (!bank || !bank.primaryTable || bank.primaryTable === "Log") {
    return { query: rawQuery };
  }

  if (!/\bFROM\s+Log\b/i.test(rawQuery)) {
    return { query: rawQuery };
  }

  return {
    query: rawQuery.replace(/\bFROM\s+Log\b/i, `FROM ${bank.primaryTable}`),
    note: `Auto-routed FROM Log to FROM ${bank.primaryTable} using local memory bank.`,
  };
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function classifyError(error: unknown): { type: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/Missing NEW_RELIC_API_KEY|Missing NEW_RELIC_COOKIE|Invalid env configuration/i.test(message)) {
    return { type: "auth_error", message };
  }

  if (/only read-only NRQL|provide at least one of since\/until|Invalid date\/time string|Unknown function|rejected/i.test(message)) {
    return { type: "query_validation_error", message };
  }

  if (/request failed \(429\)/i.test(message)) {
    return { type: "rate_limited", message };
  }

  if (/request failed \(5\d\d\)/i.test(message)) {
    return { type: "upstream_rejected", message };
  }

  if (/fetch failed|network/i.test(message)) {
    return { type: "upstream_timeout", message };
  }

  return { type: "internal_error", message };
}

async function executeQuery(rawQuery: string, options: { accountId?: number; since?: string; until?: string; limit?: number; pageToken?: string }): Promise<QueryResult> {
  const routed = await routeQueryWithMemoryBank(rawQuery);

  enforceReadOnlyQuery(routed.query);
  ensureTimeBound(routed.query, options.since, options.until);

  const limit = Math.min(options.limit ?? 200, MAX_LIMIT);
  const offset = decodePageToken(options.pageToken);
  const query = withOffset(injectWindowAndLimit(routed.query, options.since, options.until, limit), offset);

  const startedAt = Date.now();
  const rows = await client.runNrql(query, options.accountId);
  const durationMs = Date.now() - startedAt;
  const accountContext = await getAccountContext(client, {
    accountId: options.accountId,
    since: options.since,
    until: options.until,
  });

  const { redacted, redactionCount } = redactObject(rows);
  const nextPageToken = rows.length >= limit ? encodePageToken(offset + limit) : undefined;
  const diagnostics = rows.length === 0 ? await buildZeroResultDiagnostics(client, query, {
    accountId: options.accountId,
    since: options.since,
    until: options.until,
  }) : undefined;

  return {
    summary: `Fetched ${rows.length} rows in ${durationMs}ms using ${client.authMode}.${routed.note ? ` ${routed.note}` : ""}`,
    query,
    rows: redacted,
    accountContext,
    diagnostics,
    meta: {
      durationMs,
      rowsReturned: rows.length,
      capped: rows.length >= limit,
      redactionCount,
      nextPageToken,
      accountId: options.accountId ?? client.accountId,
      authMode: client.authMode,
    },
  };
}

async function makeDryRun(rawQuery: string, options: { since?: string; until?: string; limit?: number }): Promise<DryRunResult> {
  const routed = await routeQueryWithMemoryBank(rawQuery);

  enforceReadOnlyQuery(routed.query);
  ensureTimeBound(routed.query, options.since, options.until);

  const normalizedQuery = injectWindowAndLimit(routed.query, options.since, options.until, Math.min(options.limit ?? 200, MAX_LIMIT));
  const warnings: string[] = [];

  const memoryBank = await readMemoryBank();
  if (routed.note) {
    warnings.push(routed.note);
  }

  if (memoryBank && memoryBank.logTables.length > 0) {
    const queryTargetsStandardLog = /\bFROM\s+Log\b/i.test(normalizedQuery);
    const hasCustomTables = memoryBank.logTables.some((t) => t !== "Log");

    if (queryTargetsStandardLog && hasCustomTables) {
      warnings.push(
        `Memory bank shows custom log tables: ${memoryBank.logTables.join(", ")}. ` +
        `Consider querying FROM ${memoryBank.primaryTable} instead of the standard Log table.`,
      );
    }

    const targetsKnownTable = memoryBank.logTables.some((tableName) => {
      const re = new RegExp(`\\bFROM\\s+${escapeRegExp(tableName)}\\b`, "i");
      return re.test(normalizedQuery);
    });

    if (!targetsKnownTable && !queryTargetsStandardLog) {
      warnings.push("Query does not target any known log table. Call get_memory_bank to see available tables.");
    }
  } else if (!/\bFROM\s+Log\b/i.test(normalizedQuery)) {
    warnings.push("Query does not explicitly target Log events.");
  }

  return {
    valid: true,
    normalizedQuery: normalizeQuery(normalizedQuery),
    warnings,
    accountContext: {
      accountId: client.accountId,
      authMode: client.authMode,
    },
  };
}

const server = new Server(
  {
    name: "newrelic-lite-logs-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_logs",
      description: "Run a read-only NRQL query for logs with time bounds and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
          pageToken: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_error_logs",
      description: "Fetch recent error logs with optional service filter.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          serviceName: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
          pageToken: { type: "string" },
        },
      },
    },
    {
      name: "summarize_log_patterns",
      description: "Summarize top error patterns by service and message.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: 200 },
        },
      },
    },
    {
      name: "discover_infra_context",
      description: "Discover infra context from logs and write a draft context artifact.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
          outputPath: { type: "string" },
        },
      },
    },
    {
      name: "discover_log_schema",
      description: "Inspect available recent log fields, likely service/environment fields, and common values.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
        },
      },
    },
    {
      name: "get_account_context",
      description: "Show the current New Relic account context and whether recent logs exist in the selected window.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
        },
      },
    },
    {
      name: "build_memory_bank",
      description:
        "Discover all log event types, their schemas, custom fields, and sample values in this New Relic account, then write a persistent local context file. " +
        "Run this once (or whenever infrastructure changes) so that subsequent queries use the correct table names and field names. " +
        "The file is stored at NR_MEMORY_BANK_PATH or ~/.newrelic-mcp/context.json.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number", description: "Override the default account ID." },
        },
      },
    },
    {
      name: "get_memory_bank",
      description:
        "Read the locally cached New Relic context file built by build_memory_bank. " +
        "Useful for debugging or inspecting discovered table/field mappings. " +
        "If the file does not exist yet, this tool will tell you to run build_memory_bank first.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "dry_run_query",
      description: "Validate and normalize a read-only NRQL query without execution.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "search_logs") {
      const parsed = searchLogsSchema.parse(args ?? {});
      const result = await executeQuery(parsed.query, parsed);
      return textResult(result);
    }

    if (name === "get_error_logs") {
      const parsed = getErrorLogsSchema.parse(args ?? {});
      const serviceFilter = parsed.serviceName ? ` AND (service.name = '${parsed.serviceName}' OR entity.name = '${parsed.serviceName}')` : "";
      const query = `SELECT timestamp, severity, message, service.name, entity.name, trace.id, span.id FROM Log WHERE (severity = 'ERROR' OR level = 'error' OR message LIKE '%error%')${serviceFilter} ORDER BY timestamp DESC`;
      const result = await executeQuery(query, parsed);
      return textResult(result);
    }

    if (name === "summarize_log_patterns") {
      const parsed = summarizePatternsSchema.parse(args ?? {});
      const query = "SELECT count(*) AS count FROM Log WHERE (severity = 'ERROR' OR level = 'error' OR message LIKE '%error%') FACET service.name, entity.name, message";
      const result = await executeQuery(query, {
        accountId: parsed.accountId,
        since: parsed.since,
        until: parsed.until,
        limit: parsed.limit ?? 50,
      });

      result.summary = `Top ${result.rows.length} error patterns across services.`;
      return textResult(result);
    }

    if (name === "discover_infra_context") {
      const parsed = discoverInfraSchema.parse(args ?? {});
      const infraContext = await discoverInfraContext(client, {
        accountId: parsed.accountId,
        since: parsed.since,
        until: parsed.until,
      });

      const outputPath = parsed.outputPath ?? "./infra_context.json";
      const absolutePath = path.resolve(outputPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, JSON.stringify(infraContext, null, 2), "utf8");

      return textResult({
        summary: `Discovered infra context and wrote ${absolutePath}.`,
        infraContext,
      });
    }

    if (name === "discover_log_schema") {
      const parsed = discoverLogSchemaSchema.parse(args ?? {});
      const result = await discoverLogSchema(client, parsed);
      return textResult(result);
    }

    if (name === "get_account_context") {
      const parsed = accountContextSchema.parse(args ?? {});
      const result = await getAccountContext(client, parsed);
      return textResult({
        summary: `Account ${result.accountId} has ${result.totalLogsInWindow} logs in the selected window.`,
        accountContext: result,
      });
    }

    if (name === "build_memory_bank") {
      const parsed = buildMemoryBankSchema.parse(args ?? {});
      const { bank, filePath } = await buildMemoryBank(client, { accountId: parsed.accountId });
      return textResult({
        summary: `Memory bank built for account ${bank.accountId}. Found ${bank.logTables.length} log table(s): ${bank.logTables.join(", ")}.`,
        filePath,
        primaryTable: bank.primaryTable,
        logTables: bank.logTables,
        globalCustomFields: bank.globalCustomFields,
        agentHint: bank.agentHint,
        tableSchemas: Object.fromEntries(
          Object.entries(bank.tables).map(([name, t]) => [
            name,
            {
              estimatedRows: t.estimatedRows,
              windowUsed: t.windowUsed,
              customFields: t.customFields,
              fieldSamples: t.fieldSamples,
              totalFields: t.fields.length,
            },
          ]),
        ),
      });
    }

    if (name === "get_memory_bank") {
      const bank = await readMemoryBank();
      if (!bank) {
        return textResult({
          found: false,
          filePath: getMemoryBankPath(),
          message: "No memory bank found. Call build_memory_bank first to discover your New Relic log table structure.",
        });
      }

      return textResult({
        found: true,
        filePath: getMemoryBankPath(),
        builtAt: bank.builtAt,
        accountId: bank.accountId,
        primaryTable: bank.primaryTable,
        logTables: bank.logTables,
        globalCustomFields: bank.globalCustomFields,
        agentHint: bank.agentHint,
        tableSchemas: Object.fromEntries(
          Object.entries(bank.tables).map(([name, t]) => [
            name,
            {
              estimatedRows: t.estimatedRows,
              windowUsed: t.windowUsed,
              customFields: t.customFields,
              fieldSamples: t.fieldSamples,
              totalFields: t.fields.length,
            },
          ]),
        ),
      });
    }

    if (name === "dry_run_query") {
      const parsed = dryRunSchema.parse(args ?? {});
      return textResult(await makeDryRun(parsed.query, parsed));
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const classified = classifyError(error);
    return textResult({
      error: {
        type: classified.type,
        message: classified.message,
      },
    });
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Avoid leaking details to stdout because MCP requires structured responses.
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
});
