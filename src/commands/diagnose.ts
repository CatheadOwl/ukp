import { loadManifest, type LoadedManifest } from "../config/manifest.ts";

export interface ProviderCheck {
  supported: boolean;
  reason?: string;
}

export type ProviderResolver = (provider: string, capability: string) => ProviderCheck;

export interface DiagnoseReport {
  service: LoadedManifest;
  capabilities: Array<{
    name: string;
    provider: string;
    status: "ok" | "warning";
    reason?: string;
  }>;
}

function defaultProviderResolver(provider: string): ProviderCheck {
  if (provider !== "qmd") {
    return { supported: false, reason: `provider '${provider}' is not supported by this UKP build` };
  }
  const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
  return executable
    ? { supported: true }
    : { supported: false, reason: "qmd executable is not available" };
}

export function diagnoseService(
  serviceFolder: string,
  resolveProvider: ProviderResolver = defaultProviderResolver,
): DiagnoseReport {
  const service = loadManifest(serviceFolder);
  const capabilities = Object.entries(service.manifest.capabilities).map(([name, declaration]) => {
    const check = resolveProvider(declaration.provider, name);
    return {
      name,
      provider: declaration.provider,
      status: check.supported ? "ok" as const : "warning" as const,
      ...(check.reason ? { reason: check.reason } : {}),
    };
  });

  if (!capabilities.some((capability) => capability.status === "ok")) {
    throw new Error("NO_SUPPORTED_CAPABILITY");
  }
  return { service, capabilities };
}

export function renderDiagnose(report: DiagnoseReport): string {
  const lines = [
    `endpoint: ${report.service.effectiveName} (source: ${report.service.nameSource})`,
    `location: ${report.service.folder}`,
  ];
  for (const capability of report.capabilities) {
    lines.push(`capability: ${capability.name}`);
    lines.push(`provider: ${capability.provider}`);
    lines.push(`status: ${capability.status}`);
    if (capability.reason) lines.push(`warning: ${capability.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
