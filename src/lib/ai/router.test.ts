/**
 * Unit tests for router.ts — request classification
 */
import { describe, it, expect } from "vitest";
import { routeRequest, getModelForRoute } from "./router";

describe("routeRequest", () => {
  it("routes image requests to VISION with the vision model", () => {
    const result = routeRequest("describe this", true);
    expect(result.route).toBe("VISION");
    expect(result.model).toBe("qwen2.5vl:7b");
  });

  it("routes app commands to AGENT", () => {
    expect(routeRequest("open Chrome", false).route).toBe("AGENT");
    expect(routeRequest("quit Spotify", false).route).toBe("AGENT");
    expect(routeRequest("set volume to 50", false).route).toBe("AGENT");
  });

  it("routes system queries to AGENT", () => {
    expect(routeRequest("what's my battery", false).route).toBe("AGENT");
    expect(routeRequest("list running apps", false).route).toBe("AGENT");
  });

  it("routes code requests to CODING", () => {
    expect(routeRequest("fix this bug", false).route).toBe("CODING");
    expect(routeRequest("implement a function", false).route).toBe("CODING");
    expect(routeRequest("write some TypeScript", false).route).toBe("CODING");
  });

  it("routes research requests to RESEARCH", () => {
    expect(routeRequest("research this topic", false).route).toBe("RESEARCH");
    expect(routeRequest("compare these options", false).route).toBe("RESEARCH");
    expect(routeRequest("analyze the data", false).route).toBe("RESEARCH");
  });

  it("routes reasoning requests to SMART", () => {
    expect(routeRequest("why does this happen", false).route).toBe("SMART");
    expect(routeRequest("explain this concept", false).route).toBe("SMART");
    expect(routeRequest("suggest an approach", false).route).toBe("SMART");
  });

  it("routes simple requests to FAST", () => {
    expect(routeRequest("hello", false).route).toBe("FAST");
    expect(routeRequest("what is 2+2", false).route).toBe("FAST");
    expect(routeRequest("yes", false).route).toBe("FAST");
  });

  it("routes long messages to SMART", () => {
    const longMsg = "a".repeat(600);
    expect(routeRequest(longMsg, false).route).toBe("SMART");
  });
});

describe("getModelForRoute", () => {
  it("returns the local chat model for text routes and vision model for VISION", () => {
    expect(getModelForRoute("FAST")).toBe("qwen2.5:14b");
    expect(getModelForRoute("SMART")).toBe("qwen2.5:14b");
    expect(getModelForRoute("RESEARCH")).toBe("qwen2.5:14b");
    expect(getModelForRoute("CODING")).toBe("qwen2.5:14b");
    expect(getModelForRoute("VISION")).toBe("qwen2.5vl:7b");
    expect(getModelForRoute("AGENT")).toBe("qwen2.5:14b");
  });
});
