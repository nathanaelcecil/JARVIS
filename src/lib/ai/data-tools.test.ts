/**
 * Unit tests for data-tools.ts — rule plans, planner parsing, result context
 */
import { describe, it, expect } from "vitest";
import {
  deterministicPlan,
  parsePlan,
  looksLikeDataRequest,
  buildToolContext,
  hasUnplannedServices,
  plannerSystemPrompt,
} from "./data-tools";

const NOW = new Date(2026, 9, 4, 12, 0, 0); // 4 Oct 2026, local

describe("deterministicPlan", () => {
  it("lists recent mail for 'latest mail'", () => {
    expect(deterministicPlan("Hey jarvis what is my latest mail", NOW)).toEqual([
      { tool: "gmail_list_recent", args: { maxResults: 5 } },
    ]);
  });

  it("filters unread mail", () => {
    const plan = deterministicPlan("any unread emails?", NOW);
    expect(plan[0]?.args).toEqual({ query: "in:inbox is:unread", maxResults: 5 });
  });

  it("defers searches to the planner", () => {
    expect(deterministicPlan("find the email from alice about invoices", NOW)).toEqual([]);
  });

  it("never plans a send or write", () => {
    expect(deterministicPlan("send an email to bob", NOW)).toEqual([]);
    expect(deterministicPlan("add a meeting to my calendar", NOW)).toEqual([]);
  });

  it("reads today's calendar with defaults", () => {
    expect(deterministicPlan("what's on my calendar today", NOW)).toEqual([
      { tool: "calendar_list_events", args: {} },
    ]);
  });

  it("builds a tomorrow window", () => {
    const plan = deterministicPlan("what meetings do I have tomorrow", NOW);
    expect(plan[0]?.tool).toBe("calendar_list_events");
    const a = plan[0]!.args as { timeMin: string; timeMax: string };
    expect(new Date(a.timeMin).getDate()).toBe(5);
    expect(new Date(a.timeMax).getDate()).toBe(6);
  });

  it("defers other dates to the planner", () => {
    expect(deterministicPlan("what is on my calendar next month", NOW)).toEqual([]);
  });

  it("ignores unrelated requests", () => {
    expect(deterministicPlan("what is the weather", NOW)).toEqual([]);
  });

  it("plans every service a multi-service message names", () => {
    expect(deterministicPlan("check my email and calendar", NOW)).toEqual([
      { tool: "gmail_list_recent", args: { maxResults: 5 } },
      { tool: "calendar_list_events", args: {} },
    ]);
    expect(deterministicPlan("latest mail, and what meetings do I have tomorrow", NOW)).toEqual([
      { tool: "gmail_list_recent", args: { maxResults: 5 } },
      {
        tool: "calendar_list_events",
        args: {
          timeMin: new Date(2026, 9, 5).toISOString(),
          timeMax: new Date(2026, 9, 6).toISOString(),
        },
      },
    ]);
  });
});

describe("hasUnplannedServices", () => {
  it("flags named services that have not run yet", () => {
    expect(
      hasUnplannedServices("check my email and calendar", [
        { tool: "gmail_list_recent", args: {} },
      ])
    ).toBe(true);
    expect(
      hasUnplannedServices("check my email and calendar", [
        { tool: "gmail_list_recent", args: {} },
        { tool: "calendar_list_events", args: {} },
      ])
    ).toBe(false);
    expect(hasUnplannedServices("search notion for JARVIS TEST", [])).toBe(true);
    expect(
      hasUnplannedServices("search notion for JARVIS TEST", [
        { tool: "notion_search", args: {} },
      ])
    ).toBe(false);
    expect(hasUnplannedServices("what is the weather", [])).toBe(false);
  });
});

describe("planner prompt", () => {
  it("offers the Gmail/Calendar write tools and never refuses them", () => {
    const p = plannerSystemPrompt(new Date(2026, 9, 4));
    for (const t of [
      "gmail_send_email",
      "gmail_reply_email",
      "gmail_forward_email",
      "calendar_create_event",
      "calendar_update_event",
      "calendar_delete_event",
    ]) {
      expect(p).toContain(t);
    }
    expect(p).not.toContain("NOT available");
    expect(p).toContain("Never invent ids");
  });
});

describe("parsePlan", () => {
  it("parses clean JSON", () => {
    expect(parsePlan('{"tools":[{"tool":"notion_search","args":{"query":"JARVIS TEST"}}]}')).toEqual([
      { tool: "notion_search", args: { query: "JARVIS TEST" } },
    ]);
  });

  it("tolerates code fences and chatter", () => {
    const raw = 'Sure!\n```json\n{"tools":[{"tool":"gmail_search","args":{"query":"from:bob"}}]}\n```';
    expect(parsePlan(raw)[0]?.tool).toBe("gmail_search");
  });

  it("drops unknown tools and bad shapes", () => {
    expect(parsePlan('{"tools":[{"tool":"run_command","args":{"command":"rm -rf /"}}]}')).toEqual([]);
    expect(parsePlan("not json")).toEqual([]);
    expect(parsePlan('{"tools":"nope"}')).toEqual([]);
  });

  it("drops plans with unresolved template placeholders", () => {
    const t = '{"tool":"notion_read_page","args":{"pageId":"{{notion_search.0.id}}"}}';
    expect(parsePlan(`{"tools":[${t}]}`)).toEqual([]);
    expect(
      parsePlan('{"tools":[{"tool":"notion_append_blocks","args":{"pageId":"3ef62db4","content":"hi"}}]}')
    ).toHaveLength(1);
  });

  it("caps a plan at three tools", () => {
    const t = '{"tool":"notion_search","args":{"query":"x"}}';
    expect(parsePlan(`{"tools":[${t},${t},${t},${t}]}`)).toHaveLength(3);
  });
});

describe("looksLikeDataRequest / buildToolContext", () => {
  it("detects data intent", () => {
    expect(looksLikeDataRequest("check my inbox")).toBe(true);
    expect(looksLikeDataRequest("write to notion")).toBe(true);
    expect(looksLikeDataRequest("open Chrome")).toBe(false);
    // Follow-ups that never repeat the keyword are caught via recent history.
    expect(
      looksLikeDataRequest(
        "add an introduction about yourself below these lines on the same page",
        "user: What is written on JARVIS TEST page on my notion profile"
      )
    ).toBe(true);
  });

  it("embeds results and returns nothing when there are none", () => {
    expect(buildToolContext([])).toBe("");
    const ctx = buildToolContext([
      { tool: "gmail_list_recent", args: {}, result: { messages: [{ subject: "Hello" }] } },
    ]);
    expect(ctx).toContain("LIVE TOOL RESULTS");
    expect(ctx).toContain("Hello");
  });
});
