import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { AUTH_FILE, MODELS_FILE, type ProvidersListing } from "../config-manager.js";
import { getRegisteredPluginProvider } from "./registry.js";

/** Shape of one model row in the providers listing (matches config-manager). */
export type ProviderModels = ProvidersListing["providers"][number]["models"][number];

/** Upper bound for one plugin provider refresh (discovery + fetch). */
export const PROVIDER_REFRESH_TIMEOUT_MS = 60_000;

export class PluginProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`plugin provider not found: ${provider}`);
    this.name = "PluginProviderNotFoundError";
  }
}

/**
 * Native pi-ai registrations refresh through the same pipeline as config
 * registrations (their `refreshModels` callback is invoked by
 * `ModelRuntime.refresh`), so this error is no longer raised for native
 * entries. The class stays for API compatibility and as the defensive
 * branch for future registration shapes that genuinely cannot be refreshed.
 */
export class PluginProviderNotRefreshableError extends Error {
  constructor(provider: string) {
    super(`plugin provider is not refreshable (native registration): ${provider}`);
    this.name = "PluginProviderNotRefreshableError";
  }
}

/**
 * Where the SDK persists refreshed provider catalogs: `<configDir>/models-store.json`,
 * next to models.json. Mirrors `ModelRuntime.create`'s default
 * `modelsStorePath` (`join(dirname(modelsPath), "models-store.json")`), so
 * what we write here is what a later `ModelRuntime` store-restore reads.
 */
export function pluginModelsStoreFile(): string {
  return join(dirname(MODELS_FILE()), "models-store.json");
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/**
 * Persist a refreshed provider catalog into models-store.json, merging with
 * existing entries so other providers' catalogs survive. The SDK only writes
 * the store when the extension itself calls `context.publish({persist})`
 * (pi-ai `publishProviderModels` skips the write otherwise), so pi-forge
 * takes over for extensions that merely return models — keeping the
 * "refresh results visible on later listings" promise for every plugin
 * provider. Atomic write: tmp file + rename (AGENTS.md convention).
 */
export async function writePluginProviderModels(
  name: string,
  models: ModelsStoreEntry["models"],
): Promise<void> {
  const file = pluginModelsStoreFile();
  const store = await readJsonOr<Record<string, ModelsStoreEntry>>(file, {});
  store[name] = { models, checkedAt: Date.now() };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Trigger model re-discovery for one plugin-registered provider using a
 * throwaway `ModelRuntime`: register the captured registration (config form
 * via `registerProvider`, native form via `registerNativeProvider` so the
 * extension's `refreshModels` callback is honored), refresh (the SDK calls
 * the provider's `refreshModels` callback, falling back to standard
 * `/v1/models` discovery when absent), then read back the resulting models
 * and persist them to models-store.json.
 *
 * A native provider whose `refreshModels` yields nothing (no callback, no
 * network discovery result) resolves with an empty list — never an error.
 *
 * Refresh is bounded by `PROVIDER_REFRESH_TIMEOUT_MS` via an abort signal; a
 * timeout surfaces as an Error whose message contains "timed out". Other
 * failures (discovery / auth / extension callback rejection) propagate to
 * the caller (route layer maps them to 500 `agent_error`); models-store
 * content is left untouched on failure.
 */
export async function refreshPluginProvider(name: string): Promise<ProviderModels[]> {
  const entry = getRegisteredPluginProvider(name);
  if (entry === undefined) {
    throw new PluginProviderNotFoundError(name);
  }
  const runtime = await ModelRuntime.create({
    authPath: AUTH_FILE(),
    modelsPath: MODELS_FILE(),
    modelRefreshTimeoutMs: PROVIDER_REFRESH_TIMEOUT_MS,
    // Store-restore + discovery for this provider happens inside the explicit
    // refresh below; the create-time pass only touches builtins/models.json.
    refreshOnCreate: false,
  });
  if (entry.nativeProvider !== undefined) {
    // Native pi-ai registration: re-register the captured Provider object so
    // its refreshModels callback runs through the standard refresh pipeline.
    runtime.registerNativeProvider(entry.nativeProvider);
  } else {
    runtime.registerProvider(name, entry.config);
  }
  let result;
  try {
    result = await runtime.refresh({
      providers: [name],
      signal: AbortSignal.timeout(PROVIDER_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    // SDK refresh resolves with `{ aborted: true }` on timeout; the thrown
    // AbortError path is defensive for future SDK behavior.
    if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
      throw new Error(
        `plugin provider refresh timed out after ${PROVIDER_REFRESH_TIMEOUT_MS}ms: ${name}`,
        { cause: err },
      );
    }
    throw err;
  }
  if (result.aborted) {
    throw new Error(
      `plugin provider refresh timed out after ${PROVIDER_REFRESH_TIMEOUT_MS}ms: ${name}`,
    );
  }
  const refreshError = result.errors.get(name);
  if (refreshError !== undefined) throw refreshError;
  const models = runtime.getModels(name);
  const listing = models.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: m.reasoning,
    input: m.input,
    hasAuth: runtime.hasConfiguredAuth(name),
    supportedThinkingLevels: getSupportedThinkingLevels(m),
  }));
  // M1: the SDK only persists when the extension calls publish({persist});
  // write the refreshed catalog ourselves so later listings (models-store
  // restore) see it without a re-refresh. Full Model objects are stored for
  // SDK store-restore compatibility.
  await writePluginProviderModels(name, models);
  return listing;
}
