/**
 * Google OAuth token storage.
 *
 * Tokens are encrypted in the application layer with AES-256-GCM before they
 * reach Postgres (see token-crypto.ts). The database does NOT use pgcrypto for
 * these columns — migration 004 documents that.
 *
 * Failure policy is fail-closed:
 *   - write without a valid key  → throw, never write plaintext
 *   - read  without a valid key  → null (Google reads as "not connected")
 *   - decrypt failure / tamper   → null, generic log, never plaintext fallback
 *
 * Legacy plaintext rows are migrated on read when a key is present. Rows that
 * decrypt with TOKEN_ENCRYPTION_KEY_PREVIOUS are re-encrypted with the current
 * key best-effort.
 */

import { supabaseAdmin } from "../supabase-server";
import {
  TOKEN_COLUMN_ACCESS,
  TOKEN_COLUMN_REFRESH,
  decryptTokenField,
  encryptTokenField,
  isEncryptedEnvelope,
  readTokenKeySet,
  type TokenColumn,
  type TokenKeySet,
} from "./token-crypto";

const DEFAULT_USER_ID = "default";
const TABLE = "google_tokens";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiryDate: number;
  scope: string;
}

interface GoogleTokenRow {
  user_id?: string;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  expiry_date: number;
  scope: string;
}

let warnedUnavailable = false;

function warnUnavailable(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  // One clear, non-secret line. Never includes the key or any token value.
  console.warn("[TokenStore] TOKEN_ENCRYPTION_KEY missing or invalid; Google integration disabled");
}

function keys(): TokenKeySet {
  return readTokenKeySet();
}

async function encryptColumn(
  plaintext: string,
  key: Uint8Array,
  userId: string,
  column: TokenColumn,
): Promise<string> {
  return encryptTokenField({ plaintext, keyBytes: key, userId, column });
}

export async function saveGoogleTokens(tokens: GoogleTokens): Promise<void> {
  const set = keys();
  if (!set.current) {
    // Refuse loudly: silently writing plaintext is the bug this module exists
    // to prevent.
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is missing or invalid (expected 32 bytes, base64 or hex). " +
        "Refusing to store Google tokens in plaintext.",
    );
  }

  const accessToken = await encryptColumn(
    tokens.accessToken,
    set.current,
    DEFAULT_USER_ID,
    TOKEN_COLUMN_ACCESS,
  );
  const refreshToken = tokens.refreshToken
    ? await encryptColumn(tokens.refreshToken, set.current, DEFAULT_USER_ID, TOKEN_COLUMN_REFRESH)
    : "";

  const { error } = await supabaseAdmin.from(TABLE).upsert(
    {
      user_id: DEFAULT_USER_ID,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: tokens.tokenType,
      expiry_date: tokens.expiryDate,
      scope: tokens.scope,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    console.error("[TokenStore] Failed to save tokens:", error.message);
    throw error;
  }
  console.log("[TokenStore] Google tokens saved");
}

/**
 * Best-effort re-encryption of a row that was decrypted with the previous key
 * (or was legacy plaintext). Keyed on the old stored access_token so two
 * concurrent readers cannot clobber a newer write; failures are not fatal.
 */
async function reencryptRow(params: {
  /** The value currently stored (plaintext or old envelope) — used as a filter. */
  oldAccessToken: string;
  /** Decrypted plaintext to re-encrypt. */
  accessToken: string;
  refreshToken: string;
  userId: string;
  key: Uint8Array;
}): Promise<void> {
  try {
    const { userId, key } = params;
    const access = await encryptColumn(params.accessToken, key, userId, TOKEN_COLUMN_ACCESS);
    const refresh = params.refreshToken
      ? await encryptColumn(params.refreshToken, key, userId, TOKEN_COLUMN_REFRESH)
      : "";
    await supabaseAdmin
      .from(TABLE)
      .update({
        access_token: access,
        refresh_token: refresh,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("access_token", params.oldAccessToken);
    console.log("[TokenStore] Re-encrypted Google tokens with the current key");
  } catch (err) {
    // Migration is opportunistic; the tokens are still usable this request.
    console.warn(
      "[TokenStore] Could not re-encrypt stored Google tokens:",
      err instanceof Error ? err.message : "unknown error",
    );
  }
}

export async function loadGoogleTokens(): Promise<GoogleTokens | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("user_id", DEFAULT_USER_ID)
    .single();
  if (error || !data) return null;

  const row = data as unknown as GoogleTokenRow;
  const set = keys();
  if (!set.current) {
    warnUnavailable();
    return null;
  }

  const rawAccess = row.access_token ?? "";
  const rawRefresh = row.refresh_token ?? "";

  const accessEncrypted = isEncryptedEnvelope(rawAccess);
  const refreshEncrypted = isEncryptedEnvelope(rawRefresh);
  const userId = row.user_id ?? DEFAULT_USER_ID;

  let accessToken: string;
  let refreshToken: string;
  let needsMigration = false;

  if (!accessEncrypted) {
    // Fully legacy row (both fields plaintext). Usable only so it can be
    // migrated immediately — never as a silent plaintext mode. A mixed row
    // (one encrypted, one not) is suspicious and refused outright.
    if (!rawAccess || refreshEncrypted) {
      console.warn(
        "[TokenStore] Stored Google tokens are in an invalid mixed state; treating Google as not connected. Re-connect Google to rewrite them.",
      );
      return null;
    }
    accessToken = rawAccess;
    refreshToken = rawRefresh;
    needsMigration = true;
  } else {
    const decrypted = await decryptTokenField({
      envelope: rawAccess,
      current: set.current,
      previous: set.previous,
      userId,
      column: TOKEN_COLUMN_ACCESS,
    });
    if (!decrypted) {
      console.warn(
        "[TokenStore] Stored Google access token could not be decrypted (tampered or wrong key); treating Google as not connected",
      );
      return null;
    }
    accessToken = decrypted.plaintext;
    if (decrypted.usedPrevious) needsMigration = true;

    if (rawRefresh === "") {
      refreshToken = "";
    } else if (!refreshEncrypted) {
      // Access encrypted but refresh plaintext: refuse the mixed state rather
      // than use a plaintext secret.
      console.warn(
        "[TokenStore] Stored Google refresh token is not encrypted; treating Google as not connected. Re-connect Google to rewrite it.",
      );
      return null;
    } else {
      const refresh = await decryptTokenField({
        envelope: rawRefresh,
        current: set.current,
        previous: set.previous,
        userId,
        column: TOKEN_COLUMN_REFRESH,
      });
      if (!refresh) {
        console.warn(
          "[TokenStore] Stored Google refresh token could not be decrypted (tampered or wrong key); treating Google as not connected",
        );
        return null;
      }
      refreshToken = refresh.plaintext;
      if (refresh.usedPrevious) needsMigration = true;
    }
  }

  if (needsMigration) {
    await reencryptRow({
      oldAccessToken: rawAccess,
      accessToken,
      refreshToken,
      userId,
      key: set.current,
    });
  }

  return {
    accessToken,
    refreshToken,
    tokenType: row.token_type,
    expiryDate: row.expiry_date,
    scope: row.scope,
  };
}

export async function hasValidGoogleTokens(): Promise<boolean> {
  const tokens = await loadGoogleTokens();
  if (!tokens) return false;
  return tokens.expiryDate > Date.now() + 5 * 60 * 1000;
}
