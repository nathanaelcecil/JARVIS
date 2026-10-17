/**
 * Gmail tool functions — read-only (gmail.readonly scope).
 * All functions use the Gmail REST API via getValidAccessToken().
 */

import { getValidAccessToken } from './google-auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

async function gmailFetch(
  path: string,
  options?: { method?: string; body?: unknown; scopes?: string[] }
): Promise<unknown> {
  const token = await getValidAccessToken(options?.scopes);
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
  const init: RequestInit = { method: options?.method ?? 'GET', headers };
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(GMAIL_API + path, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Gmail API error (' + res.status + '): ' + err);
  }
  if (res.status === 204) return null;
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

/** RFC822 lines → base64url payload for users/me/messages/send. */
function encodeRawMessage(lines: string[]): string {
  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url');
}

async function gmailSendRaw(payload: {
  raw: string;
  threadId?: string;
}): Promise<{ id: string; threadId: string; sent: true }> {
  const data = (await gmailFetch('/users/me/messages/send', {
    method: 'POST',
    body: payload,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
  })) as { id?: string; threadId?: string };
  if (!data?.id) {
    throw new Error(
      'Gmail did not confirm the message was sent: ' + JSON.stringify(data ?? null).slice(0, 200)
    );
  }
  return { id: data.id, threadId: data.threadId ?? '', sent: true };
}

/**
 * Reject names like "Alice" — the model sometimes passes a display name
 * alone, which would produce an undeliverable message. Requires a full
 * address (something@something.tld).
 */
function requireRecipient(value: string | undefined, what: string): string {
  const v = (value ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error(
      `A valid recipient email address is required for ${what} (got "${v || 'empty'}") — use a full address like bob@example.com; a name alone will not work.`
    );
  }
  return v;
}

/** Send a brand-new email. Confirm-tier. */
export async function gmailSendEmail(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ id: string; threadId: string; sent: true; to: string }> {
  const to = requireRecipient(params.to, '"to"');
  if (!params.subject?.trim() && !params.body?.trim()) {
    throw new Error('An email needs a subject or a body.');
  }
  const raw = encodeRawMessage([
    'To: ' + to,
    'Subject: ' + (params.subject ?? '').replace(/[\r\n]/g, ' '),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body ?? '',
  ]);
  const res = await gmailSendRaw({ raw });
  return { ...res, to };
}

/** Reply to a message in its thread. Confirm-tier. */
export async function gmailReplyEmail(params: {
  messageId: string;
  body: string;
  to?: string;
}): Promise<{ id: string; threadId: string; sent: true; to: string }> {
  if (!params.messageId) throw new Error('messageId is required to reply to an email.');
  if (!params.body?.trim()) throw new Error('A reply body is required.');

  const detail = (await gmailFetch(
    '/users/me/messages/' +
      params.messageId +
      '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=References'
  )) as {
    threadId?: string;
    payload?: { headers?: { name: string; value: string }[] };
  };
  const headers = detail.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const inReplyTo = getHeader('Message-ID');
  const from = getHeader('From');
  const addrMatch = from.match(/<([^>]+)>/);
  const to = requireRecipient(
    params.to?.trim() || (addrMatch && addrMatch[1] ? addrMatch[1].trim() : from),
    'the reply recipient'
  );
  const subject = getHeader('Subject');
  const reSubject = /^re:\s/i.test(subject) ? subject : 'Re: ' + subject;

  const raw = encodeRawMessage([
    'To: ' + to,
    'Subject: ' + reSubject.replace(/[\r\n]/g, ' '),
    ...(inReplyTo ? ['In-Reply-To: ' + inReplyTo] : []),
    ...(inReplyTo ? ['References: ' + [getHeader('References'), inReplyTo].filter(Boolean).join(' ')] : []),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body,
  ]);
  const res = await gmailSendRaw({
    raw,
    ...(detail.threadId ? { threadId: detail.threadId } : {}),
  });
  return { ...res, to };
}

/** Forward a message to someone new. Confirm-tier. */
export async function gmailForwardEmail(params: {
  messageId: string;
  to: string;
  note?: string;
}): Promise<{ id: string; threadId: string; sent: true; to: string }> {
  if (!params.messageId) throw new Error('messageId is required to forward an email.');
  const to = requireRecipient(params.to, '"to"');

  const original = await gmailRead({ messageId: params.messageId });
  const subject = /^fwd:/i.test(original.subject) ? original.subject : 'Fwd: ' + original.subject;
  const quoted = [
    params.note?.trim() ?? '',
    params.note?.trim() ? '' : null,
    '---------- Forwarded message ----------',
    'From: ' + original.from,
    'Date: ' + original.date,
    'Subject: ' + original.subject,
    'To: ' + original.to,
    '',
    original.body,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const raw = encodeRawMessage([
    'To: ' + to,
    'Subject: ' + subject.replace(/[\r\n]/g, ' '),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    quoted,
  ]);
  const res = await gmailSendRaw({ raw });
  return { ...res, to };
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
