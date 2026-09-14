import { ENDPOINT_NAME, loadManifest } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { diagnoseService, type ProviderResolver } from "./diagnose.ts";
import {
  assertRemoteUrlAllowed,
  isRemoteBinding,
  readRegistry,
  registerAt,
  registerRemoteAt,
  unregisterAt,
  type RegistryBinding,
} from "../registry.ts";
import {
  fetchDiscoveryDocument,
  fetchDiscoveryDocumentAt,
  openRemoteTransport,
  remoteTokenFor,
  resolveRemoteToken,
  type RemoteTransportHandle,
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
  description: "Register the current Service folder, or a remote ukp-serve endpoint via --url.",
  usage: "[options]",
  strictArguments: true,
  options: [
    { flags: "--url <url>", help: "register a remote ukp-serve endpoint (https, ssh://host[:port], or loopback http); the endpoint name comes from its discovery document" },
    { flags: "--token <token>", help: "store the bearer token in the binding (plaintext, 0600 registry file); UKP_ENDPOINT_<NAME>_TOKEN overrides it at call time" },
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
    "  With --url, the name and instance identity come from the remote",
    "  discovery document (/.well-known/ukp.json) and are pinned TOFU-style;",
    "  bearer-token services read UKP_ENDPOINT_<NAME>_TOKEN at call time.",
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
    const parsed = parseKitArgs<{ url?: string; token?: string }>(REGISTER_SPEC, args);
    if (parsed.options.url !== undefined) {
      return executeRegisterRemote(parsed.options.url, parsed.options.token, context);
    }
    const report = diagnoseService(context.currentDirectory, context.resolveProvider);
    registerAt(context.registryPath, report.service.effectiveName, report.service.folder);
    const lines = [
      `registered: ${report.service.effectiveName}`,
      ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
      `location: ${report.service.folder}`,
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

/** Remote registration (D-077/D-078 / spec endpoint-registration): name comes
 * from the discovery document (RQ-14 strict equality holds from day one), the
 * instance uid is the TOFU pin; ssh:// urls register through a transparent
 * ephemeral tunnel, and --token stores the credential in the binding. */
async function executeRegisterRemote(
  url: string,
  token: string | undefined,
  context: InventoryCommandContext,
): Promise<InventoryCommandResult> {
  let transport: RemoteTransportHandle | undefined;
  try {
    assertRemoteUrlAllowed(url);
    transport = await openRemoteTransport({ name: "(registering)", kind: "remote", url });
    const discovery = await fetchDiscoveryDocumentAt(transport.base, {
      ...(token !== undefined ? { token } : {}),
    });
    const name = discovery.doc.name;
    if (!ENDPOINT_NAME.test(name)) {
      throw new Error(`discovery document declares an invalid endpoint name '${name}'`);
    }
    if (discovery.doc.instance_uid === undefined || typeof discovery.doc.instance_uid !== "string") {
      throw new Error("discovery document carries no instance_uid; the service must run a ukp-remote v1 server");
    }
    registerRemoteAt(context.registryPath, {
      name,
      url,
      instance_uid: discovery.doc.instance_uid,
      ...(token !== undefined ? { token } : {}),
    });
    const envToken = remoteTokenFor(name);
    const lines = [
      `registered (remote): ${name}`,
      `url: ${url}`,
      `instance_uid: ${discovery.doc.instance_uid}`,
      ...(discovery.doc.description !== undefined ? [`description: ${discovery.doc.description}`] : []),
      ...(token !== undefined
        ? [`auth: token stored in registry binding (plaintext; env UKP_ENDPOINT_${name.toUpperCase().replace(/-/g, "_")}_TOKEN overrides)`]
        : discovery.bearerRequired && envToken === undefined
          ? [`note: this endpoint requires a bearer token; pass --token or set UKP_ENDPOINT_${name.toUpperCase().replace(/-/g, "_")}_TOKEN`]
          : []),
    ];
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `ukp register: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    transport?.close();
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
    // byte-identical and synchronous.
    return (async () => {
      const rendered: Array<{ line: string; warning?: string }> = [];
      for (const endpoint of endpoints) {
        if (!isRemoteBinding(endpoint)) {
          rendered.push(renderLocalListRow({ name: endpoint.name, path: endpoint.path! }));
          continue;
        }
        rendered.push(await renderRemoteListRow(endpoint));
      }
      return renderListOutput(rendered);
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

function renderListOutput(rows: ReadonlyArray<{ line: string; warning?: string }>): InventoryCommandResult {
  const warnings = rows.flatMap((row) => (row.warning !== undefined ? [row.warning] : []));
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
 * inventory semantics as an unreadable local manifest. */
async function renderRemoteListRow(endpoint: RegistryBinding): Promise<{ line: string; warning?: string }> {
  const url = endpoint.url!;
  let transport: RemoteTransportHandle | undefined;
  try {
    transport = await openRemoteTransport(endpoint);
    const discovery = await fetchDiscoveryDocument(endpoint, transport, resolveRemoteToken(endpoint));
    const extras = Object.entries(discovery.doc.capabilities)
      .filter(([, capability]) => capability.derived !== true)
      .map(([name]) => name)
      .sort();
    const warnings = discovery.warnings.length > 0 ? { warning: discovery.warnings.join("; ") } : {};
    return { line: `${endpoint.name}\t${url}\t${extras.length > 0 ? extras.join(",") : "-"}`, ...warnings };
  } catch (error) {
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      line: `${endpoint.name}\t${url}\t(unavailable)`,
      warning: `endpoint '${endpoint.name}' capabilities unavailable: ${headline}`,
    };
  } finally {
    transport?.close();
  }
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
