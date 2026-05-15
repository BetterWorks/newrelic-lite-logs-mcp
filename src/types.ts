export type AuthMode = "api_key_only" | "cookie";

export interface AccountContext {
  accountId: number;
  authMode: AuthMode;
  totalLogsInWindow: number;
  latestLogTimestamp: string | number | null;
  since?: string;
  until?: string;
}

export interface FieldMapping {
  service?: string;
  environment?: string;
  region?: string;
  cluster?: string;
  pod?: string;
  host?: string;
}

export interface ZeroResultDiagnostics {
  probableCause: string;
  missingFields: string[];
  availableFieldSample: string[];
  suggestions: string[];
}

export interface SchemaDiscoveryResult {
  summary: string;
  accountContext: AccountContext;
  availableFields: string[];
  fieldMapping: FieldMapping;
  topValues: Record<string, string[]>;
  suggestions: string[];
}

export interface QueryMeta {
  durationMs: number;
  rowsReturned: number;
  capped: boolean;
  redactionCount: number;
  nextPageToken?: string;
  accountId: number;
  authMode: AuthMode;
}

export interface QueryResult {
  summary: string;
  rows: Array<Record<string, unknown>>;
  meta: QueryMeta;
  query: string;
  accountContext: AccountContext;
  diagnostics?: ZeroResultDiagnostics;
}

export interface DryRunResult {
  valid: boolean;
  normalizedQuery: string;
  warnings: string[];
  accountContext: Pick<AccountContext, "accountId" | "authMode">;
}

export interface InfraContext {
  generatedAt: string;
  accountId: number;
  services: string[];
  hosts: string[];
  clusters: string[];
  environments: string[];
  regions: string[];
  pods: string[];
  fieldMapping: FieldMapping;
  source: string;
}

export interface MemoryBankTable {
  name: string;
  /** All field names from keyset(). */
  fields: string[];
  /** Fields that are not standard New Relic log fields. */
  customFields: string[];
  /** Top values sampled for each interesting custom field. */
  fieldSamples: Record<string, string[]>;
  /** Approximate row count over the discovery window. */
  estimatedRows: number;
  /** SINCE clause used during discovery. */
  windowUsed: string;
  latestTimestamp: string | null;
  earliestTimestamp: string | null;
}

export interface MemoryBank {
  version: "1";
  builtAt: string;
  accountId: number;
  authMode: AuthMode;
  /** All discovered log-like event type names. */
  logTables: string[];
  /** Table with the most data — the default target for queries. */
  primaryTable: string;
  tables: Record<string, MemoryBankTable>;
  /** Custom fields that appear across one or more tables. */
  globalCustomFields: string[];
  /** Human-readable summary the AI agent should read before constructing queries. */
  agentHint: string;
}
