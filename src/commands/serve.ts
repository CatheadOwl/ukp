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
  token?: string;
}

/** Single-source command spec (ADR 0024): long-running host command — the
 * Bun.serve listener keeps the process alive after runCli returns its exit
 * code; SIGINT/SIGTERM stop the listener so the process exits with it. */
export const SERVE_SPEC: UkpCommandSpec = {
  name: "serve",
  summary: "serve one endpoint over HTTP for remote UKP clients",
  group: "operations",
  description: "Expose one registered endpoint over HTTP using the ukp-remote wire: a discovery document, search, and read.",
  usage: "--endpoint <name> [--host <addr>] [--port <n>]",
  singleEndpoint: {
    endpointHelp: "the registered endpoint to expose",
    unsupportedHelp: "serve exposes exactly one endpoint; -g is not supported",
  },
  options: [
    { flags: "--host <addr>", help: "listen address (default 127.0.0.1, loopback only without a token)" },
    { flags: "--port <n>", help: "listen port (default 8570)" },
  ],
  helpSuffix: [
    "",
    "Wire (ukp-remote v1):",
    `  GET  ${DISCOVERY_PATH}        discovery document (manifest projection,`,
    "                                protocol version, instance identity)",
    "  POST /v1/search              {query, limit} -> ukp.search.v1 envelope",
    "  GET  /v1/read?ref=…|uri=…    endpoint-relative ref or ukp:// URI",
    "",
    "Auth:",
    "  Set UKP_SERVE_TOKEN to require 'Authorization: Bearer <token>' on /v1",
    "  routes; the discovery document stays public. A non-loopback --host",
    "  without a token is refused.",
    "",
  ].join("\n"),
};

export interface ParsedServe {
  endpoint: string;
  host: string;
  port: number;
}

function toParsedServe(parsed: KitParsed): ParsedServe {
  const options = parsed.options as { host?: string; port?: string };
  const endpoint = parsed.scope.explicitEndpoints?.[0];
  // The singleEndpoint family already rejects a missing --endpoint; this is
  // a defensive narrowing for the type system.
  if (endpoint === undefined) throw new KitUsageError("serve requires --endpoint <name>");
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? "8570");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new KitUsageError("--port must be an integer between 1 and 65535");
  }
  return { endpoint, host, port };
}

export function parseServeArgs(args: readonly string[]): ParsedServe {
  return toParsedServe(parseKitArgs(SERVE_SPEC, args));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function renderServeBanner(info: ServeInfo): string {
  return [
    `serving endpoint '${info.endpoint}' (ukp-remote v1)`,
    `  listening: ${info.url}`,
    `  discovery: ${info.url}${DISCOVERY_PATH}`,
    `  auth: ${info.authRequired ? "bearer token required" : "no token (loopback only)"}`,
    "",
  ].join("\n");
}

export function executeServeCommand(
  args: readonly string[],
  context: ServeCommandContext,
): KitCommandResult {
  return executeKitCommand(SERVE_SPEC, args, (parsed) => {
    const { endpoint, host, port } = toParsedServe(parsed);
    const token = context.token ?? process.env.UKP_SERVE_TOKEN;
    if (!isLoopback(host) && token === undefined) {
      throw new Error(
        `refusing to serve '${endpoint}' on non-loopback ${host} without a token: set UKP_SERVE_TOKEN`,
      );
    }
    const { server, info } = startUkpServer({
      endpointName: endpoint,
      currentDirectory: context.currentDirectory,
      registryPath: context.registryPath,
      qmdCommand: context.qmdCommand,
      host,
      port,
      ...(token !== undefined ? { token } : {}),
    });
    const stop = () => {
      console.error(`ukp serve: stopped (${info.url})`);
      server.stop(true);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Exit code 0 flows out through runCli; the server listener keeps the
    // process alive until the signal handler stops it.
    return { exitCode: 0, stdout: renderServeBanner(info), stderr: "" };
  });
}

export function renderServeHelp(): string {
  return renderKitHelp(SERVE_SPEC);
}
