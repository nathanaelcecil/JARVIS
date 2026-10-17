/**
 * Notion tool functions — direct REST API calls.
 */

const NOTION_API_KEY = process.env['NOTION_API_KEY'] ?? '';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

if (!NOTION_API_KEY) {
  console.warn('[Notion] NOTION_API_KEY not set');
}

interface NotionFetchOptions {
  method?: string;
  body?: Record<string, unknown>;
}

async function notionFetch(path: string, options?: NotionFetchOptions): Promise<Record<string, unknown>> {
  if (!NOTION_API_KEY) throw new Error('Notion not configured');

  const fetchInit: RequestInit = {
    method: options?.method ?? 'GET',
    headers: {
      Authorization: 'Bearer ' + NOTION_API_KEY,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (options?.body) {
    fetchInit.body = JSON.stringify(options.body);
  }

  const res = await fetch(NOTION_API + path, fetchInit);

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 403 || res.status === 404) {
      throw new Error('Notion access denied — share the page with the JARVIS integration in Notion first');
    }
    throw new Error('Notion API error (' + res.status + '): ' + err);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export interface NotionSearchResult {
  id: string;
  title: string;
  type: string;
  url: string;
  lastEdited: string;
}

export async function notionSearch(params: {
  query: string;
  pageSize?: number;
}): Promise<{ results: NotionSearchResult[] }> {
  const data = await notionFetch('/search', {
    method: 'POST',
    body: { query: params.query, page_size: params.pageSize ?? 10 },
  });

  const rawResults = (data["results"] ?? []) as Array<Record<string, unknown>>;
  const results: NotionSearchResult[] = rawResults.map((r) => {
    let title = (r["title"] as string) ?? '';
    if (!title && r["properties"]) {
      const props = r["properties"] as Record<string, Record<string, unknown>>;
      const titleProp = props['title'] ?? props['Name'];
      if (titleProp?.["title"]) {
        const titleArr = titleProp["title"] as Array<Record<string, unknown>>;
        title = titleArr.map((t) => (t["plain_text"] as string) ?? '').join('');
      }
    }
    return {
      id: r["id"] as string,
      title: title || '(Untitled)',
      type: r["type"] as string,
      url: (r["url"] as string) ?? '',
      lastEdited: (r["last_edited_time"] as string) ?? '',
    };
  });

  return { results };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept either a page UUID or a human reference (title like "JARVIS TEST").
 * LLM callers routinely pass the page title instead of its id — resolve it
 * via search instead of sending a malformed id to the API.
 */
async function resolvePageId(ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const { results } = await notionSearch({ query: ref, pageSize: 10 });
  const normalized = ref.trim().toLowerCase();
  const hit =
    results.find((r) => r.title.trim().toLowerCase() === normalized) ??
    results[0];
  if (!hit) {
    throw new Error(
      `No Notion page found matching "${ref}". Run notion_search first and pass the page's id.`
    );
  }
  return hit.id;
}

/**
 * Same, for a database reference: the planner sometimes passes the database
 * title (or nothing usable) instead of its id. Prefers type "database".
 */
async function resolveDatabaseId(ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const { results } = await notionSearch({ query: ref, pageSize: 10 });
  const normalized = ref.trim().toLowerCase();
  const exact = results.filter((r) => r.title.trim().toLowerCase() === normalized);
  const hit =
    exact.find((r) => r.type === 'database') ??
    exact[0] ??
    results.find((r) => r.type === 'database') ??
    results[0];
  if (!hit) {
    throw new Error(
      `No Notion database found matching "${ref}". Run notion_search first and pass the database's id.`
    );
  }
  return hit.id;
}

export interface NotionPageContent {
  id: string;
  title: string;
  content: string;
  url: string;
}

export async function notionReadPage(params: {
  pageId: string;
}): Promise<NotionPageContent> {
  const pageId = await resolvePageId(params.pageId);
  const page = await notionFetch('/pages/' + pageId);

  let title = '';
  if (page["properties"]) {
    const props = page["properties"] as Record<string, Record<string, unknown>>;
    for (const prop of Object.values(props)) {
      if (prop["title"]) {
        const titleArr = prop["title"] as Array<Record<string, unknown>>;
        title = titleArr.map((t) => (t["plain_text"] as string) ?? '').join('');
        break;
      }
    }
  }

  const blocks = await notionFetch('/blocks/' + pageId + '/children?page_size=100');
  const rawBlocks = (blocks["results"] ?? []) as Array<Record<string, unknown>>;

  const content = rawBlocks.map((block) => {
    const type = block["type"] as string;
    const blockData = block[block["type"] as string] as Record<string, unknown> | undefined;
    const richText = blockData?.["rich_text"] as Array<Record<string, unknown>> | undefined;
    if (richText) {
      return richText.map((t) => (t["plain_text"] as string) ?? '').join('');
    }
    return '[' + type + ']';
  }).filter(Boolean).join('\n');

  return {
    id: page["id"] as string,
    title: title || '(Untitled)',
    content,
    url: (page["url"] as string) ?? '',
  };
}

export async function notionQueryDatabase(params: {
  databaseId: string;
  filter?: Record<string, unknown>;
  pageSize?: number;
}): Promise<{ results: Array<{ id: string; properties: Record<string, unknown>; url: string }> }> {
  const body: Record<string, unknown> = { page_size: params.pageSize ?? 20 };
  if (params.filter) {
    body['filter'] = params.filter;
  }

  const data = await notionFetch('/databases/' + params.databaseId + '/query', {
    method: 'POST',
    body,
  });

  const rawResults = (data["results"] ?? []) as Array<Record<string, unknown>>;
  return {
    results: rawResults.map((r) => ({
      id: r["id"] as string,
      properties: (r["properties"] as Record<string, unknown>) ?? {},
      url: (r["url"] as string) ?? '',
    })),
  };
}

const TEXT_LIMIT = 1900; // Notion caps a rich-text item at 2000 chars

function richText(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text: { content: text.slice(0, TEXT_LIMIT) } }];
}

/** Plain text → Notion blocks. "# " / "## " / "### " headings, "- " bullets, else paragraphs. */
function contentToBlocks(content: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    let type = 'paragraph';
    let text = line;
    if (line.startsWith('### ')) { type = 'heading_3'; text = line.slice(4); }
    else if (line.startsWith('## ')) { type = 'heading_2'; text = line.slice(3); }
    else if (line.startsWith('# ')) { type = 'heading_1'; text = line.slice(2); }
    else if (/^[-*] /.test(line)) { type = 'bulleted_list_item'; text = line.slice(2); }
    blocks.push({ object: 'block', type, [type]: { rich_text: richText(text) } });
    if (blocks.length >= 100) break; // Notion limit per request
  }
  return blocks;
}

/**
 * Create a page. Accepts either the simple shape
 *   { title, content?, parentPageId? | databaseId? }
 * or the raw Notion shape { parent, properties, children? }.
 * With no parent given, NOTION_DEFAULT_PARENT_PAGE_ID (env) is used.
 */
export async function notionCreatePage(params: {
  title?: string;
  content?: string;
  parentPageId?: string;
  databaseId?: string;
  parent?: Record<string, string>;
  properties?: Record<string, unknown>;
  children?: Array<Record<string, unknown>>;
}): Promise<{
  id: string;
  url: string;
  created: true;
  title: string;
  parentFallback?: string;
}> {
  const explicitDatabaseId = params.databaseId ?? params.parent?.['database_id'];
  const explicitPageId = params.parentPageId ?? params.parent?.['page_id'];

  // Callers (LLM planner) sometimes pass a page/database TITLE instead of an
  // id — resolve it through search rather than sending a malformed id.
  const databaseId = explicitDatabaseId
    ? await resolveDatabaseId(explicitDatabaseId)
    : undefined;
  const pageId = explicitPageId ? await resolvePageId(explicitPageId) : undefined;

  const envParent =
    !databaseId && !pageId
      ? process.env['NOTION_DEFAULT_PARENT_PAGE_ID']
      : undefined;
  const parentRef = databaseId ?? pageId ?? envParent;
  if (!parentRef) {
    throw new Error(
      'No Notion parent given. Provide parentPageId or databaseId, or set NOTION_DEFAULT_PARENT_PAGE_ID in .env.local.'
    );
  }
  const parent: Record<string, string> = databaseId
    ? { database_id: databaseId }
    : { page_id: parentRef };

  const title = params.title ?? '';
  const children =
    params.children ?? (params.content ? contentToBlocks(params.content) : undefined);

  const postPage = async (
    pageParent: Record<string, string>,
    dbId?: string
  ): Promise<Record<string, unknown>> => {
    let properties = params.properties;
    if (!properties) {
      if (!title) throw new Error('A title is required to create a Notion page.');
      if (dbId) {
        // A database page must set its own title column, whatever it is named.
        const db = await notionFetch('/databases/' + dbId);
        const props = (db['properties'] ?? {}) as Record<string, Record<string, unknown>>;
        const titleName =
          Object.entries(props).find(([, p]) => p['type'] === 'title')?.[0] ?? 'Name';
        properties = { [titleName]: { title: richText(title) } };
      } else {
        properties = { title: { title: richText(title) } };
      }
    }
    return notionFetch('/pages', {
      method: 'POST',
      body: {
        parent: pageParent,
        properties,
        ...(children && children.length > 0 ? { children } : {}),
      },
    });
  };

  // A planner can hallucinate a parent id (a plausible-looking fake UUID) or
  // name a page the integration cannot access; both surface as 403/404. When
  // an explicit parent was given and a default parent exists, retry there so
  // the write still lands somewhere real instead of failing with a
  // misleading "share the page" error.
  let data: Record<string, unknown>;
  let parentFallback: string | undefined;
  try {
    data = await postPage(parent, databaseId);
  } catch (err) {
    const defaultParent = process.env['NOTION_DEFAULT_PARENT_PAGE_ID'];
    const parentProblem =
      err instanceof Error && /Notion access denied/.test(err.message);
    const explicit = Boolean(explicitDatabaseId ?? explicitPageId);
    if (!parentProblem || !explicit || !defaultParent || defaultParent === parentRef) {
      throw err;
    }
    data = await postPage({ page_id: defaultParent });
    parentFallback =
      `The given Notion parent ("${explicitDatabaseId ?? explicitPageId}") was not accessible — ` +
      'created under the default parent page instead.';
  }

  if (data['object'] !== 'page' || typeof data['id'] !== 'string') {
    throw new Error('Notion did not confirm the page was created: ' + JSON.stringify(data).slice(0, 300));
  }
  return {
    id: data['id'],
    url: (data['url'] as string) ?? '',
    created: true,
    title,
    ...(parentFallback ? { parentFallback } : {}),
  };
}

/**
 * Append content blocks to the BOTTOM of an existing page.
 * Accepts simple { pageId, content } (plain text, "# " / "- " per line)
 * or raw Notion blocks via { pageId, children }.
 */
export async function notionAppendBlocks(params: {
  pageId: string;
  content?: string;
  children?: Array<Record<string, unknown>>;
}): Promise<{ pageId: string; appended: number }> {
  if (!params.pageId) {
    throw new Error("pageId is required to append blocks to a Notion page.");
  }
  const children =
    params.children ?? (params.content ? contentToBlocks(params.content) : []);
  if (children.length === 0) {
    throw new Error(
      "No content to append. Provide content (one block per line) or children."
    );
  }
  const pageId = await resolvePageId(params.pageId);
  const data = await notionFetch('/blocks/' + pageId + '/children', {
    method: 'PATCH',
    body: { children },
  });
  const results = (data["results"] ?? []) as unknown[];
  return { pageId, appended: results.length };
}

export async function notionUpdatePage(params: {
  pageId: string;
  properties: Record<string, unknown>;
}): Promise<{ id: string; url: string }> {
  const pageId = await resolvePageId(params.pageId);
  const data = await notionFetch('/pages/' + pageId, {
    method: 'PATCH',
    body: { properties: params.properties },
  });
  return { id: data["id"] as string, url: (data["url"] as string) ?? '' };
}

export async function notionArchivePage(params: {
  pageId: string;
}): Promise<{ id: string; archived: boolean }> {
  const pageId = await resolvePageId(params.pageId);
  const data = await notionFetch('/pages/' + pageId, {
    method: 'PATCH',
    body: { archived: true },
  });
  return { id: data["id"] as string, archived: (data["archived"] as boolean) ?? true };
}
