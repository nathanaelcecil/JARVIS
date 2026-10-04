-- ============================================================
-- Proactive JARVIS: schedules + delivered initiative messages
-- Machine-initiated chat: daily check-in, reminders, task-done callbacks
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- proactive_schedules: what should fire, and when
CREATE TABLE IF NOT EXISTS proactive_schedules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- 'reminder' = one-time/delayed message, 'checkin' = daily greeting (time_of_day),
  -- 'task' = background job completion callback (job_id tracked by local agent)
  kind TEXT NOT NULL DEFAULT 'reminder'
    CHECK (kind IN ('reminder', 'checkin', 'task')),
  message TEXT NOT NULL,
  -- For one-time items: exact fire time. NULL for the daily check-in (uses time_of_day).
  fire_at TIMESTAMPTZ,
  -- For daily check-in: local time of day as HH:MM (default 09:00)
  time_of_day TEXT,
  -- 'daily' repeats after firing; NULL = fire once then done
  recurring TEXT,
  session_id TEXT,
  -- For kind='task': local-agent background job id this waits on
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'fired', 'cancelled')),
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_schedules_due
  ON proactive_schedules(status, fire_at);
ALTER TABLE proactive_schedules ENABLE ROW LEVEL SECURITY;

-- proactive_messages: a message that has been produced and is waiting
-- for (or has completed) delivery to the frontend (chat + voice + banner)
CREATE TABLE IF NOT EXISTS proactive_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id UUID REFERENCES proactive_schedules(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'reminder'
    CHECK (kind IN ('reminder', 'checkin', 'task')),
  content TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proactive_messages_pending
  ON proactive_messages(status, created_at);
ALTER TABLE proactive_messages ENABLE ROW LEVEL SECURITY;
