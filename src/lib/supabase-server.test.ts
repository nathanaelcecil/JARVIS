import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

async function loadModule() {
  vi.resetModules();
  return await import("./supabase-server");
}

describe("supabase-server", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  describe("when unconfigured", () => {
    beforeEach(() => {
      delete process.env["VITE_SUPABASE_URL"];
      delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    });

    it("reports not configured", async () => {
      const m = await loadModule();
      expect(m.isSupabaseConfigured()).toBe(false);
      expect(m.getSupabaseAdmin()).toBeNull();
    });

    it("does not throw at module load", async () => {
      await expect(loadModule()).resolves.toBeDefined();
    });

    it("yields a builder that resolves to a clear error instead of throwing", async () => {
      const m = await loadModule();
      const builder = m.supabaseAdmin.from("messages");
      const res = (await (builder as unknown as PromiseLike<unknown>)) as {
        data: unknown;
        error: { code?: string; message?: string } | null;
      };
      expect(res.data).toBeNull();
      expect(res.error?.code).toBe("supabase_not_configured");
      expect(res.error?.message).toContain("Supabase is not configured");
    });

    it("supports chained methods before awaiting", async () => {
      const m = await loadModule();
      const chain = m.supabaseAdmin
        .from("memory")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      const awaited = await (chain as unknown as PromiseLike<unknown>);
      const res = awaited as { data: unknown; error: { code?: string } | null };
      expect(res.data).toBeNull();
      expect(res.error?.code).toBe("supabase_not_configured");
    });

    it("emits a one-time warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const m = await loadModule();
      await (m.supabaseAdmin.from("messages") as unknown as PromiseLike<unknown>);
      m.supabaseAdmin.from("memory");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("Supabase is not configured");
    });

    it("keeps reads empty via toPromise-style then access", async () => {
      const m = await loadModule();
      const thenable = m.supabaseAdmin.from("messages").select("role, content");
      const r = await new Promise((resolve, reject) => {
        (thenable as { then: (f: (v: unknown) => void, j: (e: unknown) => void) => unknown }).then(
          (v) => resolve(v),
          (e) => reject(e),
        );
      });
      const typed = r as { data: unknown[] };
      expect(Array.isArray(typed.data) || typed.data === null).toBe(true);
    });
  });

  describe("when configured", () => {
    beforeEach(() => {
      process.env["VITE_SUPABASE_URL"] = "https://example.supabase.co";
      process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-role-test-key";
    });

    it("reports configured and returns a client", async () => {
      const m = await loadModule();
      expect(m.isSupabaseConfigured()).toBe(true);
      const client = m.getSupabaseAdmin();
      expect(client).not.toBeNull();
      expect(typeof client?.from).toBe("function");
    });

    it("returns the same cached client across calls", async () => {
      const m = await loadModule();
      expect(m.getSupabaseAdmin()).toBe(m.getSupabaseAdmin());
    });

    it("supabaseAdmin.from delegates to the real client when configured", async () => {
      const m = await loadModule();
      const client = m.getSupabaseAdmin();
      const fromSpy = vi.spyOn(client!, "from");
      const builder = m.supabaseAdmin.from("messages");
      expect(fromSpy).toHaveBeenCalledWith("messages");
      // A real builder is a distinct object from the client itself; the
      // null-builder path returns a Proxy whose chained methods all resolve to
      // supabase_not_configured. Here we only assert delegation happened.
      expect(builder).toBeDefined();
      fromSpy.mockRestore();
    });

    it("isSupabaseConfigured can be called with an explicit env object", async () => {
      const m = await loadModule();
      expect(m.isSupabaseConfigured({ VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" })).toBe(
        false,
      );
      expect(
        m.isSupabaseConfigured({ VITE_SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" }),
      ).toBe(true);
    });
  });
});
