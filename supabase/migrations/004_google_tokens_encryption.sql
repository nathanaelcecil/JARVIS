-- 004: Google OAuth tokens are encrypted in the application layer.
--
-- 002_google_tokens.sql says "pgcrypto encryption", but that was never true:
-- the columns are plain TEXT and the (previous) writer stored plaintext.
-- Tokens are now encrypted by src/lib/google/token-store.ts with AES-256-GCM
-- (Web Crypto) before they reach Postgres, bound to their row and column with
-- AAD. pgcrypto is NOT used for these columns; do not add a pgcrypto-based
-- reader, it would not be able to decrypt this envelope format.
--
-- Envelope: v1.<kid>.<iv_b64url>.<ciphertext+tag_b64url>
--
-- This migration changes no data. It records the actual scheme so a future
-- reader does not reintroduce a plaintext path. Legacy plaintext rows are
-- migrated on read by the application (best-effort), never re-written by SQL.

COMMENT ON COLUMN google_tokens.access_token IS
  'AES-256-GCM envelope written by src/lib/google/token-store.ts (v1.<kid>.<iv>.<ct>); never plaintext.';

COMMENT ON COLUMN google_tokens.refresh_token IS
  'AES-256-GCM envelope written by src/lib/google/token-store.ts (v1.<kid>.<iv>.<ct>); never plaintext.';
