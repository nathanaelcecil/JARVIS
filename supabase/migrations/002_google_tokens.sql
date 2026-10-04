-- Phase 4: Google OAuth token storage with pgcrypto encryption
-- Tokens encrypted on write, decrypted on read using TOKEN_ENCRYPTION_KEY from Worker env.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS google_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL DEFAULT 'default',
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expiry_date BIGINT,
  scope TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_google_tokens_user ON google_tokens(user_id);
ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY;
