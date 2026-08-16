import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

/**
 * A provider registered by an extension. `config` is the exact
 * `pi.registerProvider(name, config)` payload the extension passed during
 * load (SDK `pendingProviderRegistrations` queue); for native registrations
 * (`native: true`) the SDK records a pi-ai `Provider` object instead of a
 * config, so `config` stays `{}` and the object itself is kept in
 * `nativeProvider` so the refresh path can re-register it (its
 * `refreshModels` callback participates in the standard refresh pipeline).
 */
export interface PluginProviderEntry {
  name: string;
  config: ProviderConfig;
  package: string;
  native: boolean;
  /**
   * The pi-ai `Provider` object captured from a native registration
   * (`pi.registerProvider(provider)` → SDK `pendingNativeProviderRegistrations`).
   * Present only when `native` is true; undefined for config-form entries.
   */
  nativeProvider?: Provider;
}

export interface ProviderRegistryState {
  ready: boolean;
  providers: PluginProviderEntry[];
  errors: { path: string; error: string }[];
}

export interface ProviderRegistryDeps {
  cwd: string;
  agentDir: string;
  /**
   * Extension entry paths to load, resolved by the caller. Defaults to
   * `resolveEnabledExtensionPaths(cwd, agentDir)` when omitted — including
   * package-contributed entries plus top-level `agentDir/extensions` /
   * `.pi/extensions` scanning done inside `discoverAndLoadExtensions`.
   */
  configuredPaths?: Promise<string[]>;
}
