---
change: add-extensions-manager
design-doc: openspec/changes/add-extensions-manager/superpower-design.md
base-ref: df9c05670978469002bf177c5d2d812701c67621
---

# Settings Extensions 管理页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pi-forge Settings 中新增 Extensions tab，支持枚举已安装 pi 插件（package）及其贡献资源（tools/skills/prompts/themes）、安装（npm/git/local，user/project 作用域）、卸载；新装包对新会话生效，运行中会话由用户手动 Restart。

**Architecture:** 新服务端模块 `extensions-manager.ts` 包装 SDK `DefaultPackageManager`（与既有 `extensions-discovery.ts` 同构），暴露 `listPackages`/`installPackage`/`removePackage` 纯函数；`routes/config.ts` 挂 `/api/v1/config/extensions` 三个端点；客户端 `ExtensionsTab` 仿 ProvidersTab 布局（卡片 + 展开 details），api-client 新增 3 个方法。

**Tech Stack:** TypeScript、Fastify（OpenAPI schema）、React + Zustand（SettingsPanel）、`@earendil-works/pi-coding-agent`（`DefaultPackageManager`/`SettingsManager`）、lucide-react。

**Spec:** `openspec/changes/add-extensions-manager/superpower-design.md`（需求事实源：`proposal.md`、`design.md`）

## Global Constraints

- 所有服务端模块使用命名导出（AGENTS.md 约定 1）；无 default export
- 操作环境变量读取只在 `packages/server/src/config.ts`；路径用 `config.workspacePath` / `config.piConfigDir`
- 路由在 `packages/server/src/index.ts` 注册（prefix `/api/v1`），路由文件只导出 Fastify plugin
- 路由不得直接 import SDK 对象；SDK 交互一律经 `extensions-manager.ts`
- 安装/卸载**不**触发会话 reload（用户决策）：新包对新会话生效，旧会话手动 Restart
- 本期不含插件更新（无 `update`/`checkForAvailableUpdates` 端点与 UI）
- providers 不作为包贡献展示（pi 包模型只有 extensions/skills/prompts/themes）
- 客户端 API 调用一律经 `packages/client/src/lib/api-client/index.ts` 的 `request()`；组件不直接 `fetch()`
- 所有配置/数据写入保持原子写约定；错误：校验 400、包不存在 404 `package_not_found`、SDK 崩溃 500 `{error:"agent_error"}`
- 测试运行：`npx tsx tests/test-xxx.ts`；`npm run check`（tsc + eslint + prettier）需先 `npm run build`

---

### Task 1: 服务端模块 `extensions-manager.ts`

**Files:**
- Create: `packages/server/src/extensions-manager.ts`
- Reference: `packages/server/src/extensions-discovery.ts`（构造模式与 errors 语义）

**Interfaces:**
- Produces:
  - `export type PackageScope = "user" | "project"`
  - `export interface ExtensionToolInfo { name: string; description?: string }`
  - `export interface PackageResourcePath { path: string }`
  - `export interface PackageResources { tools: ExtensionToolInfo[]; skills: PackageResourcePath[]; prompts: PackageResourcePath[]; themes: PackageResourcePath[] }`
  - `export interface InstalledPackage { source: string; type: "npm"|"git"; scope: PackageScope; installedPath?: string; name?: string; version?: string; description?: string; resources: PackageResources; errors?: { path: string; error: string }[] }`
  - `export interface PackagesListing { packages: InstalledPackage[] }`
  - `export function listPackages(cwd: string, agentDir: string): Promise<PackagesListing>`
  - `export function installPackage(cwd: string, agentDir: string, source: string, scope: PackageScope): Promise<{ source: string; scope: PackageScope }>`（内部 120s 超时）
  - `export function removePackage(cwd: string, agentDir: string, source: string, scope: PackageScope): Promise<{ removed: boolean }>`

- [ ] **Step 1: 创建模块骨架与类型**

```ts
// packages/server/src/extensions-manager.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverExtensionResources } from "./extensions-discovery.js";

export type PackageScope = "user" | "project";

export interface ExtensionToolInfo {
  name: string;
  description?: string;
}
export interface PackageResourcePath {
  path: string;
}
export interface PackageResources {
  tools: ExtensionToolInfo[];
  skills: PackageResourcePath[];
  prompts: PackageResourcePath[];
  themes: PackageResourcePath[];
}
export interface InstalledPackage {
  source: string;
  type: "npm" | "git";
  scope: PackageScope;
  installedPath?: string;
  name?: string;
  version?: string;
  description?: string;
  resources: PackageResources;
  errors?: { path: string; error: string }[];
}
export interface PackagesListing {
  packages: InstalledPackage[];
}
```

- [ ] **Step 2: 内部 helper（构造/元数据/类型推断/超时）**

```ts
const INSTALL_TIMEOUT_MS = 120_000;

async function createPackageManager(
  cwd: string,
  agentDir: string,
): Promise<DefaultPackageManager> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload?.();
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

async function readPackageMeta(installedPath?: string) {
  if (!installedPath) return undefined;
  try {
    const raw = await readFile(join(installedPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string };
    return { name: pkg.name, version: pkg.version, description: pkg.description };
  } catch {
    return undefined; // 单包元数据读失败不阻断整体列表
  }
}

function inferType(source: string): "npm" | "git" {
  return /^(git\+|https?:\/\/|git@|ssh:)/.test(source) ? "git" : "npm";
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
```

- [ ] **Step 3: `listPackages`（组合 resolve + discoverExtensionResources + listConfiguredPackages）**

```ts
export async function listPackages(cwd: string, agentDir: string): Promise<PackagesListing> {
  const pm = await createPackageManager(cwd, agentDir);
  const [configured, resolved, ext] = await Promise.all([
    Promise.resolve(pm.listConfiguredPackages()),
    pm.resolve(),
    discoverExtensionResources(cwd),
  ]);

  // tools（含注册名）来自 discoverExtensionResources，按 packageSource 分组
  const toolsBySource = new Map<string, ExtensionToolInfo[]>();
  for (const t of ext.tools) {
    if (!t.packageSource) continue;
    const list = toolsBySource.get(t.packageSource) ?? [];
    list.push({ name: t.name, description: t.description });
    toolsBySource.set(t.packageSource, list);
  }

  // skills/prompts/themes 来自 resolve()，仅 origin === "package" 归包
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
    if (!r.enabled || r.metadata.origin !== "package" || !r.metadata.source) continue;
    ensure(r.metadata.source).skills.push({ path: r.path });
  }
  for (const r of resolved.prompts) {
    if (!r.enabled || r.metadata.origin !== "package" || !r.metadata.source) continue;
    ensure(r.metadata.source).prompts.push({ path: r.path });
  }
  for (const r of resolved.themes) {
    if (!r.enabled || r.metadata.origin !== "package" || !r.metadata.source) continue;
    ensure(r.metadata.source).themes.push({ path: r.path });
  }
  for (const [src, tools] of toolsBySource) {
    ensure(src).tools = tools;
  }

  const packages: InstalledPackage[] = [];
  const seen = new Set<string>();
  for (const cp of configured) {
    const key = `${cp.scope}:${cp.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = await readPackageMeta(cp.installedPath);
    packages.push({
      source: cp.source,
      type: inferType(cp.source),
      scope: cp.scope,
      installedPath: cp.installedPath,
      ...(meta ?? {}),
      resources: resourcesBySource.get(cp.source) ?? { tools: [], skills: [], prompts: [], themes: [] },
    });
  }
  return { packages };
}
```

- [ ] **Step 4: `installPackage` / `removePackage`（带超时与作用域映射）**

```ts
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
```

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd packages/server && npx tsc --noEmit`
Expected: exit 0（无类型错误）
```bash
git add packages/server/src/extensions-manager.ts
git commit -m "feat(extensions): add extensions-manager server module"
```

---

### Task 2: `/api/v1/config/extensions` REST 端点

**Files:**
- Modify: `packages/server/src/routes/config.ts`（文件末尾、`DELETE /config/tool-overrides` 路由之后、插件 `};` 之前；沿用 `internalError(reply, err)` 与 `errorSchema`）
- Reference: 同文件 `POST /config/reload` 路由（上一个变更已落地）的 schema/handler 风格

**Interfaces:**
- Consumes: Task 1 的 `listPackages` / `installPackage` / `removePackage`、`PackageScope`
- Produces: `GET /api/v1/config/extensions`、`POST /api/v1/config/extensions/install`、`POST /api/v1/config/extensions/remove`（全部 `tags: ["config"]`）

- [ ] **Step 1: import 与 GET 列表端点**

在 `routes/config.ts` 顶部 import 区（`internalError` 所在 import 附近）加入：

```ts
import { installPackage, listPackages, removePackage } from "../extensions-manager.js";
```

在插件函数末尾、`};` 之前追加：

```ts
    fastify.get(
      "/config/extensions",
      {
        schema: {
          tags: ["config"],
          response: {
            200: {
              type: "object",
              properties: {
                packages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      source: { type: "string" },
                      type: { type: "string", enum: ["npm", "git"] },
                      scope: { type: "string", enum: ["user", "project"] },
                      installedPath: { type: "string" },
                      name: { type: "string" },
                      version: { type: "string" },
                      description: { type: "string" },
                      resources: {
                        type: "object",
                        properties: {
                          tools: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                name: { type: "string" },
                                description: { type: "string" },
                              },
                            },
                          },
                          skills: {
                            type: "array",
                            items: { type: "object", properties: { path: { type: "string" } } },
                          },
                          prompts: {
                            type: "array",
                            items: { type: "object", properties: { path: { type: "string" } } },
                          },
                          themes: {
                            type: "array",
                            items: { type: "object", properties: { path: { type: "string" } } },
                          },
                        },
                      },
                      errors: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { path: { type: "string" }, error: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (_req, reply) => {
        try {
          return await listPackages(config.workspacePath, config.piConfigDir);
        } catch (err) {
          return internalError(reply, err);
        }
      },
    );
```

（`config` 已在 routes/config.ts 中 import；若文件名与本地约定不符请按既有 import 风格调整。）

- [ ] **Step 2: POST install 端点**

```ts
    fastify.post(
      "/config/extensions/install",
      {
        schema: {
          tags: ["config"],
          body: {
            type: "object",
            required: ["source", "scope"],
            properties: {
              source: { type: "string", minLength: 1 },
              scope: { type: "string", enum: ["user", "project"] },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { source: { type: "string" }, scope: { type: "string" } },
            },
          },
        },
      },
      async (req, reply) => {
        const { source, scope } = req.body as { source: string; scope: "user" | "project" };
        try {
          return await installPackage(config.workspacePath, config.piConfigDir, source, scope);
        } catch (err) {
          return internalError(reply, err);
        }
      },
    );
```

（body schema 校验失败由 Fastify 自动回 400，无需手写 validation_error 分支。）

- [ ] **Step 3: POST remove 端点（404 package_not_found）**

```ts
    fastify.post(
      "/config/extensions/remove",
      {
        schema: {
          tags: ["config"],
          body: {
            type: "object",
            required: ["source", "scope"],
            properties: {
              source: { type: "string", minLength: 1 },
              scope: { type: "string", enum: ["user", "project"] },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { removed: { type: "boolean" } },
            },
            404: errorSchema,
          },
        },
      },
      async (req, reply) => {
        const { source, scope } = req.body as { source: string; scope: "user" | "project" };
        try {
          const { removed } = await removePackage(config.workspacePath, config.piConfigDir, source, scope);
          if (!removed) {
            return reply.code(404).send({ error: "package_not_found", message: `Package "${source}" is not installed.` });
          }
          return { removed: true };
        } catch (err) {
          return internalError(reply, err);
        }
      },
    );
```

- [ ] **Step 4: 构建 + 类型检查 + 提交**

Run: `cd packages/server && npx tsc --noEmit`
Expected: exit 0
```bash
git add packages/server/src/routes/config.ts
git commit -m "feat(extensions): add /config/extensions REST endpoints"
```

---

### Task 3: api-client 方法

**Files:**
- Modify: `packages/client/src/lib/api-client/index.ts`（config 区段，`reloadConfig` 之后）

**Interfaces:**
- Consumes: Task 2 的响应契约
- Produces:
  - `export const getExtensions: () => Promise<PackagesListing>`
  - `export const installExtension: (source: string, scope: "user"|"project") => Promise<{ source: string; scope: "user"|"project" }>`
  - `export const removeExtension: (source: string, scope: "user"|"project") => Promise<{ removed: boolean }>`
  - `export interface PackagesListing`（客户端类型，与服务端对齐）

- [ ] **Step 1: 客户端类型 + validators**

```ts
// 追加在 config 区段类型声明附近（仿 vReloadResult 风格）
export interface ClientToolInfo {
  name: string;
  description?: string;
}
export interface ClientResourcePath {
  path: string;
}
export interface ClientPackageResources {
  tools: ClientToolInfo[];
  skills: ClientResourcePath[];
  prompts: ClientResourcePath[];
  themes: ClientResourcePath[];
}
export interface ClientInstalledPackage {
  source: string;
  type: "npm" | "git";
  scope: "user" | "project";
  installedPath?: string;
  name?: string;
  version?: string;
  description?: string;
  resources: ClientPackageResources;
  errors?: { path: string; error: string }[];
}
export interface ClientPackagesListing {
  packages: ClientInstalledPackage[];
}

const vClientToolInfo = (v: unknown): v is ClientToolInfo =>
  isObject(v) && typeof v.name === "string" && (v.description === undefined || typeof v.description === "string");
const vClientResourcePath = (v: unknown): v is ClientResourcePath =>
  isObject(v) && typeof v.path === "string";
const vClientResources = (v: unknown): v is ClientPackageResources =>
  isObject(v) &&
  Array.isArray(v.tools) && v.tools.every(vClientToolInfo) &&
  Array.isArray(v.skills) && v.skills.every(vClientResourcePath) &&
  Array.isArray(v.prompts) && v.prompts.every(vClientResourcePath) &&
  Array.isArray(v.themes) && v.themes.every(vClientResourcePath);
const vClientInstalledPackage = (v: unknown): v is ClientInstalledPackage =>
  isObject(v) &&
  typeof v.source === "string" &&
  (v.type === "npm" || v.type === "git") &&
  (v.scope === "user" || v.scope === "project") &&
  vClientResources(v.resources);
const vClientPackagesListing = (v: unknown): v is ClientPackagesListing =>
  isObject(v) && Array.isArray(v.packages) && v.packages.every(vClientInstalledPackage);
const vInstallResult = (v: unknown): v is { source: string; scope: "user" | "project" } =>
  isObject(v) && typeof v.source === "string" && (v.scope === "user" || v.scope === "project");
const vRemoveResult = (v: unknown): v is { removed: boolean } =>
  isObject(v) && typeof v.removed === "boolean";
```

- [ ] **Step 2: 三个 API 方法（`reloadConfig` 之后）**

```ts
  getExtensions: () => request("/api/v1/config/extensions", vClientPackagesListing),
  installExtension: (source: string, scope: "user" | "project") =>
    request("/api/v1/config/extensions/install", vInstallResult, {
      method: "POST",
      body: { source, scope },
    }),
  removeExtension: (source: string, scope: "user" | "project") =>
    request("/api/v1/config/extensions/remove", vRemoveResult, {
      method: "POST",
      body: { source, scope },
    }),
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `cd packages/client && npx tsc --noEmit`
Expected: exit 0
```bash
git add packages/client/src/lib/api-client/index.ts
git commit -m "feat(extensions): add api-client methods for extensions management"
```

---

### Task 4: ExtensionsTab UI + tab 注册

**Files:**
- Modify: `packages/client/src/components/SettingsPanel.tsx`
  - `Tab` union（约 :33，providers 之后加 `"extensions"`）
  - `visibleTabs` 非 minimal 数组（约 :105，`"providers"` 之后加 `"extensions"`；minimal 数组**不加**）
  - 渲染分支（约 :247，`{tab === "providers" && ...}` 之后加 `{tab === "extensions" && <ExtensionsTab onError={setError} />}`）
  - 文件头 Phase 8 注释块补充 Extensions 说明
  - 新增 `ExtensionsTab` 组件（放 `ProvidersTab` 之后）
- Modify: `packages/client/src/components/SettingsPanel.tsx` 顶部 lucide-react import（加 `Settings2`）

**Interfaces:**
- Consumes: Task 3 的 `api.getExtensions` / `api.installExtension` / `api.removeExtension`、`ClientInstalledPackage` 类型
- Produces: `function ExtensionsTab({ onError }: { onError: (msg: string | undefined) => void })`

- [ ] **Step 1: tab 注册三处修改**

```ts
// Tab union（约 :33）
  | "providers"
  | "extensions"
  | "agent"

// visibleTabs 非 minimal 数组（约 :105）
        ([
          "providers",
          "extensions",
          "agent",

// 渲染分支（约 :247）
          {tab === "providers" && <ProvidersTab onError={setError} />}
          {tab === "extensions" && <ExtensionsTab onError={setError} />}
```

（lucide-react import 增加 `Settings2`。）

- [ ] **Step 2: ExtensionsTab 组件（仿 ProvidersTab 布局）**

```tsx
function ExtensionsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [listing, setListing] = useState<ClientPackagesListing | undefined>(undefined);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user"); // 默认 User 全局
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      setListing(await api.getExtensions());
    } catch (err) {
      onError(`Failed to load extensions: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (): Promise<void> => {
    const trimmed = source.trim();
    if (trimmed.length === 0 || installing) return;
    setInstalling(true);
    setFlash(undefined);
    try {
      await api.installExtension(trimmed, scope);
      setSource("");
      await refresh();
      setFlash({
        ok: true,
        text: `Installed "${trimmed}" — takes effect on new sessions. Restart running sessions from General.`,
      });
    } catch (err) {
      setFlash({ ok: false, text: `Install failed: ${errorCode(err)}` });
    } finally {
      setInstalling(false);
    }
  };

  const remove = async (p: ClientInstalledPackage): Promise<void> => {
    if (!confirm(`Uninstall "${p.source}"? Its tools and resources stop loading in new sessions.`)) return;
    setRemoving(p.source);
    try {
      await api.removeExtension(p.source, p.scope);
      await refresh();
    } catch (err) {
      onError(`Remove failed: ${errorCode(err)}`);
    } finally {
      setRemoving(undefined);
    }
  };

  if (listing === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading extensions…</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Installed pi packages and their contributed resources. New packages take effect on new
        sessions — restart running sessions from <em>General</em>.
      </p>

      {/* 安装行 */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void install();
          }}
          placeholder="npm package, name@version, git URL, or local path"
          className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "user" | "project")}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 outline-none"
          title="Install scope"
        >
          <option value="user">User (global)</option>
          <option value="project">Project</option>
        </select>
        <button
          onClick={() => void install()}
          disabled={installing || source.trim().length === 0}
          className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
        >
          {installing ? "Installing…" : "Install"}
        </button>
      </div>
      {flash !== undefined && (
        <p role="status" className={`text-xs ${flash.ok ? "text-emerald-400" : "text-red-400"}`}>
          {flash.text}
        </p>
      )}

      {listing.packages.length === 0 && (
        <p className="text-xs italic text-neutral-500">No packages installed.</p>
      )}

      {/* 包卡片（仿 ProvidersTab） */}
      {listing.packages.map((p) => {
        const res = p.resources;
        const total =
          res.tools.length + res.skills.length + res.prompts.length + res.themes.length;
        return (
          <div key={`${p.scope}:${p.source}`} className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-neutral-100">{p.name ?? p.source}</span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
                  {p.type}
                </span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
                  {p.scope}
                </span>
                {p.version !== undefined && (
                  <span className="text-[10px] text-neutral-500">v{p.version}</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs">
                <button
                  onClick={() => void remove(p)}
                  disabled={removing === p.source}
                  className="rounded border border-red-700/50 px-2 py-0.5 text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                >
                  {removing === p.source ? "Removing…" : "Remove"}
                </button>
                {/* 预留 settings 入口（本期无配置表单） */}
                <button
                  title="Package settings (reserved — no per-package settings yet)"
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  onClick={() => setFlash({ ok: false, text: `No per-package settings for "${p.source}" yet.` })}
                >
                  <Settings2 size={12} />
                </button>
              </div>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-neutral-500 light:text-neutral-600">
                {total} contributed resource{total === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-1 text-[11px]">
                {res.tools.length > 0 && (
                  <li>
                    <span className="font-semibold text-neutral-400">Tools</span>
                    <ul className="ml-3 space-y-0.5 font-mono text-neutral-300">
                      {res.tools.map((t) => (
                        <li key={t.name}>
                          {t.name}
                          {t.description !== undefined && (
                            <span className="ml-2 text-neutral-500">— {t.description}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                {res.skills.length > 0 && (
                  <li>
                    <span className="font-semibold text-neutral-400">Skills</span>
                    <ul className="ml-3 space-y-0.5 font-mono text-neutral-300">
                      {res.skills.map((s) => (
                        <li key={s.path}>{s.path}</li>
                      ))}
                    </ul>
                  </li>
                )}
                {res.prompts.length > 0 && (
                  <li>
                    <span className="font-semibold text-neutral-400">Prompts</span>
                    <ul className="ml-3 space-y-0.5 font-mono text-neutral-300">
                      {res.prompts.map((pr) => (
                        <li key={pr.path}>{pr.path}</li>
                      ))}
                    </ul>
                  </li>
                )}
                {res.themes.length > 0 && (
                  <li>
                    <span className="font-semibold text-neutral-400">Themes</span>
                    <ul className="ml-3 space-y-0.5 font-mono text-neutral-300">
                      {res.themes.map((th) => (
                        <li key={th.path}>{th.path}</li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            </details>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + prettier + 提交**

Run: `cd packages/client && npx tsc --noEmit`
Expected: exit 0
```bash
cd /home/philogag/workspace/pi-exts/pi-forge
npx prettier --write packages/client/src/components/SettingsPanel.tsx
git add packages/client/src/components/SettingsPanel.tsx
git commit -m "feat(extensions): add Extensions tab to settings"
```

---

### Task 5: 集成测试（tests/test-extensions.ts）

**Files:**
- Create: `tests/fixtures/ext-sample/package.json`、`tests/fixtures/ext-sample/skills/hello/SKILL.md`、`tests/fixtures/ext-sample/prompts/review.md`
- Create: `tests/test-extensions.ts`

**Interfaces:**
- Consumes: Task 1-2 的端点行为（GET/install/remove + 404/400）
- Produces: 通过 `scripts/run-tests.sh --only extensions` 可独立运行的集成测试

- [ ] **Step 1: 本地 fixture 包**

`tests/fixtures/ext-sample/package.json`：

```json
{
  "name": "forge-ext-sample",
  "version": "1.0.0",
  "description": "Fixture package for extension manager integration tests",
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

`tests/fixtures/ext-sample/skills/hello/SKILL.md`：

```markdown
---
name: hello
description: Says hello to the user.
---

When asked to say hello, respond with 'hello world'.
```

`tests/fixtures/ext-sample/prompts/review.md`：

```markdown
You are reviewing code. Be concise.
```

> 若 SDK 对本地目录安装要求 tarball（`installParsedSource` 走 npm pack），测试内改为在 fixture 目录执行 `npm pack` 生成 tarball 后安装其绝对路径。以实际行为为准，保持断言不变。

- [ ] **Step 2: 测试文件骨架（复用 test-config.ts 的启动模式）**

```ts
/**
 * Extensions manager integration test.
 *
 * Boots the server in-process with a temp PI_CONFIG_DIR / FORGE_DATA_DIR
 * and a fixture package under tests/fixtures/ext-sample. Covers:
 *   - GET /config/extensions empty list
 *   - POST /config/extensions/install of the local fixture (user scope)
 *   - GET shows the package with grouped resources (skills/prompts)
 *   - reinstall is idempotent (no duplicate listing entries)
 *   - POST /config/extensions/remove → 200; GET empty again
 *   - remove of an unknown package → 404 package_not_found
 *   - install with invalid body → 400
 *   - settings.json#packages[] persisted after install; install dir removed after remove
 */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const fixturePkg = resolve(__dirname, "fixtures", "ext-sample");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(base: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  base: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ext-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-ext-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-ext-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    // 1. empty list
    {
      const r = await jget(base, "/api/v1/config/extensions");
      assert("GET /config/extensions initial → 200", r.status === 200);
      assert(
        "  body is { packages: [] }",
        JSON.stringify(r.body) === '{"packages":[]}',
        JSON.stringify(r.body),
      );
    }

    // 2. install local fixture (user scope)
    let installedSource = fixturePkg;
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", {
        source: fixturePkg,
        scope: "user",
      });
      assert("POST /config/extensions/install → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as { source?: string; scope?: string };
      installedSource = body.source ?? fixturePkg;
      assert("  body echoes source + scope", body.source !== undefined && body.scope === "user");
    }

    // 3. list shows package with grouped resources
    {
      const r = await jget(base, "/api/v1/config/extensions");
      assert("GET after install → 200", r.status === 200);
      const list = (r.body as { packages: unknown[] }).packages;
      assert("  exactly one package listed", list.length === 1, JSON.stringify(list));
      const pkg = list[0] as {
        name?: string;
        scope: string;
        resources: { skills: { path: string }[]; prompts: { path: string }[] };
      };
      assert("  package name from package.json", pkg.name === "forge-ext-sample");
      assert("  scope is user", pkg.scope === "user");
      assert(
        "  resources.skills non-empty",
        Array.isArray(pkg.resources.skills) && pkg.resources.skills.length > 0,
        JSON.stringify(pkg.resources),
      );
      assert(
        "  resources.prompts non-empty",
        Array.isArray(pkg.resources.prompts) && pkg.resources.prompts.length > 0,
        JSON.stringify(pkg.resources),
      );
    }

    // 4. settings.json persisted
    {
      const raw = await readFile(join(configDir, "settings.json"), "utf8");
      const settings = JSON.parse(raw) as { packages?: { source?: string }[] };
      const found = (settings.packages ?? []).some((p) => (p.source ?? "").includes("ext-sample"));
      assert("settings.json#packages[] contains installed source", found, raw.slice(0, 400));
    }

    // 5. reinstall is idempotent — no duplicate entries
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", {
        source: installedSource,
        scope: "user",
      });
      assert("reinstall → 200 (or explicit already-installed error)", r.status === 200, JSON.stringify(r.body));
      const list = (await jget(base, "/api/v1/config/extensions")).body as { packages: unknown[] };
      assert("  still exactly one entry", list.packages.length === 1, JSON.stringify(list.packages));
    }

    // 6. remove unknown package → 404
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/remove", {
        source: "definitely-not-installed",
        scope: "user",
      });
      assert("remove unknown → 404", r.status === 404);
      assert(
        "  error is package_not_found",
        (r.body as { error?: string }).error === "package_not_found",
        JSON.stringify(r.body),
      );
    }

    // 7. remove installed package → 200, list empty, install dir gone
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/remove", {
        source: installedSource,
        scope: "user",
      });
      assert("remove installed → 200", r.status === 200);
      assert("  removed: true", (r.body as { removed?: boolean }).removed === true);
      const list = (await jget(base, "/api/v1/config/extensions")).body as { packages: unknown[] };
      assert("  list empty after remove", list.packages.length === 0, JSON.stringify(list.packages));
      const pkgDir = join(configDir, "packages", "forge-ext-sample");
      await stat(pkgDir).then(
        () => assert("  install dir removed", false, `still exists: ${pkgDir}`),
        () => assert("  install dir removed", true),
      );
    }

    // 8. invalid body → 400
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", { source: "x" });
      assert("install without scope → 400", r.status === 400, JSON.stringify(r.body));
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-extensions] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-extensions] PASS");
}

main().catch((err) => {
  console.error("[test-extensions] uncaught error:", err);
  process.exit(1);
});
```

- [ ] **Step 3: 构建 + 运行测试（先红后绿）**

Run: `cd /home/philogag/workspace/pi-exts/pi-forge && npm run build && npx tsx tests/test-extensions.ts`
Expected: 全部断言 PASS；若 SDK 安装行为与预期不符（如本地目录需 pack、安装目录名不同），调整 fixture/断言并记录偏差
```bash
git add tests/test-extensions.ts tests/fixtures/ext-sample
git commit -m "test(extensions): integration tests for extensions manager"
```

---

### Task 6: 全量验证

**Files:**
- 无新文件（验证任务）

- [ ] **Step 1: 完整 check**

Run: `cd /home/philogag/workspace/pi-exts/pi-forge && npm run check`
Expected: tsc + eslint + prettier 全部通过

- [ ] **Step 2: 回归测试**

Run: `scripts/run-tests.sh --only extensions,config,api`
Expected: 全部 PASS（config/api 为既有套件回归）

- [ ] **Step 3: 提交（若有遗留改动）**

```bash
git add -A
git commit -m "chore(extensions): final verification fixes" || echo "nothing to commit"
```

- [ ] **Step 4: 手动验证清单（可选，浏览器）**

- MINIMAL_UI=1 时 Extensions tab 不出现
- 安装后新建会话出现新工具；运行中会话无 → Settings → General Restart 后出现
- 展开四组资源，空组隐藏
