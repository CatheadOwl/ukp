import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliContext } from "../src/cli.ts";

const projectRoot = join(import.meta.dir, "..", "..");
const registryRoot = mkdtempSync(join(tmpdir(), "ukp-project-ground-truth-"));
const registryPath = join(registryRoot, "registry.toml");
const artifactRoot = join(registryRoot, "artifacts");
const workspace = join(registryRoot, "workspace");
const clientConfig = join(workspace, ".ukp", "client.toml");
const qmdPath = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
if (!qmdPath) throw new Error("qmd executable is required for project ground truth");
const qmdCommand = qmdPath.toLowerCase().endsWith(".ps1")
  ? [Bun.which("powershell.exe") ?? "powershell.exe", "-NoProfile", "-File", qmdPath]
  : [qmdPath];

const endpoints = [
  ["ukp-product", join(projectRoot, "product")],
  ["ukp-development", join(projectRoot, "development")],
  ["ukp-meeting-room", join(projectRoot, "meeting_room")],
] as const;

function call(args: string[], currentDirectory = projectRoot, overrides: Partial<CliContext> = {}) {
  let stdout = "";
  let stderr = "";
  const context: CliContext = {
    currentDirectory,
    registryPath,
    qmdCommand,
    artifactRoot,
    ...overrides,
  };
  const exitCode = runCli(args, (value) => { stdout += String(value); }, (value) => { stderr += String(value); }, context);
  return { exitCode, stdout, stderr };
}

function directQmd(folder: string, query: string, limit: number): unknown {
  const result = spawnSync(qmdCommand[0]!, [...qmdCommand.slice(1), "search", query, "-n", String(limit), "--format", "json"], {
    cwd: folder,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  for (const [, folder] of endpoints) {
    const diagnosed = call(["diagnose"], folder);
    assert.equal(diagnosed.exitCode, 0, diagnosed.stderr);
  }

  for (const [, folder] of endpoints) {
    const registered = call(["register"], folder);
    assert.equal(registered.exitCode, 0, registered.stderr);
  }

  const listed = call(["list"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n").map((line) => line.split("\t")[0]), [
    "ukp-development",
    "ukp-meeting-room",
    "ukp-product",
  ]);

  assert.equal(call(["unregister", "ukp-meeting-room"]).exitCode, 0);
  assert.equal(call(["register"], join(projectRoot, "meeting_room")).exitCode, 0);

  mkdirSync(join(workspace, ".ukp"), { recursive: true });
  writeFileSync(clientConfig, "default_endpoints = [\"ukp-product\", \"ukp-development\"]\n", "utf8");
  const clientScoped = call(["search", "atomic capability", "--limit", "3", "--json"], workspace, {
    artifactRunId: "client-scope",
  });
  assert.equal(clientScoped.exitCode, 0, clientScoped.stderr);
  const clientEnvelope = JSON.parse(clientScoped.stdout);
  assert.deepEqual(clientEnvelope.endpoints.map((endpoint: { name: string }) => endpoint.name), [
    "ukp-product",
    "ukp-development",
  ]);

  rmSync(clientConfig, { force: true });
  const fallback = call(["search", "atomic capability", "--limit", "3", "--json"], workspace, {
    artifactRunId: "global-fallback",
  });
  assert.equal(fallback.exitCode, 0, fallback.stderr);
  const fallbackEnvelope = JSON.parse(fallback.stdout);
  assert.deepEqual(fallbackEnvelope.endpoints.map((endpoint: { name: string }) => endpoint.name), [
    "ukp-development",
    "ukp-meeting-room",
    "ukp-product",
  ]);

  for (const [name, folder] of endpoints) {
    const endpoint = fallbackEnvelope.endpoints.find((candidate: { name: string }) => candidate.name === name);
    assert.ok(endpoint?.artifact, `missing artifact for ${name}`);
    assert.deepEqual(JSON.parse(readFileSync(endpoint.artifact, "utf8")), directQmd(folder, "atomic capability", 3));
  }

  process.stdout.write("project ground truth: diagnose/register/list/unregister, client scope, registry fallback, and direct QMD parity passed\n");
} finally {
  rmSync(registryRoot, { recursive: true, force: true });
}
