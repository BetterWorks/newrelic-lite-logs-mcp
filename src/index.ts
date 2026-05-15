#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildZeroResultDiagnostics, getAccountContext } from "./log-discovery.js";
import { buildMemoryBank, readMemoryBank } from "./memory-bank.js";
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

const dryRunSchema = z.object({
  query: z.string().min(1),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

const buildMemoryBankSchema = z.object({
  accountId: z.number().int().positive().optional(),
  localRepositoryName: z.string().min(1).optional(),
  environments: z.array(z.string().min(1)).max(30).optional(),
  serviceMappings: z.array(
    z.object({
      localService: z.string().min(1),
      infraService: z.string().min(1).optional(),
      pods: z.array(z.string().min(1)).max(50).optional(),
      containers: z.array(z.string().min(1)).max(50).optional(),
      notes: z.string().optional(),
    }),
  ).max(300).optional(),
  clarifications: z.array(z.string().min(1)).max(100).optional(),
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

function compactUnique(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
      warnings.push("Query does not target any known log table. Rebuild or inspect ./.newrelic/memory-bank.json.");
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
      name: "build_memory_bank",
      description:
        "Build a one-time, repo-committable New Relic memory bank with infra context, log tables, log schemas, custom fields, and field samples. " +
        "Before calling this tool, ask the user clarifying questions and pass them via localRepositoryName, environments, serviceMappings, and clarifications. " +
        "The output must remain concise, deterministic, and machine-readable for efficient context-window usage. " +
        "The file is stored at NR_MEMORY_BANK_PATH or ./.newrelic/memory-bank.json.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number", description: "Override the default account ID." },
          localRepositoryName: {
            type: "string",
            description: "Local repository or service group name (for example: engage-api).",
          },
          environments: {
            type: "array",
            items: { type: "string" },
            description: "Environment names relevant to this repo (for example: prod-us, prod-eu, stage).",
          },
          serviceMappings: {
            type: "array",
            description: "Mapping between local repo services and infra service/pod/container identities.",
            items: {
              type: "object",
              properties: {
                localService: { type: "string" },
                infraService: { type: "string" },
                pods: { type: "array", items: { type: "string" } },
                containers: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
              },
              required: ["localService"],
            },
          },
          clarifications: {
            type: "array",
            items: { type: "string" },
            description: "Any additional human clarifications that should be persisted in short bullet form.",
          },
        },
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

    if (name === "build_memory_bank") {
      const parsed = buildMemoryBankSchema.parse(args ?? {});
      const { bank, filePath } = await buildMemoryBank(client, {
        accountId: parsed.accountId,
        localRepositoryName: parsed.localRepositoryName,
        environments: compactUnique(parsed.environments),
        serviceMappings: (parsed.serviceMappings ?? []).map((mapping) => ({
          localService: mapping.localService.trim(),
          infraService: mapping.infraService?.trim(),
          pods: compactUnique(mapping.pods),
          containers: compactUnique(mapping.containers),
          notes: mapping.notes?.trim(),
        })),
        clarifications: compactUnique(parsed.clarifications),
      });
      return textResult({
        summary:
          `Memory bank built for account ${bank.accountId}. Found ${bank.logTables.length} log table(s): ${bank.logTables.join(", ")}. ` +
          "Use this repo file as the single source of truth for table, field, and service mapping context.",
        filePath,
        primaryTable: bank.primaryTable,
        logTables: bank.logTables,
        localRepositoryName: bank.repositoryContext.localRepositoryName,
        environments: bank.repositoryContext.environments,
        serviceMappings: bank.repositoryContext.serviceMappings,
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
