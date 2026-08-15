/**
 * Manage pi PACKAGES (install unit: npm or git, persisted in
 * `settings.json#packages[]`, managed by the SDK `DefaultPackageManager`)
 * for the Settings → Extensions page.
 *
 * Complements `extensions-discovery.ts` (read-only mirror that enumerates
 * package-contributed tools/skills). This module adds the management
 * surface: list (with per-package contributed resources + package.json
 * metadata), install (npm spec / git URL / local path, user or project
 * scope), remove.
 *
 * It deliberately does NOT reload running sessions after install/remove
 * (design D3): a newly installed package takes effect on NEW sessions;
 * running sessions are restarted manually from Settings → General (the
 * existing `/config/reload` entry).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverExtensionResources } from "./extensions-discovery.js";

export type PackageScope = "user" | "project";

export interface ExtensionToolInfo {
  /** Name as the agent sees it (what `pi.registerTool({ name })` set). */
  name: string;
  /** Optional human-readable description from the tool definition. */
  description?: string;
}

export interface PackageResourcePath {
  /** Absolute path of the contributed resource (skill dir/file, prompt file, theme). */
  path: string;
}

export interface PackageResources {
  tools: ExtensionToolInfo[];
  skills: PackageResourcePath[];
  prompts: PackageResourcePath[];
  themes: PackageResourcePath[];
}

export interface InstalledPackage {
  /** User-visible package source: npm spec ("pi-subagents", "name@version"), git URL, or local path. */
  source: string;
  type: "npm" | "git" | "local";
  scope: PackageScope;
  installedPath?: string;
  /** From the installed package.json, when readable. */
  name?: string;
  version?: string;
  description?: string;
  resources: PackageResources;
  /** Attributable extension-load errors — non-fatal diagnostics. */
  errors?: { path: string; error: string }[];
}

export interface PackagesListing {
  packages: InstalledPackage[];
}

/** npm install / git clone can take far longer than a session reload — 120s budget. */
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Build a fresh package manager per operation. SettingsManager is not
 * thread-safe and the SDK reads config on construction, so a per-call
 * instance always sees the latest on-disk `packages[]` (mirrors
 * `extensions-discovery.ts`; a module-level singleton was rejected in
 * design D1 because config may change via CLI / other processes).
 */
async function createPackageManager(cwd: string, agentDir: string): Promise<DefaultPackageManager> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload?.();
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

async function readPackageMeta(
  installedPath?: string,
): Promise<{ name?: string; version?: string; description?: string } | undefined> {
  if (installedPath === undefined) return undefined;
  try {
    const raw = await readFile(join(installedPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string };
    const meta: { name?: string; version?: string; description?: string } = {};
    if (pkg.name !== undefined) meta.name = pkg.name;
    if (pkg.version !== undefined) meta.version = pkg.version;
    if (pkg.description !== undefined) meta.description = pkg.description;
    return meta;
  } catch {
    return undefined; // one unreadable package must not break the whole listing
  }
}

function inferType(source: string): "npm" | "git" | "local" {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(git\+|git@|https?:\/\/|ssh:)/.test(source)) return "git";
  return "local";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Enumerate configured packages with their contributed resources and
 * package.json metadata.
 *
 * Data sources (design D2):
 *   - `listConfiguredPackages()` → the configured set (source + scope + installedPath)
 *   - `resolve()` → per-resource-type paths, grouped to packages by
 *     `metadata.source`, keeping only `origin === "package"` entries
 *   - `discoverExtensionResources()` → registered tool NAMES (loading the
 *     extension modules), grouped by `packageSource`
 *   - `installedPath/package.json` → name / version / description
 *
 * A single broken package must not fail the whole listing (errors
 * semantics mirror `discoverExtensionResources`).
 */
export async function listPackages(cwd: string, agentDir: string): Promise<PackagesListing> {
  const pm = await createPackageManager(cwd, agentDir);
  const [configured, resolved, ext] = await Promise.all([
    Promise.resolve(pm.listConfiguredPackages()),
    pm.resolve(),
    discoverExtensionResources(cwd),
  ]);

  // Extension path → package source, for attributing extension-load errors.
  const extensionPathToPackage = new Map<string, string>();
  for (const r of resolved.extensions) {
    if (!r.enabled) continue;
    const src = r.metadata.source;
    if (typeof src !== "string" || src.length === 0) continue;
    extensionPathToPackage.set(r.path, src);
  }

  const resourcesBySource = new Map<string, PackageResources>();
  const ensure = (source: string): PackageResources => {
    let r = resourcesBySource.get(source);
    if (r === undefined) {
      r = { tools: [], skills: [], prompts: [], themes: [] };
      resourcesBySource.set(source, r);
    }
    return r;
  };
  for (const r of resolved.skills) {
    // Only PACKAGE-origin skills: top-level (global dir, project .pi/skills)
    // are already loaded via the includeDefaults path — mirror extensions-discovery.
    if (!r.enabled || r.metadata.origin !== "package") continue;
    const src = r.metadata.source;
    if (typeof src !== "string" || src.length === 0) continue;
    ensure(src).skills.push({ path: r.path });
  }
  for (const r of resolved.prompts) {
    if (!r.enabled || r.metadata.origin !== "package") continue;
    const src = r.metadata.source;
    if (typeof src !== "string" || src.length === 0) continue;
    ensure(src).prompts.push({ path: r.path });
  }
  for (const r of resolved.themes) {
    if (!r.enabled || r.metadata.origin !== "package") continue;
    const src = r.metadata.source;
    if (typeof src !== "string" || src.length === 0) continue;
    ensure(src).themes.push({ path: r.path });
  }
  for (const t of ext.tools) {
    if (t.packageSource === undefined) continue;
    const info: ExtensionToolInfo = { name: t.name };
    if (t.description !== undefined) info.description = t.description;
    ensure(t.packageSource).tools.push(info);
  }

  // Attribute extension-load errors to their package when possible.
  const errorsBySource = new Map<string, { path: string; error: string }[]>();
  for (const e of ext.errors) {
    const src = extensionPathToPackage.get(e.path);
    if (src === undefined) continue;
    const list = errorsBySource.get(src) ?? [];
    list.push(e);
    errorsBySource.set(src, list);
  }

  const packages: InstalledPackage[] = [];
  const seen = new Set<string>();
  for (const cp of configured) {
    // Same source installed at both scopes is a legit pair — dedupe on scope:source only.
    const key = `${cp.scope}:${cp.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = await readPackageMeta(cp.installedPath);
    const pkg: InstalledPackage = {
      source: cp.source,
      type: inferType(cp.source),
      scope: cp.scope,
      resources: resourcesBySource.get(cp.source) ?? {
        tools: [],
        skills: [],
        prompts: [],
        themes: [],
      },
    };
    if (cp.installedPath !== undefined) pkg.installedPath = cp.installedPath;
    if (meta !== undefined) {
      if (meta.name !== undefined) pkg.name = meta.name;
      if (meta.version !== undefined) pkg.version = meta.version;
      if (meta.description !== undefined) pkg.description = meta.description;
    }
    const errs = errorsBySource.get(cp.source);
    if (errs !== undefined && errs.length > 0) pkg.errors = errs;
    packages.push(pkg);
  }
  return { packages };
}

/**
 * Install a package and persist it in `settings.json#packages[]`.
 *
 * `scope === "project"` maps to the SDK `{ local: true }` install
 * (workspace `.pi/packages/` + project-scoped setting); `"user"` maps to
 * the global `~/.pi/agent` install (design D6). Does NOT reload running
 * sessions — the package takes effect on new sessions.
 */
export async function installPackage(
  cwd: string,
  agentDir: string,
  source: string,
  scope: PackageScope,
): Promise<{ source: string; scope: PackageScope }> {
  const pm = await createPackageManager(cwd, agentDir);
  await withTimeout(
    pm.installAndPersist(source, { local: scope === "project" }),
    INSTALL_TIMEOUT_MS,
    `package install ${source}`,
  );
  return { source, scope };
}

/**
 * Remove a package and its persisted `settings.json#packages[]` entry.
 * Returns `{ removed: false }` when the source was not installed
 * (route maps that to 404 `package_not_found`). Does NOT reload running
 * sessions.
 */
export async function removePackage(
  cwd: string,
  agentDir: string,
  source: string,
  scope: PackageScope,
): Promise<{ removed: boolean }> {
  const pm = await createPackageManager(cwd, agentDir);
  const removed = await pm.removeAndPersist(source, { local: scope === "project" });
  return { removed };
}
