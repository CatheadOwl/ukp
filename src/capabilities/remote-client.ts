import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate } from "node:crypto";
import {
  DISCOVERY_PATH,
  PROTOCOL_NAME,
  type DiscoveryDocument,
  type DoorDocument,
  type DoorEndpointSummary,
} from "../server.ts";
import {
  assertRemoteUrlAllowed,
  parseRemoteUrl,
  refreshRemoteTlsCert,
  type RegistryBinding,
  type RemoteUrlParts,
} from "../registry.ts";
import { spkiPinOf } from "./tls-identity.ts";
import type { SearchEndpointOutcome } from "./search.ts";
import type { NavEnvelope } from "./nav.ts";
import type { ProposeResult, ProposeStatus } from "./propose.ts";
import { EXTERNAL_PROVIDER } from "../config/external-tool.ts";
import type { RgEndpointOutcome, RgMatch, RgCountEntry } from "./rg.ts";

/** Remote transport for the client side (ukp-remote wire v1, ADR-REM-002/003;
 * ukp_remote W2). All calls fetch fresh (no cross-invocation cache), carry the
 * endpoint token when configured, and map transport failures onto the
 * existing capability failure vocabulary. */

export class RemoteTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTransportError";
  }
}

/** `UKP_ENDPOINT_<NAME>_TOKEN` (name upper-cased, `-` → `_`): D-077 / ADR-REM-003. */
export function remoteTokenFor(endpointName: string): string | undefined {
  return process.env[`UKP_ENDPOINT_${endpointName.toUpperCase().replace(/-/g, "_")}_TOKEN`];
}

/** Credential resolution (D-078): env wins, the stored binding token is the
 * fallback — injected credentials (CI/agent env) never get shadowed by the
 * file, while the file keeps interactive use zero-ceremony. */
export function resolveRemoteToken(binding: RegistryBinding): string | undefined {
  return remoteTokenFor(binding.name) ?? binding.token;
}

/** `UKP_REMOTE_TIMEOUT_MS` mirrors `UKP_PROVIDER_TIMEOUT_MS` (60s default). */
function remoteTimeoutMs(): number {
  const raw = process.env.UKP_REMOTE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : 60_000;
}

/** TOFU mismatch policy (RQ-17): `warn` (default) appends a warning and
 * continues; `block` refuses the endpoint until it is explicitly
 * re-registered. */
function tofuMode(): "warn" | "block" {
  return process.env.UKP_TOFU === "block" ? "block" : "warn";
}

export interface RemoteTransportHandle {
  /** Wire base the client actually fetches (tunnel endpoint or the url itself). */
  base: string;
  /** Releases per-invocation resources (kills an ephemeral tunnel); noop for
   * direct connections. */
  close: () => void;
  /** TLS anchor for https bases (W5' / D-079): present when the binding
   * carries a pinned certificate; all fetches on this handle verify against
   * it. Mutated in place by the renewal re-anchor. */
  tls?: RemoteTlsAnchor;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => {}, open: () => {}, close: () => {}, drain: () => {}, error: () => {} },
    });
    const port = listener.port;
    listener.stop(true);
    if (port > 0) resolve(port);
    else reject(new RemoteTransportError("unable to allocate a local tunnel port"));
  });
}

/** TLS trust state for one invocation (W5' / D-079): `ca` is the pinned
 * certificate PEM handed to fetch as the trust anchor; `pin` is the RFC 7469
 * SPKI pin used to distinguish "server renewed its certificate, same key"
 * (re-anchor and continue) from "identity changed" (hard block). */
export interface RemoteTlsAnchor {
  ca: string;
  pin?: string;
  /** Endpoint label for the identity-changed error; absent at registration
   * (the name is not known yet — it comes from the discovery document). */
  name?: string;
  /** When set, a successful re-anchor persists the new PEM into the binding. */
  registryPath?: string;
}

export interface RemoteTlsProbe {
  /** Verified against the system trust store + hostname (public-CA path). */
  authorized: boolean;
  certPem: string;
  spkiPin: string;
}

/** Registration-time TLS probe (W5'): for https urls, capture the peer
 * certificate before the first fetch. authorized=true means a public CA
 * chain validates (no pinning); false means self-signed/private — the client
 * TOFU-pins the certificate as trust anchor plus its SPKI as identity.
 * Non-https urls (ssh:// tunnel, loopback http) return undefined: transport
 * security comes from SSH or locality, not TLS. */
export async function probeRemoteTls(url: string): Promise<RemoteTlsProbe | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteTransportError(`remote endpoint url is not a valid absolute URL: ${url}`);
  }
  if (parsed.protocol !== "https:") return undefined;
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  const host = parsed.hostname;
  return await new Promise<RemoteTlsProbe>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port,
        // SNI must be a name, not an IP (node:tls rejects IP servernames);
        // IP-addressed certificates verify through the SAN, not SNI.
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false,
      },
      () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        if (peer === undefined || peer.raw === undefined || peer.raw.length === 0) {
          reject(new RemoteTransportError(`remote endpoint presented no TLS certificate: ${url}`));
          return;
        }
        resolve({
          authorized: socket.authorized === true,
          certPem: new X509Certificate(peer.raw).toString(),
          spkiPin: spkiPinOf(peer.raw),
        });
      },
    );
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new RemoteTransportError(`TLS probe timed out: ${url}`));
    });
    socket.on("error", (error) => {
      reject(new RemoteTransportError(`TLS probe failed: ${url} (${error instanceof Error ? error.message : String(error)})`));
    });
  });
}

/** Door-endpoint wire prefix (ADR-REM-004 / O-3): a url with a path segment
 * (`ssh://ali/notes`) addresses one endpoint THROUGH the door at origin —
 * every wire route hangs off `/e/<name>`, so the path becomes this prefix
 * on the transport base and downstream `${base}/v1/…` calls stay unchanged. */
function wirePrefix(endpointName: string | undefined): string {
  return endpointName === undefined ? "" : `/e/${endpointName}`;
}

function tlsAnchorOf(binding: RegistryBinding, options: { registryPath?: string }): RemoteTlsAnchor | undefined {
  return binding.url !== undefined && binding.url.startsWith("https://") && binding.tls_cert !== undefined
    ? {
        ca: binding.tls_cert,
        ...(binding.tls_pin !== undefined ? { pin: binding.tls_pin } : {}),
        name: binding.name,
        ...(options.registryPath !== undefined ? { registryPath: options.registryPath } : {}),
      }
    : undefined;
}

function directTransportHandle(
  binding: RegistryBinding,
  parts: RemoteUrlParts,
  options: { registryPath?: string },
): RemoteTransportHandle {
  return {
    base: parts.origin + wirePrefix(parts.endpointName),
    close: () => {},
    ...(tlsAnchorOf(binding, options) !== undefined ? { tls: tlsAnchorOf(binding, options)! } : {}),
  };
}

/** W9 / ADR-REM-006: the woken door self-reaps after this idle window. The
 * ali E2E falsified the "clean disconnect reaps via SIGHUP" assumption for
 * no-TTY sessions — without a controlling terminal a remote command NEVER
 * receives SIGHUP, normal disconnect included — so `-tt` (below) is what
 * makes the door session-bound, and this window is the pure backstop for
 * paths where even the pty session lingers (network death awaiting TCP
 * keepalive). NOT a tuning knob. */
const WAKE_DOOR_MAX_IDLE_SECONDS = 60;
/** Probe budget for a woken door: ssh handshake + auth + remote bun startup. */
const WAKE_READY_TIMEOUT_MS = 20_000;
/** Remote door ports are client-chosen from this unprivileged band — the url
 * port no longer selects anything under wake (the resident-door assumption is
 * gone; per-binding door urls keep their identity role). The band sits BELOW
 * the Linux (32768+) and Windows (49152+) ephemeral ranges, so OS-assigned
 * short-lived listeners never collide with it; only an explicitly bound
 * service in the band can (rare — absorbed by the bounded retry). */
const WAKE_REMOTE_PORT_MIN = 20000;
const WAKE_REMOTE_PORT_SPAN = 12768;

function randomRemotePort(): number {
  return WAKE_REMOTE_PORT_MIN + Math.floor(Math.random() * WAKE_REMOTE_PORT_SPAN);
}

/** Tier 1 (ADR-REM-006 §4): substrate-native handshake amortization. A
 * dedicated `-N` mux master is spawned per origin before the wake client;
 * with ControlPersist it daemonizes immediately and self-exits WINDOW
 * seconds after the last session — ukp never reaps it. The wake client then
 * multiplexes over the warm connection (no TCP+key handshake); only the
 * remote bun startup stays per-call. The door STILL spawns per call as the
 * client's own session and dies with it — this is NOT the deferred Tier-2
 * persistent door. UKP-owned ControlPath namespace (keyed by %r/%h/%p = the
 * SSH endpoint, not the forwarded ports) avoids colliding with the user's
 * own multiplexing config. Native Windows OpenSSH has no ControlMaster
 * support ("unix listener too long") — Tier 0 there, per-call handshake. */
const WAKE_MUX_PERSIST_SECONDS = 120;
const WAKE_MUX_CONTROL_PATH = "~/.ssh/ukp-cm-%r@%h-%p";
/** A successful candidate daemonizes (its foreground exits within seconds of
 * the handshake); one still alive after this window is by definition the
 * degraded direct `-N` connection — reaped here. */
const WAKE_MASTER_GRACE_MS = 10_000;

/** The candidate's options: it OWNS master creation (ControlMaster=auto +
 * ControlPersist — with them a becoming-master daemonizes immediately and
 * self-exits after the persist window). */
function muxCandidateOptions(): readonly string[] {
  if (process.platform === "win32") return [];
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${WAKE_MUX_PERSIST_SECONDS}`,
    "-o", `ControlPath=${WAKE_MUX_CONTROL_PATH}`,
  ];
}

/** The wake client's options: attach-only (ControlMaster=no + ControlPath).
 * OpenSSH attempts the control socket whenever ControlPath is set, so the
 * client rides an existing master without any handshake; with no master (or
 * a stale socket) it just connects directly. Crucially the client NEVER
 * creates masters: a client-side auto racing the candidate resolves via
 * temp-bind+link() where the loser disables mux and continues as a FOREGROUND
 * connection — for the candidate that means an idle `-N` leaking forever
 * (openssh mux.c muxserver_listen). */
function muxClientOptions(): readonly string[] {
  if (process.platform === "win32") return [];
  return [
    "-o", "ControlMaster=no",
    "-o", `ControlPath=${WAKE_MUX_CONTROL_PATH}`,
  ];
}

/** The detached mux master (Tier 1): no session, no forwards — with
 * ControlPersist it backgrounds itself and holds just the authenticated
 * connection for the persist window. If a master already exists (socket
 * alive), this exits immediately and harmlessly. Only FAILED candidates are
 * reaped, after the grace window: a daemonized master's foreground has
 * already exited, while a candidate that lost the creation race or hit a
 * stale socket lives on as a plain direct `-N` connection that would idle
 * forever — one per invocation until the socket is cleaned by hand. Never
 * spawned on win32: native OpenSSH has no ControlMaster support. */
function spawnMuxMaster(
  sshCommand: readonly string[] | undefined,
  target: string,
): void {
  if (process.platform === "win32") return;
  const argv = [
    ...(sshCommand ?? ["ssh"]),
    "-N",
    "-o", "BatchMode=yes",
    ...muxCandidateOptions(),
    target,
  ];
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const grace = setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, WAKE_MASTER_GRACE_MS);
    (grace as { unref?: () => void }).unref?.();
  } catch {
    // best-effort: without a master the wake client just handshakes itself
  }
}

/** The pinned wake command (W9 / ADR-REM-006 §4 安全收窄): a fixed shape where
 * only the client-chosen integer port and idle window are interpolated — the
 * exact string an operator can allowlist with git-shell / authorized_keys
 * `command=`. Loopback-only, anonymous: SSH carries encryption and auth. */
function wakeDoorCommand(remotePort: number): string {
  return `ukp serve --allow-anonymous --host 127.0.0.1 --port ${remotePort} --max-idle ${WAKE_DOOR_MAX_IDLE_SECONDS}`;
}

/** HTTP-level readiness probe through the tunnel (W9): a TCP accept on the
 * local forward proves nothing — ssh accepts locally and connects remotely
 * lazily — so we poll the door's public discovery document until it answers
 * AND declares the ukp-remote protocol (a foreign listener that happens to
 * occupy the remote port and answer 200 must not read as "ready"). An ssh
 * that already exited aborts the wait (no point polling a dead forward; the
 * caller classifies from the captured stderr). */
async function probeWakeReady(
  base: string,
  timeoutMs: number,
  proc: ReturnType<typeof Bun.spawn>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${base}${DISCOVERY_PATH}`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        try {
          const body: unknown = await response.json();
          if (
            typeof body === "object" && body !== null
            && (body as Record<string, unknown>).protocol === PROTOCOL_NAME
          ) {
            return true;
          }
        } catch {
          // not our door (non-JSON) — keep waiting; the real door may still
          // be booting behind the forward
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      // not ready yet — the door is still booting behind the forward
    }
    if (proc.exitCode !== null) return false;
    if (Date.now() > deadline) return false;
    await Bun.sleep(150);
  }
}

/** Keep the tail of a spawn's output for failure diagnostics. The wake
 * client runs under `-tt` (a pty merges the remote stderr into its stdout),
 * so diagnostics can arrive on either stream — both are drained and
 * concatenated. Resolves when the streams end (i.e. after the process is
 * dead) — only await once the proc has been killed or has exited. */
function drainStderrTail(streams: readonly ReadableStream<Uint8Array>[], keep = 2000): Promise<string> {
  return Promise.all(
    streams.map((stream) => new Response(stream).text().catch(() => "")),
  ).then((texts) => {
    const text = texts.join("").trim();
    return text.length > keep ? `…${text.slice(-keep)}` : text;
  });
}

/** On-demand wake (W9 / ADR-REM-006, replaces the W4 `-N -L` resident-door
 * assumption): one ssh process both opens the local forward AND runs the
 * pinned `ukp serve` loopback door as its remote command — the door lives and
 * dies with the session (SIGHUP on clean close; `--max-idle` bounds the
 * abrupt-disconnect orphan). Encryption + host/user auth come from the user's
 * SSH config/keys. `sshCommand` is a test injection point for the ssh binary.
 * Bounded retries absorb a client-chosen remote port colliding with an
 * in-use one (the door fails to bind and the command exits). */
async function openSshTunnel(
  parts: { user?: string; host: string },
  options: { sshCommand?: readonly string[] },
  endpointLabel: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }> {
  const target = parts.user !== undefined ? `${parts.user}@${parts.host}` : parts.host;
  // Tier 1 first: a detached mux master per origin (no-op when one already
  // holds the socket); the wake client below rides it when possible and
  // degrades to a full handshake when not (first call of a burst, win32).
  spawnMuxMaster(options.sshCommand, target);
  // Fatal mux conditions on the wake client (ControlPath expansion too long,
  // unwritable socket dir) are fatal per attempt — once seen, drop the mux
  // options for the remaining attempts so the endpoint degrades to Tier 0
  // instead of hard-failing what worked without mux.
  let muxDisabled = false;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const localPort = await freePort();
    const remotePort = randomRemotePort();
    const argv = [
      ...(options.sshCommand ?? ["ssh"]),
      // Session-bound door (ali E2E): a no-TTY remote command NEVER receives
      // SIGHUP on disconnect — normal disconnect included, the door only ever
      // died to --max-idle. Forcing a pty gives the session a controlling
      // terminal, so killing the client reaps the door in seconds (verified:
      // kill -9 of the local ssh → door gone within 3s).
      "-tt",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "BatchMode=yes",
      ...(muxDisabled ? [] : muxClientOptions()),
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      target,
      wakeDoorCommand(remotePort),
    ];
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stderrTail = drainStderrTail([proc.stdout, proc.stderr]);
    if (await probeWakeReady(`http://127.0.0.1:${localPort}`, WAKE_READY_TIMEOUT_MS, proc)) {
      return { proc, base: `http://127.0.0.1:${localPort}` };
    }
    proc.kill();
    // Read `exited` only after the stderr stream ended (its end implies the
    // process is dead) — reading before the probe's last tick could label a
    // fast crash as a slow timeout.
    const diagnostics = (await stderrTail).trim();
    const exited = proc.exitCode !== null;
    if (/ControlPath too long|muxserver_listen|unix_listener/i.test(diagnostics)) {
      muxDisabled = true;
    }
    // POSIX login shells print "…: ukp: command not found" (exit 127); Windows
    // OpenSSH under cmd prints "'ukp' is not recognized…" (exit 9009).
    if (exited && /not found|not recognized|exit status 127|status 9009/i.test(diagnostics)) {
      throw new RemoteTransportError(
        `waking the ukp door on '${target}' (endpoint '${endpointLabel}') failed — the remote shell cannot find 'ukp': ${diagnostics}. Host prerequisite (W9): ssh reachable AND ukp on the remote PATH`,
      );
    }
    if (attempt === attempts) {
      throw new RemoteTransportError(
        exited
          ? `waking the ukp door on '${target}' (endpoint '${endpointLabel}') failed: ${diagnostics}`
          : `the ukp door on '${target}' (endpoint '${endpointLabel}') did not become ready within ${WAKE_READY_TIMEOUT_MS / 1000}s; check the host alias and key auth (BatchMode)`,
      );
    }
  }
  // Unreachable: the loop throws on its final attempt (attempts >= 1).
  throw new RemoteTransportError(`waking the ukp door on '${target}' failed unexpectedly`);
}

/** Ensure a usable wire base for one invocation (D-078 transparent ssh, W9
 * on-demand wake): http/https urls are used directly; `ssh://[user@]host
 * [:port][/endpoint]` spawns ONE ssh process that opens the local forward
 * AND wakes the pinned loopback door as its remote command, then returns the
 * tunnel endpoint (plus the `/e/<name>` prefix when the url selects a door
 * endpoint). Under wake the url's `[:port]` selects nothing — the remote
 * door port is client-chosen. https bindings with a pinned certificate carry
 * their TLS anchor on the handle. `sshCommand` is a test injection point for
 * the ssh binary invocation; `registryPath` lets the renewal re-anchor
 * persist. */
export async function openRemoteTransport(
  binding: RegistryBinding,
  options: { sshCommand?: readonly string[]; registryPath?: string } = {},
): Promise<RemoteTransportHandle> {
  if (binding.kind !== "remote" || binding.url === undefined) {
    throw new RemoteTransportError(`endpoint '${binding.name}' is not a remote binding`);
  }
  assertRemoteUrlAllowed(binding.url);
  const parts = parseRemoteUrl(binding.url);
  if (parts === undefined) {
    throw new RemoteTransportError(`remote endpoint url is not admissible: ${binding.url}`);
  }
  if (parts.scheme !== "ssh") {
    return directTransportHandle(binding, parts, options);
  }
  const tunnel = await openSshTunnel(parts, options, binding.name);
  return {
    base: tunnel.base + wirePrefix(parts.endpointName),
    close: () => tunnel.proc.kill(),
  };
}

/** Per-invocation transport pool (W7 / O-5, W9 wake): same-origin ssh urls
 * share ONE woken ssh+door pair for the pool's lifetime — a 3-endpoint door's
 * `ukp list` is one tunnel, not four (per-row + door fetch). The map stores
 * the OPEN PROMISE, so overlapping acquires (a future fan-out) converge on
 * one spawn instead of racing a second and orphaning the first door. Pure
 * client-internal: handed-out handles have a noop `close`; the caller closes
 * the pool when the invocation ends. Direct (https / loopback http) urls
 * need no pooling and get the same one-shot handles as
 * `openRemoteTransport`. */
export interface RemoteTransportPool {
  acquire(binding: RegistryBinding): Promise<RemoteTransportHandle>;
  close(): void;
}

export function createTransportPool(
  options: { sshCommand?: readonly string[]; registryPath?: string } = {},
): RemoteTransportPool {
  const tunnels = new Map<string, Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }>>();
  return {
    async acquire(binding) {
      if (binding.kind !== "remote" || binding.url === undefined) {
        throw new RemoteTransportError(`endpoint '${binding.name}' is not a remote binding`);
      }
      assertRemoteUrlAllowed(binding.url);
      const parts = parseRemoteUrl(binding.url);
      if (parts === undefined) {
        throw new RemoteTransportError(`remote endpoint url is not admissible: ${binding.url}`);
      }
      if (parts.scheme !== "ssh") {
        return directTransportHandle(binding, parts, options);
      }
      let tunnel = tunnels.get(parts.origin);
      if (tunnel === undefined) {
        // Drop the entry on failure so a retry inside the same invocation
        // spawns fresh instead of re-throwing a stale rejected promise.
        tunnel = openSshTunnel(parts, options, binding.name).catch((error: unknown) => {
          tunnels.delete(parts.origin);
          throw error;
        });
        tunnels.set(parts.origin, tunnel);
      }
      const acquired = await tunnel;
      return {
        base: acquired.base + wirePrefix(parts.endpointName),
        close: () => {},
      };
    },
    close() {
      for (const tunnel of tunnels.values()) void tunnel.then(({ proc }) => proc.kill(), () => {});
      tunnels.clear();
    },
  };
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function unreachableError(url: string, error: unknown): RemoteTransportError {
  const code = (error as { code?: unknown }).code;
  const detail = error instanceof Error ? error.message : String(error);
  return new RemoteTransportError(
    `remote endpoint unreachable: ${url} (${detail}${typeof code === "string" && code !== "" ? ` [${code}]` : ""})`,
  );
}

/** Renewal re-anchor attempt (W5' / D-079, adjudication point B): after a fetch-phase
 * failure with an anchor present, probe the CURRENT peer certificate.
 * Same SPKI pin → server renewed its certificate keeping the key: swap the
 * anchor (and persist) and let the caller retry once, invisibly. Different
 * pin → identity change (reinstall or MITM): hard block. Unreachable probe
 * → the original failure stands. */
async function reanchorFromProbe(url: string, anchor: RemoteTlsAnchor): Promise<boolean> {
  const probe = await probeRemoteTls(url).catch(() => undefined);
  if (probe === undefined) return false;
  if (anchor.pin !== undefined && probe.spkiPin !== anchor.pin) {
    throw new RemoteTransportError(
      `remote '${anchor.name ?? "endpoint"}' TLS identity changed — pinned ${anchor.pin}, got ${probe.spkiPin}; if the server was reinstalled this is expected: refresh trust with 'ukp register --url <url> --token <token>'`,
    );
  }
  anchor.ca = probe.certPem;
  if (anchor.registryPath !== undefined && anchor.name !== undefined) {
    try {
      refreshRemoteTlsCert(anchor.registryPath, anchor.name, probe.certPem);
    } catch {
      // persistence is best-effort: the in-memory anchor already unblocks
      // this invocation; the next renewal re-anchors again.
    }
  }
  return true;
}

/** Fetch + JSON-decode with one transparent renewal re-anchor: a pinned
 * https anchor turns a certificate-verification fetch failure into a probe —
 * same SPKI keeps going (anchor swapped in place), a different SPKI blocks. */
async function fetchJson(
  url: string,
  init: RequestInit,
  anchor?: RemoteTlsAnchor,
): Promise<{ status: number; body: unknown }> {
  const attempt = async (ca?: string, wrap = true): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(remoteTimeoutMs()),
        ...(ca !== undefined ? { tls: { ca } } : {}),
      } as RequestInit);
    } catch (error) {
      // wrap=false keeps the raw error so the anchored caller can classify
      // it (TLS verification failure → re-anchor probe) before wrapping.
      if (!wrap) throw error;
      throw unreachableError(url, error);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RemoteTransportError(`remote endpoint returned a non-JSON body (status ${response.status}): ${url}`);
    }
    return { status: response.status, body };
  };

  if (anchor === undefined) return await attempt();
  try {
    return await attempt(anchor.ca, false);
  } catch (error) {
    if (error instanceof RemoteTransportError) throw error; // non-JSON body: not a TLS event
    if (isTimeoutError(error)) throw unreachableError(url, error);
    // Re-anchoring needs a pinned identity: only the SPKI pin distinguishes
    // "renewed certificate, same key" from "different identity".
    if (anchor.pin !== undefined && await reanchorFromProbe(url, anchor)) return await attempt(anchor.ca);
    throw unreachableError(url, error);
  }
}

function asRecord(body: unknown, url: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RemoteTransportError(`remote endpoint returned an unexpected payload shape: ${url}`);
  }
  return body as Record<string, unknown>;
}

export interface DiscoveryFetch {
  doc: DiscoveryDocument;
  /** TOFU observations (caller renders as warnings; mismatch never blocks). */
  warnings: string[];
  bearerRequired: boolean;
}

/** Fetch + validate the discovery document, run the TOFU pin comparison. */
export async function fetchDiscoveryDocument(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token?: string,
): Promise<DiscoveryFetch> {
  return fetchDiscoveryDocumentAt(transport.base, {
    name: binding.name,
    ...(binding.instance_uid !== undefined ? { pinnedUid: binding.instance_uid } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(transport.tls !== undefined ? { tlsAnchor: transport.tls } : {}),
  });
}

/** Raw well-known fetch shared by the endpoint and door document paths:
 * decodes JSON, checks the protocol name/version, and reports whether the
 * service declares bearer auth. Scope discrimination (absence of `scope` =
 * endpoint document) is the callers' job — that IS the wire contract
 * (ADR-REM-004 / O-1). */
async function fetchWellKnownRecord(
  base: string,
  options: { token?: string; tlsAnchor?: RemoteTlsAnchor },
): Promise<{ record: Record<string, unknown>; bearerRequired: boolean }> {
  const url = `${base}${DISCOVERY_PATH}`;
  const { body } = await fetchJson(url, { headers: authorizationHeaders(options.token) }, options.tlsAnchor);
  const record = asRecord(body, url);
  if (record.protocol !== PROTOCOL_NAME) {
    throw new RemoteTransportError(`service at ${base} is not a ukp-remote service (protocol: ${String(record.protocol)})`);
  }
  if (record.protocol_version !== "1") {
    throw new RemoteTransportError(`service at ${base} speaks ukp-remote protocol version ${String(record.protocol_version)}; this client supports 1`);
  }
  const schemes = (record.security as { schemes?: unknown } | undefined)?.schemes;
  return { record, bearerRequired: Array.isArray(schemes) && schemes.includes("bearer") };
}

/** URL-addressed variant for registration (the name is not known yet — it
 * comes FROM this document per RQ-14). `tlsAnchor` carries the registration
 * probe's captured certificate for self-signed servers (W5'). A door
 * document here is a classified failure: this path is for endpoint
 * documents; doors go through `fetchRegistrationDocument`. */
export async function fetchDiscoveryDocumentAt(
  url: string,
  options: { name?: string; pinnedUid?: string; token?: string; tlsAnchor?: RemoteTlsAnchor } = {},
): Promise<DiscoveryFetch> {
  const base = url.replace(/\/+$/, "");
  const label = options.name ?? base;
  const { record, bearerRequired } = await fetchWellKnownRecord(base, options);
  if (record.scope === "host") {
    throw new RemoteTransportError(
      `service at ${base} is a host door (scope:"host"); register it with 'ukp register --url ${base}' to import its endpoints`,
    );
  }
  const warnings: string[] = [];
  if (options.pinnedUid !== undefined && record.instance_uid !== options.pinnedUid) {
    // TOFU (ADR-REM-003, RQ-17): warn by default, refuse under UKP_TOFU=block —
    // never silently trust the new identity.
    const detail = `endpoint '${label}' identity changed (pinned ${options.pinnedUid}, served ${String(record.instance_uid)}); re-register with 'ukp register --url' if this replacement is intended`;
    if (tofuMode() === "block") {
      throw new RemoteTransportError(`${detail} (refused: UKP_TOFU=block)`);
    }
    warnings.push(detail);
  }
  return {
    doc: record as unknown as DiscoveryDocument,
    warnings,
    bearerRequired,
  };
}

/** Door roster validation (O-1): every `endpoints[]` entry must carry a
 * string name + instance_uid — the trust payload clients pin per endpoint. */
function parseDoorEndpoints(record: Record<string, unknown>, base: string): DoorEndpointSummary[] {
  const rawEndpoints = record.endpoints;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    throw new RemoteTransportError(`host door at ${base} declares no endpoints`);
  }
  const endpoints: DoorEndpointSummary[] = [];
  for (const entry of rawEndpoints) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RemoteTransportError(`host door at ${base} declares a malformed endpoints[] entry`);
    }
    const summary = entry as Record<string, unknown>;
    if (typeof summary.name !== "string" || typeof summary.instance_uid !== "string") {
      throw new RemoteTransportError(`host door at ${base} declares an endpoint without name/instance_uid`);
    }
    endpoints.push(summary as unknown as DoorEndpointSummary);
  }
  return endpoints;
}

export interface DoorFetch {
  doc: DoorDocument;
  bearerRequired: boolean;
}

/** Fetch + validate a host door document (ADR-REM-004 / O-1): requires
 * `scope:"host"` and a well-formed `endpoints[]` roster. Per-endpoint TOFU
 * happens on the per-endpoint documents at import/call time — the door
 * itself carries no identity. */
export async function fetchDoorDocument(
  url: string,
  options: { token?: string; tlsAnchor?: RemoteTlsAnchor } = {},
): Promise<DoorFetch> {
  const base = url.replace(/\/+$/, "");
  const { record, bearerRequired } = await fetchWellKnownRecord(base, options);
  if (record.scope !== "host") {
    throw new RemoteTransportError(`service at ${base} is not a host door (scope: ${String(record.scope)}); register it directly with 'ukp register --url ${base}'`);
  }
  return {
    doc: { ...(record as unknown as DoorDocument), endpoints: parseDoorEndpoints(record, base) },
    bearerRequired,
  };
}

/** Registration-time well-known fetch with scope discrimination (O-1): the
 * document at the url's origin self-describes — `scope:"host"` routes to the
 * door import flow, absence routes to today's single-endpoint registration.
 * One fetch, one verdict. */
export type RegistrationFetch =
  | { kind: "door"; door: DoorFetch }
  | { kind: "endpoint"; discovery: DiscoveryFetch };

export async function fetchRegistrationDocument(
  url: string,
  options: { token?: string; tlsAnchor?: RemoteTlsAnchor } = {},
): Promise<RegistrationFetch> {
  const base = url.replace(/\/+$/, "");
  const { record, bearerRequired } = await fetchWellKnownRecord(base, options);
  if (record.scope === "host") {
    return {
      kind: "door",
      door: {
        doc: { ...(record as unknown as DoorDocument), endpoints: parseDoorEndpoints(record, base) },
        bearerRequired,
      },
    };
  }
  return { kind: "endpoint", discovery: { doc: record as unknown as DiscoveryDocument, warnings: [], bearerRequired } };
}

export interface RemoteSearchExecution {
  outcome: SearchEndpointOutcome;
  /** Provider-native results array (wire `results`): the render source for
   * human result units, replacing local providerOutput's role. */
  results: unknown[];
  /** Inline references (wire `references`, RQ-07): per-result handoff keys
   * with server-declared `ukp_uri`. */
  references: Array<{ ukp_uri?: string }> | undefined;
}

/** POST /v1/search → endpoint outcome in the local SearchEndpointOutcome
 * vocabulary (status/message/envelope-compatible fields). */
export async function remoteSearch(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token: string | undefined,
  query: string,
  limit: number,
): Promise<RemoteSearchExecution> {
  const base = transport.base;
  const { status, body } = await fetchJson(`${base}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authorizationHeaders(token) },
    body: JSON.stringify({ query, limit }),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/search`);
  const envelope = record.endpoints as Array<Record<string, unknown>> | undefined;
  const entry = Array.isArray(envelope) ? envelope[0] : undefined;

  if (status === 401) {
    return { outcome: failedOutcome(binding.name, authMessage(token)), results: [], references: undefined };
  }
  if (entry === undefined) {
    return { outcome: failedOutcome(binding.name, `remote search returned no endpoint result (status ${status})`), results: [], references: undefined };
  }
  const entryStatus = entry.status;
  if (entryStatus !== "succeeded" && entryStatus !== "no_matches") {
    const message = typeof entry.message === "string" ? entry.message : `remote endpoint status '${String(entryStatus)}'`;
    return { outcome: { name: binding.name, provider: providerOf(record), status: "failed", message }, results: [], references: undefined };
  }
  const referencesRecord = record.references as { results?: unknown } | undefined;
  const references = referencesRecord !== undefined && Array.isArray(referencesRecord.results)
    ? referencesRecord.results as Array<{ ukp_uri?: string }>
    : undefined;
  return {
    outcome: {
      name: binding.name,
      provider: providerOf(record),
      status: entryStatus,
      ...(typeof entry.message === "string" ? { message: entry.message } : {}),
    },
    results: Array.isArray(record.results) ? record.results : [],
    references,
  };
}

function authMessage(token: string | undefined): string {
  return token === undefined
    ? "remote endpoint requires a bearer token; set UKP_ENDPOINT_<NAME>_TOKEN (NAME upper-cased, '-' → '_')"
    : "remote endpoint rejected the bearer token (401)";
}

function providerOf(record: Record<string, unknown>): string | null {
  const endpoints = record.endpoints as Array<Record<string, unknown>> | undefined;
  const provider = Array.isArray(endpoints) ? endpoints[0]?.provider : undefined;
  return typeof provider === "string" ? provider : null;
}

function failedOutcome(name: string, message: string): SearchEndpointOutcome {
  return { name, provider: null, status: "failed", message };
}

export interface RemoteReadResult {
  status: number;
  ok: boolean;
  content: string;
  /** Envelope error fields for failures (class/message). */
  errorClass?: string;
  errorMessage?: string;
  reference: string;
}

/** GET /v1/read — raw transport; classification into ReadOutcome happens in
 * the read adapter (commands/read.ts) where the local vocabulary lives. */
export async function remoteRead(
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: { ref?: string; uri?: string; lines?: string; pin?: string },
): Promise<RemoteReadResult> {
  const base = transport.base;
  const search = new URLSearchParams();
  if (params.ref !== undefined) search.set("ref", params.ref);
  if (params.uri !== undefined) search.set("uri", params.uri);
  if (params.lines !== undefined) search.set("lines", params.lines);
  if (params.pin !== undefined) search.set("pin", params.pin);
  const { status, body } = await fetchJson(`${base}/v1/read?${search.toString()}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/read`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;
  return {
    status,
    ok: record.ok === true,
    content: typeof record.content === "string" ? record.content : "",
    ...(error !== undefined && typeof error.class === "string" ? { errorClass: error.class } : {}),
    ...(error !== undefined && typeof error.message === "string" ? { errorMessage: error.message } : {}),
    reference: typeof record.reference === "string" ? record.reference : (params.ref ?? params.uri ?? ""),
  };
}

export interface RemoteNavResult {
  status: number;
  /** Success marker: the nav envelope itself (ukp.nav.v1) — it has no `ok`
   * field, so schema presence is the verdict. */
  ok: boolean;
  envelope?: NavEnvelope;
  /** Transport-shape error fields for failures (class/message). */
  errorClass?: string;
  errorMessage?: string;
}

/** GET /v1/nav — raw transport; classification into NavFailure happens in
 * the nav adapter (commands/nav.ts) where the local vocabulary lives. */
export async function remoteNav(
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: { path?: string; depth?: number },
): Promise<RemoteNavResult> {
  const base = transport.base;
  const search = new URLSearchParams();
  if (params.path !== undefined) search.set("path", params.path);
  if (params.depth !== undefined) search.set("depth", String(params.depth));
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const { status, body } = await fetchJson(`${base}/v1/nav${query}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/nav`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;
  // Shape gate (read precedent validates what it consumes): a body claiming
  // the schema but missing the rendered fields would crash the shared
  // renderers downstream — treat it as a failed call, not a success.
  const ok = record.schema === "ukp.nav.v1"
    && Array.isArray(record.entries)
    && Array.isArray(record.diagnostics);
  return {
    status,
    ok,
    ...(ok ? { envelope: record as unknown as NavEnvelope } : {}),
    ...(!ok && error !== undefined && typeof error.class === "string" ? { errorClass: error.class } : {}),
    ...(!ok && error !== undefined && typeof error.message === "string" ? { errorMessage: error.message } : {}),
  };
}

export interface RemoteRgExecution {
  outcome: RgEndpointOutcome;
  /** Envelope-level warnings from the server run (scope/duplicate notes —
   * usually empty server-side; endpoint failures live in the outcome). */
  warnings: string[];
}

function remoteRgMatches(raw: unknown): RgMatch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): RgMatch[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const match = entry as Record<string, unknown>;
    if (typeof match.path !== "string") return [];
    return [{
      path: match.path,
      ...(typeof match.line === "number" ? { line: match.line } : {}),
      ...(typeof match.text === "string" ? { text: match.text } : {}),
      ...(typeof match.ukp_uri === "string" ? { ukp_uri: match.ukp_uri } : {}),
    }];
  });
}

function remoteRgCounts(raw: unknown): RgCountEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): RgCountEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const count = entry as Record<string, unknown>;
    if (typeof count.path !== "string" || typeof count.count !== "number") return [];
    return [{ path: count.path, count: count.count }];
  });
}

const RG_WIRE_STATUSES = new Set(["succeeded", "no_matches", "skipped", "failed", "interrupted", "cancelled"]);

/** GET /v1/rg — single-endpoint outcome in the local RgEndpointOutcome
 * vocabulary (provider is rg's external tier regardless of transport). */
export async function remoteRg(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: {
    query: string;
    limit: number;
    glob?: string;
    type?: string;
    ignoreCase?: boolean;
    count?: boolean;
    passthrough: readonly string[];
  },
): Promise<RemoteRgExecution> {
  const base = transport.base;
  const search = new URLSearchParams({ query: params.query, limit: String(params.limit) });
  if (params.glob !== undefined) search.set("glob", params.glob);
  if (params.type !== undefined) search.set("type", params.type);
  if (params.ignoreCase === true) search.set("i", "1");
  if (params.count === true) search.set("count", "1");
  for (const arg of params.passthrough) search.append("passthrough", arg);
  const { status, body } = await fetchJson(`${base}/v1/rg?${search.toString()}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/rg`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;

  if (status === 401) {
    return { outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message: authMessage(token) }, warnings: [] };
  }
  if (error !== undefined) {
    // Route-level failure: an older serve without /v1/rg answers 404
    // not-found; anything else keeps the server's message.
    const message = typeof error.message === "string"
      ? error.message
      : `remote rg failed (status ${status})`;
    return { outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message }, warnings: [] };
  }
  const envelope = record.endpoints as Array<Record<string, unknown>> | undefined;
  const entry = Array.isArray(envelope) ? envelope[0] : undefined;
  if (entry === undefined) {
    return {
      outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message: `remote rg returned no endpoint result (status ${status})` },
      warnings: [],
    };
  }
  const wireStatus = typeof entry.status === "string" && RG_WIRE_STATUSES.has(entry.status) ? entry.status : "failed";
  const matches = remoteRgMatches(entry.matches);
  const counts = remoteRgCounts(entry.counts);
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    outcome: {
      name: binding.name,
      provider: EXTERNAL_PROVIDER,
      status: wireStatus as RgEndpointOutcome["status"],
      ...(typeof entry.message === "string" ? { message: entry.message } : {}),
      ...(matches !== undefined ? { matches } : {}),
      ...(counts !== undefined ? { counts } : {}),
      ...(entry.truncated === true ? { truncated: true } : {}),
    },
    warnings,
  };
}

export interface RemoteProposeResult {
  status: number;
  /** Success marker: the ukp.propose.v1 envelope with a valid three-state
   * status and revision — schema + field presence is the verdict (nav
   * precedent). */
  ok: boolean;
  result?: ProposeResult;
  /** Transport-shape error fields for failures (class/message). */
  errorClass?: string;
  errorMessage?: string;
}

const PROPOSE_WIRE_STATUSES = new Set<ProposeStatus>(["created", "unchanged", "updated"]);

/** PUT /v1/propose/{id} — the write face (W8 / ADR-REM-005). Body is the
 * proposal text itself (UTF-8); classification into ProposeFailure happens
 * in the propose command adapter where the local vocabulary lives. */
export async function remotePropose(
  transport: RemoteTransportHandle,
  token: string | undefined,
  id: string,
  content: string,
): Promise<RemoteProposeResult> {
  const base = transport.base;
  const url = `${base}/v1/propose/${id}`;
  const { status, body } = await fetchJson(url, {
    method: "PUT",
    headers: { "content-type": "text/plain; charset=utf-8", ...authorizationHeaders(token) },
    body: content,
  }, transport.tls);
  const record = asRecord(body, url);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;
  const ok = record.schema === "ukp.propose.v1"
    && typeof record.id === "string"
    && typeof record.status === "string"
    && PROPOSE_WIRE_STATUSES.has(record.status as ProposeStatus)
    && typeof record.revision === "number"
    && Number.isSafeInteger(record.revision)
    && record.revision >= 1;
  return {
    status,
    ok,
    ...(ok
      ? { result: { id: record.id as string, status: record.status as ProposeStatus, revision: record.revision as number } }
      : {}),
    ...(!ok && error !== undefined && typeof error.class === "string" ? { errorClass: error.class } : {}),
    ...(!ok && error !== undefined && typeof error.message === "string" ? { errorMessage: error.message } : {}),
  };
}
