-- ============================================================
-- JARVIS Amber-Core: Initial Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- messages: conversation history
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- memory: durable facts/preferences that compound over time
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  relevance_keywords TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  last_accessed TIMESTAMPTZ DEFAULT now()
);

-- learned_behaviors: explicit corrections, included in every system prompt
CREATE TABLE IF NOT EXISTS learned_behaviors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  behavior TEXT NOT NULL,
  source TEXT DEFAULT 'user_correction',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- activity_log: every tool execution
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input JSONB,
  result JSONB,
  approval_status TEXT DEFAULT 'auto',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_keywords ON memory USING GIN(relevance_keywords);
CREATE INDEX IF NOT EXISTS idx_memory_accessed ON memory(last_accessed DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
