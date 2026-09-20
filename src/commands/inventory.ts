import { ENDPOINT_NAME, loadManifest } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { diagnoseService, type ProviderResolver } from "./diagnose.ts";
import {
  assertRegistrableRemoteUrl,
  isRemoteBinding,
  parseRemoteUrl,
  readRegistry,
  registerAt,
  registerRemoteAt,
  unregisterAt,
  type RegistryBinding,
} from "../registry.ts";
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
    "Register the current Service folder, a remote ukp-serve endpoint via --url, or — when that url is a host door — every endpoint behind it in one gesture.",
  usage: "[options]",
  strictArguments: true,
  options: [
    { flags: "--url <url>", help: "register a remote ukp-serve endpoint (https://host[:port], ssh://host[/endpoint] — ssh takes no port, the woken door picks its own — or loopback http); a host door url (its document declares scope:\"host\") imports every endpoint behind the door — binding urls gain the endpoint-name path (ssh://ali/notes)" },
    { flags: "--endpoint <name>", help: "assert the remote-declared name of the endpoint being registered (expected-name assertion; with a host door this imports only that endpoint)" },
    { flags: "--name <handle>", help: "remote only: register under this local handle — the registry key and ukp:// authority — instead of the declared name; use it when the declared name is already taken" },
    { flags: "--select <names>", help: "with a host door url: import only the named endpoints (comma-separated); a name not on the door is a usage error" },
    { flags: "--token <token>", help: "store the bearer token in the binding (plaintext, 0600 registry file); with a host door it is copied into every imported binding; UKP_ENDPOINT_<NAME>_TOKEN overrides it at call time" },
  ],
  helpSuffix: [
    "",
    "Recovery:",
    "  Registering a name already bound to a different location is rejected.",
    "  Unregister the old binding first, then register from the new Service folder:",
    "  ukp unregister --endpoint <name>",
    "",
    "Binding:",
    "  The Host Registry binds the Service Manifest's effective name to this",
    "  folder's location; 'ukp list' shows the resulting bindings.",
    "  With --url, the declared name and instance identity come from the",
    "  remote discovery document (/.well-known/ukp.json) and are pinned",
    "  TOFU-style as provenance; your registry binds them under a local",
    "  handle — the declared name by default, or --name <handle> when that",
    "  name is already taken. Use --endpoint <name> as an expected-name",
    "  assertion on the declared name; bearer-token services read",
    "  UKP_ENDPOINT_<NAME>_TOKEN (keyed by the handle) at call time.",
    "",
    "Host doors (ADR-REM-004):",
    "  'ukp register --url ssh://ali' fetches the door's discovery document",
    "  and imports every endpoint behind it (a door url may also name one",
    "  endpoint: ssh://ali/notes). Import is explicit and idempotent:",
    "  re-running refreshes TOFU pins and tokens. Name conflicts are skipped",
    "  with a visible reason (never silently renamed) — re-register that one",
    "  endpoint with --name to land it under another handle; --select narrows",
    "  the import; door growth shows in 'ukp list' as drift notes until",
    "  imported.",
    "",
  ].join("\n"),
};

export const LIST_SPEC: UkpCommandSpec = {
  name: "list",
  summary: "list registered endpoint bindings",
  group: "registry",
  description: "List registered endpoint bindings and capabilities.",
  usage: "[options]",
  strictArguments: true,
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

function renderLocalListRow(endpoint: { name: string; path: string }): { line: string; warning?: string } {
  let service;
  try {
    service = loadManifest(endpoint.path);
  } catch (error) {
    // One-line headline only: an inventory warning must stay scannable even
    // when the underlying ManifestError carries a full zod schema dump.
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      line: `${endpoint.name}\t${endpoint.path}\t(unavailable)`,
      warning: `endpoint '${endpoint.name}' capabilities unavailable: ${headline}`,
    };
  }
  const extras = Object.keys(service.manifest.capabilities)
    .filter((name) => !(isFileNativeCapability(name) && FILE_NATIVE_CAPABILITIES[name].derived))
    .sort();
  return { line: `${endpoint.name}\t${endpoint.path}\t${extras.length > 0 ? extras.join(",") : "-"}` };
}

export function executeRegisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult | Promise<InventoryCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(REGISTER_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<{ url?: string; token?: string; select?: string; endpoint?: string; name?: string }>(REGISTER_SPEC, args);
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
    registerAt(context.registryPath, report.service.effectiveName, report.service.folder);
    const lines = [
      `registered: ${report.service.effectiveName}`,
      ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
      `location: ${report.service.folder}`,
      // Register never edits Client Config (guide client owns that); this is
      // a pointer for the cross-workspace consumption case, which is the
      // standard follow-up after registering a Service others will reference.
      "next: to use this endpoint by default from another workspace, see 'ukp guide client' (workspace .ukp/client.toml)",
    ];
    return {
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: "",
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
  door: { endpoints: ReadonlyArray<{ name: string; instance_uid: string; capabilities: Record<string, unknown> }> },
  targets: ReadonlyArray<{ name: string; instance_uid: string; capabilities: Record<string, unknown> }>,
  credentials: { token?: string; tls_cert?: string; tls_pin?: string },
  context: InventoryCommandContext,
  handleOverride?: string,
): InventoryCommandResult {
  const existing = readRegistry(context.registryPath);
  const lines = [`door ${origin}: ${door.endpoints.length} endpoint(s)`];
  let landed = 0;
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
        ...(credentials.token !== undefined ? { token: credentials.token } : {}),
        ...(credentials.tls_cert !== undefined && credentials.tls_pin !== undefined
          ? { tls_cert: credentials.tls_cert, tls_pin: credentials.tls_pin }
          : {}),
      });
      landed += 1;
      lines.push(`refreshed: ${sameUrl.name}  (TOFU pin/credentials refreshed)`);
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
      ...(credentials.token !== undefined ? { token: credentials.token } : {}),
      ...(credentials.tls_cert !== undefined && credentials.tls_pin !== undefined
        ? { tls_cert: credentials.tls_cert, tls_pin: credentials.tls_pin }
        : {}),
    });
    landed += 1;
    lines.push(
      handle !== target.name
        ? `imported: ${handle}  (declares ${target.name}; ${declaredCapabilitySummary(target.capabilities)})`
        : `imported: ${handle}  (${declaredCapabilitySummary(target.capabilities)})`,
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
        { endpoints: roster },
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

    // Endpoint document at the origin: today's single registration.
    if (parts.endpointName !== undefined) {
      throw new Error(
        `no such endpoint '${parts.endpointName}' on ${parts.origin}: it serves a single endpoint '${wellKnown.discovery.doc.name}' (not a host door)`,
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
    registerRemoteAt(context.registryPath, {
      name: handle,
      declared_name: declaredName,
      url,
      instance_uid: wellKnown.discovery.doc.instance_uid,
      ...(token !== undefined ? { token } : {}),
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
      ...(token !== undefined
        ? [`auth: token stored in registry binding (plaintext; env UKP_ENDPOINT_${handle.toUpperCase().replace(/-/g, "_")}_TOKEN overrides)`]
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
    parseKitArgs(LIST_SPEC, args);
    const endpoints = readRegistry(context.registryPath);
    if (endpoints.length === 0) {
      return { exitCode: 0, stdout: "No endpoints registered.", stderr: "" };
    }
    const remotes = endpoints.filter(isRemoteBinding);
    if (remotes.length === 0) {
      return renderListOutput(endpoints.map((endpoint) => renderLocalListRow({ name: endpoint.name, path: endpoint.path! })));
    }
    // Remote rows fetch the discovery document (fresh per invocation); the
    // same conditional-async seam as search/read keeps all-local listings
    // byte-identical and synchronous. One transport pool serves the whole
    // invocation (O-5): same-origin door bindings — and their drift check —
    // share a single ssh tunnel.
    return (async () => {
      const pool = createTransportPool({
        registryPath: context.registryPath,
        ...(context.sshCommand === undefined ? {} : { sshCommand: context.sshCommand }),
      });
      try {
        const rendered: Array<{ line: string; warning?: string }> = [];
        for (const endpoint of endpoints) {
          if (!isRemoteBinding(endpoint)) {
            rendered.push(renderLocalListRow({ name: endpoint.name, path: endpoint.path! }));
            continue;
          }
          rendered.push(await renderRemoteListRow(endpoint, pool));
        }
        const drift = await collectDoorDriftNotes(endpoints, pool);
        return renderListOutput(rendered, [...collectSameInstanceNotes(endpoints), ...drift]);
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
  rows: ReadonlyArray<{ line: string; warning?: string }>,
  extraNotes: readonly string[] = [],
): InventoryCommandResult {
  const warnings = [...rows.flatMap((row) => (row.warning !== undefined ? [row.warning] : [])), ...extraNotes];
  const stdout = [
    `capabilities on every endpoint: ${DEFAULT_CAPABILITIES.join(", ")} (derived file-native); additional declared capabilities per endpoint:`,
    ...rows.map((row) => row.line),
  ].join("\n");
  return {
    exitCode: 0,
    stdout,
    stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
  };
}

/** Remote row: capabilities from the discovery document; unreachable
 * endpoints degrade to `(unavailable)` + one stderr warning — the same
 * inventory semantics as an unreadable local manifest. Door-form bindings
 * (`ssh://ali/notes`) fetch their per-endpoint document through the shared
 * pool's tunnel. A handle that differs from the declared name (ADR-REM-007)
 * carries the declaration inline for audit. */
async function renderRemoteListRow(
  endpoint: RegistryBinding,
  pool: RemoteTransportPool,
): Promise<{ line: string; warning?: string }> {
  const url = endpoint.url!;
  const declaredNote = endpoint.declared_name !== undefined && endpoint.declared_name !== endpoint.name
    ? ` (declares ${endpoint.declared_name})`
    : "";
  try {
    const transport = await pool.acquire(endpoint);
    const discovery = await fetchDiscoveryDocument(endpoint, transport, resolveRemoteToken(endpoint));
    const extras = Object.entries(discovery.doc.capabilities)
      .filter(([, capability]) => capability.derived !== true)
      .map(([name]) => name)
      .sort();
    const warnings = discovery.warnings.length > 0 ? { warning: discovery.warnings.join("; ") } : {};
    return { line: `${endpoint.name}${declaredNote}\t${url}\t${extras.length > 0 ? extras.join(",") : "-"}`, ...warnings };
  } catch (error) {
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      line: `${endpoint.name}${declaredNote}\t${url}\t(unavailable)`,
      warning: `endpoint '${endpoint.name}' capabilities unavailable: ${headline}`,
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
        `note: ${[...handles].sort().map((handle) => `'${handle}'`).join(" and ")} pin the same instance_uid ${uid} — one service under two handles`,
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
    // the door and its endpoints); the door document itself is public, so no
    // credential is spent on the check.
    const anchor = group.members[0]!;
    try {
      const transport = await pool.acquire({
        name: anchor.name,
        kind: "remote",
        url: origin,
        ...(anchor.tls_cert !== undefined ? { tls_cert: anchor.tls_cert, tls_pin: anchor.tls_pin } : {}),
      });
      const door = await fetchDoorDocument(transport.base, {});
      const unimported = door.doc.endpoints
        .map((endpoint) => endpoint.name)
        .filter((name) => !group.imported.has(name));
      if (unimported.length > 0) {
        notes.push(
          `door ${origin}: ${unimported.length} unimported endpoint(s): ${unimported.join(", ")} — run 'ukp register --url ${origin}' to import`,
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
