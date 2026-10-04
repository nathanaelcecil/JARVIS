/**
 * Unit tests for guardrails.ts — permission logic
 */
import { describe, it, expect, beforeEach } from "vitest";
import { checkPermission, promoteTool, demoteTool, isTrusted, getTrustedTools } from "./guardrails";

describe("checkPermission", () => {
  it("returns auto for read-only tools", () => {
    expect(checkPermission("filesystem.list_directory")).toEqual({ allowed: true, permission: "auto" });
    expect(checkPermission("system.get_battery")).toEqual({ allowed: true, permission: "auto" });
    expect(checkPermission("desktop.list_running_apps")).toEqual({ allowed: true, permission: "auto" });
  });

  it("returns confirm for state-changing tools", () => {
    expect(checkPermission("desktop.open_app")).toEqual({ allowed: true, permission: "confirm" });
    expect(checkPermission("system.set_volume")).toEqual({ allowed: true, permission: "confirm" });
    expect(checkPermission("terminal.run_command")).toEqual({ allowed: true, permission: "confirm" });
  });

  it("returns never for destructive tools", () => {
    expect(checkPermission("system.shutdown")).toEqual({ allowed: false, permission: "never" });
    expect(checkPermission("system.factory_reset")).toEqual({ allowed: false, permission: "never" });
  });

  it("defaults to confirm for unknown tools", () => {
    expect(checkPermission("unknown.tool.name")).toEqual({ allowed: true, permission: "confirm" });
  });
});

describe("trust promotion", () => {
  beforeEach(() => {
    demoteTool("desktop.open_app");
    demoteTool("system.shutdown");
  });

  it("promotes confirm-tier tools to auto", () => {
    const result = promoteTool("desktop.open_app");
    expect(result).toBe(true);
    expect(checkPermission("desktop.open_app")).toEqual({ allowed: true, permission: "auto" });
  });

  it("cannot promote never-tier tools", () => {
    const result = promoteTool("system.shutdown");
    expect(result).toBe(false);
    expect(checkPermission("system.shutdown")).toEqual({ allowed: false, permission: "never" });
  });

  it("demotes tools back to default tier", () => {
    promoteTool("desktop.open_app");
    expect(isTrusted("desktop.open_app")).toBe(true);
    demoteTool("desktop.open_app");
    expect(isTrusted("desktop.open_app")).toBe(false);
    expect(checkPermission("desktop.open_app")).toEqual({ allowed: true, permission: "confirm" });
  });

  it("returns true for already-auto tools on promotion", () => {
    const result = promoteTool("system.get_battery");
    expect(result).toBe(true);
  });
});
