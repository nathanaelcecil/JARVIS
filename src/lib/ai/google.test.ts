/**
 * Gmail send/reply/forward + Calendar create/update/delete — payload checks
 * with mocked fetch and mocked OAuth (auth itself is tested in google-auth.test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../functions/google-auth", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
}));

type MockResp = { __body: unknown; __status: number };
const ok = (body: unknown, status = 200): MockResp => ({ __body: body, __status: status });

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function mockFetch(responses: Array<unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const next = responses.shift();
      const isWrapped =
        next !== null && typeof next === "object" && "__status" in (next as object);
      const body = isWrapped ? (next as MockResp).__body : next;
      const status = isWrapped ? (next as MockResp).__status : 200;
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
      });
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

describe("calendar writes", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["GOOGLE_CLIENT_ID"];
  });

  it("creates an event and defaults end to start + 30 min", async () => {
    const calls = mockFetch([
      ok({
        id: "evt1",
        htmlLink: "https://calendar.google.com/evt1",
        summary: "JARVIS test plan",
        start: { dateTime: "2026-10-11T16:00:00+05:30" },
      }),
    ]);
    const { calendarCreateEvent } = await import("../../functions/google-calendar");
    const res = await calendarCreateEvent({
      summary: "JARVIS test plan",
      start: "2026-10-11T16:00:00+05:30",
      timeZone: "Asia/Kolkata",
      location: "Office",
    });
    expect(res).toEqual({
      id: "evt1",
      htmlLink: "https://calendar.google.com/evt1",
      summary: "JARVIS test plan",
      start: "2026-10-11T16:00:00+05:30",
      created: true,
    });
    expect(calls[0]!.url).toContain("/calendars/primary/events");
    expect(calls[0]!.method).toBe("POST");
    const body = calls[0]!.body as {
      summary: string;
      start: { dateTime: string; timeZone?: string };
      end: { dateTime: string; timeZone?: string };
      location?: string;
    };
    expect(body.summary).toBe("JARVIS test plan");
    expect(body.start.timeZone).toBe("Asia/Kolkata");
    expect(body.end.timeZone).toBe("Asia/Kolkata");
    expect(body.location).toBe("Office");
    expect(new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime()).toBe(
      30 * 60 * 1000
    );
  });

  it("rejects a create without title or start and never calls the API", async () => {
    const calls = mockFetch([]);
    const { calendarCreateEvent } = await import("../../functions/google-calendar");
    await expect(
      calendarCreateEvent({ summary: "", start: "2026-10-11T16:00:00Z" })
    ).rejects.toThrow(/summary/);
    await expect(
      calendarCreateEvent({ summary: "x", start: "" })
    ).rejects.toThrow(/start/);
    expect(calls).toHaveLength(0);
  });

  it("updates only the provided fields", async () => {
    const calls = mockFetch([ok({ id: "evt1", summary: "Renamed" })]);
    const { calendarUpdateEvent } = await import("../../functions/google-calendar");
    const res = await calendarUpdateEvent({ eventId: "evt1", summary: "Renamed" });
    expect(res).toEqual({ id: "evt1", summary: "Renamed", updated: true });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/calendars/primary/events/evt1");
    expect(Object.keys(calls[0]!.body!)).toEqual(["summary"]);
  });

  it("rejects updates with no eventId or no fields", async () => {
    mockFetch([]);
    const { calendarUpdateEvent } = await import("../../functions/google-calendar");
    await expect(calendarUpdateEvent({ eventId: "", summary: "x" })).rejects.toThrow(/eventId/);
    await expect(calendarUpdateEvent({ eventId: "evt1" })).rejects.toThrow(/No fields/);
  });

  it("deletes with DELETE and treats 204 as success", async () => {
    const calls = mockFetch([ok(null, 204)]);
    const { calendarDeleteEvent } = await import("../../functions/google-calendar");
    const res = await calendarDeleteEvent({ eventId: "evt1" });
    expect(res).toEqual({ id: "evt1", deleted: true });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/calendars/primary/events/evt1");
  });
});

describe("gmail writes", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["GOOGLE_CLIENT_ID"];
  });

  it("sends a new email as base64url RFC822", async () => {
    const calls = mockFetch([ok({ id: "m1", threadId: "t1" })]);
    const { gmailSendEmail } = await import("../../functions/gmail");
    const res = await gmailSendEmail({
      to: "nathanaelcecil@gmail.com",
      subject: "JARVIS test",
      body: "Hello from JARVIS.",
    });
    expect(res).toEqual({
      id: "m1",
      threadId: "t1",
      sent: true,
      to: "nathanaelcecil@gmail.com",
    });
    expect(calls[0]!.url).toContain("/users/me/messages/send");
    expect(calls[0]!.method).toBe("POST");
    const raw = Buffer.from((calls[0]!.body as { raw: string }).raw, "base64url").toString("utf-8");
    expect(raw).toContain("To: nathanaelcecil@gmail.com");
    expect(raw).toContain("Subject: JARVIS test");
    expect(raw).toContain("Hello from JARVIS.");
  });

  it("rejects a send with no recipient", async () => {
    const calls = mockFetch([]);
    const { gmailSendEmail } = await import("../../functions/gmail");
    await expect(gmailSendEmail({ to: "  ", subject: "s", body: "b" })).rejects.toThrow(
      /recipient/
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a name instead of an email address, without calling the API", async () => {
    const calls = mockFetch([]);
    const { gmailSendEmail, gmailForwardEmail } = await import("../../functions/gmail");
    await expect(gmailSendEmail({ to: "Alice", subject: "s", body: "b" })).rejects.toThrow(
      /full address/
    );
    await expect(
      gmailForwardEmail({ messageId: "m0", to: "Bob Smith" })
    ).rejects.toThrow(/full address/);
    expect(calls).toHaveLength(0);
  });

  it("replies in-thread to the original sender", async () => {
    const calls = mockFetch([
      ok({
        id: "m0",
        threadId: "thr9",
        payload: {
          headers: [
            { name: "Message-ID", value: "<abc@mail.gmail.com>" },
            { name: "Subject", value: "Weekly report" },
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "References", value: "<old@mail>" },
          ],
        },
      }),
      ok({ id: "m2", threadId: "thr9" }),
    ]);
    const { gmailReplyEmail } = await import("../../functions/gmail");
    const res = await gmailReplyEmail({ messageId: "m0", body: "Thanks, Alice." });
    expect(res.sent).toBe(true);
    expect(res.to).toBe("alice@example.com");
    expect(calls[0]!.url).toContain("/messages/m0?format=metadata");
    expect(calls[1]!.method).toBe("POST");
    const sent = calls[1]!.body as { raw: string; threadId?: string };
    expect(sent.threadId).toBe("thr9");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf-8");
    expect(raw).toContain("To: alice@example.com");
    expect(raw).toContain("Subject: Re: Weekly report");
    expect(raw).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(raw).toContain("References: <old@mail> <abc@mail.gmail.com>");
    expect(raw).toContain("Thanks, Alice.");
  });

  it("forwards with the quoted original", async () => {
    const bodyData = Buffer.from("Original content here").toString("base64url");
    const calls = mockFetch([
      ok({
        payload: {
          headers: [
            { name: "Subject", value: "Budget" },
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "To", value: "me@example.com" },
            { name: "Date", value: "Mon, 1 Oct 2026 10:00:00 +0000" },
          ],
          body: { data: bodyData },
        },
        snippet: "Original content here",
      }),
      ok({ id: "m3", threadId: "" }),
    ]);
    const { gmailForwardEmail } = await import("../../functions/gmail");
    const res = await gmailForwardEmail({
      messageId: "m0",
      to: "carol@example.com",
      note: "FYI",
    });
    expect(res).toEqual({ id: "m3", threadId: "", sent: true, to: "carol@example.com" });
    expect(calls[0]!.url).toContain("/messages/m0?format=full");
    const sent = calls[1]!.body as { raw: string };
    const raw = Buffer.from(sent.raw, "base64url").toString("utf-8");
    expect(raw).toContain("To: carol@example.com");
    expect(raw).toContain("Subject: Fwd: Budget");
    expect(raw).toContain("FYI");
    expect(raw).toContain("---------- Forwarded message ----------");
    expect(raw).toContain("Original content here");
  });
});
