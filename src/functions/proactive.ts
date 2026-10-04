/**
 * Proactive JARVIS: server-side functions for schedules and initiative messages.
 *
 * Plain async functions (not createServerFn) so they can be called both from
 * the server-side tool dispatch (registry.ts) and from the /api/proactive route.
 *
 * Tables (supabase/migrations/003_proactive.sql):
 * - proactive_schedules: what should fire and when (reminder / checkin / task)
 * - proactive_messages:  produced messages waiting for frontend delivery
 */

import { supabaseAdmin } from "../lib/supabase-server";

export interface ProactiveSchedule {
  id: string;
  kind: "reminder" | "checkin" | "task";
  message: string;
  fire_at: string | null;
  time_of_day: string | null;
  recurring: string | null;
  session_id: string | null;
  job_id: string | null;
  status: "active" | "fired" | "cancelled";
  last_fired_at: string | null;
  created_at: string;
}

export interface ProactiveMessage {
  id: string;
  schedule_id: string | null;
  kind: "reminder" | "checkin" | "task";
  content: string;
  session_id: string | null;
  status: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
}

/** Schedule a proactive message (one-time, delayed, or daily recurring). */
export async function scheduleReminder(params: {
  message: string;
  fireAt?: string;
  delayMinutes?: number;
  recurring?: string;
  kind?: "reminder" | "checkin" | "task";
  sessionId?: string;
  jobId?: string;
}): Promise<{ id: string; fireAt: string | null; recurring: string | null }> {
  const message = params.message.trim();
  if (!message) throw new Error("schedule_reminder: message must not be empty");

  let fireAt: string | null = null;
  if (params.fireAt) {
    const d = new Date(params.fireAt);
    if (isNaN(d.getTime())) {
      throw new Error(`schedule_reminder: invalid fireAt: ${params.fireAt}`);
    }
    fireAt = d.toISOString();
  } else if (typeof params.delayMinutes === "number") {
    fireAt = new Date(Date.now() + params.delayMinutes * 60_000).toISOString();
  }

  const recurring =
    params.recurring && params.recurring.toLowerCase() === "daily"
      ? "daily"
      : null;

  if (!fireAt && !recurring && params.kind !== "checkin") {
    throw new Error(
      "schedule_reminder: provide fireAt, delayMinutes, or recurring: \"daily\""
    );
  }

  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .insert({
      kind: params.kind ?? "reminder",
      message,
      fire_at: fireAt,
      recurring,
      session_id: params.sessionId ?? null,
      job_id: params.jobId ?? null,
      status: "active",
    })
    .select("id, fire_at, recurring")
    .single();

  if (error) throw new Error(`schedule_reminder failed: ${error.message}`);
  return { id: data.id as string, fireAt: data.fire_at, recurring: data.recurring };
}

/** Cancel a scheduled proactive message by id. */
export async function cancelReminder(params: {
  id: string;
}): Promise<{ id: string; cancelled: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .update({ status: "cancelled" })
    .eq("id", params.id)
    .eq("status", "active")
    .select("id");

  if (error) throw new Error(`cancel_reminder failed: ${error.message}`);
  return { id: params.id, cancelled: (data ?? []).length > 0 };
}

/** Change the daily check-in time (default 09:00). Voice-changeable. */
export async function setCheckinTime(params: {
  time: string;
}): Promise<{ time: string; scheduleId: string }> {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(params.time.trim());
  if (!m) {
    throw new Error(`set_checkin_time: expected HH:MM 24h time, got "${params.time}"`);
  }
  const timeOfDay = `${m[1]!.padStart(2, "0")}:${m[2]}`;

  // Upsert the single check-in schedule row
  const { data: existing } = await supabaseAdmin
    .from("proactive_schedules")
    .select("id")
    .eq("kind", "checkin")
    .eq("status", "active")
    .limit(1);

  const row = (existing ?? [])[0];
  if (row) {
    const { error } = await supabaseAdmin
      .from("proactive_schedules")
      .update({ time_of_day: timeOfDay, status: "active" })
      .eq("id", row.id);
    if (error) throw new Error(`set_checkin_time failed: ${error.message}`);
    return { time: timeOfDay, scheduleId: row.id as string };
  }

  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .insert({
      kind: "checkin",
      message:
        "Good morning, sir. You're up and running — anything you'd like to start with?",
      time_of_day: timeOfDay,
      recurring: "daily",
      status: "active",
    })
    .select("id")
    .single();
  if (error) throw new Error(`set_checkin_time failed: ${error.message}`);
  return { time: timeOfDay, scheduleId: data.id as string };
}

/** List all active scheduled proactive messages. */
export async function listReminders(): Promise<{
  schedules: Array<{
    id: string;
    kind: string;
    message: string;
    fireAt: string | null;
    timeOfDay: string | null;
    recurring: string | null;
  }>;
}> {
  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .select("id, kind, message, fire_at, time_of_day, recurring")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`list_reminders failed: ${error.message}`);
  return {
    schedules: (data ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      message: r.message as string,
      fireAt: (r.fire_at as string | null) ?? null,
      timeOfDay: (r.time_of_day as string | null) ?? null,
      recurring: (r.recurring as string | null) ?? null,
    })),
  };
}

/** Scheduler: active schedules whose fire time has passed (or check-in due today). */
export async function getDueSchedules(now: Date): Promise<ProactiveSchedule[]> {
  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .select("*")
    .eq("status", "active")
    .or(`fire_at.is.null,fire_at.lte.${now.toISOString()}`);

  if (error) throw new Error(`getDueSchedules failed: ${error.message}`);
  const rows = (data ?? []) as ProactiveSchedule[];

  // Check-in rows fire only when local time >= time_of_day, once per day
  const [h, mi] = [now.getHours(), now.getMinutes()];
  return rows.filter((s) => {
    if (s.kind === "checkin") {
      if (!s.time_of_day) return false;
      const [th, tm] = s.time_of_day.split(":").map(Number);
      const dueNow = h > (th ?? 9) || (h === (th ?? 9) && mi >= (tm ?? 0));
      const firedToday =
        s.last_fired_at &&
        new Date(s.last_fired_at).toDateString() === now.toDateString();
      return dueNow && !firedToday;
    }
    // reminder + task rows fire when fire_at passes
    return s.fire_at !== null && new Date(s.fire_at) <= now;
  });
}

/**
 * Scheduler: atomically claim a schedule before delivering it.
 * The UPDATE is conditional, so concurrent ticks (multiple module instances,
 * direct tick calls) cannot deliver the same schedule twice.
 * Returns true only for the tick that won the claim.
 */
export async function claimSchedule(schedule: ProactiveSchedule): Promise<boolean> {
  const nowIso = new Date().toISOString();

  if (schedule.recurring === "daily") {
    // Daily check-in: claim only if not already fired today (local day)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data, error } = await supabaseAdmin
      .from("proactive_schedules")
      .update({ last_fired_at: nowIso })
      .eq("id", schedule.id)
      .eq("status", "active")
      .or(`last_fired_at.is.null,last_fired_at.lt.${startOfDay.toISOString()}`)
      .select("id");
    if (error) throw new Error(`claimSchedule failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  // One-shot (reminder/task): claim only while still active
  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .update({ status: "fired", last_fired_at: nowIso })
    .eq("id", schedule.id)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`claimSchedule failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Scheduler: produce a proactive message (frontend polls these). */
export async function produceMessage(params: {
  scheduleId?: string;
  kind: "reminder" | "checkin" | "task";
  content: string;
  sessionId?: string;
}): Promise<ProactiveMessage> {
  const { data, error } = await supabaseAdmin
    .from("proactive_messages")
    .insert({
      schedule_id: params.scheduleId ?? null,
      kind: params.kind,
      content: params.content,
      session_id: params.sessionId ?? null,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) throw new Error(`produceMessage failed: ${error.message}`);
  return data as ProactiveMessage;
}

/** Frontend poll: pending messages, then mark them delivered. */
export async function getPendingMessages(): Promise<ProactiveMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("proactive_messages")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) throw new Error(`getPendingMessages failed: ${error.message}`);
  const rows = (data ?? []) as ProactiveMessage[];
  if (rows.length === 0) return [];

  const { error: updErr } = await supabaseAdmin
    .from("proactive_messages")
    .update({ status: "delivered", delivered_at: new Date().toISOString() })
    .in(
      "id",
      rows.map((r) => r.id)
    );
  if (updErr) console.error("[Proactive] mark delivered failed:", updErr.message);

  return rows;
}

/** Background job finished: insert a task-completion schedule that fires immediately. */
export async function reportTaskCompletion(params: {
  jobId: string;
  label: string;
  exitCode: number;
  summary?: string | undefined;
}): Promise<{ id: string }> {
  const ok = params.exitCode === 0;
  const content =
    `Background task "${params.label}" has finished — ` +
    (ok
      ? `exit code 0. ${params.summary ?? "Completed cleanly."}`
      : `exit code ${params.exitCode}. ${params.summary ?? "It failed; check the output."}`);

  const { data, error } = await supabaseAdmin
    .from("proactive_schedules")
    .insert({
      kind: "task",
      message: content,
      fire_at: new Date().toISOString(), // immediate
      job_id: params.jobId,
      status: "active",
    })
    .select("id")
    .single();

  if (error) throw new Error(`reportTaskCompletion failed: ${error.message}`);
  return { id: data.id as string };
}
