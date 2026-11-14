import {
  executeKitCommand,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  KitUsageError,
  type KitCommandResult,
  type KitParsed,
  type UkpCommandSpec,
} from "./kit.ts";
import { parseRemoteUrl, readRegistry } from "../registry.ts";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { certSanOf, normalizeTlsSanEntry, spkiPinOf } from "../capabilities/tls-identity.ts";
import { fetchDoorDocument } from "../capabilities/remote-client.ts";
import { DISCOVERY_PATH, startUkpServer, type ServeInfo } from "../server.ts";
import { printTaskPreflightError, renderServeTaskArtifacts, writeServeTaskArtifacts, type ServeTaskTls } from "./serve-task.ts";
import { acquireLock, releaseLock, LockBusyError } from "../fslock.ts";
import {
  appendTokenLine,
  loadTokenFile,
  mintTokenFileKey,
  parseTokenFileText,
  removeTokenLines,
  storeTokenFile,
  TokenFileUsageError,
  type TokenFileEntry,
} from "../plumbing/token-file.ts";

export interface ServeCommandContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  /** Overrides `process.env.UKP_SERVE_TOKEN` for tests. */
  tokens?: readonly string[];
  /** Overrides the home directory the serve token file and the
   * `--print-task --write` artifacts resolve into (tests point this at a
   * scratch home; production resolves the real user home). */
  homeDir?: string;
}

/** `UKP_SERVE_TOKEN=a,b,c` (RQ-16): comma-separated, trimmed, empty entries
 * dropped — any listed token authorizes. */
function parseServeTokens(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** W13 / RQ-16c rehearsal point A: the labeled token file lives at
 * `~/.ukp/tokens` (0600, hash-only rows) beside the registry — the app-dot
 * directory plus 0600 is the CLI credential-file standard shape. */
export function serveTokenFilePath(context: ServeCommandContext): string {
  return join(context.homeDir ?? homedir(), ".ukp", "tokens");
}

/** W13 chain order (rehearsal point D), as one testable resolution: env
 * tokens win outright — while set, the file is not consulted at all (AWS/
 * gh/kubectl chain order; an empty env value parses to no tokens and falls
 * through to the file, the same mainstream treatment of empty-as-unset).
 * Otherwise the file arms the gate ONLY when it exists AND holds at least
 * one parseable key — a missing or keyless file leaves admission exactly
 * where RQ-18 put it (both sources absent ⇒ --allow-anonymous decides), so
 * an anonymous door is not walled off by an empty file. A present but
 * malformed file is a loud startup refusal instead (never half-arm). The
 * source decision is startup-time; once armed, the file's CONTENT is
 * fresh per request (delete every line ⇒ everyone 401s, fail closed). */
export function resolveServeAuthSources(
  envTokens: readonly string[],
  homeDir: string,
): { tokens: readonly string[]; tokenFilePath?: string } | { error: string } {
  if (envTokens.length > 0) return { tokens: envTokens };
  const path = join(homeDir, ".ukp", "tokens");
  const loaded = loadTokenFile(path);
  if ("error" in loaded) return { error: loaded.error };
  if ("missing" in loaded) return { tokens: [] };
  const parsed = parseTokenFileText(loaded.text);
  if ("error" in parsed) {
    return {
      error: `token file ${path} line ${parsed.error.line}: ${parsed.error.message} (fix the line, or move the file away and reissue with 'ukp serve token add')`,
    };
  }
  return parsed.entries.length > 0 ? { tokens: [], tokenFilePath: path } : { tokens: [] };
}

/** Read the current managed text under the write-discipline lock. A missing
 * file is the empty state; anything else (unreadable, over-open
 * permissions, format errors) is a loud failure — the token file is a
 * credential store, and silent degradation here would half-arm a gate. */
function loadManagedTokenText(path: string): { text: string; entries: TokenFileEntry[] } {
  const loaded = loadTokenFile(path);
  if ("missing" in loaded) return { text: "", entries: [] };
  if ("error" in loaded) throw new Error(loaded.error);
  const parsed = parseTokenFileText(loaded.text);
  if ("error" in parsed) {
    throw new Error(
      `token file ${path} line ${parsed.error.line}: ${parsed.error.message} (fix the line, or move the file away and reissue with 'ukp serve token add')`,
    );
  }
  return { text: loaded.text, entries: parsed.entries };
}

/** `ukp serve token add|list|revoke` (W13 / RQ-16c, rehearsal point B):
 * the issuance face for the labeled token file — minting, hashing, and the
 * 0600 discipline are not hand-editing material, so the command owns the
 * file's managed rewrites (append/remove preserve comment lines) under the
 * same write-discipline lock propose uses. The raw key is printed exactly
 * once, at mint time; the file never holds it. */
function executeServeTokenCommand(
  args: readonly string[],
  context: ServeCommandContext,
): KitCommandResult {
  const [verb, ...rest] = args;
  const path = serveTokenFilePath(context);
  const usage = "usage: ukp serve token add <label> <scopes> | ukp serve token list | ukp serve token revoke <label> (scopes: notes:ro,cad:rw - Docker-registry style; full access is '*:rw')";
  if (verb === undefined) throw new KitUsageError(usage);

  if (verb === "add") {
    const [label, scopesSpec] = rest;
    if (rest.length !== 2 || label === undefined || scopesSpec === undefined) {
      throw new KitUsageError(`serve token add takes <label> <scopes> (${usage})`);
    }
    let minted;
    try {
      minted = mintTokenFileKey(label, scopesSpec);
    } catch (error) {
      if (error instanceof TokenFileUsageError) throw new KitUsageError(error.message);
      throw error;
    }
    const { sameLabel } = withTokenFileLock(path, () => {
      const current = loadManagedTokenText(path);
      const sameLabel = current.entries.filter((entry) => entry.label === label).length;
      storeTokenFile(path, appendTokenLine(current.text, minted.line));
      return { sameLabel };
    });
    const rotation = sameLabel > 0
      ? `\nlabel '${label}' already had ${sameLabel} active key(s); both remain valid until revoked (zero-downtime rotation).`
      : "";
    return {
      exitCode: 0,
      stdout: [
        `issued key for '${label}' (scopes: ${scopesSpec})`,
        "",
        `  ${minted.token}`,
        "",
        `stored in ${path} (0600, hash-only). The raw key is shown ONCE - hand it to the client now.${rotation}`,
        "The serve gate re-reads the file on every request: revoking needs no restart",
        `('ukp serve token revoke ${label}' or delete the line).`,
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  if (verb === "list") {
    if (rest.length > 0) throw new KitUsageError(`serve token list takes no arguments (${usage})`);
    const loaded = loadTokenFile(path);
    if ("missing" in loaded) {
      return {
        exitCode: 0,
        stdout: `no token file at ${path} - issue a key with 'ukp serve token add <label> <scopes>'\n`,
        stderr: "",
      };
    }
    if ("error" in loaded) throw new Error(loaded.error);
    const parsed = parseTokenFileText(loaded.text);
    if ("error" in parsed) {
      throw new Error(`token file ${path} line ${parsed.error.line}: ${parsed.error.message}`);
    }
    if (parsed.entries.length === 0) {
      return {
        exitCode: 0,
        stdout: `token file ${path} holds no keys (only comments) - issue one with 'ukp serve token add <label> <scopes>'\n`,
        stderr: "",
      };
    }
    const labelWidth = Math.max(...parsed.entries.map((entry) => entry.label.length), "label".length);
    const idWidth = Math.max(...parsed.entries.map((entry) => entry.keyId.length), "key-id".length);
    const rows = parsed.entries.map((entry) =>
      `  ${entry.label.padEnd(labelWidth)}  ${entry.keyId.padEnd(idWidth)}  ${
        Object.entries(entry.scopes).map(([name, access]) => `${name}:${access}`).join(",")
      }`);
    return {
      exitCode: 0,
      stdout: [
        `token file ${path} - ${parsed.entries.length} key(s) (hashes omitted; revoke deletes the whole label)`,
        `  ${"label".padEnd(labelWidth)}  ${"key-id".padEnd(idWidth)}  scopes`,
        ...rows,
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  if (verb === "revoke") {
    const [label] = rest;
    if (rest.length !== 1 || label === undefined) {
      throw new KitUsageError(`serve token revoke takes <label> (${usage})`);
    }
    const removed = withTokenFileLock(path, () => {
      const current = loadManagedTokenText(path);
      const result = removeTokenLines(current.text, label);
      if (result.removed === 0) {
        const labels = [...new Set(current.entries.map((entry) => entry.label))];
        throw new KitUsageError(
          `no key with label '${label}' in ${path}${labels.length > 0 ? ` (labels present: ${labels.join(", ")})` : " (the file holds no keys)"}`,
        );
      }
      storeTokenFile(path, result.text);
      return result.removed;
    });
    return {
      exitCode: 0,
      stdout: [
        `revoked ${removed} key(s) with label '${label}' from ${path}`,
        "a running gate stops accepting them on the next request (fresh read - no restart needed).",
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  throw new KitUsageError(`unknown serve token verb '${verb}' (${usage})`);
}

// W16 / ADR-REM-015: the owner-side door faces. `status` is the read-only
// self-description the four-step ceremony lacked — the door's own well-known
// document is the authority for what it serves right now, the machine home
// answers for the token file, the TLS identity, and the task-vs-manual
// deployment shape; process command lines are deliberately NOT productized
// here. `share` validates a name against the live roster, mints the
// exactly-aligned key through the same mint path `token add` uses, and emits
// the consumer's paste-ready register command with the raw key embedded
// (shown once — the same disclosure face as token add; share never sends
// anything anywhere itself).

/** The door's self-signed identity, as persisted in the machine home at
 * serve time: the host door keeps the flat `tls/cert.pem`; a single-endpoint
 * door keeps `tls/<endpoint>/cert.pem` (the same per-endpoint residence the
 * server resolves). Present = the door (when up) speaks https and this cert
 * is the anchor a registering client pins. */
function doorIdentityCert(registryPath: string): string | undefined {
  const certPath = join(dirname(registryPath), "tls", "cert.pem");
  return existsSync(certPath) ? readFileSync(certPath, "utf8") : undefined;
}

/** Candidate door identities in the machine home, in probe order: the
 * preferred endpoint's own identity first (the caller names it when it
 * knows — share does), then the flat host-door cert, then every other
 * per-endpoint identity sorted. One resolution rule for every face and
 * every door shape: the probe anchors against the same material the door
 * serves, and when nothing anchors a live https door the verdict is "TLS
 * could not be anchored", never "not answering". */
function doorIdentityCandidates(registryPath: string, preferEndpoint?: string): string[] {
  const tlsDir = join(dirname(registryPath), "tls");
  const candidates: string[] = [];
  if (preferEndpoint !== undefined) {
    const preferred = join(tlsDir, preferEndpoint, "cert.pem");
    if (existsSync(preferred)) candidates.push(preferred);
  }
  const flat = join(tlsDir, "cert.pem");
  if (existsSync(flat)) candidates.push(flat);
  let names: string[] = [];
  try {
    names = readdirSync(tlsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // no tls dir: no identities in the machine home at all
  }
  for (const name of names) {
    const path = join(tlsDir, name, "cert.pem");
    if (!candidates.includes(path) && existsSync(path)) candidates.push(path);
  }
  return candidates;
}

type DoorProbe =
  | { state: "up"; origin: string; scheme: "http" | "https"; roster: string[]; bearerRequired: boolean; identityCert?: string }
  | { state: "down"; origin: string; scheme: "http" | "https"; reason: string }
  /** Something answered at the origin but it is not a ukp service — a
   * different beast from a dead address (walkthrough N4, 2026-11-13: a
   * non-door response must not read as "the address did not answer"). */
  | { state: "not-a-door"; origin: string; scheme: "http" | "https"; reason: string }
  | { state: "single-endpoint"; origin: string; identityCert?: string }
  /** The address answered but no machine-home identity anchored its TLS —
   * "cannot anchor trust" and "unreachable" are different verdicts; a live
   * door must not read as dead (trust-anchor resolution discipline:
   * one rule for every operation type, honest failure when unanchorable). */
  | { state: "tls-unanchored"; origin: string; scheme: "http" | "https"; reason: string };

/** One well-known fetch against a door origin: the live roster's only
 * authority. `scheme` is the caller's stated scheme; the machine home's
 * persisted identities anchor https the same TOFU way registration does,
 * tried in candidate order (an operator-certificate door validates
 * normally without them). */
async function probeDoorOrigin(input: {
  origin: string;
  scheme: "http" | "https";
  registryPath: string;
  preferEndpoint?: string;
}): Promise<DoorProbe> {
  const attempts: (string | undefined)[] = input.scheme === "https"
    ? (() => {
      const candidates = doorIdentityCandidates(input.registryPath, input.preferEndpoint);
      return candidates.length > 0 ? candidates : [undefined];
    })()
    : [undefined];
  let lastMessage = "";
  let anchoredCert: string | undefined;
  for (const certPath of attempts) {
    const cert = certPath !== undefined ? readFileSync(certPath, "utf8") : undefined;
    try {
      const door = await fetchDoorDocument(input.origin, {
        displayUrl: input.origin,
        ...(input.scheme === "https" && cert !== undefined ? { tlsAnchor: { ca: cert } } : {}),
      });
      return {
        state: "up",
        origin: input.origin,
        scheme: input.scheme,
        roster: door.doc.endpoints.map((endpoint) => endpoint.name),
        bearerRequired: door.bearerRequired,
        ...(cert !== undefined ? { identityCert: cert } : {}),
      };
    } catch (error) {
      lastMessage = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
      // A TLS verification failure means the door answered and this
      // candidate did not match — the next identity may anchor it. Any
      // connection-level verdict (refused / reset / timeout / resolve) or a
      // body-level one (a ukp document that is not a host door) ends the
      // ladder; in the latter the attempt's identity did anchor TLS.
      if (input.scheme !== "https" || !/TLS verification failed/.test(lastMessage)) {
        if (cert !== undefined) anchoredCert = cert;
        break;
      }
    }
  }
  if (input.scheme === "https" && anchoredCert === undefined && /TLS verification failed/.test(lastMessage)) {
    return { state: "tls-unanchored", origin: input.origin, scheme: input.scheme, reason: lastMessage };
  }
  if (lastMessage.includes("is not a host door")) {
    return { state: "single-endpoint", origin: input.origin, ...(anchoredCert !== undefined ? { identityCert: anchoredCert } : {}) };
  }
  if (lastMessage.includes("is not a ukp-remote service") || lastMessage.includes("returned a non-JSON body")) {
    return { state: "not-a-door", origin: input.origin, scheme: input.scheme, reason: lastMessage };
  }
  return { state: "down", origin: input.origin, scheme: input.scheme, reason: lastMessage };
}

/** `--host/--port/--tls`, the probe's knobs (status and share share them). */
function parseDoorProbeArgs(args: readonly string[], usage: string): { host: string; port: number; forceTls: boolean } {
  let host = "127.0.0.1";
  let port = 8570;
  let forceTls = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--tls") {
      forceTls = true;
    } else if (arg === "--host") {
      host = args[index + 1] ?? "";
      index += 1;
    } else if (arg === "--port") {
      port = Number(args[index + 1]);
      index += 1;
    } else {
      throw new KitUsageError(`unexpected argument '${arg}' (${usage})`);
    }
  }
  if (host.length === 0) throw new KitUsageError("--host requires an address");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new KitUsageError("--port must be an integer between 1 and 65535");
  }
  return { host, port, forceTls };
}

function localRegistryNames(registryPath: string): string[] | undefined {
  try {
    return readRegistry(registryPath)
      .filter((binding) => binding.kind !== "remote")
      .map((binding) => binding.name);
  } catch {
    return undefined;
  }
}

/** Token-file summary for status: labels and count, never a secret (the
 * detail face stays `ukp serve token list`). */
function tokenFileSummary(path: string): string {
  const loaded = loadTokenFile(path);
  if ("missing" in loaded) {
    return `tokens: no token file at ${path} - issue a key with 'ukp serve token add <label> <scopes>'`;
  }
  if ("error" in loaded) return `tokens: ${path} is unreadable: ${loaded.error}`;
  const parsed = parseTokenFileText(loaded.text);
  if ("error" in parsed) return `tokens: ${path} line ${parsed.error.line}: ${parsed.error.message}`;
  if (parsed.entries.length === 0) {
    return `tokens: ${path} holds no keys (only comments)`;
  }
  const labels = [...new Set(parsed.entries.map((entry) => entry.label))];
  return `tokens: ${parsed.entries.length} key(s) at ${path} - labels: ${labels.join(", ")} ('ukp serve token list' for key ids and scopes)`;
}

/** `ukp serve status` (W16): exit 0 whether the door is up or down — it is a
 * report, and a down door is a state the report must be able to name. */
async function executeServeStatusCommand(
  args: readonly string[],
  context: ServeCommandContext,
): Promise<KitCommandResult> {
  const usage = "usage: ukp serve status [--host <addr>] [--port <n>] [--tls]";
  const probe = parseDoorProbeArgs(args, usage);
  const home = context.homeDir ?? homedir();
  const lines: string[] = ["host door status"];

  const scheme: "http" | "https" = probe.forceTls
    || doorIdentityCandidates(context.registryPath).length > 0
    ? "https"
    : "http";
  const result = await probeDoorOrigin({
    origin: `${scheme}://${probe.host}:${probe.port}`,
    scheme,
    registryPath: context.registryPath,
  });
  if (result.state === "up") {
    lines.push(
      `  door: up at ${result.origin} - ${result.roster.length} endpoint(s) on the roster: ${
        result.roster.join(", ") || "(none)"
      }`,
    );
    const locals = localRegistryNames(context.registryPath);
    if (locals !== undefined) {
      const hidden = locals.filter((name) => !result.roster.includes(name));
      lines.push(hidden.length > 0
        ? `  select: the roster hides ${hidden.length} registered endpoint(s): ${hidden.join(", ")} (a subset door's whitelist is fixed at start - restart to change it)`
        : `  select: the roster serves every registered endpoint (${locals.length}) - no hidden names`);
    }
  } else if (result.state === "single-endpoint") {
    lines.push(
      `  door: ${result.origin} is serving a single endpoint, not a host door (status covers door mode)`,
    );
  } else if (result.state === "tls-unanchored") {
    // Trust-anchor discipline: "cannot anchor TLS" is not "the address did
    // not answer" — the door may be live; name what is missing and where
    // the machine home keeps door identities.
    lines.push(
      `  door: ${result.origin} answered but its TLS identity could not be anchored from the machine home - the door may still be live; check the address and scheme, and the door identities under ${join(dirname(context.registryPath), "tls")}`,
    );
  } else if (result.state === "not-a-door") {
    // Walkthrough N4: an answering non-UKP service is not a dead address —
    // the wording must not claim the address stayed silent.
    lines.push(
      `  door: something answered at ${result.origin}, but it is not a ukp door (${result.reason}) - check the address and port, and the http/https scheme`,
    );
  } else {
    // Address-scoped, not machine-scoped (2026-11-12 walkthrough F2): a
    // down probe at the default 8570 must not read as "no door on this
    // machine" — a door started with a custom --port is alive elsewhere,
    // so the remedy names the default and the same-port retry.
    lines.push(
      `  door: not answering at ${result.origin} (${result.reason}) - this address did not answer; if the door runs on a custom --port, retry status with the same value (the default probe is 8570)`,
    );
  }

  const identityCert = (result.state === "up" || result.state === "single-endpoint")
    ? result.identityCert
    : doorIdentityCert(context.registryPath);
  if (identityCert !== undefined) {
    lines.push(`  tls: self-signed door identity ${spkiPinOf(identityCert)} (SAN: ${certSanOf(identityCert)})`);
  } else if (result.state === "up" && result.scheme === "https") {
    lines.push("  tls: answering over https with no self-signed identity in the machine home (an operator certificate)");
  }
  lines.push(tokenFileSummary(serveTokenFilePath(context)));
  const taskManaged = existsSync(join(home, ".ukp", "start-door.cmd"));
  lines.push(taskManaged
    ? `  deployment: task-managed (start-door.cmd present in ${join(home, ".ukp")} - 'ukp serve --print-task' prints the teardown playbook)`
    : `  deployment: manual (no print-task artifacts in ${join(home, ".ukp")})`);
  lines.push("");
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

/** `ukp serve share <endpoint> --to <label> --at <url> [--rw]` (W16): the
 * combined hand-over gesture. `--at` is required and explicit — the
 * consumer-facing origin is the owner's to state (a loopback probe address
 * would mint a paste-ready command that points at the wrong machine). */
async function executeServeShareCommand(
  args: readonly string[],
  context: ServeCommandContext,
): Promise<KitCommandResult> {
  const usage =
    "usage: ukp serve share <endpoint> --to <label> --at <consumer-url> [--rw] (e.g. ukp serve share notes --to liku --at https://192.168.1.10:8570 - the door is probed through --at, the address the consumer will use)";
  const positional: string[] = [];
  let label: string | undefined;
  let at: string | undefined;
  let rw = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--rw") rw = true;
    else if (arg === "--to") {
      label = args[index + 1];
      index += 1;
    } else if (arg === "--at") {
      at = args[index + 1];
      index += 1;
    } else positional.push(arg);
  }
  const endpoint = positional[0];
  if (positional.length !== 1 || endpoint === undefined) {
    throw new KitUsageError(`serve share takes one <endpoint> (${usage})`);
  }
  if (label === undefined) throw new KitUsageError(`--to <label> is required (${usage})`);
  if (at === undefined) {
    throw new KitUsageError(
      `--at <consumer-url> is required - it is the origin the consumer will use, e.g. --at https://192.168.1.10:8570 (${usage})`,
    );
  }
  const atParts = parseRemoteUrl(at);
  if (atParts === undefined || (atParts.scheme !== "http" && atParts.scheme !== "https")) {
    throw new KitUsageError(
      `--at must be an http(s) origin the consumer can reach, e.g. --at https://192.168.1.10:8570 (plain http is loopback-only - share an https door for other hosts) (${usage})`,
    );
  }
  if (atParts.endpointName !== undefined) {
    throw new KitUsageError(`--at is the door origin; share derives the endpoint path itself (got '${at}')`);
  }

  // The probe rides the consumer-facing origin itself: if the address the
  // consumer will use does not answer, the handover would be dead on
  // arrival — share catches that here, before minting anything.
  const door = await probeDoorOrigin({
    origin: atParts.origin,
    scheme: atParts.scheme,
    registryPath: context.registryPath,
    preferEndpoint: endpoint,
  });
  if (door.state === "down") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp serve: the door is not answering at ${door.origin} (${door.reason}) - start it, check 'ukp serve status', then share\n`,
    };
  }
  if (door.state === "tls-unanchored") {
    // Trust-anchor discipline: "cannot anchor TLS" is not "not answering".
    // The probe checked the endpoint's own identity first (the caller names
    // it), then every machine-home identity.
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp serve: the door at ${door.origin} answered but its TLS identity could not be anchored from the machine home (no matching self-signed identity under ${join(dirname(context.registryPath), "tls")}; '${endpoint}' was checked first) - the door may still be live; verify the door's --tls setup and the --at origin, then share again\n`,
    };
  }
  if (door.state === "single-endpoint") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp serve: ${door.origin} is serving a single endpoint, not a host door (share mints keys through a host door's roster - start the door without --endpoint to serve every registered endpoint as one host door, then share)\n`,
    };
  }
  if (door.state === "not-a-door") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp serve: something answered at ${door.origin}, but it is not a ukp door (${door.reason}) - check the address and port, then share again\n`,
    };
  }
  if (!door.roster.includes(endpoint)) {
    const locals = localRegistryNames(context.registryPath);
    if (locals === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp serve: '${endpoint}' is not on the door's roster and the Host Registry is not readable\n`,
      };
    }
    if (!locals.includes(endpoint)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp serve: '${endpoint}' is not registered on this host - register its folder first ('ukp register <folder>'), then share again\n`,
      };
    }
    // Registered but hidden: teach the widen-restart (ADR-REM-010 keeps the
    // whitelist startup-fixed). 2026-11-13 ruling (walkthrough N3): share
    // prints ONLY the provably-correct delta — the wider --select set — and
    // never assembles a full start command from the probe; the door's listen
    // address and TLS setup are the owner's (a consumer-reachable probe
    // origin is not the listen host, and --tls-san/--tls-cert are
    // unrecoverable), so a seemingly paste-ready rebuild line was a trap.
    const widened = [...new Set([...door.roster, endpoint])].sort();
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `ukp serve: '${endpoint}' is registered on this host but the door's roster does not carry it (a subset door's whitelist is fixed at start).`,
        `widen the door, then share again: in the command or saved task files that STARTED this door, set --select to the wider set and restart, keeping your own --host/--port and TLS flags unchanged:`,
        `  --select ${widened.join(",")}`,
        `(only the select set above is derived, from the live roster - share cannot see the door's original listen address or TLS setup and will not reconstruct a full start command; the restart keeps registered endpoints serving)`,
        `(for a task-managed resident door, make the widen durable: stop the door first ('ukp serve --print-task' Notes carry the kill command), re-save its files with the wider --select (move the current pair aside first - --write never overwrites), then start the task - a foreground rebuild alone leaves the saved cmd narrower, and the next logon re-launches it)`,
        "",
      ].join("\n"),
    };
  }
  if (!door.bearerRequired) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp serve: the door at ${door.origin} admits anonymous requests - its gate is not armed, so a key would change nothing. Start it with the token file ('ukp serve token add'), or hand over an ssh:// door instead\n`,
    };
  }

  // Mint through the token add path verbatim: same lock, same file, same
  // zero-downtime rotation semantics for a repeated label.
  const scopes = `${endpoint}:${rw ? "rw" : "ro"}`;
  let minted;
  try {
    minted = mintTokenFileKey(label, scopes);
  } catch (error) {
    if (error instanceof TokenFileUsageError) throw new KitUsageError(error.message);
    throw error;
  }
  const path = serveTokenFilePath(context);
  const { sameLabel } = withTokenFileLock(path, () => {
    const current = loadManagedTokenText(path);
    const sameLabel = current.entries.filter((entry) => entry.label === label).length;
    storeTokenFile(path, appendTokenLine(current.text, minted.line));
    return { sameLabel };
  });
  const registerUrl = `${atParts.origin}/${endpoint}`;
  return {
    exitCode: 0,
    stdout: [
      `shared '${endpoint}' with '${label}' (scope ${scopes}) - door at ${door.origin}`,
      "",
      "on the consuming machine, paste this one line:",
      `  ukp register --url ${registerUrl} --token ${minted.token}`,
      "",
      `the line embeds the raw key - shown ONCE, stored hash-only at ${path} (0600).`,
      `revoke with 'ukp serve token revoke ${label}'`
        + `${sameLabel > 0
          ? ` (the label already held ${sameLabel} active key(s); now ${sameLabel + 1}, all valid until revoked - revoke removes EVERY key under '${label}', so consumers holding an older key lose access too)`
          : ""}.`,
      "if this door gates on UKP_SERVE_TOKEN instead of the file, the key is inert - run the door on the token file to hand out keys.",
      "",
    ].join("\n"),
    stderr: "",
  };
}

/** Cross-process read-modify-write discipline for the token file (the same
 * fslock propose uses): two concurrent `token add` runs must not lose a
 * line to a last-writer-wins rename. Serving itself never takes the lock —
 * fresh readers observe atomic replaces, never partial files. */
function withTokenFileLock<T>(path: string, work: () => T): T {
  const lockPath = `${path}.lock`;
  // The lock file's directory must exist before the exclusive create —
  // a first-ever `token add` on a machine without ~/.ukp yet.
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = acquireLock(lockPath);
  } catch (error) {
    if (error instanceof LockBusyError) {
      throw new Error(`another ukp process is editing the token file (${lockPath} is locked): retry shortly`);
    }
    throw error;
  }
  try {
    return work();
  } finally {
    releaseLock(lockPath, descriptor);
  }
}

/** Single-source command spec (ADR 0024): long-running host command — the
 * Bun.serve listener keeps the process alive after runCli returns its exit
 * code; SIGINT/SIGTERM stop the listener so the process exits with it.
 * `--endpoint` is optional (W7 / ADR-REM-004): present = the original
 * single-endpoint mode; absent = host door mode serving the registry over
 * `/e/<name>/` routing — every local binding, or the `--select` whitelist
 * subset (ADR-REM-010). */
export const SERVE_SPEC: UkpCommandSpec = {
  name: "serve",
  summary: "serve one endpoint, a selected subset, or the whole registry as a host door - one HTTP server, one port - for remote UKP clients",
  group: "operations",
  description:
    "Expose a registered endpoint over HTTP using the ukp-remote wire, or - without --endpoint - serve local endpoints as one host door routed by name: all of them, or just the ones --select names.",
  usage: "[--endpoint <name>] [--select <names>] [--host <addr>] [--port <n>] [--tls [--tls-san <ip|dns>]... | --tls-cert <pem> --tls-key <pem>] [--max-idle <seconds>] [--systemd-socket] [--print-task [--write]] | token add <label> <scopes> | token list | token revoke <label> | status | share <endpoint> --to <label> --at <consumer-url> [--rw]",
  options: [
    { flags: "--endpoint <name>", help: "the registered endpoint to expose; omit it to serve a host door (/e/<name>/ routing, one port) instead" },
    { flags: "--select <names>", help: "host door serving ONLY the named endpoints (comma-separated): one port, /e/<name>/ routing, and a door document that declares just this subset - unselected local endpoints are not served, routed, or declared; mutually exclusive with --endpoint" },
    { flags: "--host <addr>", help: "listen address (default 127.0.0.1; a bind beyond loopback needs a token and TLS)" },
    { flags: "--port <n>", help: "listen port (default 8570)" },
    { flags: "--tls", help: "serve HTTPS with a self-signed identity (auto-generated under ~/.ukp/tls/<name>/, machine-local beside the registry; SAN covers this host's addresses; clients pin it at registration)" },
    { flags: "--tls-san <ip|dns>", help: "extra SAN entry for the --tls self-signed identity (repeatable): a public/NAT IP or hostname no NIC of this host carries; a persisted certificate missing an entry is re-signed over the same key (pin unchanged, pinned clients re-anchor)", multi: true },
    { flags: "--tls-cert <pem>", help: "TLS certificate (chain) PEM path - Let's Encrypt, mkcert, or a private CA; pair with --tls-key" },
    { flags: "--tls-key <pem>", help: "TLS private key PEM path; pair with --tls-cert" },
    { flags: "--allow-anonymous", help: "permit tokenless access on loopback (local testing, or an ssh-forwarded host door where SSH carries encryption and auth; once the tokens file holds any key the bearer gate is armed and this flag no longer enables tokenless access)" },
    { flags: "--allow-http", help: "permit plain http beyond loopback when TLS is terminated in front of this door (a reverse proxy on another host, a container sidecar, an overlay network): without it such a door is refused, because bearer keys would travel unencrypted - with it the hop from that TLS edge to this door stays plaintext, so keep it on a private network; consumers register the edge's https origin" },
    { flags: "--max-idle <seconds>", help: "exit after <seconds> without requests (self-reap; the orphan backstop for on-demand-woken doors - fractional values accepted for tests)" },
    { flags: "--systemd-socket", help: "serve on the systemd socket-activation listener (LISTEN_FDS fd 3) instead of binding a port - the port belongs to your .socket unit; Linux-only" },
    { flags: "--print-task", help: "Windows: print this door's process-manager artifacts (start script, hidden launcher, Task Scheduler command, firewall rule) instead of serving - review and apply them yourself; nothing is installed or started for you, and the token is yours to paste (never printed)" },
    { flags: "--write", help: "with --print-task: write the two artifact files (%USERPROFILE%\\.ukp\\start-door.cmd with the token interpolated from UKP_SERVE_TOKEN, plus the hidden launcher) instead of printing them - existing files are never overwritten, the token is never displayed, and the task/firewall steps stay on stdout for you to apply" },
  ],
  helpSuffix: [
    "",
    "Wire (ukp-remote v1), single endpoint (--endpoint <name>):",
    `  GET  ${DISCOVERY_PATH}        discovery document (manifest projection,`,
    "                                protocol version, instance identity)",
    "  POST /v1/search              {query, limit} -> ukp.search.v1 envelope",
    "  GET  /v1/read?ref=...|uri=...  endpoint-relative ref or ukp:// URI",
    "  GET  /v1/nav?path=&depth=    markdown route view (ukp.nav.v1)",
    "  GET  /v1/rg?query=...        lexical search (ukp.rg.v1, ukp_uri handoff)",
    "  PUT  /v1/propose/<id>        proposal upsert (ukp.propose.v1) - the write",
    "                               face; a scoped key needs this endpoint at rw",
    "",
    "Wire (ukp-remote v1), host door (no --endpoint):",
    `  GET  ${DISCOVERY_PATH}        door document (scope:"host", endpoint roster -`,
    "                                the --select subset when --select is given)",
    "  GET  /e/<name>/.well-known/ukp.json   per-endpoint document (same shape",
    "                                as single-endpoint mode; TOFU pins anchor here)",
    "  POST /e/<name>/v1/search     capabilities routed by endpoint name",
    "  GET  /e/<name>/v1/read|nav|rg",
    "  PUT  /e/<name>/v1/propose/<id>  proposal upsert (ukp.propose.v1) - the write",
    "                                 face; a scoped key needs <name> at rw",
    "",
    "Auth (deny by default):",
    "  Serving requires a credential: UKP_SERVE_TOKEN (comma-separate",
    "  several: alice,bob; any listed token authorizes - full power) or a",
    "  labeled key from the token file. Tokenless serving is an explicit",
    "  opt-in: --allow-anonymous, loopback binds only. The discovery",
    "  document stays public. A reverse proxy on the same host forwards",
    "  from the public side to the loopback bind, so proxy deployments",
    "  treat the credential as mandatory - serve cannot see past its own",
    "  bind address.",
    "",
    "  UKP_SERVE_TOKEN is the token file's full-power shortcut form and",
    "  takes precedence when set (AWS/gh/kubectl chain order): the file is",
    "  not consulted while the env is present.",
    "",
    "  Token file (labeled, scoped, revocable keys):",
    "    ukp serve token add <label> <scopes>   issue a key (raw shown once)",
    "    ukp serve token list                   labels, key ids, scopes",
    "    ukp serve token revoke <label>         revoke every key of a label",
    "",
    "  Door owner faces:",
    "    ukp serve status                       one-screen door self-description",
    "    ukp serve share <name> --to <label> --at <url> [--rw]",
    "  status reads the live door document (roster, and which registered",
    "  endpoints the roster hides) plus the machine home (token summary, TLS",
    "  identity, task vs manual deployment). share validates <name> is on the",
    "  live roster (or teaches the --select rebuild command), mints a key",
    "  scoped to exactly that name, and prints the consumer's paste-ready",
    "  register command with the raw key embedded (shown once). --at is the",
    "  origin the CONSUMER will use, e.g. --at https://192.168.1.10:8570.",
    "  Scopes are Docker-registry style, required per key: notes:ro,cad:rw",
    "  ('*' is the explicit full-power name: '*:rw'). The file lives at",
    "  ~/.ukp/tokens (0600, hash-only rows) and is re-read on every request",
    "  - deleting a line revokes without a restart. A name the door declares",
    "  but your key cannot touch answers 'no route under your key' (no 403",
    "  class exists); names the door does not declare answer exactly like",
    "  nonexistent ones.",
    "",
    "  Loopback-without-token covers testing/dogfood AND the ssh door",
    "  deployment: bind the door on the remote host's loopback and let ssh",
    "  forwarding carry encryption and authentication (clients register",
    "  'ukp register --url ssh://<host>' - zero tokens, docker",
    "  DOCKER_HOST=ssh:// posture). It is not the way to consume a",
    "  same-machine endpoint - register its local path instead.",
    "  TLS: pass --tls to serve HTTPS with a self-signed identity",
    "  (generated under ~/.ukp/tls/<name>/ beside the registry - the flat",
    "  ~/.ukp/tls/ in door mode -, SAN covers this host's addresses; remote",
    "  clients TOFU-pin it at registration and refresh by re-registering), or",
    "  --tls-cert/--tls-key",
    "  for your own certificate (Let's Encrypt - IP certs available since",
    "  2026-01 -, mkcert, a private CA). Plain HTTP remains loopback-only by",
    "  admission; public exposure needs TLS or the ssh:// transport. A door",
    "  bound beyond loopback without TLS is refused at startup - a bearer",
    "  key must not travel unencrypted. --allow-http is the explicit opt-in",
    "  for a door whose TLS is terminated in front (a proxy on another host,",
    "  a container sidecar): that hop stays plaintext and the banner says so.",
    "",
    "  A cloud NAT/EIP host's public IP is on no NIC (--tls alone cannot",
    "  cover it): add --tls-san <public-ip> next to --tls. Repeatable; DNS",
    "  names accepted. The persisted certificate re-signs over the same key",
    "  when a new entry appears - the pin is unchanged and pinned clients",
    "  re-anchor transparently; dropping entries never re-signs.",
    "",
  ].join("\n"),
};

export interface ParsedServe {
  /** Present = single-endpoint mode; absent = host door mode (W7). */
  endpoint?: string;
  /** `--select` names (ADR-REM-010): present next to an absent endpoint =
   * subset door — the door serves, routes, and declares only these
   * endpoints. Parsed here exactly the way register --select parses its
   * list (comma-separated, trimmed, empty entries dropped); the execute
   * layer's eager check (usage error with the roster) is the admission. */
  select?: string[];
  host: string;
  port: number;
  /** Present = the --max-idle self-reap timer is armed (W9). */
  maxIdleSeconds?: number;
  /** Present = the systemd-passed listener (W10, Linux-only). */
  systemdSocket?: boolean;
  /** Present = render the Windows process-manager artifacts instead of
   * serving (W12; Windows-only, print-only, never starts a listener). */
  printTask?: boolean;
  /** Present = the print-task artifacts' file pair lands on disk with the
   * env token interpolated (O-020 ruling C); only valid next to
   * --print-task, and the print surface stays secret-free. */
  write?: boolean;
  /** `--tls-san` values, normalized to `IP:x`/`DNS:y` SAN form (repeatable);
   * valid only next to `--tls` — the execute layer enforces the pairing.
   * Absent when the flag is not passed (parse output stays byte-identical
   * to the pre-flag shape). */
  tlsSan?: string[];
}

function toParsedServe(parsed: KitParsed): ParsedServe {
  const options = parsed.options as { host?: string; port?: string; endpoint?: string; select?: string; maxIdle?: string; systemdSocket?: boolean; printTask?: boolean; write?: boolean; tlsSan?: string[] };
  const endpoint = options.endpoint;
  if (endpoint !== undefined && endpoint.length === 0) {
    throw new KitUsageError("--endpoint <name> must not be empty (omit it to serve a host door)");
  }
  // --select parses with register --select's exact list semantics (the same
  // operation's other side): comma-separated, trimmed, empties dropped. A
  // flag that parses to nothing is a usage error, not an empty whitelist.
  let select: string[] | undefined;
  if (options.select !== undefined) {
    select = options.select.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (select.length === 0) {
      throw new KitUsageError("--select requires at least one endpoint name");
    }
  }
  if (endpoint !== undefined && select !== undefined) {
    throw new KitUsageError("--endpoint and --select cannot be used together (--endpoint is the N=1 form; --select narrows a host door)");
  }
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? "8570");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new KitUsageError("--port must be an integer between 1 and 65535");
  }
  const systemdSocket = options.systemdSocket === true;
  if (systemdSocket && options.port !== undefined) {
    throw new KitUsageError("--systemd-socket and --port are mutually exclusive (the socket unit owns the port)");
  }
  const printTask = options.printTask === true;
  if (printTask && systemdSocket) {
    throw new KitUsageError("--print-task is the Windows resident form; --systemd-socket is the Linux one (systemd holds the port - see the deployment handbook)");
  }
  const write = options.write === true;
  if (write && !printTask) {
    throw new KitUsageError("--write modifies --print-task: run ukp serve --print-task --write (without --print-task, serve just serves)");
  }
  let maxIdleSeconds: number | undefined;
  if (options.maxIdle !== undefined) {
    maxIdleSeconds = Number(options.maxIdle);
    if (!Number.isFinite(maxIdleSeconds) || maxIdleSeconds <= 0 || maxIdleSeconds > 86400) {
      throw new KitUsageError("--max-idle must be a positive number of seconds (at most 86400)");
    }
    if (printTask) {
      throw new KitUsageError("--print-task is for a resident door; --max-idle self-reaps (it is the on-demand backstop) and would leave the door down until the next logon");
    }
  }
  let tlsSan: string[] = [];
  if (options.tlsSan !== undefined) {
    try {
      // normalized then deduplicated — case variants of one entry collapse
      // here, so ParsedServe carries the canonical set
      tlsSan = [...new Set(options.tlsSan.map(normalizeTlsSanEntry))];
    } catch (error) {
      throw new KitUsageError(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(select !== undefined ? { select } : {}),
    host,
    port,
    ...(maxIdleSeconds !== undefined ? { maxIdleSeconds } : {}),
    ...(systemdSocket ? { systemdSocket } : {}),
    ...(printTask ? { printTask } : {}),
    ...(write ? { write } : {}),
    ...(tlsSan.length > 0 ? { tlsSan } : {}),
  };
}

export function parseServeArgs(args: readonly string[]): ParsedServe {
  return toParsedServe(parseKitArgs(SERVE_SPEC, args));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** The banner auth line, both sources (W13): the token-file form names the
 * fresh-read revocation idiom so the operator knows deleting a line is the
 * whole lifecycle. */
function authBannerLine(info: ServeInfo): string {
  if (info.tokenFile !== undefined) {
    return `  auth: bearer token required (token file: ${info.tokenFile.keys} key(s) - re-read per request, revoke with 'ukp serve token revoke <label>')`;
  }
  if (info.authRequired) return "  auth: bearer token required";
  return info.mode === "door"
    ? "  auth: no token (loopback bind; ssh-forwarded clients authenticate by SSH key)"
    : "  auth: no token (loopback only)";
}

/** The banner transport warning (INV-03 override): present only when
 * --allow-http admitted plain http beyond loopback, so the operator channel
 * keeps naming the plaintext hop the flag accepted. */
function transportBannerLines(info: ServeInfo): string[] {
  return info.insecureHttp === true
    ? ["  warning: plain http beyond loopback (--allow-http) - bearer keys travel unencrypted from your TLS edge to this door; keep that hop on a private network"]
    : [];
}

export function renderServeBanner(info: ServeInfo): string {
  if (info.mode === "door") {
    return [
      `serving host door (ukp-remote v1)`,
      `  listening: ${info.url}`,
      `  discovery: ${info.url.startsWith("http") ? `${info.url}${DISCOVERY_PATH}` : info.url} (host door)`,
      `  endpoints: ${info.door!.endpoints.length > 0 ? info.door!.endpoints.join(", ") : "(none - register endpoints on this host)"}`,
      ...(info.door!.select !== undefined
        ? [`  select: ${info.door!.select.join(", ")} (subset door - unselected local endpoints are not served, routed, or declared)`]
        : []),
      `  write: ${info.door!.write.length > 0 ? info.door!.write.join(", ") + " (propose via PUT /e/<name>/v1/propose/<id>)" : "(no endpoint declares propose)"}`,
      authBannerLine(info),
      ...transportBannerLines(info),
      `  rg: ${info.rg === "ok" ? "ok" : "missing (rg calls skip with a warning - install ripgrep on this door's PATH)"}`,
      ...(info.maxIdleSeconds !== undefined
        ? [`  idle: exits after ${info.maxIdleSeconds}s without requests (--max-idle)`]
        : []),
      ...(info.tls !== undefined
        ? [`  tls: ${info.tls.source === "operator" ? "operator certificate" : `self-signed identity (${info.tls.source})`} ${info.tls.pin} (SAN: ${info.tls.san})`]
        : []),
      "",
    ].join("\n");
  }
  return [
    `serving endpoint '${info.endpoint}' (ukp-remote v1)`,
    `  listening: ${info.url}`,
    `  discovery: ${info.url.startsWith("http") ? `${info.url}${DISCOVERY_PATH}` : info.url}`,
    authBannerLine(info),
    ...transportBannerLines(info),
    `  rg: ${info.rg === "ok" ? "ok" : "missing (rg calls skip with a warning - install ripgrep on this door's PATH)"}`,
    ...(info.maxIdleSeconds !== undefined
      ? [`  idle: exits after ${info.maxIdleSeconds}s without requests (--max-idle)`]
      : []),
    ...(info.tls !== undefined
      ? [`  tls: ${info.tls.source === "operator" ? "operator certificate" : `self-signed identity (${info.tls.source})`} ${info.tls.pin} (SAN: ${info.tls.san})`]
      : []),
    "",
  ].join("\n");
}

/** Auth admission (RQ-18, web-standard deny-by-default): a credential is
 * required to start serving — an env token or at least one token-file key
 * (W13: both sources feed the same `authArmed` bit); tokenless access is an
 * explicit, loopback-only opt-in. A reverse proxy on the same host
 * forwards from the public side to the loopback bind, so the proxy recipes
 * treat the bearer requirement as mandatory — serve itself cannot see past
 * its own bind address. */
export function serveAuthDecision(
  host: string,
  authArmed: boolean,
  allowAnonymous: boolean,
): { ok: true; authRequired: boolean } | { ok: false; reason: string } {
  if (authArmed) return { ok: true, authRequired: true };
  if (!isLoopback(host)) {
    return {
      ok: false,
      reason: `refusing to serve on non-loopback ${host} without a token: set UKP_SERVE_TOKEN, or issue a file key with 'ukp serve token add <label> <scopes>'`,
    };
  }
  if (allowAnonymous) return { ok: true, authRequired: false };
  return {
    ok: false,
    reason: "serve requires authentication: set UKP_SERVE_TOKEN, issue a file key with 'ukp serve token add <label> <scopes>', or pass --allow-anonymous for tokenless loopback testing (a reverse proxy on the same host still requires a token)",
  };
}

/** Transport admission (INV-03, serve side): plain http stops at loopback.
 * Registration and --print-task already refused the shape, but a
 * bearer-keyed door could still start on a non-loopback bind without TLS -
 * and since ukp clients refuse to register that url, the only callers able
 * to use it were ones sending the key in the clear. TLS on the door admits
 * any bind; loopback plain http stays the sanctioned local shape (same-host
 * proxy, ssh forward); anything else needs --allow-http, the explicit
 * statement that TLS is terminated in front of this door. A
 * --systemd-socket listener's bind belongs to the socket unit, so loopback
 * cannot be verified there and it rides the same refusal. `insecureHttp`
 * marks the admitted override for the banner warning. */
export function serveTransportDecision(input: {
  host: string;
  tls: boolean;
  allowHttp: boolean;
  systemdSocket?: boolean;
}): { ok: true; insecureHttp: boolean } | { ok: false; reason: string } {
  if (input.tls) return { ok: true, insecureHttp: false };
  if (input.systemdSocket === true) {
    if (input.allowHttp) return { ok: true, insecureHttp: true };
    return {
      ok: false,
      reason:
        "plain http on --systemd-socket: the listener's bind address belongs to the socket unit and may be public, so bearer keys could travel unencrypted - pass --tls (or --tls-cert/--tls-key), or --allow-http when the socket unit binds a private address with TLS terminated in front",
    };
  }
  if (isLoopback(input.host)) return { ok: true, insecureHttp: false };
  if (input.allowHttp) return { ok: true, insecureHttp: true };
  return {
    ok: false,
    reason: `plain http on non-loopback ${input.host}: bearer keys would travel unencrypted - pass --tls (self-signed, pinned at registration) or --tls-cert/--tls-key, bind loopback behind a TLS-terminating proxy, or pass --allow-http when TLS is terminated in front of this door`,
  };
}

export function executeServeCommand(
  args: readonly string[],
  context: ServeCommandContext,
): KitCommandResult {
  // W13: `ukp serve token …` is the issuance subcommand family — dispatched
  // ahead of the flag parser (SERVE_SPEC declares no positionals), with the
  // same error contract executeKitCommand applies (usage errors exit 2 with the
  // usage line, operational failures exit 1 naming the command). Help
  // requests route to the same rendered help (which teaches the family).
  if (args[0] === "token") {
    if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      return { exitCode: 0, stdout: renderKitHelp(SERVE_SPEC), stderr: "" };
    }
    try {
      return executeServeTokenCommand(args.slice(1), context);
    } catch (error) {
      if (error instanceof KitUsageError) {
        return { exitCode: 2, stdout: "", stderr: renderKitUsageError(SERVE_SPEC, error.message) };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp serve: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }
  return executeKitCommand(SERVE_SPEC, args, (parsed) => {
    const { endpoint, select, host, port, maxIdleSeconds, systemdSocket, write, tlsSan = [] } = toParsedServe(parsed);
    const allowAnonymous = (parsed.options as { allowAnonymous?: boolean }).allowAnonymous === true;
    const allowHttp = (parsed.options as { allowHttp?: boolean }).allowHttp === true;
    const printTask = (parsed.options as { printTask?: boolean }).printTask === true;
    const options = parsed.options as { tls?: boolean; tlsCert?: string; tlsKey?: string };
    // TLS flag family (W5'): --tls and --tls-cert/--tls-key are mutually
    // exclusive; the explicit pair must arrive complete. --tls-san only
    // shapes the self-signed generation — an operator certificate carries
    // its own SAN, so the flag next to one is a mistake, not a no-op.
    if (options.tls === true && (options.tlsCert !== undefined || options.tlsKey !== undefined)) {
      throw new KitUsageError("--tls and --tls-cert/--tls-key are mutually exclusive");
    }
    if (options.tls !== true && (options.tlsCert !== undefined) !== (options.tlsKey !== undefined)) {
      throw new KitUsageError("--tls-cert and --tls-key are used together");
    }
    if (tlsSan.length > 0 && options.tls !== true) {
      throw new KitUsageError("--tls-san is only used with --tls (an explicit --tls-cert certificate carries its own SAN)");
    }
    // Subset-door admission (ADR-REM-010): a name not among the local
    // bindings is a usage error with the roster — the eager check mirrors
    // register --select's door-import behavior and the ingress admission
    // precedent (a typo silently narrowing the door is a zero-signal
    // misconfiguration). An unreadable registry skips the check: that
    // failure surface is the door's own, shown per request like today.
    if (select !== undefined && endpoint === undefined) {
      let localNames: string[] | undefined;
      try {
        localNames = readRegistry(context.registryPath)
          .filter((binding) => binding.kind !== "remote")
          .map((binding) => binding.name);
      } catch {
        localNames = undefined;
      }
      if (localNames !== undefined) {
        const unknown = select.filter((name) => !localNames!.includes(name));
        if (unknown.length > 0) {
          throw new KitUsageError(
            `--select names not registered on this host: ${unknown.join(", ")} (available: ${localNames.join(", ")})`,
          );
        }
      }
    }
    // W12 print branch: render the Windows artifacts and stop. No listener,
    // no admission token check. Print mode never reads the env token - the
    // output is secret-free by construction. Write mode (O-020 ruling C:
    // the D-090 secret-free clause scopes to the print surface) reads
    // UKP_SERVE_TOKEN to interpolate it into the files it writes - the
    // token exists in exactly one place, the cmd file's bytes; stdout stays
    // secret-free in both modes.
    if (printTask) {
      const preflight = printTaskPreflightError({
        platform: process.platform,
        host,
        hasTls: options.tls === true || options.tlsCert !== undefined,
        allowAnonymous,
        allowHttp,
      });
      if (preflight !== undefined) {
        throw new Error(preflight);
      }
      const tls: ServeTaskTls | undefined =
        options.tls === true
          ? { mode: "self-signed", sanEntries: tlsSan }
          : options.tlsCert !== undefined && options.tlsKey !== undefined
            ? { mode: "certificates", certPath: options.tlsCert, keyPath: options.tlsKey }
            : undefined;
      const input = {
        host,
        port,
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(select !== undefined ? { select } : {}),
        ...(tls !== undefined ? { tls } : {}),
        ...(allowHttp ? { allowHttp } : {}),
      };
      if (!write) {
        return {
          exitCode: 0,
          stdout: renderServeTaskArtifacts(input),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: writeServeTaskArtifacts(input, {
          token: process.env.UKP_SERVE_TOKEN,
          homeDir: context.homeDir ?? homedir(),
        }),
        stderr: "",
      };
    }
    const tokens = context.tokens ?? parseServeTokens(process.env.UKP_SERVE_TOKEN);
    // W13 chain order (rehearsal point D) — see resolveServeAuthSources:
    // env is the full-power shortcut and wins outright; the file arms the
    // gate only when it holds at least one key; a malformed file refuses
    // startup loudly; both sources absent leaves RQ-18's anonymous opt-in
    // exactly where it was.
    const authSources = resolveServeAuthSources(tokens, context.homeDir ?? homedir());
    if ("error" in authSources) throw new Error(authSources.error);
    const gateTokens = authSources.tokens;
    const tokenFilePath = authSources.tokenFilePath;
    const authArmed = gateTokens.length > 0 || tokenFilePath !== undefined;
    // W10: socket activation must not admit tokenless serving — the bind
    // address belongs to the socket unit (possibly public), so the loopback
    // premise of --allow-anonymous is unverifiable here (RQ-18 review P1).
    if (systemdSocket && !authArmed) {
      throw new Error(
        "refusing to serve on --systemd-socket without a token: the listener's bind address belongs to the socket unit and may be public - tokenless loopback serving cannot be verified here; set UKP_SERVE_TOKEN or issue a file key with 'ukp serve token add'",
      );
    }
    const decision = serveAuthDecision(host, authArmed, allowAnonymous);
    if (!decision.ok) {
      const target = endpoint === undefined ? "host door" : `'${endpoint}'`;
      throw new Error(`refusing to serve ${target}: ${decision.reason}`);
    }
    const transport = serveTransportDecision({
      host,
      tls: options.tls === true || options.tlsCert !== undefined,
      allowHttp,
      ...(systemdSocket ? { systemdSocket } : {}),
    });
    if (!transport.ok) {
      const target = endpoint === undefined ? "host door" : `'${endpoint}'`;
      throw new Error(`refusing to serve ${target}: ${transport.reason}`);
    }
    const { server, info, stopAll } = startUkpServer({
      currentDirectory: context.currentDirectory,
      registryPath: context.registryPath,
      qmdCommand: context.qmdCommand,
      host,
      port,
      ...(endpoint !== undefined ? { endpointName: endpoint } : {}),
      ...(select !== undefined ? { select } : {}),
      ...(gateTokens.length > 0 ? { tokens: gateTokens } : {}),
      ...(tokenFilePath !== undefined ? { tokenFilePath } : {}),
      ...(maxIdleSeconds !== undefined ? { maxIdleSeconds } : {}),
      ...(systemdSocket !== undefined && systemdSocket ? { systemdSocket } : {}),
      ...(transport.insecureHttp ? { insecureHttp: true } : {}),
      ...(options.tls === true
        ? { tls: { mode: "self-signed" as const, ...(tlsSan.length > 0 ? { sanEntries: tlsSan } : {}) } }
        : options.tlsCert !== undefined && options.tlsKey !== undefined
          ? { tls: { mode: "certificates" as const, certPath: options.tlsCert, keyPath: options.tlsKey } }
          : {}),
    });
    const stop = () => {
      console.error(`ukp serve: stopped (${info.url})`);
      stopAll();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // SIGHUP = the session died (client killed the ssh that woke this door).
    // Bun IGNORES SIGHUP by default (ali E2E: every woken door survived its
    // session and idled to max-idle) — the explicit handler restores the
    // session-bound lifecycle; --max-idle stays the backstop for abnormal
    // disconnects where no signal ever arrives. Never fires on Windows.
    process.once("SIGHUP", stop);
    // Exit code 0 flows out through runCli; the server listener keeps the
    // process alive until the signal handler stops it.
    return { exitCode: 0, stdout: renderServeBanner(info), stderr: "" };
  });
}

/** The full serve routing face (W16): the door-owner subcommands dispatch
 * ahead of `executeServeCommand` the same way the token family does — both
 * probe the live door, so this entry may return a promise (the bin entry
 * awaits it through runCli's maybe-async path; direct callers of the sync
 * shapes — serving, print-task, the token family — are unchanged). */
export function runServeCommand(
  args: readonly string[],
  context: ServeCommandContext,
): KitCommandResult | Promise<KitCommandResult> {
  if (args[0] === "status" || args[0] === "share") {
    if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      return { exitCode: 0, stdout: renderKitHelp(SERVE_SPEC), stderr: "" };
    }
    const run = args[0] === "status"
      ? executeServeStatusCommand(args.slice(1), context)
      : executeServeShareCommand(args.slice(1), context);
    return run.catch((error) => {
      if (error instanceof KitUsageError) {
        return { exitCode: 2, stdout: "", stderr: renderKitUsageError(SERVE_SPEC, error.message) };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp serve: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    });
  }
  return executeServeCommand(args, context);
}

export function renderServeHelp(): string {
  return renderKitHelp(SERVE_SPEC);
}
