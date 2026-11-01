import { describe, expect, it } from "vitest";
import { formatConfirmArgs } from "./confirm-format";

describe("formatConfirmArgs", () => {
  it("keeps a multi-line command byte-for-byte", () => {
    const command = "echo first\n  echo second &&\n\techo third";
    const formatted = formatConfirmArgs("run_command", { command });
    expect(formatted.command).toBe(command);
    expect(formatted.command).toContain("\n");
    expect(formatted.command).toContain("\t");
  });

  it("never truncates a long command", () => {
    const command = `echo ${"a".repeat(5000)}; rm -rf /tmp/target`;
    const formatted = formatConfirmArgs("run_command", { command });
    expect(formatted.command).toBe(command);
    expect(formatted.command).toHaveLength(command.length);
    // The dangerous tail must be visible, not cut off.
    expect(formatted.command?.endsWith("rm -rf /tmp/target")).toBe(true);
  });

  it("keeps leading/trailing spaces so invisible whitespace is visible", () => {
    const command = "   ls   ";
    expect(formatConfirmArgs("run_command", { command }).command).toBe("   ls   ");
  });

  it("extracts the command for background jobs too", () => {
    const formatted = formatConfirmArgs("run_background", { command: "sleep 1", cwd: "/tmp" });
    expect(formatted.command).toBe("sleep 1");
    expect(formatted.fields).toEqual([{ key: "cwd", value: "/tmp" }]);
  });

  it("renders other arguments on their own lines and pretty-prints objects", () => {
    const formatted = formatConfirmArgs("browser_fill_form", {
      fields: [{ selector: "#q", value: "x" }],
      submitSelector: "#go",
    });
    expect(formatted.command).toBeNull();
    expect(formatted.fields.map((f) => f.key)).toEqual(["fields", "submitSelector"]);
    expect(formatted.fields[0]!.value).toContain("\n");
    expect(formatted.fields[1]).toEqual({ key: "submitSelector", value: "#go" });
  });

  it("skips an injected signal object", () => {
    const formatted = formatConfirmArgs("open_app", {
      name: "Safari",
      signal: new AbortController().signal,
    });
    expect(formatted.fields).toEqual([{ key: "name", value: "Safari" }]);
  });
});
