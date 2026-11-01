/**
 * Recurrence parsing and next-run arithmetic for routines.
 *
 * The grammar is deliberately small and explicit — the model is told exactly
 * what is accepted, and anything else is refused with a message that lists the
 * accepted forms. Atticus accepts free-form phrases and relies on the model to
 * normalise them; here the normalisation is a parser with tests, so a routine
 * can never be stored with a schedule nobody can predict.
 *
 * Accepted:
 *   every 15 minutes | every 30 mins | every 2 hours | every hour
 *   every day at 8 | daily at 08:30 | every weekday at 9am
 *   every monday at 9 | every friday at 17:30
 */

export type Recurrence =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; weekdaysOnly: boolean }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export type ParseResult = { ok: true; recurrence: Recurrence } | { ok: false; error: string };

export const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;

const USAGE =
  'Use "every 30 minutes", "every 2 hours", "every day at 08:30", "every weekday at 9am" or "every monday at 9".';

function parseClock(
  hourText: string,
  minuteText: string | undefined,
  meridiem: string | undefined,
): { hour: number; minute: number } | null {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  const suffix = meridiem?.toLowerCase();
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

/** Parse a human schedule phrase into a Recurrence, or explain why not. */
export function parseRecurrence(input: string): ParseResult {
  if (typeof input !== "string") {
    return { ok: false, error: `a schedule is required. ${USAGE}` };
  }
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");

  const interval = /^every (\d{1,4}) ?(minutes?|mins?|hours?|hrs?)$/.exec(text);
  if (interval) {
    const amount = Number(interval[1]);
    const minutes = /^h/.test(interval[2]!) ? amount * 60 : amount;
    if (minutes < MIN_INTERVAL_MINUTES) {
      return { ok: false, error: `the shortest interval is ${MIN_INTERVAL_MINUTES} minutes` };
    }
    if (minutes > MAX_INTERVAL_MINUTES) {
      return { ok: false, error: "the longest interval is 24 hours" };
    }
    return { ok: true, recurrence: { kind: "interval", minutes } };
  }

  if (text === "every hour" || text === "hourly") {
    return { ok: true, recurrence: { kind: "interval", minutes: 60 } };
  }

  const clock = /(\d{1,2})(?::(\d{2}))? ?(am|pm)?/;

  const daily = /^every day at (.+)$/.exec(text) ?? /^daily at (.+)$/.exec(text);
  if (daily) {
    const m = clock.exec(daily[1]!);
    const parsed = m ? parseClock(m[1]!, m[2], m[3]) : null;
    if (!parsed) return { ok: false, error: `could not read the time in "${input}". ${USAGE}` };
    return {
      ok: true,
      recurrence: { kind: "daily", hour: parsed.hour, minute: parsed.minute, weekdaysOnly: false },
    };
  }

  const weekday = /^every ?weekdays? at (.+)$/.exec(text);
  if (weekday) {
    const m = clock.exec(weekday[1]!);
    const parsed = m ? parseClock(m[1]!, m[2], m[3]) : null;
    if (!parsed) return { ok: false, error: `could not read the time in "${input}". ${USAGE}` };
    return {
      ok: true,
      recurrence: { kind: "daily", hour: parsed.hour, minute: parsed.minute, weekdaysOnly: true },
    };
  }

  const weekly = /^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (.+)$/.exec(
    text,
  );
  if (weekly) {
    const m = clock.exec(weekly[2]!);
    const parsed = m ? parseClock(m[1]!, m[2], m[3]) : null;
    if (!parsed) return { ok: false, error: `could not read the time in "${input}". ${USAGE}` };
    const index = WEEKDAY_NAMES.indexOf(weekly[1] as (typeof WEEKDAY_NAMES)[number]);
    return {
      ok: true,
      recurrence: {
        kind: "weekly",
        weekday: index,
        hour: parsed.hour,
        minute: parsed.minute,
      },
    };
  }

  return { ok: false, error: `could not read "${input}" as a schedule. ${USAGE}` };
}

function atClock(day: Date, hour: number, minute: number): Date {
  const copy = new Date(day.getTime());
  copy.setHours(hour, minute, 0, 0);
  return copy;
}

/** The next time this recurrence should fire, strictly after `from`. */
export function nextRunAt(recurrence: Recurrence, from: Date = new Date()): Date {
  if (recurrence.kind === "interval") {
    return new Date(from.getTime() + recurrence.minutes * 60_000);
  }

  if (recurrence.kind === "daily") {
    let candidate = atClock(from, recurrence.hour, recurrence.minute);
    if (candidate.getTime() <= from.getTime()) {
      candidate = new Date(candidate.getTime());
      candidate.setDate(candidate.getDate() + 1);
    }
    if (recurrence.weekdaysOnly) {
      // Saturday/Sunday do not count: walk forward to Monday.
      while (candidate.getDay() === 0 || candidate.getDay() === 6) {
        candidate = new Date(candidate.getTime());
        candidate.setDate(candidate.getDate() + 1);
        candidate = atClock(candidate, recurrence.hour, recurrence.minute);
      }
    }
    return candidate;
  }

  // Weekly: consider today, then the next six days.
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(from.getTime());
    day.setDate(day.getDate() + offset);
    if (day.getDay() !== recurrence.weekday) continue;
    const candidate = atClock(day, recurrence.hour, recurrence.minute);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable for a valid weekday, but keep the contract total.
  const fallback = new Date(from.getTime() + 7 * 24 * 60 * 60_000);
  return atClock(fallback, recurrence.hour, recurrence.minute);
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** A short human description, used in confirmations and routine lists. */
export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.kind === "interval") {
    if (recurrence.minutes < 60) return `every ${recurrence.minutes} minutes`;
    if (recurrence.minutes === 60) return "every hour";
    if (recurrence.minutes % 60 === 0) return `every ${recurrence.minutes / 60} hours`;
    return `every ${recurrence.minutes} minutes`;
  }
  const time = `${two(recurrence.hour)}:${two(recurrence.minute)}`;
  if (recurrence.kind === "daily") {
    return `${recurrence.weekdaysOnly ? "every weekday" : "every day"} at ${time}`;
  }
  return `every ${WEEKDAY_NAMES[recurrence.weekday]} at ${time}`;
}
