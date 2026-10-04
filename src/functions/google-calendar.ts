/**
 * Google Calendar tool functions — read-only (calendar.readonly scope).
 */

import { getValidAccessToken } from './google-auth';

const CAL_API = 'https://www.googleapis.com/calendar/v3';

async function calFetch(path: string): Promise<unknown> {
  const token = await getValidAccessToken();
  const res = await fetch(CAL_API + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
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
