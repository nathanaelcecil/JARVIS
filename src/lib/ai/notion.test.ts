/**
 * Notion page creation — checks the exact payload sent to the API (mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("notionCreatePage", () => {
  const PAGE_UUID = "11111111-2222-4333-8444-555555555555";
  const DB_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  beforeEach(() => {
    vi.resetModules();
    process.env["NOTION_API_KEY"] = "secret_test";
    delete process.env["NOTION_DEFAULT_PARENT_PAGE_ID"];
  });

  function mockFetch(responses: unknown[]) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
        const next = responses.shift();
        const wrapped =
          next !== null && typeof next === "object" && "__status" in (next as object);
        const body = wrapped ? (next as { __body: unknown }).__body : next;
        const status = wrapped ? (next as { __status: number }).__status : 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => JSON.stringify(body ?? null),
        } as Response;
      })
    );
    return calls;
  }

  it("builds a page under a parent page from simple args", async () => {
    const calls = mockFetch([{ object: "page", id: "new-id", url: "https://notion.so/new" }]);
    const { notionCreatePage } = await import("../../functions/notion");
    const res = await notionCreatePage({
      title: "Plan",
      content: "# Goals\n- one\nplain line",
      parentPageId: PAGE_UUID,
    });
    expect(res).toEqual({ id: "new-id", url: "https://notion.so/new", created: true, title: "Plan" });
    const body = calls[0]!.body as {
      parent: unknown;
      properties: unknown;
      children: Array<{ type: string }>;
    };
    expect(body.parent).toEqual({ page_id: PAGE_UUID });
    expect(body.properties).toEqual({ title: { title: [{ type: "text", text: { content: "Plan" } }] } });
    expect(body.children.map((b) => b.type)).toEqual(["heading_1", "bulleted_list_item", "paragraph"]);
  });

  it("finds the title column of a database", async () => {
    const calls = mockFetch([
      { properties: { Tags: { type: "multi_select" }, Task: { type: "title" } } },
      { object: "page", id: "p2", url: "u2" },
    ]);
    const { notionCreatePage } = await import("../../functions/notion");
    await notionCreatePage({ title: "Buy milk", databaseId: DB_UUID });
    expect(calls[0]!.url).toContain("/databases/" + DB_UUID);
    const body = calls[1]!.body as { parent: unknown; properties: Record<string, unknown> };
    expect(body.parent).toEqual({ database_id: DB_UUID });
    expect(Object.keys(body.properties)).toEqual(["Task"]);
  });

  it("uses the default parent from the environment", async () => {
    process.env["NOTION_DEFAULT_PARENT_PAGE_ID"] = "default-parent";
    const calls = mockFetch([{ object: "page", id: "p3", url: "u3" }]);
    const { notionCreatePage } = await import("../../functions/notion");
    await notionCreatePage({ title: "T" });
    expect((calls[0]!.body as { parent: unknown }).parent).toEqual({ page_id: "default-parent" });
  });

  it("fails loudly with no parent, and never claims success without a page", async () => {
    mockFetch([]);
    const { notionCreatePage } = await import("../../functions/notion");
    await expect(notionCreatePage({ title: "T" })).rejects.toThrow(/No Notion parent/);

    mockFetch([{ object: "error", message: "nope" }]);
    await expect(notionCreatePage({ title: "T", parentPageId: PAGE_UUID })).rejects.toThrow(/did not confirm/);
  });

  it("resolves a database title to its id before creating", async () => {
    const calls = mockFetch([
      { results: [{ id: DB_UUID, title: "Tasks", type: "database" }] },
      { properties: { Task: { type: "title" } } },
      { object: "page", id: "p5", url: "u5" },
    ]);
    const { notionCreatePage } = await import("../../functions/notion");
    await notionCreatePage({ title: "Buy milk", databaseId: "Tasks" });
    expect(calls[0]!.url).toContain("/search");
    expect(calls[1]!.url).toContain("/databases/" + DB_UUID);
    const body = calls[2]!.body as { parent: unknown };
    expect(body.parent).toEqual({ database_id: DB_UUID });
  });

  it("falls back to the default parent when the given parent is inaccessible", async () => {
    process.env["NOTION_DEFAULT_PARENT_PAGE_ID"] = PAGE_UUID;
    const fakeDb = "b5b2e6e2-9f6d-4f5d-906d-9f6d9f6d9f6d"; // hallucinated id
    const calls = mockFetch([
      { __body: { message: "object_not_found" }, __status: 404 },
      { object: "page", id: "p6", url: "u6" },
    ]);
    const { notionCreatePage } = await import("../../functions/notion");
    const res = await notionCreatePage({ title: "T", databaseId: fakeDb });
    expect(calls[0]!.url).toContain("/databases/" + fakeDb);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { parent: unknown }).parent).toEqual({
      page_id: PAGE_UUID,
    });
    expect(res.id).toBe("p6");
    expect(res.parentFallback).toMatch(/not accessible/);
  });
});

describe("notionAppendBlocks", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["NOTION_API_KEY"] = "secret_test";
  });

  function mockFetch(responses: unknown[]) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
        return { ok: true, status: 200, json: async () => responses.shift() } as Response;
      })
    );
    return calls;
  }

  const UUID = "11111111-2222-4333-8444-555555555555";

  it("PATCHes children built from plain text onto the page", async () => {
    const calls = mockFetch([{ results: [{ id: "b1" }, { id: "b2" }] }]);
    const { notionAppendBlocks } = await import("../../functions/notion");
    const res = await notionAppendBlocks({
      pageId: UUID,
      content: "## Intro\n- point one\nplain line",
    });
    expect(res).toEqual({ pageId: UUID, appended: 2 });
    expect(calls[0]!.url).toContain(`/blocks/${UUID}/children`);
    const body = calls[0]!.body as { children: Array<{ type: string }> };
    expect(body.children.map((b) => b.type)).toEqual([
      "heading_2",
      "bulleted_list_item",
      "paragraph",
    ]);
  });

  it("rejects an append with no content and never invents a pageId", async () => {
    mockFetch([]);
    const { notionAppendBlocks } = await import("../../functions/notion");
    await expect(notionAppendBlocks({ pageId: "page-1" })).rejects.toThrow(/No content/);
    await expect(notionAppendBlocks({ pageId: "", content: "hi" })).rejects.toThrow(/pageId/);
  });

  it("resolves a page title to its id via search before PATCHing", async () => {
    const calls = mockFetch([
      { results: [{ id: UUID, title: "JARVIS TEST" }] },
      { results: [{ id: "b1" }] },
    ]);
    const { notionAppendBlocks } = await import("../../functions/notion");
    const res = await notionAppendBlocks({ pageId: "JARVIS TEST", content: "hello" });
    expect(res).toEqual({ pageId: UUID, appended: 1 });
    expect(calls[0]!.url).toContain("/search");
    expect(calls[1]!.url).toContain(`/blocks/${UUID}/children`);
  });

  it("fails loudly when the page title matches nothing", async () => {
    mockFetch([{ results: [] }]);
    const { notionAppendBlocks } = await import("../../functions/notion");
    await expect(
      notionAppendBlocks({ pageId: "NO SUCH PAGE", content: "x" })
    ).rejects.toThrow(/No Notion page found/);
  });
});
