/**
 * Google token encryption tests.
 *
 * Supabase is mocked — nothing here touches a database. Keys are synthetic
 * 32-byte values created for the test; no real secret appears in any output.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: unknown;
}

interface Update {
  values: Row;
  filters: Array<[string, unknown]>;
}

const db = vi.hoisted(() => ({
  row: null as Row | null,
  upserts: [] as Row[],
  updates: [] as Update[],
}));

vi.mock("../supabase-server", () => {
  const selectChain = () => {
    const chain = {
      eq: () => chain,
      single: async () => ({
        data: db.row,
        error: db.row ? null : { message: "no rows" },
      }),
    };
    return chain;
  };

  const updateChain = (values: Row) => {
    const filters: Array<[string, unknown]> = [];
    const chain = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      then(
        onFulfilled: (value: { error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        db.updates.push({ values, filters });
        return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return {
    supabaseAdmin: {
      from: () => ({
        select: () => selectChain(),
        upsert: async (values: Row) => {
          db.upserts.push(values);
          return { error: null };
        },
        update: (values: Row) => updateChain(values),
      }),
    },
  };
});

import {
  decryptTokenField,
  encryptTokenField,
  isEncryptedEnvelope,
  parseKeyMaterial,
} from "./token-crypto";
import { hasValidGoogleTokens, loadGoogleTokens, saveGoogleTokens } from "./token-store";

const KEY_A = "a".repeat(64); // hex, 32 bytes
const KEY_B = "b".repeat(64);
const KEY_PREV = "c".repeat(64);

const TOKENS = {
  accessToken: "ya29.plaintext-access-token-value",
  refreshToken: "1//plaintext-refresh-token-value",
  tokenType: "Bearer",
  expiryDate: Date.now() + 3_600_000,
  scope: "https://www.googleapis.com/auth/gmail.readonly",
};

/** Flip a byte inside the ciphertext body (robust; last-char edits can be no-ops). */
function tamperEnvelope(envelope: string): string {
  const parts = envelope.split(".");
  const body = parts[3] ?? "";
  const raw = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const index = Math.floor(raw.length / 2);
  raw[index] = (raw[index] ?? 0) ^ 0xff;
  parts[3] = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return parts.join(".");
}

function setKeys(current?: string, previous?: string): void {
  if (current === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
  else process.env["TOKEN_ENCRYPTION_KEY"] = current;
  if (previous === undefined) delete process.env["TOKEN_ENCRYPTION_KEY_PREVIOUS"];
  else process.env["TOKEN_ENCRYPTION_KEY_PREVIOUS"] = previous;
}

/** Apply the most recent migration update to the fake row. */
function applyLastUpdate(): void {
  const update = db.updates[db.updates.length - 1];
  if (!update || !db.row) return;
  db.row = { ...db.row, ...update.values };
}

beforeEach(() => {
  db.row = null;
  db.upserts.length = 0;
  db.updates.length = 0;
  setKeys(KEY_A);
});

afterAll(() => {
  setKeys();
});

describe("key material", () => {
  it("accepts 32 bytes as hex, base64 and base64url", () => {
    expect(parseKeyMaterial(KEY_A)?.length).toBe(32);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(parseKeyMaterial(b64)?.length).toBe(32);
    expect(
      parseKeyMaterial(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))?.length,
    ).toBe(32);
  });

  it("rejects passphrases, wrong lengths and junk", () => {
    expect(parseKeyMaterial("correct horse battery staple")).toBeNull();
    expect(parseKeyMaterial("abc")).toBeNull();
    expect(parseKeyMaterial("z".repeat(64))).toBeNull();
    expect(parseKeyMaterial(btoa("short"))).toBeNull();
    expect(parseKeyMaterial("")).toBeNull();
    expect(parseKeyMaterial(undefined)).toBeNull();
  });
});

describe("field encryption", () => {
  it("round-trips and produces a self-describing envelope", async () => {
    const key = parseKeyMaterial(KEY_A);
    expect(key).toBeTruthy();
    if (!key) return;
    const envelope = await encryptTokenField({
      plaintext: "secret-value",
      keyBytes: key,
      userId: "default",
      column: "access_token",
    });
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("secret-value");

    const decrypted = await decryptTokenField({
      envelope,
      current: key,
      previous: null,
      userId: "default",
      column: "access_token",
    });
    expect(decrypted?.plaintext).toBe("secret-value");
    expect(decrypted?.usedPrevious).toBe(false);
  });

  it("uses a fresh IV for every encryption", async () => {
    const key = parseKeyMaterial(KEY_A);
    if (!key) return;
    const a = await encryptTokenField({
      plaintext: "x",
      keyBytes: key,
      userId: "default",
      column: "access_token",
    });
    const b = await encryptTokenField({
      plaintext: "x",
      keyBytes: key,
      userId: "default",
      column: "access_token",
    });
    expect(a).not.toBe(b);
  });

  it("rejects a swapped column / user (AAD mismatch)", async () => {
    const key = parseKeyMaterial(KEY_A);
    if (!key) return;
    const envelope = await encryptTokenField({
      plaintext: "secret",
      keyBytes: key,
      userId: "default",
      column: "access_token",
    });
    const swappedColumn = await decryptTokenField({
      envelope,
      current: key,
      previous: null,
      userId: "default",
      column: "refresh_token",
    });
    const swappedUser = await decryptTokenField({
      envelope,
      current: key,
      previous: null,
      userId: "someone-else",
      column: "access_token",
    });
    expect(swappedColumn).toBeNull();
    expect(swappedUser).toBeNull();
  });

  it("rejects a tampered ciphertext", async () => {
    const key = parseKeyMaterial(KEY_A);
    if (!key) return;
    const envelope = await encryptTokenField({
      plaintext: "secret",
      keyBytes: key,
      userId: "default",
      column: "access_token",
    });
    const tampered = await decryptTokenField({
      envelope: tamperEnvelope(envelope),
      current: key,
      previous: null,
      userId: "default",
      column: "access_token",
    });
    expect(tampered).toBeNull();
  });
});

describe("saveGoogleTokens", () => {
  it("stores ciphertext only — never the plaintext", async () => {
    await saveGoogleTokens(TOKENS);
    expect(db.upserts).toHaveLength(1);
    const stored = db.upserts[0]!;
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(TOKENS.accessToken);
    expect(serialized).not.toContain(TOKENS.refreshToken);
    expect(String(stored["access_token"]).startsWith("v1.")).toBe(true);
    expect(String(stored["refresh_token"]).startsWith("v1.")).toBe(true);
    expect(stored["token_type"]).toBe("Bearer");
    expect(stored["expiry_date"]).toBe(TOKENS.expiryDate);
  });

  it("throws instead of writing plaintext when the key is missing", async () => {
    setKeys(undefined);
    await expect(saveGoogleTokens(TOKENS)).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(db.upserts).toHaveLength(0);
  });

  it("throws when the key is invalid", async () => {
    setKeys("not-a-valid-key");
    await expect(saveGoogleTokens(TOKENS)).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(db.upserts).toHaveLength(0);
  });

  it("stores an empty refresh token as empty (nothing to protect)", async () => {
    await saveGoogleTokens({ ...TOKENS, refreshToken: "" });
    expect(db.upserts[0]!["refresh_token"]).toBe("");
  });
});

describe("loadGoogleTokens", () => {
  async function saveAndLoad(): Promise<void> {
    await saveGoogleTokens(TOKENS);
    db.row = { ...db.upserts[0]! };
  }

  it("round-trips saved tokens", async () => {
    await saveAndLoad();
    const loaded = await loadGoogleTokens();
    expect(loaded).toEqual(TOKENS);
  });

  it("returns null when the key is missing (fail closed)", async () => {
    await saveAndLoad();
    setKeys(undefined);
    expect(await loadGoogleTokens()).toBeNull();
  });

  it("returns null when the key is wrong", async () => {
    await saveAndLoad();
    setKeys(KEY_B);
    expect(await loadGoogleTokens()).toBeNull();
  });

  it("returns null when the ciphertext is tampered", async () => {
    await saveAndLoad();
    const access = String(db.row!["access_token"]);
    db.row!["access_token"] = tamperEnvelope(access);
    expect(await loadGoogleTokens()).toBeNull();
  });

  it("returns null when access and refresh ciphertexts are swapped", async () => {
    await saveAndLoad();
    const access = db.row!["access_token"];
    db.row!["access_token"] = db.row!["refresh_token"];
    db.row!["refresh_token"] = access;
    expect(await loadGoogleTokens()).toBeNull();
  });

  it("refuses a legacy plaintext refresh token even if access looks encrypted", async () => {
    await saveAndLoad();
    db.row!["refresh_token"] = TOKENS.refreshToken;
    expect(await loadGoogleTokens()).toBeNull();
  });

  it("migrates a legacy plaintext row on read when a key is present", async () => {
    db.row = {
      user_id: "default",
      access_token: TOKENS.accessToken,
      refresh_token: TOKENS.refreshToken,
      token_type: "Bearer",
      expiry_date: TOKENS.expiryDate,
      scope: TOKENS.scope,
    };
    const loaded = await loadGoogleTokens();
    expect(loaded).toEqual(TOKENS);
    expect(db.updates).toHaveLength(1);
    expect(String(db.updates[0]!.values["access_token"]).startsWith("v1.")).toBe(true);
    // The migration is keyed on the old plaintext so it cannot clobber a newer write.
    expect(db.updates[0]!.filters).toEqual([
      ["user_id", "default"],
      ["access_token", TOKENS.accessToken],
    ]);
  });

  it("refuses a legacy plaintext row when no key is present", async () => {
    setKeys(undefined);
    db.row = {
      user_id: "default",
      access_token: TOKENS.accessToken,
      refresh_token: TOKENS.refreshToken,
      token_type: "Bearer",
      expiry_date: TOKENS.expiryDate,
      scope: TOKENS.scope,
    };
    expect(await loadGoogleTokens()).toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it("decrypts with the previous key and re-encrypts with the current key", async () => {
    setKeys(KEY_PREV);
    await saveGoogleTokens(TOKENS);
    db.row = { ...db.upserts[0]! };

    // Rotate: previous key is still accepted for decryption.
    setKeys(KEY_A, KEY_PREV);
    const loaded = await loadGoogleTokens();
    expect(loaded).toEqual(TOKENS);
    expect(db.updates).toHaveLength(1);

    // After the migration write, the new key alone is enough.
    applyLastUpdate();
    setKeys(KEY_A);
    expect(await loadGoogleTokens()).toEqual(TOKENS);
  });

  it("does not re-encrypt rows already under the current key", async () => {
    await saveAndLoad();
    expect(await loadGoogleTokens()).toEqual(TOKENS);
    expect(db.updates).toHaveLength(0);
  });
});

describe("hasValidGoogleTokens", () => {
  it("is false with no stored row", async () => {
    expect(await hasValidGoogleTokens()).toBe(false);
  });

  it("is false for an expired token", async () => {
    await saveGoogleTokens({ ...TOKENS, expiryDate: Date.now() - 1000 });
    db.row = { ...db.upserts[0]! };
    expect(await hasValidGoogleTokens()).toBe(false);
  });

  it("is true for a token that is still valid", async () => {
    await saveGoogleTokens(TOKENS);
    db.row = { ...db.upserts[0]! };
    expect(await hasValidGoogleTokens()).toBe(true);
  });
});
