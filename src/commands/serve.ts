import {
  executeKitCommand,
  parseKitArgs,
  renderKitHelp,
  KitUsageError,
  type KitCommandResult,
  type KitParsed,
  type UkpCommandSpec,
} from "./kit.ts";
import { readRegistry } from "../registry.ts";
import { normalizeTlsSanEntry } from "../capabilities/tls-identity.ts";
import { DISCOVERY_PATH, startUkpServer, type ServeInfo } from "../server.ts";
import { printTaskPreflightError, renderServeTaskArtifacts, type ServeTaskTls } from "./serve-task.ts";

export interface ServeCommandContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  /** Overrides `process.env.UKP_SERVE_TOKEN` for tests. */
  tokens?: readonly string[];
}

/** `UKP_SERVE_TOKEN=a,b,c` (RQ-16): comma-separated, trimmed, empty entries
 * dropped — any listed token authorizes. */
function parseServeTokens(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
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
  usage: "[--endpoint <name>] [--select <names>] [--host <addr>] [--port <n>] [--tls [--tls-san <ip|dns>]... | --tls-cert <pem> --tls-key <pem>] [--max-idle <seconds>] [--systemd-socket] [--print-task]",
  options: [
    { flags: "--endpoint <name>", help: "the registered endpoint to expose; omit it to serve a host door (/e/<name>/ routing, one port) instead" },
    { flags: "--select <names>", help: "host door serving ONLY the named endpoints (comma-separated): one port, /e/<name>/ routing, and a door document that declares just this subset - unselected local endpoints are not served, routed, or declared; mutually exclusive with --endpoint" },
    { flags: "--host <addr>", help: "listen address (default 127.0.0.1, loopback only without a token)" },
    { flags: "--port <n>", help: "listen port (default 8570)" },
    { flags: "--tls", help: "serve HTTPS with a self-signed identity (auto-generated under .ukp/tls/, SAN covers this host's addresses; clients pin it at registration)" },
    { flags: "--tls-san <ip|dns>", help: "extra SAN entry for the --tls self-signed identity (repeatable): a public/NAT IP or hostname no NIC of this host carries; a persisted certificate missing an entry is re-signed over the same key (pin unchanged, pinned clients re-anchor)", multi: true },
    { flags: "--tls-cert <pem>", help: "TLS certificate (chain) PEM path - Let's Encrypt, mkcert, or a private CA; pair with --tls-key" },
    { flags: "--tls-key <pem>", help: "TLS private key PEM path; pair with --tls-cert" },
    { flags: "--allow-anonymous", help: "permit tokenless access on loopback (local testing, or an ssh-forwarded host door where SSH carries encryption and auth; reverse-proxy deployments still require UKP_SERVE_TOKEN)" },
    { flags: "--max-idle <seconds>", help: "exit after <seconds> without requests (self-reap; the orphan backstop for on-demand-woken doors - fractional values accepted for tests)" },
    { flags: "--systemd-socket", help: "serve on the systemd socket-activation listener (LISTEN_FDS fd 3) instead of binding a port - the port belongs to your .socket unit; Linux-only" },
    { flags: "--print-task", help: "Windows: print this door's process-manager artifacts (start script, hidden launcher, Task Scheduler command, firewall rule) instead of serving - review and apply them yourself; nothing is installed or started for you, and the token is yours to paste (never printed)" },
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
    "",
    "Wire (ukp-remote v1), host door (no --endpoint):",
    `  GET  ${DISCOVERY_PATH}        door document (scope:"host", endpoint roster -`,
    "                                the --select subset when --select is given)",
    "  GET  /e/<name>/.well-known/ukp.json   per-endpoint document (same shape",
    "                                as single-endpoint mode; TOFU pins anchor here)",
    "  POST /e/<name>/v1/search     capabilities routed by endpoint name",
    "  GET  /e/<name>/v1/read|nav|rg",
    "",
    "Auth (deny by default):",
    "  Serving requires UKP_SERVE_TOKEN (comma-separate several: alice,bob;",
    "  any listed token authorizes). Tokenless serving is an explicit opt-in:",
    "  --allow-anonymous, loopback binds only. The discovery document stays",
    "  public. A reverse proxy on the same host forwards from the public side",
    "  to the loopback bind, so proxy deployments treat the token as",
    "  mandatory - serve cannot see past its own bind address.",
    "",
    "  Loopback-without-token covers testing/dogfood AND the ssh door",
    "  deployment: bind the door on the remote host's loopback and let ssh",
    "  forwarding carry encryption and authentication (clients register",
    "  'ukp register --url ssh://<host>' - zero tokens, docker",
    "  DOCKER_HOST=ssh:// posture). It is not the way to consume a",
    "  same-machine endpoint - register its local path instead.",
    "  TLS: pass --tls to serve HTTPS with a self-signed identity",
    "  (generated under .ukp/tls/ - under the registry directory in door",
    "  mode -, SAN covers this host's addresses; remote clients TOFU-pin it",
    "  at registration and refresh by re-registering), or --tls-cert/--tls-key",
    "  for your own certificate (Let's Encrypt - IP certs available since",
    "  2026-01 -, mkcert, a private CA). Plain HTTP remains loopback-only by",
    "  admission; public exposure needs TLS or the ssh:// transport.",
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
  /** `--tls-san` values, normalized to `IP:x`/`DNS:y` SAN form (repeatable);
   * valid only next to `--tls` — the execute layer enforces the pairing.
   * Absent when the flag is not passed (parse output stays byte-identical
   * to the pre-flag shape). */
  tlsSan?: string[];
}

function toParsedServe(parsed: KitParsed): ParsedServe {
  const options = parsed.options as { host?: string; port?: string; endpoint?: string; select?: string; maxIdle?: string; systemdSocket?: boolean; printTask?: boolean; tlsSan?: string[] };
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
    ...(tlsSan.length > 0 ? { tlsSan } : {}),
  };
}

export function parseServeArgs(args: readonly string[]): ParsedServe {
  return toParsedServe(parseKitArgs(SERVE_SPEC, args));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
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
      `  auth: ${info.authRequired ? "bearer token required" : "no token (loopback bind; ssh-forwarded clients authenticate by SSH key)"}`,
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
    `  auth: ${info.authRequired ? "bearer token required" : "no token (loopback only)"}`,
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

/** Auth admission (RQ-18, web-standard deny-by-default): a token is required
 * to start serving; tokenless access is an explicit, loopback-only opt-in.
 * A reverse proxy on the same host forwards from the public side to the
 * loopback bind, so the proxy recipes treat UKP_SERVE_TOKEN as mandatory —
 * serve itself cannot see past its own bind address. */
export function serveAuthDecision(
  host: string,
  tokens: readonly string[],
  allowAnonymous: boolean,
): { ok: true; authRequired: boolean } | { ok: false; reason: string } {
  if (tokens.length > 0) return { ok: true, authRequired: true };
  if (!isLoopback(host)) {
    return {
      ok: false,
      reason: `refusing to serve on non-loopback ${host} without a token: set UKP_SERVE_TOKEN`,
    };
  }
  if (allowAnonymous) return { ok: true, authRequired: false };
  return {
    ok: false,
    reason: "serve requires authentication: set UKP_SERVE_TOKEN, or pass --allow-anonymous for tokenless loopback testing (a reverse proxy on the same host still requires UKP_SERVE_TOKEN)",
  };
}

export function executeServeCommand(
  args: readonly string[],
  context: ServeCommandContext,
): KitCommandResult {
  return executeKitCommand(SERVE_SPEC, args, (parsed) => {
    const { endpoint, select, host, port, maxIdleSeconds, systemdSocket, tlsSan = [] } = toParsedServe(parsed);
    const allowAnonymous = (parsed.options as { allowAnonymous?: boolean }).allowAnonymous === true;
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
    // W12 print-only branch: render the Windows artifacts and stop. No
    // listener, no admission token check (the token is pasted into the
    // generated script later), and the env token is deliberately not read
    // — the output is secret-free by construction.
    if (printTask) {
      const preflight = printTaskPreflightError({
        platform: process.platform,
        host,
        hasTls: options.tls === true || options.tlsCert !== undefined,
        allowAnonymous,
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
      return {
        exitCode: 0,
        stdout: renderServeTaskArtifacts({
          host,
          port,
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(select !== undefined ? { select } : {}),
          ...(tls !== undefined ? { tls } : {}),
        }),
        stderr: "",
      };
    }
    const tokens = context.tokens ?? parseServeTokens(process.env.UKP_SERVE_TOKEN);
    // W10: socket activation must not admit tokenless serving — the bind
    // address belongs to the socket unit (possibly public), so the loopback
    // premise of --allow-anonymous is unverifiable here (RQ-18 review P1).
    if (systemdSocket && tokens.length === 0) {
      throw new Error(
        "refusing to serve on --systemd-socket without a token: the listener's bind address belongs to the socket unit and may be public - tokenless loopback serving cannot be verified here; set UKP_SERVE_TOKEN",
      );
    }
    const decision = serveAuthDecision(host, tokens, allowAnonymous);
    if (!decision.ok) {
      const target = endpoint === undefined ? "host door" : `'${endpoint}'`;
      throw new Error(`refusing to serve ${target}: ${decision.reason}`);
    }
    const { server, info, stopAll } = startUkpServer({
      currentDirectory: context.currentDirectory,
      registryPath: context.registryPath,
      qmdCommand: context.qmdCommand,
      host,
      port,
      ...(endpoint !== undefined ? { endpointName: endpoint } : {}),
      ...(select !== undefined ? { select } : {}),
      ...(tokens.length > 0 ? { tokens } : {}),
      ...(maxIdleSeconds !== undefined ? { maxIdleSeconds } : {}),
      ...(systemdSocket !== undefined && systemdSocket ? { systemdSocket } : {}),
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

export function renderServeHelp(): string {
  return renderKitHelp(SERVE_SPEC);
}
