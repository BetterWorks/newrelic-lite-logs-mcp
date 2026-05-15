const DENIED_NRQL_PATTERNS = [
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bCREATE\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
];

const SENSITIVE_KEY_PATTERN = /(token|authorization|cookie|apikey|api_key|password|secret|session|email)/i;
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,}/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const COOKIE_PATTERN = /(cookie\s*[:=]\s*)([^;\n]+)/gi;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;

export function enforceReadOnlyQuery(query: string): void {
  for (const pattern of DENIED_NRQL_PATTERNS) {
    if (pattern.test(query)) {
      throw new Error("Query rejected: only read-only NRQL is allowed.");
    }
  }
}

export function ensureTimeBound(query: string, since?: string, until?: string): void {
  const hasInlineSince = /\bSINCE\b/i.test(query);
  const hasInlineUntil = /\bUNTIL\b/i.test(query);
  if (since || until || hasInlineSince || hasInlineUntil) {
    return;
  }

  throw new Error("Query rejected: provide at least one of since/until or include SINCE/UNTIL in NRQL.");
}

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function formatNrqlTime(value: string): string {
  const trimmed = value.trim();

  if (/^['"].*['"]$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  if (/^(now|today|yesterday|this\s+|last\s+|\d+\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago)/i.test(trimmed)) {
    return trimmed;
  }

  return `'${trimmed}'`;
}

export function injectWindowAndLimit(query: string, since?: string, until?: string, limit?: number): string {
  let q = normalizeQuery(query);

  if (since && !/\bSINCE\b/i.test(q)) {
    q = `${q} SINCE ${formatNrqlTime(since)}`;
  }

  if (until && !/\bUNTIL\b/i.test(q)) {
    q = `${q} UNTIL ${formatNrqlTime(until)}`;
  }

  if (typeof limit === "number") {
    if (/\bLIMIT\b\s+\d+/i.test(q)) {
      q = q.replace(/\bLIMIT\b\s+\d+/i, `LIMIT ${limit}`);
    } else {
      q = `${q} LIMIT ${limit}`;
    }
  }

  return q;
}

export function withOffset(query: string, offset: number): string {
  if (!offset) {
    return query;
  }

  if (/\bOFFSET\b\s+\d+/i.test(query)) {
    return query.replace(/\bOFFSET\b\s+\d+/i, `OFFSET ${offset}`);
  }

  return `${query} OFFSET ${offset}`;
}

export function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodePageToken(token?: string): number {
  if (!token) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { offset?: number };
    return typeof parsed.offset === "number" && parsed.offset > 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export function redactObject<T>(input: T): { redacted: T; redactionCount: number } {
  let redactionCount = 0;

  const redactString = (value: string): string => {
    let out = value;

    out = out.replace(BEARER_PATTERN, () => {
      redactionCount += 1;
      return "Bearer [REDACTED]";
    });

    out = out.replace(JWT_PATTERN, () => {
      redactionCount += 1;
      return "[REDACTED_JWT]";
    });

    out = out.replace(EMAIL_PATTERN, () => {
      redactionCount += 1;
      return "[REDACTED_EMAIL]";
    });

    out = out.replace(COOKIE_PATTERN, (_match, prefix: string) => {
      redactionCount += 1;
      return `${prefix}[REDACTED]`;
    });

    return out;
  };

  const visit = (value: unknown, keyHint?: string): unknown => {
    if (typeof value === "string") {
      if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
        redactionCount += 1;
        return "[REDACTED]";
      }

      return redactString(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = visit(v, k);
      }
      return out;
    }

    return value;
  };

  return { redacted: visit(input) as T, redactionCount };
}
