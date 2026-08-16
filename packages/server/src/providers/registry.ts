import {
  createEventBus,
  discoverAndLoadExtensions,
  type Extension,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import { resolveEnabledExtensionPaths } from "../extensions-manager.js";
import type { PluginProviderEntry, ProviderRegistryDeps, ProviderRegistryState } from "./types.js";

let deps: ProviderRegistryDeps | undefined;
let state: ProviderRegistryState = { ready: false, providers: [], errors: [] };

/**
 * Wire the registry's deps (workspace root + agent config dir). Mirrors
 * `plugin-config/registry.ts#configurePluginConfigRegistry`: called at boot
 * before the first `refreshPluginProviders()`.
 */
export function configurePluginProviderRegistry(d: ProviderRegistryDeps): void {
  deps = d;
}

/**
 * Normalize a pnpm virtual-store name segment to an npm package name:
 * `@scope+pkg@1.2.3` → `@scope/pkg`, `pi-provider-litellm@1.2.3` →
 * `pi-provider-litellm`.
 */
function normalizeStoreName(segment: string): string {
  const versionAt = segment.lastIndexOf("@");
  const namePart = versionAt > 0 ? segment.slice(0, versionAt) : segment;
  if (namePart.startsWith("@")) {
    const plus = namePart.indexOf("+", 1);
    if (plus > 0) return `${namePart.slice(0, plus)}/${namePart.slice(plus + 1)}`;
  }
  return namePart;
}

/**
 * Best-effort package name for an extension entry path. Understands npm
 * scoped packages (`node_modules/@scope/pkg/…` → `@scope/pkg`) and the pnpm
 * virtual-store layout (`node_modules/.store/<name>@<version>/…`), preferring
 * the last `node_modules/` segment so unrelated earlier segments are ignored.
 * Top-level `agentDir/extensions/<name>` entries keep the directory name.
 * Unmatched paths fall back to "extension".
 */
function packageFromPath(extensionPath: string, agentDir: string): string {
  const rel = extensionPath.startsWith(agentDir)
    ? extensionPath.slice(agentDir.length)
    : extensionPath;
  // pnpm virtual store: node_modules/.store/@scope+pkg@1.2.3/node_modules/...
  const store = /\/\.store\/([^/]+)\//.exec(rel);
  if (store !== null) return normalizeStoreName(store[1]!);
  // npm scoped package: node_modules/@scope/pkg/...
  const scoped = /node_modules\/(@[^/]+)\/([^/]+)/.exec(rel);
  if (scoped !== null) return `${scoped[1]}/${scoped[2]!.replace(/\.pi-extension$/, "")}`;
  // plain package: last node_modules segment is the one containing the entry
  let plain: RegExpExecArray | null = null;
  for (const m of rel.matchAll(/node_modules\/([^/]+)/g)) plain = m;
  if (plain !== null) return plain[1]!.replace(/\.pi-extension$/, "");
  const top = /extensions\/([^/]+)/.exec(rel);
  if (top !== null) return top[1]!.replace(/\.pi-extension$/, "");
  return "extension";
}

/**
 * Resolve the display package name for a registration. The extension's
 * `sourceInfo.source` is authoritative for package-contributed extensions
 * (`origin: "package"` — the npm spec recorded in settings.json), so the
 * extensions map is consulted first and path parsing only backs it up.
 * Note: SDK 0.84.2's `discoverAndLoadExtensions` reports
 * `origin: "top-level"` / `source: "local"` for every loaded extension, so
 * the sourceInfo branch is currently inert; the path parser stays the
 * effective resolver until a future SDK populates package origins.
 */
function packageNameFor(
  extensionPath: string,
  sourceInfo: SourceInfo | undefined,
  agentDir: string,
): string {
  if (sourceInfo !== undefined && sourceInfo.origin === "package") {
    return sourceInfo.source;
  }
  return packageFromPath(extensionPath, agentDir);
}

/**
 * Load enabled extensions and capture every provider registration from the
 * SDK's pending-queue (`ExtensionRuntimeState.pendingProviderRegistrations` /
 * `pendingNativeProviderRegistrations`). Safe to call repeatedly (reload);
 * each run replaces the captured state. Failures are isolated per extension
 * (SDK `LoadExtensionsResult.errors`) and never reject the caller.
 */
export async function refreshPluginProviders(): Promise<ProviderRegistryState> {
  if (deps === undefined) {
    // Boot wiring missing — surface as not-ready (matching
    // `plugin-config/registry.ts`), keeping whatever was captured before.
    state = { ready: false, providers: state.providers, errors: state.errors };
    return state;
  }
  try {
    const configured = await (deps.configuredPaths ??
      resolveEnabledExtensionPaths(deps.cwd, deps.agentDir));
    const bus = createEventBus();
    const result = await discoverAndLoadExtensions(configured, deps.cwd, deps.agentDir, bus);
    // Match registrations back to their loaded extension for source metadata.
    const extensionsByPath = new Map<string, Extension>();
    for (const ext of result.extensions) {
      extensionsByPath.set(ext.path, ext);
      extensionsByPath.set(ext.resolvedPath, ext);
    }
    const byName = new Map<string, PluginProviderEntry>();
    // Native pi-ai registrations are the SDK's *base* layer; config
    // registrations are the overlay (model-runtime.js registerProvider
    // composes base ← native/builtin, overlay ← extension config). Process
    // natives first so a same-named config registration below wins — the
    // entry then keeps the extension's ProviderConfig and refresh semantics.
    for (const native of result.runtime.pendingNativeProviderRegistrations ?? []) {
      // Keyed by provider.id, matching the SDK's registerNativeProvider
      // (provider.name is only a display label and may not be unique).
      byName.set(native.provider.id, {
        name: native.provider.id,
        config: {},
        package: packageNameFor(
          native.extensionPath,
          extensionsByPath.get(native.extensionPath)?.sourceInfo,
          deps.agentDir,
        ),
        native: true,
        // Keep the pi-ai Provider object itself so the refresh path can
        // re-register it on a throwaway ModelRuntime and run its
        // `refreshModels` callback through the standard refresh pipeline.
        nativeProvider: native.provider,
      });
    }
    for (const reg of result.runtime.pendingProviderRegistrations ?? []) {
      // Re-registration of the same name keeps the most recent config
      // (Map.set overwrite) and never produces duplicate entries.
      byName.set(reg.name, {
        name: reg.name,
        config: reg.config,
        package: packageNameFor(
          reg.extensionPath,
          extensionsByPath.get(reg.extensionPath)?.sourceInfo,
          deps.agentDir,
        ),
        native: false,
      });
    }
    state = {
      ready: true,
      providers: [...byName.values()],
      errors: result.errors.map((e) => ({ path: e.path, error: String(e.error) })),
    };
  } catch (err) {
    // Top-level failure (e.g. package-manager resolve error): surface it as
    // not-ready but keep the last successfully captured providers instead of
    // wiping them (mirrors `plugin-config/registry.ts` keeping declarations).
    state = {
      ready: false,
      providers: state.providers,
      errors: [...state.errors, { path: "<registry>", error: String(err) }],
    };
  }
  return state;
}

export function getPluginProviderState(): ProviderRegistryState {
  // Shallow copy so callers cannot mutate the module-level state.
  return { ...state, providers: [...state.providers], errors: [...state.errors] };
}

export function getRegisteredPluginProvider(name: string): PluginProviderEntry | undefined {
  return state.providers.find((p) => p.name === name);
}
