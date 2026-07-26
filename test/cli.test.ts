import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS, renderHelp, runCli } from "../src/cli.ts";

describe("CLI bootstrap", () => {
  test("renders every P0 command in help", () => {
    const help = renderHelp();
    for (const [name] of COMMANDS) {
      expect(help).toContain(name);
    }
  });

  test("help exits successfully", () => {
    const output: string[] = [];
    expect(runCli(["--help"], (message) => output.push(message))).toBe(0);
    expect(output.join("\n")).toContain("Usage: ukp");
  });

  test("unknown command is a usage error", () => {
    const errors: string[] = [];
    expect(runCli(["wat"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown command");
  });

  test("register, list, and unregister form an inventory lifecycle", () => {
    const fixture = join(import.meta.dir, "fixtures", "qmd-provider");
    const registryPath = join(mkdtempSync(join(tmpdir(), "ukp-cli-")), "registry.toml");
    const context = {
      currentDirectory: fixture,
      registryPath,
      resolveProvider: () => ({ supported: true }),
    };
    const output: string[] = [];
    expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.join("\n")).toContain("fixture-qmd");
    expect(runCli(["unregister", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.at(-1)).toBe("No endpoints registered.");
  });
});
