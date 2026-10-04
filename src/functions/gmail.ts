/**
 * Gmail tool functions — read-only (gmail.readonly scope).
 * All functions use the Gmail REST API via getValidAccessToken().
 */

import { getValidAccessToken } from './google-auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

async function gmailFetch(path: string): Promise<unknown> {
  const token = await getValidAccessToken();
  const res = await fetch(GMAIL_API + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Gmail API error (' + res.status + '): ' + err);
  }
  return res.json();
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  isUnread: boolean;
}

/**
 * Search Gmail messages by query string.
 */
export async function gmailSearch(params: {
  query: string;
  maxResults?: number;
}): Promise<{ messages: GmailMessage[]; totalEstimate: number }> {
  const max = params.maxResults ?? 10;
  const data = (await gmailFetch(
    '/users/me/messages?q=' + encodeURIComponent(params.query) + '&maxResults=' + max
  )) as { messages?: { id: string }[]; resultSizeEstimate?: number };

  if (!data.messages || data.messages.length === 0) {
    return { messages: [], totalEstimate: 0 };
  }

  // Fetch each message's metadata
  const messages: GmailMessage[] = [];
  for (const msg of data.messages) {
    const detail = (await gmailFetch(
      '/users/me/messages/' + msg.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date'
    )) as {
      id: string;
      threadId: string;
      snippet: string;
      labelIds?: string[];
      payload?: { headers?: { name: string; value: string }[] };
    };

    const headers = detail.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name === name)?.value ?? '';

    messages.push({
      id: detail.id,
      threadId: detail.threadId,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      date: getHeader('Date'),
      snippet: detail.snippet,
      isUnread: detail.labelIds?.includes('UNREAD') ?? false,
    });
  }

  return { messages, totalEstimate: data.resultSizeEstimate ?? messages.length };
}

/**
 * Read a specific Gmail message by ID.
 */
export async function gmailRead(params: {
  messageId: string;
}): Promise<{
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  snippet: string;
}> {
  const detail = (await gmailFetch(
    '/users/me/messages/' + params.messageId + '?format=full'
  )) as {
    payload?: {
      headers?: { name: string; value: string }[];
      body?: { data?: string };
      parts?: { mimeType: string; body?: { data?: string } }[];
    };
    snippet: string;
  };

  const headers = detail.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? '';

  // Extract body (prefer text/plain, fallback to text/html stripped)
  let body = '';
  if (detail.payload?.body?.data) {
    body = Buffer.from(detail.payload.body.data, 'base64url').toString('utf-8');
  } else if (detail.payload?.parts) {
    const textPart = detail.payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
  }

  return {
    subject: getHeader('Subject'),
    from: getHeader('From'),
    to: getHeader('To'),
    date: getHeader('Date'),
    body,
    snippet: detail.snippet,
  };
}

/**
 * List recent messages (convenience wrapper around search).
 */
export async function gmailListRecent(params?: {
  maxResults?: number;
  query?: string;
}): Promise<{ messages: GmailMessage[] }> {
  const query = params?.query ?? 'in:inbox';
  const result = await gmailSearch({ query, maxResults: params?.maxResults ?? 10 });
  return { messages: result.messages };
}
