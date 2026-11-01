/**
 * Envelope encryption for Google OAuth token fields.
 *
 * AES-256-GCM via Web Crypto (crypto.subtle) so the same code runs under Bun,
 * Node and a Worker-style runtime. Every value gets a fresh random 96-bit IV,
 * and the ciphertext is bound to its row + column with AAD:
 *
 *   google_tokens|<user_id>|<column>
 *
 * so a ciphertext cannot be swapped between columns or users.
 *
 * Envelope:  v1.<kid>.<iv_b64url>.<ciphertext+tag_b64url>
 *   kid = first 8 hex chars of SHA-256(key) — non-reversible, for rotation logs.
 *
 * Deliberately NOT here: passphrase KDFs, default keys, or any fallback to
 * plaintext. The key must be exactly 32 random bytes, base64 or hex.
 */

export const TOKEN_COLUMN_ACCESS = "access_token" as const;
export const TOKEN_COLUMN_REFRESH = "refresh_token" as const;
export type TokenColumn = typeof TOKEN_COLUMN_ACCESS | typeof TOKEN_COLUMN_REFRESH;

const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENVELOPE_PREFIX = "v1.";
const ENVELOPE_RE = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

export interface TokenKeySet {
  /** Current key bytes, or null when missing/invalid. */
  current: Uint8Array | null;
  /** Previous key bytes, decrypt-only, or null. */
  previous: Uint8Array | null;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  const out = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) {
    const byte = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+$/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse key material: exactly 32 bytes, hex (64 chars) or base64/base64url.
 * Anything else — passphrases, short keys, wrong encodings — is rejected.
 */
export function parseKeyMaterial(value: string | undefined | null): Uint8Array | null {
  if (!value) return null;
  const trimmed = value.trim();
  const fromHex = hexToBytes(trimmed);
  if (fromHex) return fromHex;
  const fromBase64 = base64ToBytes(trimmed);
  if (fromBase64 && fromBase64.length === KEY_BYTES) return fromBase64;
  return null;
}

/** Read TOKEN_ENCRYPTION_KEY / TOKEN_ENCRYPTION_KEY_PREVIOUS at call time. */
export function readTokenKeySet(
  env: Record<string, string | undefined> = process.env,
): TokenKeySet {
  return {
    current: parseKeyMaterial(env["TOKEN_ENCRYPTION_KEY"]),
    previous: parseKeyMaterial(env["TOKEN_ENCRYPTION_KEY_PREVIOUS"]),
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytes as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    usages,
  );
}

/** First 8 hex chars of SHA-256(key) — safe to log and compare. */
export async function keyId(keyBytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", keyBytes as unknown as BufferSource),
  );
  return toHex(digest).slice(0, 8);
}

export function aadFor(userId: string, column: TokenColumn): Uint8Array {
  return new TextEncoder().encode(`google_tokens|${userId}|${column}`);
}

/** True when a stored value looks like our envelope (vs legacy plaintext). */
export function isEncryptedEnvelope(value: string): boolean {
  return ENVELOPE_RE.test(value);
}

/** Encrypt one token field. Throws only on invalid key material. */
export async function encryptTokenField(params: {
  plaintext: string;
  keyBytes: Uint8Array;
  userId: string;
  column: TokenColumn;
}): Promise<string> {
  if (params.keyBytes.length !== KEY_BYTES) {
    throw new Error("token encryption key must be 32 bytes");
  }
  const key = await importAesKey(params.keyBytes, ["encrypt"]);
  const kid = await keyId(params.keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as BufferSource,
        additionalData: aadFor(params.userId, params.column) as unknown as BufferSource,
      },
      key,
      new TextEncoder().encode(params.plaintext),
    ),
  );
  return `${ENVELOPE_PREFIX}${kid}.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export interface DecryptedField {
  plaintext: string;
  kid: string;
  /** True when the value was decrypted with the previous key. */
  usedPrevious: boolean;
}

/**
 * Decrypt one field. Returns null for tampering, wrong key, or a column/user
 * swap — callers treat null as "not connected", never as a reason to fall back
 * to plaintext.
 */
export async function decryptTokenField(params: {
  envelope: string;
  current: Uint8Array | null;
  previous: Uint8Array | null;
  userId: string;
  column: TokenColumn;
}): Promise<DecryptedField | null> {
  const match = ENVELOPE_RE.exec(params.envelope);
  if (!match) return null;
  const kid = match[1] as string;
  const iv = base64UrlToBytes(match[2] as string);
  const ciphertext = base64UrlToBytes(match[3] as string);
  if (!iv || !ciphertext) return null;

  const candidates: Array<{ bytes: Uint8Array; previous: boolean }> = [];
  if (params.current) candidates.push({ bytes: params.current, previous: false });
  if (params.previous) candidates.push({ bytes: params.previous, previous: true });

  for (const candidate of candidates) {
    if ((await keyId(candidate.bytes)) !== kid) continue;
    try {
      const key = await importAesKey(candidate.bytes, ["decrypt"]);
      const plaintextBytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv as unknown as BufferSource,
          additionalData: aadFor(params.userId, params.column) as unknown as BufferSource,
        },
        key,
        ciphertext as unknown as BufferSource,
      );
      return {
        plaintext: new TextDecoder().decode(plaintextBytes),
        kid,
        usedPrevious: candidate.previous,
      };
    } catch {
      // Tampered, wrong key, or wrong AAD — try the next candidate, else fail.
      return null;
    }
  }
  return null;
}
