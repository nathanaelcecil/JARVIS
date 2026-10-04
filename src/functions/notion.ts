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

export interface NotionPageContent {
  id: string;
  title: string;
  content: string;
  url: string;
}

export async function notionReadPage(params: {
  pageId: string;
}): Promise<NotionPageContent> {
  const page = await notionFetch('/pages/' + params.pageId);

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

  const blocks = await notionFetch('/blocks/' + params.pageId + '/children?page_size=100');
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

export async function notionCreatePage(params: {
  parent: Record<string, string>;
  properties: Record<string, unknown>;
  children?: Array<Record<string, unknown>>;
}): Promise<{ id: string; url: string }> {
  const data = await notionFetch('/pages', {
    method: 'POST',
    body: params as unknown as Record<string, unknown>,
  });
  return { id: data["id"] as string, url: (data["url"] as string) ?? '' };
}

export async function notionUpdatePage(params: {
  pageId: string;
  properties: Record<string, unknown>;
}): Promise<{ id: string; url: string }> {
  const data = await notionFetch('/pages/' + params.pageId, {
    method: 'PATCH',
    body: { properties: params.properties },
  });
  return { id: data["id"] as string, url: (data["url"] as string) ?? '' };
}

export async function notionArchivePage(params: {
  pageId: string;
}): Promise<{ id: string; archived: boolean }> {
  const data = await notionFetch('/pages/' + params.pageId, {
    method: 'PATCH',
    body: { archived: true },
  });
  return { id: data["id"] as string, archived: (data["archived"] as boolean) ?? true };
}
