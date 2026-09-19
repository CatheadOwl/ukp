import {
  executeKitCommand,
  parseKitArgs,
  renderKitHelp,
  KitUsageError,
  type KitCommandResult,
  type KitParsed,
  type UkpCommandSpec,
} from "./kit.ts";
import { DISCOVERY_PATH, startUkpServer, type ServeInfo } from "../server.ts";

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
 * single-endpoint mode; absent = host door mode serving the whole registry
 * over `/e/<name>/` routing. */
export const SERVE_SPEC: UkpCommandSpec = {
  name: "serve",
  summary: "serve one endpoint — or the whole registry as a host door — over HTTP for remote UKP clients",
  group: "operations",
  description:
    "Expose a registered endpoint over HTTP using the ukp-remote wire, or — without --endpoint — serve every local endpoint as one host door routed by name.",
  usage: "[--endpoint <name>] [--host <addr>] [--port <n>] [--tls | --tls-cert <pem> --tls-key <pem>] [--max-idle <seconds>]",
  options: [
    { flags: "--endpoint <name>", help: "the registered endpoint to expose; omit it to serve the whole registry as a host door (/e/<name>/ routing, all endpoints, one port)" },
    { flags: "--host <addr>", help: "listen address (default 127.0.0.1, loopback only without a token)" },
    { flags: "--port <n>", help: "listen port (default 8570)" },
    { flags: "--tls", help: "serve HTTPS with a self-signed identity (auto-generated under .ukp/tls/, SAN covers this host's addresses; clients pin it at registration)" },
    { flags: "--tls-cert <pem>", help: "TLS certificate (chain) PEM path — Let's Encrypt, mkcert, or a private CA; pair with --tls-key" },
    { flags: "--tls-key <pem>", help: "TLS private key PEM path; pair with --tls-cert" },
    { flags: "--allow-anonymous", help: "permit tokenless access on loopback (local testing, or an ssh-forwarded host door where SSH carries encryption and auth; reverse-proxy deployments still require UKP_SERVE_TOKEN)" },
    { flags: "--max-idle <seconds>", help: "exit after <seconds> without requests (self-reap; the orphan backstop for on-demand-woken doors — fractional values accepted for tests)" },
  ],
  helpSuffix: [
    "",
    "Wire (ukp-remote v1), single endpoint (--endpoint <name>):",
    `  GET  ${DISCOVERY_PATH}        discovery document (manifest projection,`,
    "                                protocol version, instance identity)",
    "  POST /v1/search              {query, limit} -> ukp.search.v1 envelope",
    "  GET  /v1/read?ref=…|uri=…    endpoint-relative ref or ukp:// URI",
    "  GET  /v1/nav?path=&depth=    markdown route view (ukp.nav.v1)",
    "  GET  /v1/rg?query=…          lexical search (ukp.rg.v1, ukp_uri handoff)",
    "",
    "Wire (ukp-remote v1), host door (no --endpoint):",
    `  GET  ${DISCOVERY_PATH}        door document (scope:"host", endpoint roster)`,
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
    "  mandatory — serve cannot see past its own bind address.",
    "",
    "  Loopback-without-token covers testing/dogfood AND the ssh door",
    "  deployment: bind the door on the remote host's loopback and let ssh",
    "  forwarding carry encryption and authentication (clients register",
    "  'ukp register --url ssh://<host>' — zero tokens, docker",
    "  DOCKER_HOST=ssh:// posture). It is not the way to consume a",
    "  same-machine endpoint — register its local path instead.",
    "  TLS (W5'): pass --tls to serve HTTPS with a self-signed identity",
    "  (generated under .ukp/tls/ — under the registry directory in door",
    "  mode —, SAN covers this host's addresses; remote clients TOFU-pin it",
    "  at registration and refresh by re-registering), or --tls-cert/--tls-key",
    "  for your own certificate (Let's Encrypt — IP certs available since",
    "  2026-01 —, mkcert, a private CA). Plain HTTP remains loopback-only by",
    "  admission; public exposure needs TLS or the ssh:// transport.",
    "",
  ].join("\n"),
};

export interface ParsedServe {
  /** Present = single-endpoint mode; absent = host door mode (W7). */
  endpoint?: string;
  host: string;
  port: number;
  /** Present = the --max-idle self-reap timer is armed (W9). */
  maxIdleSeconds?: number;
}

function toParsedServe(parsed: KitParsed): ParsedServe {
  const options = parsed.options as { host?: string; port?: string; endpoint?: string; maxIdle?: string };
  const endpoint = options.endpoint;
  if (endpoint !== undefined && endpoint.length === 0) {
    throw new KitUsageError("--endpoint <name> must not be empty (omit it to serve a host door)");
  }
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? "8570");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new KitUsageError("--port must be an integer between 1 and 65535");
  }
  let maxIdleSeconds: number | undefined;
  if (options.maxIdle !== undefined) {
    maxIdleSeconds = Number(options.maxIdle);
    if (!Number.isFinite(maxIdleSeconds) || maxIdleSeconds <= 0 || maxIdleSeconds > 86400) {
      throw new KitUsageError("--max-idle must be a positive number of seconds (at most 86400)");
    }
  }
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    host,
    port,
    ...(maxIdleSeconds !== undefined ? { maxIdleSeconds } : {}),
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
      `  discovery: ${info.url}${DISCOVERY_PATH} (host door)`,
      `  endpoints: ${info.door!.endpoints.length > 0 ? info.door!.endpoints.join(", ") : "(none — register endpoints on this host)"}`,
      `  write: ${info.door!.write.length > 0 ? info.door!.write.join(", ") + " (propose via PUT /e/<name>/v1/propose/<id>)" : "(no endpoint declares propose)"}`,
      `  auth: ${info.authRequired ? "bearer token required" : "no token (loopback bind; ssh-forwarded clients authenticate by SSH key)"}`,
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
    `  discovery: ${info.url}${DISCOVERY_PATH}`,
    `  auth: ${info.authRequired ? "bearer token required" : "no token (loopback only)"}`,
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
    const { endpoint, host, port, maxIdleSeconds } = toParsedServe(parsed);
    const allowAnonymous = (parsed.options as { allowAnonymous?: boolean }).allowAnonymous === true;
    const options = parsed.options as { tls?: boolean; tlsCert?: string; tlsKey?: string };
    // TLS flag family (W5'): --tls and --tls-cert/--tls-key are mutually
    // exclusive; the explicit pair must arrive complete.
    if (options.tls === true && (options.tlsCert !== undefined || options.tlsKey !== undefined)) {
      throw new KitUsageError("--tls and --tls-cert/--tls-key are mutually exclusive");
    }
    if (options.tls !== true && (options.tlsCert !== undefined) !== (options.tlsKey !== undefined)) {
      throw new KitUsageError("--tls-cert and --tls-key are used together");
    }
    const tokens = context.tokens ?? parseServeTokens(process.env.UKP_SERVE_TOKEN);
    const decision = serveAuthDecision(host, tokens, allowAnonymous);
    if (!decision.ok) {
      const target = endpoint === undefined ? "host door" : `'${endpoint}'`;
      throw new Error(`refusing to serve ${target}: ${decision.reason}`);
    }
    const { server, info } = startUkpServer({
      currentDirectory: context.currentDirectory,
      registryPath: context.registryPath,
      qmdCommand: context.qmdCommand,
      host,
      port,
      ...(endpoint !== undefined ? { endpointName: endpoint } : {}),
      ...(tokens.length > 0 ? { tokens } : {}),
      ...(maxIdleSeconds !== undefined ? { maxIdleSeconds } : {}),
      ...(options.tls === true
        ? { tls: { mode: "self-signed" as const } }
        : options.tlsCert !== undefined && options.tlsKey !== undefined
          ? { tls: { mode: "certificates" as const, certPath: options.tlsCert, keyPath: options.tlsKey } }
          : {}),
    });
    const stop = () => {
      console.error(`ukp serve: stopped (${info.url})`);
      server.stop(true);
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
