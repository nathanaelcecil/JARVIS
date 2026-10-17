/**
 * Google Calendar tool functions — read-only (calendar.readonly scope).
 */

import { getValidAccessToken } from './google-auth';

const CAL_API = 'https://www.googleapis.com/calendar/v3';

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

async function calFetch(
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
  const res = await fetch(CAL_API + path, init);
  if (res.status === 204) return null; // DELETE success has no body
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Calendar API error (' + res.status + '): ' + err);
  }
  return res.json();
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  location: string;
  htmlLink: string;
}

/**
 * List events from the primary calendar within a time range.
 */
export async function calendarListEvents(params: {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}): Promise<{ events: CalendarEvent[] }> {
  const now = new Date();
  const timeMin = params.timeMin ?? new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const timeMax = params.timeMax ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const max = params.maxResults ?? 20;

  const data = (await calFetch(
    '/calendars/primary/events?timeMin=' + encodeURIComponent(timeMin) +
    '&timeMax=' + encodeURIComponent(timeMax) +
    '&maxResults=' + max +
    '&singleEvents=true&orderBy=startTime'
  )) as { items?: Array<{
    id: string;
    summary?: string;
    description?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    htmlLink?: string;
  }> };

  const events: CalendarEvent[] = (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? '(No title)',
    description: e.description ?? '',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    location: e.location ?? '',
    htmlLink: e.htmlLink ?? '',
  }));

  return { events };
}

/**
 * Search events by text query.
 */
export async function calendarSearchEvents(params: {
  query: string;
  timeMin?: string;
  timeMax?: string;
}): Promise<{ events: CalendarEvent[] }> {
  const now = new Date();
  const timeMin = params.timeMin ?? now.toISOString();
  const timeMax = params.timeMax ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const data = (await calFetch(
    '/calendars/primary/events?q=' + encodeURIComponent(params.query) +
    '&timeMin=' + encodeURIComponent(timeMin) +
    '&timeMax=' + encodeURIComponent(timeMax) +
    '&singleEvents=true&orderBy=startTime'
  )) as { items?: Array<{
    id: string;
    summary?: string;
    description?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    htmlLink?: string;
  }> };

  const events: CalendarEvent[] = (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? '(No title)',
    description: e.description ?? '',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    location: e.location ?? '',
    htmlLink: e.htmlLink ?? '',
  }));

  return { events };
}

// ─── Writes (calendar.events scope, confirm-tier) ────────────────────────

/** Create an event. `end` defaults to start + 30 minutes. */
export async function calendarCreateEvent(params: {
  summary: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  timeZone?: string;
}): Promise<{ id: string; htmlLink: string; summary: string; start: string; created: true }> {
  if (!params.summary?.trim()) throw new Error('An event needs a summary (title).');
  if (!params.start) throw new Error('An event needs a start time (ISO 8601).');

  let endDateTime = params.end;
  if (!endDateTime) {
    const startMs = new Date(params.start).getTime();
    if (Number.isNaN(startMs)) {
      throw new Error('Could not parse the start time — provide an ISO 8601 time and an end.');
    }
    endDateTime = new Date(startMs + 30 * 60 * 1000).toISOString();
  }

  const start: Record<string, string> = { dateTime: params.start };
  const end: Record<string, string> = { dateTime: endDateTime };
  if (params.timeZone) {
    start['timeZone'] = params.timeZone;
    end['timeZone'] = params.timeZone;
  }

  const body: Record<string, unknown> = { summary: params.summary, start, end };
  if (params.description) body['description'] = params.description;
  if (params.location) body['location'] = params.location;

  const data = (await calFetch('/calendars/primary/events', {
    method: 'POST',
    body,
    scopes: [EVENTS_SCOPE],
  })) as { id?: string; htmlLink?: string; summary?: string; start?: { dateTime?: string } };
  if (!data?.id) {
    throw new Error(
      'Calendar did not confirm the event was created: ' + JSON.stringify(data ?? null).slice(0, 200)
    );
  }
  return {
    id: data.id,
    htmlLink: data.htmlLink ?? '',
    summary: data.summary ?? params.summary,
    start: data.start?.dateTime ?? params.start,
    created: true,
  };
}

/** Update fields of an existing event — only the fields you pass change. */
export async function calendarUpdateEvent(params: {
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  timeZone?: string;
}): Promise<{ id: string; summary: string; updated: true }> {
  if (!params.eventId) throw new Error('eventId is required to update a calendar event.');

  const body: Record<string, unknown> = {};
  if (params.summary !== undefined) body['summary'] = params.summary;
  if (params.description !== undefined) body['description'] = params.description;
  if (params.location !== undefined) body['location'] = params.location;
  if (params.start !== undefined) {
    body['start'] = {
      dateTime: params.start,
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
    };
  }
  if (params.end !== undefined) {
    body['end'] = {
      dateTime: params.end,
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
    };
  }
  if (Object.keys(body).length === 0) {
    throw new Error('No fields to update. Provide at least one of summary/start/end/description/location.');
  }

  const data = (await calFetch('/calendars/primary/events/' + params.eventId, {
    method: 'PATCH',
    body,
    scopes: [EVENTS_SCOPE],
  })) as { id?: string; summary?: string };
  if (!data?.id) {
    throw new Error(
      'Calendar did not confirm the update: ' + JSON.stringify(data ?? null).slice(0, 200)
    );
  }
  return { id: data.id, summary: data.summary ?? params.summary ?? '', updated: true };
}

/** Delete an event. Permanent — confirm-tier. */
export async function calendarDeleteEvent(params: {
  eventId: string;
}): Promise<{ id: string; deleted: true }> {
  if (!params.eventId) throw new Error('eventId is required to delete a calendar event.');
  await calFetch('/calendars/primary/events/' + params.eventId, {
    method: 'DELETE',
    scopes: [EVENTS_SCOPE],
  });
  return { id: params.eventId, deleted: true };
}
