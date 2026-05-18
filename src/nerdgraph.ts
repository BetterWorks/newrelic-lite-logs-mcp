import type { NewRelicClient } from "./newrelic.js";

export interface NrEntity {
  guid: string;
  name: string;
  entityType: string;
  domain: string;
  accountId: number;
  permalink: string | null;
}

export interface SearchEntitiesOptions {
  name?: string;
  type?: string;
  domain?: string;
  accountId?: number;
  limit?: number;
}

const ENTITY_SEARCH_DOCUMENT = `
  query SearchEntities($q: String!, $limit: Int) {
    actor {
      entitySearch(query: $q, options: { limit: $limit }) {
        results {
          entities {
            guid
            name
            entityType
            domain
            accountId
            permalink
          }
        }
      }
    }
  }
`.trim();

function buildEntitySearchQuery(options: SearchEntitiesOptions): string {
  const parts: string[] = [];

  if (options.name) {
    const safe = options.name.replace(/'/g, "''").slice(0, 200);
    parts.push(`name LIKE '%${safe}%'`);
  }

  if (options.type) {
    const safe = options.type.replace(/'/g, "''").slice(0, 50);
    parts.push(`type = '${safe}'`);
  }

  if (options.domain) {
    const safe = options.domain.replace(/'/g, "''").slice(0, 50);
    parts.push(`domain = '${safe}'`);
  }

  if (options.accountId) {
    parts.push(`accountId = ${options.accountId}`);
  }

  if (parts.length === 0) {
    throw new Error("At least one search parameter is required: name, type, domain, or accountId.");
  }

  return parts.join(" AND ");
}

type EntitySearchResponse = {
  actor: {
    entitySearch: {
      results: {
        entities: Array<{
          guid: string;
          name: string;
          entityType: string;
          domain: string;
          accountId: number;
          permalink: string | null;
        }>;
      };
    };
  };
};

export async function searchEntities(
  client: NewRelicClient,
  options: SearchEntitiesOptions,
): Promise<NrEntity[]> {
  const q = buildEntitySearchQuery(options);
  const limit = Math.min(options.limit ?? 25, 200);

  const data = await client.runNerdGraph<EntitySearchResponse>(ENTITY_SEARCH_DOCUMENT, { q, limit });

  return data?.actor?.entitySearch?.results?.entities ?? [];
}
