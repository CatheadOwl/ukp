import { join } from "node:path";
import { ENDPOINT_NAME, loadManifest, ServiceFolderInaccessibleError } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { EXTERNAL_TOOL_CAPABILITIES } from "../config/external-tool.ts";
import { diagnoseService, type ProviderResolver } from "./diagnose.ts";
import {
  assertUkpResidents,
  ensureVersionVisibleUkpIgnore,
  renderUkpIgnorePostureLine,
  ukpIgnoreStarWarning,
} from "./init.ts";
import {
  assertRegistrableRemoteUrl,
  isRemoteBinding,
  parseRemoteUrl,
  readRegistry,
  rebindAt,
  registerAt,
  registerRemoteAt,
  unregisterAt,
  type RegistryBinding,
} from "../registry.ts";
import { resolveScope, type ResolvedScope } from "../scope.ts";
import {
  createTransportPool,
  fetchDiscoveryDocument,
  fetchDoorDocument,
  fetchRegistrationDocument,
  probeRemoteTls,
  remoteTokenFor,
  resolveRemoteToken,
  type RemoteTransportPool,
} from "../capabilities/remote-client.ts";
import { defaultCredentialStore, type CredentialStore } from "../credential-store.ts";
import {
  KitUsageError,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  type UkpCommandSpec,
} from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

export interface InventoryCommandContext {
  currentDirectory: string;
  registryPath: string;
  resolveProvider?: ProviderResolver;
  /** Test injection point for the ssh binary behind ssh:// transports. */
  sshCommand?: readonly string[];
  /** Credential-store injection (ADR-REM-013 / W14): absent = the default
   * OS store (win32 DPAPI / mac security / linux secret-tool); tests pin
   * both register paths deterministically with the in-memory and
   * unavailable stubs. */
  credentialStore?: CredentialStore;
  /** Streaming seam (ukp_list W2 / ADR 0026 rule 3): when present, the
   * remote-mixed branch delivers stdout line-by-line through it — the header
   * and every local row flush synchronously before any network work starts,
   * remote rows append in registry order as they resolve — and the returned
   * result carries an empty stdout (the output already went out on this
   * channel; writeCommandResult's falsy check skips the final print).
   * Absent, the full text returns in result.stdout unchanged. The all-local
   * path never streams: it stays synchronous and byte-identical either
   * way. */
  emitStdout?: (line: string) => void;
  /** Progress seam (ukp_list W2 / ADR 0026 rule 3): self-contained stderr
   * frames for the remote fetch — the first frame is plain text, updates
   * carry a leading \r, the final frame clears the line. The wiring layer
   * injects it only when stderr is a TTY, so piped runs stay silent and
   * stdout never gains a control character. */
  emitProgress?: (frame: string) => void;
}

export interface InventoryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Single-source command specs (ADR 0024): summaries feed the root help via
 * cli.ts; usage feeds the help header and the usage-error line; excess
 * positionals are rejected by commander (strictArguments). */
export const REGISTER_SPEC: UkpCommandSpec = {
  name: "register",
  summary: "register a Service endpoint",
  group: "registry",
  description:
    "Register the current Service folder, a remote ukp-serve endpoint via --url, or - when that url is a host door - every endpoint behind it in one gesture.",
  usage: "[options]",
  strictArguments: true,
  options: [
    { flags: "--url <url>", help: "register a remote ukp-serve endpoint (https://host[:port], ssh://host[/endpoint] - ssh takes no port, the woken door picks its own - or loopback http); a host door url (its document declares scope:\"host\") imports every endpoint behind the door - binding urls gain the endpoint-name path (ssh://ali/notes)" },
    { flags: "--rebind", help: "local only: relocate this endpoint name to the current Service folder in one step (the folder moved); the name must already be bound to a local folder - registering a name bound elsewhere without this flag is rejected with the recovery path" },
    { flags: "--endpoint <name>", help: "assert the remote-declared name of the endpoint being registered (expected-name assertion; with a host door this imports only that endpoint)" },
    { flags: "--name <handle>", help: "remote only: register under this local handle - the registry key and ukp:// authority - instead of the declared name; use it when the declared name is already taken" },
    { flags: "--select <names>", help: "with a host door url: import only the named endpoints (comma-separated); a name not on the door is a usage error" },
    { flags: "--token <token>", help: "store the bearer token in the binding (plaintext, 0600 registry file); with a host door it is copied into every imported binding; UKP_ENDPOINT_<NAME>_TOKEN overrides it at call time" },
  ],
  helpSuffix: [
    "",
    "Recovery:",
    "  Registering a name already bound to a different location is rejected.",
    "  If the Service folder moved, re-run register from the new folder with",
    "  --rebind to relocate the name in one step (local bindings only):",
    "  ukp register --rebind",
    "  Without the flag the two-step path stays available:",
    "  ukp unregister --endpoint <name>",
    "",
    "Binding:",
    "  The Host Registry binds the Service Manifest's effective name to this",
    "  folder's location; 'ukp list' shows the resulting bindings. A local",
    "  register (plain or --rebind) also brings .ukp/.gitignore to the",
    "  precise-ignore posture: created when absent, a legacy '*' template",
    "  migrated so the declarations can be committed, an operator-owned",
    "  file left untouched.",
    "  With --url, the declared name and instance identity come from the",
    "  remote discovery document (/.well-known/ukp.json) and are pinned",
    "  TOFU-style as provenance; your registry binds them under a local",
    "  handle - the declared name by default, or --name <handle> when that",
    "  name is already taken. Use --endpoint <name> as an expected-name",
    "  assertion on the declared name; bearer-token services read",
    "  UKP_ENDPOINT_<NAME>_TOKEN (keyed by the handle) at call time.",
    "",
    "Host doors:",
    "  'ukp register --url ssh://ali' fetches the door's discovery document",
    "  and imports every endpoint behind it (a door url may also name one",
    "  endpoint: ssh://ali/notes). Import is explicit and idempotent:",
    "  re-running refreshes TOFU pins and tokens. Name conflicts are skipped",
    "  with a visible reason (never silently renamed) - re-register that one",
    "  endpoint with --name to land it under another handle; --select narrows",
    "  the import; door growth shows in 'ukp list' as drift notes until",
    "  imported.",
    "",
  ].join("\n"),
};

export const LIST_SPEC: UkpCommandSpec = {
  name: "list",
  summary: "list endpoint bindings - workspace scope by default, every registration with -g",
  group: "registry",
  description: "List endpoint bindings and capabilities: the workspace scope by default (nearest .ukp/client.toml; every registered endpoint when there is none), or the full Host Registry with -g.",
  usage: "[-g] [--json]",
  strictArguments: true,
  options: [
    { flags: "-g, --global", help: "list every registered endpoint (the full Host Registry), ignoring the workspace scope and without reading .ukp/client.toml" },
    { flags: "--json", help: "emit the offline machine-readable endpoint snapshot (schema ukp.list.v1; reads registry facts only, so remote capability fields are null - the text listing is the live view, fresh-fetching each remote row's discovery document and degrading unreachable rows to (unavailable)); rides the same scope as the text listing" },
  ],
};

export const UNREGISTER_SPEC: UkpCommandSpec = {
  name: "unregister",
  summary: "remove a registered endpoint binding (files on disk are untouched)",
  group: "registry",
  description: "Remove a registered endpoint.",
  usage: "--endpoint <name>",
  arguments: [{ name: "name", help: "legacy alias for --endpoint <name>; prefer the flag form" }],
  options: [{ flags: "-c, --endpoint <name>", help: "select the endpoint binding to remove" }],
  strictArguments: true,
};

interface UnregisterCommandOptions extends Record<string, unknown> {
  endpoint?: string;
}

// Derived file-native capabilities (read/nav today) exist on every registered
// endpoint without a declaration (ADR 0016 rule 2); they are stated once in
// the header instead of being repeated on every row. Everything else a
// Service declares (search, update, propose, ...) is per-endpoint news and
// gets its own column.
const DEFAULT_CAPABILITIES = (Object.keys(FILE_NATIVE_CAPABILITIES) as Array<keyof typeof FILE_NATIVE_CAPABILITIES>)
  .filter((name) => FILE_NATIVE_CAPABILITIES[name].derived)
  .sort();

/** Base-tier membership for the machine snapshot (ukp.list.v1): the
 * declaration-free baseline every healthy local endpoint carries — the
 * derived file-native set (nav, read; ADR 0016 rule 2, the header's own
 * statement) plus the external-tool base tier (rg; ADR-RG-003). Membership
 * only: rg's runtime availability still degrades by tool presence (tier
 * semantics unchanged — `base_tier` is not a liveness claim). */
const BASE_TIER_CAPABILITIES = [
  ...DEFAULT_CAPABILITIES,
  ...(Object.keys(EXTERNAL_TOOL_CAPABILITIES) as Array<keyof typeof EXTERNAL_TOOL_CAPABILITIES>)
    .filter((name) => EXTERNAL_TOOL_CAPABILITIES[name].baseTier),
].sort();

/** One endpoint as offline machine facts — the `ukp.list.v1` row (TODO
 * 20261028-0053). The machine contract is a registry-snapshot projection:
 * local rows read the Service Manifest (a local file read, never the
 * network); remote rows carry registry facts only, because the registry
 * pins no capability or liveness claims for remote bindings and the
 * contract never probes — the text face's fresh discovery fetch is a
 * per-invocation human affordance, not snapshot truth. Nullability is the
 * contract's one rule: `null` = "not asserted in this snapshot". */
export interface ListEndpointSnapshot {
  /** Registry handle — the ukp:// authority and the `--endpoint` key. */
  name: string;
  /** Local/remote discriminator (registry `kind`; absence = local). */
  kind: "local" | "remote";
  /** Binding location: the local canonical absolute path, or the
   * registered remote url verbatim. Exactly one of path/url is non-null. */
  location: { path: string | null; url: string | null };
  /** Remote-declared name snapshot (ADR-REM-007 provenance); null for
   * local bindings and legacy remote bindings that predate the field. */
  declared_name: string | null;
  /** Sorted declared capability extras (the text capabilities cell as an
   * array); null on degraded local rows and on every remote row. */
  capabilities: string[] | null;
  /** Declaration-free baseline members in effect (nav/read/rg today);
   * null on degraded local rows and on every remote row. */
  base_tier: string[] | null;
  /** Local rows: the Service Manifest loaded (true) or the row degraded
   * (false). Remote rows: null — remote liveness is not an offline fact. */
  available: boolean | null;
  /** Remote rows: where the binding's bearer secret resides
   * (ADR-REM-013) — "os-store" (token_ref), "inline" (plaintext registry
   * fallback), or "none" (no stored credential; env-only). Local rows:
   * null — locals carry no credentials (INV-11). */
  token_residence: "os-store" | "inline" | "none" | null;
  /** The same one-line degradation headline the text face emits on
   * stderr; null when the row is not degraded. */
  warning: string | null;
}

/** Envelope of the `--json` snapshot — the repo machine-face convention
 * (versioned schema id + pretty-printed single document, as nav/rg). */
export interface ListSnapshotEnvelope {
  schema: "ukp.list.v1";
  command: "list";
  endpoints: ListEndpointSnapshot[];
}

/** One list row as structured cells — column geometry is decided once, in
 * renderListOutput, from every row's actual widths (raw tab stops made the
 * columns land on a different multiple-of-8 per row once names, paths and
 * urls of very different widths mixed). */
interface InventoryListRow {
  /** Endpoint handle; a remote handle that differs from its declared name
   * carries the declaration inline (`name (declares X)`). */
  name: string;
  /** Local folder path or remote binding url. */
  location: string;
  /** Comma-separated declared extras, `-` for none, `(unavailable)` on
   * degraded rows. */
  capabilities: string;
  warning?: string;
}

/** Offline facts for one local binding — the single producer BOTH faces
 * consume (the same-truth seam of the machine contract: the text row and
 * the ukp.list.v1 row are projections of this, never parallel assemblies).
 * Manifest load failures degrade exactly like the text face: no capability
 * assertions plus the same one-line warning. */
interface LocalListFacts {
  name: string;
  path: string;
  /** Sorted declared extras; null on a degraded row. */
  capabilities: string[] | null;
  /** Baseline members; null on a degraded row. */
  baseTier: string[] | null;
  available: boolean;
  warning: string | null;
}

function localListFacts(endpoint: { name: string; path: string }): LocalListFacts {
  let service;
  try {
    service = loadManifest(endpoint.path);
  } catch (error) {
    // One-line headline only: an inventory warning must stay scannable even
    // when the underlying ManifestError carries a full zod schema dump.
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    // A dead binding (folder unreachable) is a binding-level failure, not a
    // capability degradation: the binding itself routes nowhere. It gets its
    // own frame plus the one-step rebind remedy (dead-binding item 1; the
    // `declared capabilities` qualifier stays reserved for manifest-level
    // failures where the folder IS reachable — probe-anchored wording).
    if (error instanceof ServiceFolderInaccessibleError) {
      return {
        name: endpoint.name,
        path: endpoint.path,
        capabilities: null,
        baseTier: null,
        available: false,
        warning: `endpoint '${endpoint.name}' binding is dead: ${headline}; `
          + `if the folder moved, run 'ukp register --rebind' from the new folder `
          + `(or 'ukp unregister --endpoint ${endpoint.name}')`,
      };
    }
    return {
      name: endpoint.name,
      path: endpoint.path,
      capabilities: null,
      baseTier: null,
      available: false,
      warning: `endpoint '${endpoint.name}' declared capabilities unavailable: ${headline}`,
    };
  }
  const extras = Object.keys(service.manifest.capabilities)
    .filter((name) => !(isFileNativeCapability(name) && FILE_NATIVE_CAPABILITIES[name].derived))
    .sort();
  return { name: endpoint.name, path: endpoint.path, capabilities: extras, baseTier: [...BASE_TIER_CAPABILITIES], available: true, warning: null };
}

function renderLocalListRow(endpoint: { name: string; path: string }): InventoryListRow {
  const facts = localListFacts(endpoint);
  return {
    name: facts.name,
    location: facts.path,
    capabilities: facts.available
      ? (facts.capabilities!.length > 0 ? facts.capabilities!.join(",") : "-")
      : "(unavailable)",
    ...(facts.warning !== null ? { warning: facts.warning } : {}),
  };
}

/** ukp.list.v1 projection of one local binding — the same localListFacts
 * the text row renders from, shaped as snapshot fields. */
function localSnapshotRow(endpoint: { name: string; path: string }): ListEndpointSnapshot {
  const facts = localListFacts(endpoint);
  return {
    name: facts.name,
    kind: "local",
    location: { path: facts.path, url: null },
    declared_name: null,
    capabilities: facts.capabilities,
    base_tier: facts.baseTier,
    available: facts.available,
    token_residence: null,
    warning: facts.warning,
  };
}

/** ukp.list.v1 row for one remote binding: pure registry projection, no
 * transport. The handle stays the bare `name` — the text face's
 * `name (declares X)` cell is a rendering; here the declaration rides in
 * `declared_name` as structure. Capability and liveness fields are null
 * per the offline contract (the registry pins none for remotes). */
function remoteSnapshotRow(endpoint: RegistryBinding): ListEndpointSnapshot {
  return {
    name: endpoint.name,
    kind: "remote",
    location: { path: null, url: endpoint.url! },
    declared_name: endpoint.declared_name ?? null,
    capabilities: null,
    base_tier: null,
    available: null,
    token_residence: endpoint.token_ref === "os-store"
      ? "os-store"
      : endpoint.token !== undefined ? "inline" : "none",
    warning: null,
  };
}

/** `--json` emission (TODO 20261028-0053 machine contract): one
 * pretty-printed document in the repo machine-face convention, rows in the
 * text face's order (locals first, then remotes, each in registry order).
 * Offline and synchronous by construction — no transport pool is ever
 * created for this path, so a registry full of remote bindings costs zero
 * network. stderr stays empty in this mode: degradation truth rides in the
 * rows' `warning` fields. */
function renderListJsonSnapshot(endpoints: readonly RegistryBinding[]): InventoryCommandResult {
  const rows = [
    ...endpoints
      .filter((endpoint) => !isRemoteBinding(endpoint))
      .map((endpoint) => localSnapshotRow({ name: endpoint.name, path: endpoint.path! })),
    ...endpoints.filter(isRemoteBinding).map(remoteSnapshotRow),
  ];
  const envelope: ListSnapshotEnvelope = { schema: "ukp.list.v1", command: "list", endpoints: rows };
  return { exitCode: 0, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: "" };
}

export function executeRegisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult | Promise<InventoryCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(REGISTER_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<{ url?: string; token?: string; select?: string; endpoint?: string; name?: string; rebind?: boolean }>(REGISTER_SPEC, args);
    const expectedName = parsed.options.endpoint;
    if (expectedName !== undefined && !ENDPOINT_NAME.test(expectedName)) {
      throw new KitUsageError("--endpoint requires a valid endpoint name");
    }
    const handleName = parsed.options.name;
    if (handleName !== undefined && !ENDPOINT_NAME.test(handleName)) {
      throw new KitUsageError("--name requires a valid endpoint name");
    }
    if (handleName !== undefined && parsed.options.url === undefined) {
      // N-1 (ADR-REM-007): a local name lives in the Service Manifest the
      // folder owner controls; the registry naming slot is remote-only.
      throw new KitUsageError("--name chooses a remote registration handle and requires --url");
    }
    if (parsed.options.rebind === true && parsed.options.url !== undefined) {
      // --rebind is the narrow local relocation exit; remote handles keep
      // the unregister path (registry-commands rebind-one-step, 2026-10-24).
      throw new KitUsageError("--rebind relocates a local binding and cannot be combined with --url");
    }
    if (parsed.options.url !== undefined) {
      return executeRegisterRemote(parsed.options.url, parsed.options.token, parsed.options.select, expectedName, handleName, context);
    }
    if (parsed.options.select !== undefined) {
      throw new KitUsageError("--select requires --url <door url>");
    }
    const report = diagnoseService(context.currentDirectory, context.resolveProvider);
    if (expectedName !== undefined && expectedName !== report.service.effectiveName) {
      throw new Error(`expected endpoint '${expectedName}', but this Service effective name is '${report.service.effectiveName}'`);
    }
    // INV-21 admission gate BEFORE the binding write: a foreign resident in
    // .ukp/ refuses the whole gesture — registry untouched, guard not
    // rewritten over material it no longer covers (the 2026-11-02 KB shape:
    // a '*' guard swapped onto the current template above a legacy tls/).
    const ukpDirectory = join(report.service.folder, ".ukp");
    assertUkpResidents(ukpDirectory, { endpointName: report.service.effectiveName });
    if (parsed.options.rebind === true) {
      // Diagnosis already validated the new Service folder — a failed rebind
      // (unknown name, remote handle, taken location) leaves the old binding
      // untouched; the swap itself is one atomic registry transition.
      const previous = readRegistry(context.registryPath).find(
        (endpoint) => endpoint.name === report.service.effectiveName,
      );
      rebindAt(context.registryPath, report.service.effectiveName, report.service.folder);
      // The service-side version-control step rides the same binding
      // gestures (use is the client-face carrier; a pure Service folder —
      // the fresh-clone revival path this command IS — has no reason to
      // run use, and re-running init is refused once the manifest exists).
      const posture = ensureVersionVisibleUkpIgnore(ukpDirectory);
      const lines = [
        `rebound: ${report.service.effectiveName}`,
        `from: ${previous?.path ?? "(unknown)"}`,
        ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
        `location: ${report.service.folder}`,
        renderUkpIgnorePostureLine(posture, ukpDirectory),
      ];
      return {
        exitCode: 0,
        stdout: lines.join("\n"),
        stderr: posture === "operator-owned-star" ? ukpIgnoreStarWarning(ukpDirectory) : "",
      };
    }
    registerAt(context.registryPath, report.service.effectiveName, report.service.folder);
    const posture = ensureVersionVisibleUkpIgnore(ukpDirectory);
    const lines = [
      `registered: ${report.service.effectiveName}`,
      ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
      `location: ${report.service.folder}`,
      renderUkpIgnorePostureLine(posture, ukpDirectory),
      // Register never edits Client Config (guide client owns that); this is
      // a pointer for the cross-workspace consumption case, which is the
      // standard follow-up after registering a Service others will reference.
      "next: to use this endpoint by default from another workspace, see 'ukp guide client' (workspace .ukp/client.toml)",
    ];
    return {
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: posture === "operator-owned-star" ? ukpIgnoreStarWarning(ukpDirectory) : "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(REGISTER_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(REGISTER_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp register: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Door-form binding url (O-3): canonical door origin + `/` + endpoint name —
 * the door lives in the url, indistinguishable from a direct registration. */
function doorEndpointUrl(origin: string, name: string): string {
  return `${origin}/${name}`;
}

/** Declared-capability column for import reports: same convention as list
 * rows — derived file-native capabilities are ambient, everything else is
 * per-endpoint news; `-` when the endpoint declares nothing extra. */
function declaredCapabilitySummary(capabilities: Record<string, unknown>): string {
  const extras = Object.entries(capabilities as Record<string, { derived?: boolean }>)
    .filter(([, capability]) => capability.derived !== true)
    .map(([name]) => name)
    .sort();
  return extras.length > 0 ? extras.join(",") : "-";
}

/** Import the door roster into the registry (ADR-REM-004 / O-4; naming
 * residence ADR-REM-007 / D-086): default is every endpoint, `--select`
 * narrows, conflicts are skipped with a visible reason plus the
 * single-endpoint `--name` remedy (never silently renamed), and same
 * url+declared name is the idempotent refresh under the existing handle
 * (TOFU pin + token, the W4 semantics in batch). ≥1 import/refresh exits 0;
 * all-skipped exits 1. */
function importDoorEndpoints(
  origin: string,
  door: {
    endpoints: ReadonlyArray<{ name: string; instance_uid: string; capabilities: Record<string, unknown> }>;
    /** Key-echo (ADR-REM-014): the presented key's admitted names, when the
     * door answered the registration fetch with one — undefined for an
     * anonymous fetch or a pre-echo door, and then nothing below changes. */
    admitted?: readonly string[];
  },
  targets: ReadonlyArray<{ name: string; instance_uid: string; capabilities: Record<string, unknown> }>,
  credentials: { token?: string; tls_cert?: string; tls_pin?: string },
  context: InventoryCommandContext,
  handleOverride?: string,
): InventoryCommandResult {
  const existing = readRegistry(context.registryPath);
  const lines = [`door ${origin}: ${door.endpoints.length} endpoint(s)`];
  let landed = 0;
  // Key-echo blind-import count (ADR-REM-014): bindings that land outside
  // the presented key's admission — annotated per line, totaled in a note,
  // never silently "ready" (the blank-agent probe found exactly that).
  let outOfScope = 0;
  const blindImport = (name: string): boolean => {
    const blind = door.admitted !== undefined && !door.admitted.includes(name);
    if (blind) outOfScope += 1;
    return blind;
  };
  // ADR-REM-013 / W14: with a token in hand, the OS credential store is the
  // default residence; a failed put falls back inline for THAT handle, and
  // the summary line at the end states which form landed — never a silent
  // downgrade.
  const store = context.credentialStore ?? defaultCredentialStore();
  const storeMode = credentials.token !== undefined && store.available();
  let storedHandles = 0;
  let inlineHandles = 0;
  const tokenField = (handle: string): { token_ref?: "os-store"; token?: string } => {
    if (credentials.token === undefined) return {};
    if (storeMode && store.put(handle, credentials.token)) {
      storedHandles += 1;
      return { token_ref: "os-store" };
    }
    inlineHandles += 1;
    return { token: credentials.token };
  };
  for (const target of targets) {
    // N-5 (ADR-REM-007): the url path segment stays the door-declared name —
    // the door routes by it; only the local handle may differ.
    const url = doorEndpointUrl(origin, target.name);
    const handle = handleOverride ?? target.name;
    // Mirror of registerRemoteBinding's same-url branch (registry.ts):
    // skip-line wording lives here, refusal semantics there — keep in step.
    const sameUrl = existing.find((endpoint) => endpoint.kind === "remote" && endpoint.url === url);
    if (sameUrl !== undefined) {
      // Legacy bindings carry no declared_name; their handle stood in for it.
      const existingDeclared = sameUrl.declared_name ?? sameUrl.name;
      if (existingDeclared !== target.name) {
        lines.push(`skipped:  ${target.name}  (url ${url} is bound to '${sameUrl.name}' declaring '${existingDeclared}')`);
        continue;
      }
      // A default gesture (no --name) refreshes the instance under its
      // EXISTING handle (N-2); an explicit --name must match it — explicit
      // means explicit, renaming goes through unregister.
      if (sameUrl.name !== handle && (handleOverride !== undefined || handle !== target.name)) {
        lines.push(`skipped:  ${target.name}  (url ${url} already bound to '${sameUrl.name}'; unregister it to change the handle)`);
        continue;
      }
      registerRemoteAt(context.registryPath, {
        name: sameUrl.name,
        declared_name: target.name,
        url,
        instance_uid: target.instance_uid,
        ...tokenField(sameUrl.name),
        ...(credentials.tls_cert !== undefined && credentials.tls_pin !== undefined
          ? { tls_cert: credentials.tls_cert, tls_pin: credentials.tls_pin }
          : {}),
      });
      landed += 1;
      lines.push(
        `refreshed: ${sameUrl.name}  (TOFU pin/credentials refreshed${blindImport(target.name) ? "; your key has no scope for it" : ""})`,
      );
      continue;
    }
    const sameName = existing.find((endpoint) => endpoint.name === handle);
    if (sameName !== undefined) {
      lines.push(
        `skipped:  ${target.name}  (name '${handle}' already bound to ${sameName.kind === "remote" ? sameName.url : sameName.path}; `
          + `re-register this endpoint with --name <handle> to land it under another)`,
      );
      continue;
    }
    registerRemoteAt(context.registryPath, {
      name: handle,
      declared_name: target.name,
      url,
      instance_uid: target.instance_uid,
      ...tokenField(handle),
      ...(credentials.tls_cert !== undefined && credentials.tls_pin !== undefined
        ? { tls_cert: credentials.tls_cert, tls_pin: credentials.tls_pin }
        : {}),
    });
    landed += 1;
    const noScope = blindImport(target.name) ? "; your key has no scope for it" : "";
    lines.push(
      handle !== target.name
        ? `imported: ${handle}  (declares ${target.name}; ${declaredCapabilitySummary(target.capabilities)}${noScope})`
        : `imported: ${handle}  (${declaredCapabilitySummary(target.capabilities)}${noScope})`,
    );
  }
  if (credentials.token !== undefined && landed > 0) {
    // No imports landed = no token was stored anywhere; printing an auth
    // line then misattributed a store failure that never happened.
    lines.push(
      storedHandles > 0 && inlineHandles === 0
        ? "auth: token stored in the OS credential store (keyed per endpoint handle)"
        : `auth: token stored in every imported binding (plaintext fallback${storeMode ? " - an OS store write failed" : " - no OS credential store available"}; 0600 registry file; treat it as a secret)`,
    );
  }
  if (outOfScope > 0) {
    lines.push(
      `note: ${outOfScope} imported endpoint(s) are outside this key's scope (calling them will answer 'no route under your key')`,
    );
  }
  return {
    exitCode: landed > 0 ? 0 : 1,
    stdout: lines.join("\n"),
    stderr: "",
  };
}

/** Remote registration (D-077/D-078 / spec endpoint-registration; host doors
 * since W7 / ADR-REM-004; naming residence ADR-REM-007): the well-known
 * document at the url's origin self-describes — an endpoint document (no
 * `scope`) registers one endpoint (declared name from the document as
 * provenance, local handle = declared name or --name, TOFU pin, --token in
 * the binding); a door document (`scope:"host"`) runs the import flow above
 * (--name only when exactly one target results). ssh:// urls tunnel
 * transparently; https urls probe TLS first (W5' / D-079): a public-CA chain
 * validates normally, a self-signed certificate is TOFU-pinned into the
 * binding(s) and verified on every later call. */
async function executeRegisterRemote(
  url: string,
  token: string | undefined,
  select: string | undefined,
  expectedName: string | undefined,
  handleName: string | undefined,
  context: InventoryCommandContext,
): Promise<InventoryCommandResult> {
  const selected = select === undefined
    ? undefined
    : select.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (selected !== undefined && selected.length === 0) {
    throw new KitUsageError("--select requires at least one endpoint name");
  }
  if (selected !== undefined && expectedName !== undefined) {
    throw new KitUsageError("--endpoint and --select cannot be used together");
  }

  let pool: RemoteTransportPool | undefined;
  try {
    // D-089: registration intake rejects an explicit ssh:// port (dead
    // grammar since the W9 wake); parse-time surfaces stay permissive.
    assertRegistrableRemoteUrl(url);
    const parts = parseRemoteUrl(url);
    if (parts === undefined) {
      throw new Error(`remote endpoint url is not admissible: ${url}`);
    }
    const tlsProbe = await probeRemoteTls(parts.origin);
    const pinSelfSigned = tlsProbe !== undefined && !tlsProbe.authorized;
    pool = createTransportPool(context.sshCommand === undefined ? {} : { sshCommand: context.sshCommand });
    const transport = await pool.acquire({ name: "(registering)", kind: "remote", url: parts.origin });
    const wellKnown = await fetchRegistrationDocument(transport.base, {
      ...(token !== undefined ? { token } : {}),
      ...(pinSelfSigned && tlsProbe !== undefined ? { tlsAnchor: { ca: tlsProbe.certPem } } : {}),
      displayUrl: parts.origin,
    });

    if (wellKnown.kind === "door") {
      const roster = wellKnown.door.doc.endpoints;
      for (const endpoint of roster) {
        if (!ENDPOINT_NAME.test(endpoint.name) || endpoint.instance_uid.length === 0) {
          throw new Error(`host door at ${parts.origin} declares an invalid endpoint '${endpoint.name}'`);
        }
      }
      const rosterNames = roster.map((endpoint) => endpoint.name).join(", ");
      let targets;
      if (parts.endpointName !== undefined) {
        if (expectedName !== undefined && expectedName !== parts.endpointName) {
          throw new KitUsageError(
            `remote url selects endpoint '${parts.endpointName}', but --endpoint asserts '${expectedName}'`,
          );
        }
        // A path segment addresses ONE endpoint through the door (H-rehearsal):
        // membership is checked against the live roster, unknown names say so.
        const found = roster.find((endpoint) => endpoint.name === parts.endpointName);
        if (found === undefined) {
          throw new Error(`no such endpoint '${parts.endpointName}' on door ${parts.origin} (available: ${rosterNames})`);
        }
        targets = [found];
      } else if (expectedName !== undefined) {
        const found = roster.find((endpoint) => endpoint.name === expectedName);
        if (found === undefined) {
          throw new Error(`no such endpoint '${expectedName}' on door ${parts.origin} (available: ${rosterNames})`);
        }
        targets = [found];
      } else if (selected !== undefined) {
        const unknown = selected.filter((name) => !roster.some((endpoint) => endpoint.name === name));
        if (unknown.length > 0) {
          throw new KitUsageError(
            `--select names not on door ${parts.origin}: ${unknown.join(", ")} (available: ${rosterNames})`,
          );
        }
        targets = roster.filter((endpoint) => selected.includes(endpoint.name));
      } else {
        targets = [...roster];
      }
      if (handleName !== undefined && targets.length !== 1) {
        throw new KitUsageError(
          `--name applies to a single endpoint, but this import targets ${targets.length}; narrow with --select/--endpoint or drop --name`,
        );
      }
      const result = importDoorEndpoints(
        parts.origin,
        // The registration fetch already carried the token (above), so a
        // key-echo-aware door hands its per-key admission along with the
        // roster (ADR-REM-014); pre-echo doors leave it undefined.
        { endpoints: roster, admitted: wellKnown.door.doc.admitted },
        targets,
        {
          ...(token !== undefined ? { token } : {}),
          ...(pinSelfSigned && tlsProbe !== undefined
            ? { tls_cert: tlsProbe.certPem, tls_pin: tlsProbe.spkiPin }
            : {}),
        },
        context,
        handleName,
      );
      const nameHint = wellKnown.door.bearerRequired && token === undefined
        ? [`note: this door requires a bearer token; pass --token or set UKP_ENDPOINT_<NAME>_TOKEN per endpoint`]
        : [];
      return {
        ...result,
        stdout: [...result.stdout.split("\n"), ...nameHint].join("\n"),
      };
    }

    // Endpoint document at the origin: today's single registration. The
    // /<name> path form addresses host doors only (learnability N2): the
    // refusal must teach the root-url registration, not contradict the
    // served name.
    if (parts.endpointName !== undefined) {
      throw new Error(
        `${parts.origin} serves a single endpoint '${wellKnown.discovery.doc.name}' (not a host door)`
          + ` - a /<name> path addresses host doors only; register the root url '${parts.origin}'`
          + ` and the served endpoint arrives under its own name`,
      );
    }
    if (selected !== undefined) {
      throw new KitUsageError(`--select requires a host door url: ${parts.origin} serves a single endpoint`);
    }
    const declaredName = wellKnown.discovery.doc.name;
    if (!ENDPOINT_NAME.test(declaredName)) {
      throw new Error(`discovery document declares an invalid endpoint name '${declaredName}'`);
    }
    if (expectedName !== undefined && expectedName !== declaredName) {
      throw new Error(`expected endpoint '${expectedName}', but discovery document declares '${declaredName}'`);
    }
    if (wellKnown.discovery.doc.instance_uid === undefined || typeof wellKnown.discovery.doc.instance_uid !== "string") {
      throw new Error("discovery document carries no instance_uid; the service must run a ukp-remote v1 server");
    }
    // ADR-REM-007 / D-086: the handle is the consumer-chosen local name
    // (defaults to the declared name); the declared name is stored as
    // provenance and stays the target of the expected-name assertion above.
    // N-2: a default-gesture re-registration of an already-tracked instance
    // (same url, same declared name) refreshes it under its EXISTING handle —
    // an explicitly different --name is refused first (explicit means
    // explicit; renaming goes through unregister).
    const requestedHandle = handleName ?? declaredName;
    const tracked = readRegistry(context.registryPath).find(
      (endpoint) => endpoint.kind === "remote" && endpoint.url === url,
    );
    if (
      tracked !== undefined && handleName !== undefined && handleName !== tracked.name
      && (tracked.declared_name ?? tracked.name) === declaredName
    ) {
      throw new Error(`remote endpoint ${url} is already registered as '${tracked.name}'; unregister it first to change the handle`);
    }
    const handle = tracked !== undefined
      && (tracked.declared_name ?? tracked.name) === declaredName
      && requestedHandle === declaredName
      ? tracked.name
      : requestedHandle;
    // ADR-REM-013 / W14 residence decision (single-endpoint form): the OS
    // credential store is the default; the inline registry token is the
    // loud fallback when no store exists or the write fails.
    const credentialStore = context.credentialStore ?? defaultCredentialStore();
    let tokenFields: { token_ref?: "os-store"; token?: string } = {};
    let authLine: string | undefined;
    if (token !== undefined) {
      if (credentialStore.available() && credentialStore.put(handle, token)) {
        tokenFields = { token_ref: "os-store" };
        authLine = `auth: token stored in the OS credential store; env UKP_ENDPOINT_${handle.toUpperCase().replace(/-/g, "_")}_TOKEN overrides`;
      } else {
        tokenFields = { token };
        authLine = `auth: token stored in registry binding (plaintext fallback${credentialStore.available() ? " - an OS store write failed" : " - no OS credential store available"}; treat it as a secret; env UKP_ENDPOINT_${handle.toUpperCase().replace(/-/g, "_")}_TOKEN overrides)`;
      }
    }
    registerRemoteAt(context.registryPath, {
      name: handle,
      declared_name: declaredName,
      url,
      instance_uid: wellKnown.discovery.doc.instance_uid,
      ...tokenFields,
      ...(pinSelfSigned && tlsProbe !== undefined
        ? { tls_cert: tlsProbe.certPem, tls_pin: tlsProbe.spkiPin }
        : {}),
    });
    const envToken = remoteTokenFor(handle);
    const lines = [
      `registered (remote): ${handle}`,
      ...(handle !== declaredName ? [`declares: ${declaredName} (remote-declared name, stored as provenance)`] : []),
      `url: ${url}`,
      `instance_uid: ${wellKnown.discovery.doc.instance_uid}`,
      ...(pinSelfSigned && tlsProbe !== undefined
        ? [`tls: pinned ${tlsProbe.spkiPin} (self-signed; compare with the serve banner out-of-band on untrusted networks)`]
        : []),
      ...(wellKnown.discovery.doc.description !== undefined ? [`description: ${wellKnown.discovery.doc.description}`] : []),
      ...(authLine !== undefined
        ? [authLine]
        : wellKnown.discovery.bearerRequired && envToken === undefined
          ? [`note: this endpoint requires a bearer token; pass --token or set UKP_ENDPOINT_${handle.toUpperCase().replace(/-/g, "_")}_TOKEN`]
          : []),
    ];
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(REGISTER_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp register: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    pool?.close();
  }
}

export function executeListCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult | Promise<InventoryCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(LIST_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<{ json?: boolean; global?: boolean }>(LIST_SPEC, args);
    // Scope semantics (owner ruling 2026-10-28 / ADR 0031, restoring the
    // 13ae382 clause): list eats the workspace scope like every consumer
    // command — the nearest client.toml's default_endpoints by default,
    // full-registry fallback when there is none (bare machines unchanged) —
    // and -g lists the full Host Registry without reading the config. No
    // machine-face exemption: --json rides the same resolution (the
    // exemption pattern is exactly what let the 09-21 contract ratify the
    // implementation drift); ukp.list.v1's fields are unchanged, only the
    // row set is selected.
    const registry = readRegistry(context.registryPath);
    let endpoints: readonly RegistryBinding[];
    let scopeWarnings: string[] = [];
    if (parsed.options.global === true) {
      endpoints = registry;
    } else {
      let scope: ResolvedScope;
      try {
        scope = resolveScope({ currentDirectory: context.currentDirectory, registry });
      } catch (error) {
        // Same law as the scope family, no list exemption: an invalid
        // client.toml or one that resolves to nothing fails the listing —
        // with the -g escape taught in place (it never reads the config).
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp list: ${message}; use 'ukp list -g' to list every registered endpoint\n`,
        };
      }
      endpoints = scope.bindings;
      scopeWarnings = scope.warnings;
    }
    if (parsed.options.json === true) {
      // Machine contract (ukp.list.v1 / TODO 20261028-0053): the offline
      // snapshot of the SELECTED endpoints. Returns before any transport
      // pool exists — see renderListJsonSnapshot; the sync return with
      // remote bindings present is the structural pin of the no-network
      // promise. Scope-level dangling warnings ride stderr (same strings
      // as the text face); row-level degradation truth stays in rows.
      const snapshot = renderListJsonSnapshot(endpoints);
      return {
        ...snapshot,
        stderr: scopeWarnings.length > 0 ? `${scopeWarnings.join("\n")}\n` : "",
      };
    }
    if (endpoints.length === 0) {
      return { exitCode: 0, stdout: "No endpoints registered.", stderr: "" };
    }
    const remotes = endpoints.filter(isRemoteBinding);
    if (remotes.length === 0) {
      return renderListOutput(endpoints.map((endpoint) => renderLocalListRow({ name: endpoint.name, path: endpoint.path! })), scopeWarnings);
    }
    // Remote rows fetch the discovery document (fresh per invocation); the
    // same conditional-async seam as search/read keeps all-local listings
    // byte-identical and synchronous. One transport pool serves the whole
    // invocation (O-5): same-origin door bindings — and their drift check —
    // share a single ssh tunnel.
    //
    // Fan-out + streaming (ukp_list W1/W2 / ADR 0026 rules 1 and 3): local
    // rows flush first — they are registry data in memory, so first output
    // needs no network at all — then every remote fetch and the drift check
    // start together (wall clock = max over origins, not the sum;
    // same-origin acquires converge on the pool's single open promise), and
    // remote rows append in registry order as they resolve, never rewriting
    // an already-emitted line. Row order is W2's one agent-visible change:
    // locals first, then remotes, each group in registry (name-sorted)
    // order.
    return (async () => {
      const pool = createTransportPool({
        registryPath: context.registryPath,
        ...(context.sshCommand === undefined ? {} : { sshCommand: context.sshCommand }),
      });
      try {
        const localRows = endpoints
          .filter((endpoint) => !isRemoteBinding(endpoint))
          .map((endpoint) => renderLocalListRow({ name: endpoint.name, path: endpoint.path! }));
        // Column geometry is decided once, before the first flush, from
        // every row's registry-known leading cells (ADR 0026 rule 4): only
        // the last cell depends on the network, so streaming never shifts a
        // column width.
        const geometry = listRowGeometry([
          ...localRows,
          ...remotes.map((endpoint) => ({ name: remoteRowName(endpoint), location: endpoint.url! })),
        ]);
        const lines: string[] = [];
        // The progress line and the streamed rows share one terminal: a
        // frame never ends with \n, so the cursor parks at its end — the
        // next row would print BESIDE the frame and the following \r would
        // overwrite the row's head (Windows Terminal dogfood finding). The
        // interlock: every row flush clears the frame first, owns its line,
        // and lets the next drawProgress redraw on the fresh bottom row.
        // With no progress channel (piped runs) the clear is a no-op and
        // the stream is untouched.
        const progress = context.emitProgress;
        let progressWidth = 0;
        const drawProgress = (frame: string) => {
          if (progress === undefined) return;
          progress(frame);
          progressWidth = frame.length;
        };
        const clearProgress = () => {
          if (progress === undefined || progressWidth === 0) return;
          progress(`\r${" ".repeat(progressWidth)}\r`);
          progressWidth = 0;
        };
        const flush = (line: string) => {
          clearProgress();
          lines.push(line);
          context.emitStdout?.(line);
        };

        flush(listHeaderLine());
        for (const row of localRows) flush(renderListLine(row, geometry));

        // Everything network-facing starts only after the local flush — and
        // the progress line goes out first, so the user never watches a
        // spinner-less wait. Frames must stay ASCII/narrow and each update
        // at least as wide as its predecessor: the clear blanks
        // progressWidth columns, so a wider glyph than code units (or a
        // shorter update) would leave stale tail cells on a real terminal.
        drawProgress(`fetching ${remotes.length} remote endpoint(s)...`);
        const remoteRows = remotes.map((endpoint) => renderRemoteListRow(endpoint, pool));
        const drift = collectDoorDriftNotes(endpoints, pool, context.credentialStore ?? defaultCredentialStore());

        const warnings = localRows.flatMap((row) => (row.warning !== undefined ? [row.warning] : []));
        let done = 0;
        // Head-of-line emission: the fetches already run concurrently; rows
        // print in registry order as their predecessors resolve. Each flush
        // cleared the frame; the update redraws it on the fresh bottom row.
        for (const row of remoteRows) {
          const resolved = await row;
          flush(renderListLine(resolved, geometry));
          if (resolved.warning !== undefined) warnings.push(resolved.warning);
          done += 1;
          if (done < remotes.length) drawProgress(`\rfetching remote endpoint(s): ${done}/${remotes.length}`);
        }
        // Cleared before the drift await (the last row's flush already
        // blanked the frame): every row is on screen, so the table reads
        // complete while the stderr footnotes gather — an https door's
        // drift fetch may be the slowest leg and a spinner under a finished
        // table would be noise.
        clearProgress();
        // Scope dangling warnings lead (they qualify the selection itself),
        // then row degradation, then the same-instance/drift notes.
        const stderrLines = [...scopeWarnings, ...warnings, ...collectSameInstanceNotes(endpoints), ...(await drift)];
        return {
          exitCode: 0,
          stdout: context.emitStdout === undefined ? lines.join("\n") : "",
          stderr: stderrLines.length > 0 ? `${stderrLines.join("\n")}\n` : "",
        };
      } finally {
        pool.close();
      }
    })();
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(LIST_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(LIST_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp list: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function renderListOutput(
  rows: ReadonlyArray<InventoryListRow>,
  leadingNotes: readonly string[] = [],
  extraNotes: readonly string[] = [],
): InventoryCommandResult {
  const warnings = [...leadingNotes, ...rows.flatMap((row) => (row.warning !== undefined ? [row.warning] : [])), ...extraNotes];
  const stdout = [listHeaderLine(), ...rows.map((row) => renderListLine(row, listRowGeometry(rows)))].join("\n");
  return {
    exitCode: 0,
    stdout,
    stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
  };
}

function listHeaderLine(): string {
  // The parenthetical is plain-language by probe verdict (20260921-list-wording):
  // blank readers parsed "(built-in, from the folder itself)" directly, while
  // "(derived file-native)" read as undefined jargon. Reworded 2026-11-12
  // (walkthrough F6): "from the folder itself" is false on a consumer
  // machine, where a remote row's capabilities arrive from the door's
  // discovery document — "(no declaration needed)" keeps the plain-language
  // bar while staying true for both local and remote rows.
  return `capabilities on every endpoint: ${DEFAULT_CAPABILITIES.join(", ")} (built-in, no declaration needed); additional declared capabilities per endpoint:`;
}

/** Space-padded columns: each cell pads to the widest same-column cell plus
 * a two-space gutter (the guide topic list's idiom), last column unpadded so
 * no line carries trailing whitespace. Tab-separated rows rendered ragged
 * whenever name/location widths straddled the terminal's tab stops. The
 * padded columns are registry-known strings (ADR 0026 rule 4): only the
 * last, unpadded cell depends on the remote fetch — so geometry can be
 * computed before the first flush and streaming never shifts a width. */
interface ListRowGeometry {
  nameWidth: number;
  locationWidth: number;
}

function listRowGeometry(rows: ReadonlyArray<Pick<InventoryListRow, "name" | "location">>): ListRowGeometry {
  return {
    nameWidth: Math.max(...rows.map((row) => row.name.length)),
    locationWidth: Math.max(...rows.map((row) => row.location.length)),
  };
}

function renderListLine(row: InventoryListRow, geometry: ListRowGeometry): string {
  return `${row.name.padEnd(geometry.nameWidth)}  ${row.location.padEnd(geometry.locationWidth)}  ${row.capabilities}`;
}

/** The name cell of a remote row — registry-known without any network, so
 * column geometry and the streamed local flush can lay out before any
 * fetch resolves. A handle that differs from the declared name
 * (ADR-REM-007) carries the declaration inline for audit. */
function remoteRowName(endpoint: RegistryBinding): string {
  return endpoint.declared_name !== undefined && endpoint.declared_name !== endpoint.name
    ? `${endpoint.name} (declares ${endpoint.declared_name})`
    : endpoint.name;
}

/** Remote row: capabilities from the discovery document; unreachable
 * endpoints degrade to `(unavailable)` + one stderr warning — the same
 * inventory semantics as an unreadable local manifest. Door-form bindings
 * (`ssh://ali/notes`) fetch their per-endpoint document through the shared
 * pool's tunnel. */
async function renderRemoteListRow(
  endpoint: RegistryBinding,
  pool: RemoteTransportPool,
): Promise<InventoryListRow> {
  const url = endpoint.url!;
  const name = remoteRowName(endpoint);
  try {
    const transport = await pool.acquire(endpoint);
    const discovery = await fetchDiscoveryDocument(
      endpoint,
      transport,
      resolveRemoteToken(endpoint, defaultCredentialStore()),
    );
    const extras = Object.entries(discovery.doc.capabilities)
      .filter(([, capability]) => capability.derived !== true)
      .map(([name]) => name)
      .sort();
    const warnings = discovery.warnings.length > 0 ? { warning: discovery.warnings.join("; ") } : {};
    return { name, location: url, capabilities: extras.length > 0 ? extras.join(",") : "-", ...warnings };
  } catch (error) {
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      name,
      location: url,
      capabilities: "(unavailable)",
      warning: `endpoint '${endpoint.name}' declared capabilities unavailable: ${headline}`,
    };
  }
}

/** Same-instance double-handle note (ADR-REM-007 / N-2): two handles may
 * legitimately point at one service through different urls (e.g. an ssh door
 * and an https door of the same host); the shared instance_uid makes it
 * visible. A note, not an error — each handle is a valid addressing surface,
 * but ukp:// references under the two handles are not interchangeable. */
function collectSameInstanceNotes(endpoints: readonly RegistryBinding[]): string[] {
  const byUid = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    if (!isRemoteBinding(endpoint) || endpoint.instance_uid === undefined) continue;
    const handles = byUid.get(endpoint.instance_uid) ?? [];
    handles.push(endpoint.name);
    byUid.set(endpoint.instance_uid, handles);
  }
  const notes: string[] = [];
  for (const [uid, handles] of byUid) {
    if (handles.length > 1) {
      notes.push(
        `note: ${[...handles].sort().map((handle) => `'${handle}'`).join(" and ")} pin the same instance_uid ${uid} - one service under two handles`,
      );
    }
  }
  return notes;
}

/** Door drift notes (ADR-REM-004 / O-4): group door-form bindings by their
 * url origin, fetch each door's document ONCE per invocation (riding the
 * pool's shared tunnel), and note the endpoints the door serves that the
 * ledger has not imported. The view is dynamic, the ledger stays static —
 * an unreachable door skips its check silently (rows already degrade to
 * `(unavailable)` on their own) and exit code never moves. */
async function collectDoorDriftNotes(
  endpoints: readonly RegistryBinding[],
  pool: RemoteTransportPool,
  store: CredentialStore,
): Promise<string[]> {
  const origins = new Map<string, { members: RegistryBinding[]; imported: Set<string> }>();
  for (const endpoint of endpoints) {
    if (!isRemoteBinding(endpoint)) continue;
    const parts = parseRemoteUrl(endpoint.url ?? "");
    if (parts === undefined || parts.endpointName === undefined) continue;
    let group = origins.get(parts.origin);
    if (group === undefined) {
      group = { members: [], imported: new Set<string>() };
      origins.set(parts.origin, group);
    }
    group.members.push(endpoint);
    // The roster speaks declared names; a handle that differs from the
    // declared name (ADR-REM-007) must not read as "not imported".
    group.imported.add(endpoint.declared_name ?? endpoint.name);
  }
  const notes: string[] = [];
  for (const [origin, group] of [...origins.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    // Anchor TLS on a member binding (https doors: same certificate serves
    // the door and its endpoints). Since the key-echo ruling (ADR-REM-014)
    // the check also spends the anchor member's token: a valid file key
    // earns the door's `admitted` echo, and the drift note becomes that
    // key's view (which unimported names it could actually address, which
    // imported bindings will hit 'no route under your key'). A member with
    // no resolvable token — or a pre-echo door — keeps the objective door
    // view, byte-identical to before.
    const anchor = group.members[0]!;
    const anchorToken = resolveRemoteToken(anchor, store);
    try {
      const transport = await pool.acquire({
        name: anchor.name,
        kind: "remote",
        url: origin,
        ...(anchor.tls_cert !== undefined ? { tls_cert: anchor.tls_cert, tls_pin: anchor.tls_pin } : {}),
      });
      const door = await fetchDoorDocument(transport.base, {
        displayUrl: transport.displayUrl,
        ...(anchorToken !== undefined ? { token: anchorToken } : {}),
        // ISSUE-017: the anchor hangs on the transport handle only — the
        // fetch must carry it onward (same hand-off as fetchDiscoveryDocument),
        // or a self-signed TOFU door rejects the well-known fetch and the
        // drift note dies silently for its primary deployment shape.
        ...(transport.tls !== undefined ? { tlsAnchor: transport.tls } : {}),
      });
      const admitted = door.doc.admitted;
      // The echo speaks for the key that earned it: a member binding under a
      // DIFFERENT token is not this echo's to judge — skip it.
      const echoesMember = (member: RegistryBinding): boolean =>
        resolveRemoteToken(member, store) === anchorToken;
      if (admitted !== undefined) {
        for (const member of group.members) {
          if (!echoesMember(member)) continue;
          const declaredName = member.declared_name ?? member.name;
          if (admitted.includes(declaredName)) continue;
          notes.push(
            `door ${origin}: '${member.name}' is outside this key's scope (calls answer 'no route under your key')`,
          );
        }
      }
      const unimported = door.doc.endpoints
        .map((endpoint) => endpoint.name)
        .filter((name) => !group.imported.has(name));
      if (unimported.length === 0) continue;
      // A roster name can be unimported because it COLLIDED — the name is
      // held by another binding, and the plain import remedy would skip it
      // again. Those names get the single-endpoint --name remedy instead
      // (W11 / ADR-REM-007).
      const outsideKey = (name: string): string =>
        admitted !== undefined && !admitted.includes(name) ? " (not under your key)" : "";
      const free = unimported.filter((name) => !endpoints.some((binding) => binding.name === name));
      const taken = unimported.filter((name) => endpoints.some((binding) => binding.name === name));
      if (free.length > 0) {
        notes.push(
          `door ${origin}: ${free.length} unimported endpoint(s): ${free.map((name) => name + outsideKey(name)).join(", ")} - run 'ukp register --url ${origin}' to import`,
        );
      }
      if (taken.length > 0) {
        notes.push(
          `door ${origin}: name(s) taken: ${taken.map((name) => name + outsideKey(name)).join(", ")} - import under another handle: 'ukp register --url ${origin}/<name> --name <handle>'`,
        );
      }
    } catch {
      // Door unreachable or not a door (anymore): the check is best-effort;
      // endpoint rows carry their own `(unavailable)` degradation.
    }
  }
  return notes;
}

export function executeUnregisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(UNREGISTER_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<UnregisterCommandOptions>(UNREGISTER_SPEC, args);
    const positional = parsed.positionals[0];
    if (parsed.options.endpoint && positional) {
      throw new KitUsageError("unregister accepts either --endpoint <name> or legacy positional <name>, not both");
    }
    const name = parsed.options.endpoint ?? positional;
    if (!name || !ENDPOINT_NAME.test(name)) {
      throw new KitUsageError("unregister requires a valid endpoint name via --endpoint <name>");
    }
    const previous = readRegistry(context.registryPath).find((binding) => binding.name === name);
    // ADR-REM-013: a store-resident secret leaves with its binding.
    if (previous?.token_ref === "os-store") {
      (context.credentialStore ?? defaultCredentialStore()).remove(name);
    }
    unregisterAt(context.registryPath, name);
    return {
      exitCode: 0,
      stdout: `unregistered: ${name}\nlocation: ${previous?.path ?? previous?.url ?? "unknown"}`,
      stderr: "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(UNREGISTER_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(UNREGISTER_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp unregister: ${error instanceof Error ? error.message : String(error)}` };
  }
}
