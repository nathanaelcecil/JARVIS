/**
 * Approval tokens for the local-agent boundary.
 *
 * Possession of the bearer secret (`local-agent/.agent-secret`) authorizes the
 * HTTP request. It must NOT be enough to run a confirm-tier tool. Those tools
 * require a token minted by the server only after a real human approval:
 *
 *   v1.<base64url(payload)>.<base64url(HMAC-SHA256)>
 *
 * payload = { v, tool, argsHash, nonce, iat, exp }
 *
 * - HMAC key is a separate 32-byte key file (`local-agent/.approval-key`),
 *   never derived from the bearer secret.
 * - argsHash is SHA-256 of a canonical JSON encoding of the arguments, so a
 *   token approved for one command cannot execute a different one.
 * - nonce + short expiry give single use; the verifier keeps an in-memory
 *   nonce set. A local-agent restart clears it, which the 60 s expiry bounds.
 *
 * This does NOT defend against another process running as the same OS user
 * that can read both key files. It separates a leaked bearer value (logs, a
 * browser, a transcript) from the ability to authorize an action.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

export const APPROVAL_TOKEN_VERSION = 1;
export const APPROVAL_TTL_MS = 60_000;
export const APPROVAL_CLOCK_TOLERANCE_MS = 5_000;

export type ApprovalErrorCode =
  | "approval_required"
  | "approval_invalid"
  | "approval_expired"
  | "approval_replayed"
  | "approval_mismatch"
  | "tool_forbidden";

export interface ApprovalCheck {
  ok: boolean;
  code?: ApprovalErrorCode;
  status?: number;
  message?: string;
}

interface ApprovalPayload {
  v: number;
  tool: string;
  argsHash: string;
  nonce: string;
  iat: number;
  exp: number;
}

/** Stable JSON: object keys sorted, undefined omitted, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/** SHA-256 of the canonical argument encoding, hex. */
export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    return Buffer.from(padded + pad, "base64");
  } catch {
    return null;
  }
}

function sign(payloadB64: string, key: string): string {
  return toBase64Url(
    createHmac("sha256", Buffer.from(key, "hex")).update(payloadB64, "utf8").digest(),
  );
}

/** Mint a token. Only the server calls this, and only after a real approval. */
export function mintApprovalToken(params: {
  key: string;
  tool: string;
  args: Record<string, unknown>;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}): string {
  const now = params.now ?? Date.now();
  const payload: ApprovalPayload = {
    v: APPROVAL_TOKEN_VERSION,
    tool: params.tool,
    argsHash: hashArgs(params.args),
    nonce: params.nonce ?? crypto.randomUUID(),
    iat: now,
    exp: now + (params.ttlMs ?? APPROVAL_TTL_MS),
  };
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `v1.${payloadB64}.${sign(payloadB64, params.key)}`;
}

function parsePayload(payloadB64: string): ApprovalPayload | null {
  const raw = fromBase64Url(payloadB64);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p["v"] !== APPROVAL_TOKEN_VERSION) return null;
  if (typeof p["tool"] !== "string") return null;
  if (typeof p["argsHash"] !== "string" || !/^[a-f0-9]{64}$/.test(p["argsHash"])) return null;
  if (typeof p["nonce"] !== "string" || p["nonce"].length < 8) return null;
  if (typeof p["iat"] !== "number" || typeof p["exp"] !== "number") return null;
  return {
    v: p["v"],
    tool: p["tool"],
    argsHash: p["argsHash"],
    nonce: p["nonce"],
    iat: p["iat"],
    exp: p["exp"],
  };
}

/** Short, non-reversible key id for logs. Never log the key or the token. */
export function approvalKeyId(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/**
 * In-memory single-use nonce set. Pruned by expiry on every check.
 */
export class NonceStore {
  private readonly used = new Map<string, number>();

  has(nonce: string, now: number): boolean {
    const exp = this.used.get(nonce);
    if (exp === undefined) return false;
    if (exp + APPROVAL_CLOCK_TOLERANCE_MS < now) {
      this.used.delete(nonce);
      return false;
    }
    return true;
  }

  record(nonce: string, exp: number): void {
    this.used.set(nonce, exp);
    if (this.used.size > 1024) this.prune(Date.now());
  }

  prune(now: number): void {
    for (const [nonce, exp] of this.used) {
      if (exp + APPROVAL_CLOCK_TOLERANCE_MS < now) this.used.delete(nonce);
    }
  }

  get size(): number {
    return this.used.size;
  }
}

/** Verify a token for a specific tool + arguments. Stateless except for nonces. */
export function verifyApprovalToken(params: {
  key: string;
  token: string;
  tool: string;
  args: Record<string, unknown>;
  now?: number;
  nonces: NonceStore;
}): ApprovalCheck {
  const now = params.now ?? Date.now();
  const parts = params.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return {
      ok: false,
      code: "approval_invalid",
      status: 403,
      message: "malformed approval token",
    };
  }
  const payloadB64 = parts[1] ?? "";
  const signatureB64 = parts[2] ?? "";

  // Authenticate the payload BEFORE trusting anything in it.
  const expected = sign(payloadB64, params.key);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureB64, "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return {
      ok: false,
      code: "approval_invalid",
      status: 403,
      message: "approval signature invalid",
    };
  }

  const payload = parsePayload(payloadB64);
  if (!payload) {
    return {
      ok: false,
      code: "approval_invalid",
      status: 403,
      message: "approval payload invalid",
    };
  }

  if (now > payload.exp + APPROVAL_CLOCK_TOLERANCE_MS) {
    return { ok: false, code: "approval_expired", status: 403, message: "approval token expired" };
  }
  if (payload.iat > now + APPROVAL_CLOCK_TOLERANCE_MS) {
    return {
      ok: false,
      code: "approval_invalid",
      status: 403,
      message: "approval token not yet valid",
    };
  }
  if (payload.tool !== params.tool) {
    return {
      ok: false,
      code: "approval_mismatch",
      status: 403,
      message: "approval token is for a different tool",
    };
  }
  if (payload.argsHash !== hashArgs(params.args)) {
    return {
      ok: false,
      code: "approval_mismatch",
      status: 403,
      message: "approval token is for different arguments",
    };
  }
  if (params.nonces.has(payload.nonce, now)) {
    return {
      ok: false,
      code: "approval_replayed",
      status: 403,
      message: "approval token already used",
    };
  }

  params.nonces.record(payload.nonce, payload.exp);
  return { ok: true };
}

// ── Key file management ─────────────────────────────────────

/** Read an approval key, or null when missing/invalid. Never logs the value. */
export function readApprovalKey(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

/**
 * Read the approval key, creating it on first run with mode 0600.
 * `wx` makes creation atomic: a concurrent starter loses the race and reads
 * the winner's key instead of overwriting it (which would invalidate tokens).
 */
export function getOrCreateApprovalKey(path: string): string {
  const existing = readApprovalKey(path);
  if (existing) return existing;

  const generated = randomBytes(32).toString("hex");
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, generated);
    } finally {
      closeSync(fd);
    }
    return generated;
  } catch (err) {
    // Someone else created it between the read and the write — use theirs.
    const raced = readApprovalKey(path);
    if (raced) return raced;
    throw err;
  }
}
