import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS, renderHelp, renderSearchHelp, runCli } from "../src/cli.ts";

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

  test("search help documents selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderSearchHelp()).toContain("Usage: ukp search <query>");
    expect(runCli(["search", "--help"], (message) => output.push(message))).toBe(0);
    expect(output.join("\n")).toContain("-c <endpoint>");
    expect(output.join("\n")).toContain("-g                  search every endpoint");
  });

  test("search usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["search", "query", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("Run 'ukp search --help' for details.");
  });

  test("empty Registry search explains how to recover", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-empty-"));
    const output: string[] = [];
    expect(runCli(["search", "query", "--json"], (message) => output.push(message), undefined, {
      currentDirectory: root,
      registryPath: join(root, "registry.toml"),
      artifactRoot: join(root, "artifacts"),
    })).toBe(1);
    expect(output.join("\n")).toContain("the Host Registry is empty");
    expect(output.join("\n")).toContain("ukp register");
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
