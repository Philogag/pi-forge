# Optimize Providers Plugin APIKey Implementation Plan

> **给 agentic worker 使用：** 用 superpowers:subagent-driven-development
> 逐任务实现本计划。每个 step 是一个 2-5 分钟动作（TDD：先写失败测试→
> 看失败→最小实现→看通过→提交）。

---
change: optimize-providers-plugin-apikey
design-doc: openspec/changes/optimize-providers-plugin-apikey/design.md
base-ref: 5ec0c2dc08568973ae6a39b4e9b878649456be76
---

**Goal:** 让浏览器 Providers 界面自动感知插件注册的 apikey provider（pi-provider-litellm / pi-provider-omniroute）：来源标注、key 管理、模型刷新、settings.json 块配置表单化。

**Architecture:** 进程级 provider 注册表（providers/registry.ts）在启动时后台加载扩展，从 SDK `ExtensionRuntimeState.pendingProviderRegistrations` 公开队列捕获插件注册的 provider；刷新端点用一次性 `ModelRuntime.create + registerProvider + refresh` 触发模型发现并持久化到 models-store；列表接口合并注册表与 models-store；配置表单复用 plugin-config 兼容框架（compat 声明）。

**Tech Stack:** Node 22 / Fastify / @earendil-works/pi-coding-agent 0.84.2（discoverAndLoadExtensions、ModelRuntime、ModelRegistry）/ React + Zustand / Vite。测试 `npx tsx tests/xxx.ts`（须先 `npm run build`）。

**Spec:** `openspec/changes/optimize-providers-plugin-apikey/specs/plugin-provider-registry/spec.md`、`plugin-provider-refresh/spec.md`、`plugin-provider-config/spec.md` + `design.md`

## Global Constraints

- 无新依赖。命名导出（无 default export）。
- 操作型 env 只在 `packages/server/src/config.ts` 读，且必须配 CLI flag（本期尽量不加新 env；用 SDK 默认超时）。
- 路由只注册在 `packages/server/src/index.ts`；路由文件导出 Fastify 插件函数。
- 文件写走原子写（.tmp + rename）；路径校验（遍历 → 403）；结构化错误（400 校验 / 404 not_found / 500 agent_error `{error, message}`）。
- 浏览器 HTTP 全走 `api-client.ts`（`request()`），组件不直接 fetch。
- SDK 事实：`discoverAndLoadExtensions(configuredPaths, cwd, agentDir?, eventBus?)` → `LoadExtensionsResult{extensions, errors: {path,error}[], runtime}`；`runtime.pendingProviderRegistrations: Array<{name, config: ProviderConfigInput, extensionPath}>`（公开队列，bindCore 前稳定；pi-forge 从不 bindCore）；`ModelRuntime.create({authPath, modelsPath, modelsStore?, modelRefreshTimeoutMs?})`；`ModelRegistry` 有 `getAll()/hasConfiguredAuth(m)/getSupportedThinkingLevels`。
- 既有模式参考：`packages/server/src/plugin-config/registry.ts`（configurePluginConfigRegistry(d: RegistryDeps): void / refreshPluginConfigs() / getPluginConfigState()——providers 注册表照此模式）；`tests/test-plugin-config-api.ts` 的 boot 骨架。
- tsconfig: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（条件赋值）；eslint：`consistent-type-definitions`（对象类型用 interface）、去 undefined 用 `!`。

---

### Task 1: provider 注册表（providers/registry.ts）

**Files:**
- Create: `packages/server/src/providers/registry.ts`
- Create: `packages/server/src/providers/types.ts`
- Test: `tests/test-providers.ts`（本任务只写注册捕获段；后续任务追加段落）

**Interfaces:**
- Consumes: `extensions-manager.ts` 的 `resolveEnabledExtensionPaths(cwd: string, agentDir: string): Promise<ResolvedExtensionPath[]>`（已存在；capture 同款用法）；SDK `discoverAndLoadExtensions`；SDK 类型 `ProviderConfigInput`（import type { ProviderConfigInput } from "@earendil-works/pi-coding-agent"）。
- Produces: `configurePluginProviderRegistry(d: ProviderRegistryDeps): void`、`refreshPluginProviders(): Promise<ProviderRegistryState>`（fire-and-forget 调用方 `void refreshPluginProviders()`）、`getPluginProviderState(): ProviderRegistryState`、`getRegisteredPluginProvider(name: string): PluginProviderEntry | undefined`。
  - `ProviderRegistryDeps { cwd: string; agentDir: string; configuredPaths?: Promise<ResolvedExtensionPath[]> }`
  - `PluginProviderEntry { name: string; config: ProviderConfigInput; package: string; native: boolean }`
  - `ProviderRegistryState { ready: boolean; providers: PluginProviderEntry[]; errors: { path: string; error: string }[] }`

- [ ] **Step 1: 写失败测试（注册捕获 + 隔离）**

在 `tests/test-providers.ts` 写第一段（boot 骨架照 `tests/test-plugin-config-api.ts`：mkdtemp 三目录 + env `WORKSPACE_PATH/PI_CONFIG_DIR/FORGE_DATA_DIR/SESSION_DIR/NODE_ENV=test` + `import { buildServer } from "../packages/server/dist/index.js"` + listen port 0）：

```ts
// 临时扩展：agentDir/extensions/test-provider-ext/index.js（commonjs）
// 内容（照 pi 扩展协议，加载时调 pi.registerProvider）：
//   const { registerProvider } = require("@earendil-works/pi-coding-agent/dist/extensions/runner.js");
//   registerProvider("testprovider", {
//     baseUrl: "http://127.0.0.1:1/v1",
//     refreshModels: async () => [{ id: "test-model", name: "Test Model", contextWindow: 8000, maxTokens: 4000, reasoning: false, input: ["text"] }],
//   });
import { getPluginProviderState, refreshPluginProviders, configurePluginProviderRegistry } from "../packages/server/dist/providers/registry.js";

const st = await refreshPluginProviders();
assert("registry ready", st.ready === true);
const found = st.providers.find((p) => p.name === "testprovider");
assert("captured provider", found !== undefined);
assert("package resolved", found?.package === "test-provider-ext");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: FAIL（模块不存在 / ready false）。

- [ ] **Step 3: 实现 `providers/types.ts` + `providers/registry.ts`**

```ts
// providers/types.ts
import type { ProviderConfigInput } from "@earendil-works/pi-coding-agent";
export interface PluginProviderEntry {
  name: string;
  config: ProviderConfigInput;
  package: string;
  native: boolean; // 来自 pendingNativeProviderRegistrations（本期仅标记，不展开 config）
}
export interface ProviderRegistryState {
  ready: boolean;
  providers: PluginProviderEntry[];
  errors: { path: string; error: string }[];
}
export interface ProviderRegistryDeps {
  cwd: string;
  agentDir: string;
  configuredPaths?: Promise<{ path: string }[]>;
}
```

```ts
// providers/registry.ts
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { resolveEnabledExtensionPaths } from "../extensions-manager.js";
import type { ProviderRegistryDeps, ProviderRegistryState, PluginProviderEntry } from "./types.js";

let deps: ProviderRegistryDeps | undefined;
let state: ProviderRegistryState = { ready: false, providers: [], errors: [] };

export function configurePluginProviderRegistry(d: ProviderRegistryDeps): void {
  deps = d;
}

function packageFromPath(extensionPath: string, agentDir: string): string {
  const rel = extensionPath.replace(agentDir, "");
  const m = rel.match(/node_modules\/([^/]+)/) ?? rel.match(/extensions\/([^/]+)/);
  if (m) return m[1].replace(/\.pi-extension$/, "");
  return "extension";
}

export async function refreshPluginProviders(): Promise<ProviderRegistryState> {
  if (deps === undefined) {
    state = { ready: true, providers: [], errors: [] };
    return state;
  }
  try {
    const configured = await (deps.configuredPaths ?? resolveEnabledExtensionPaths(deps.cwd, deps.agentDir));
    const bus = createEventBus();
    const result = await discoverAndLoadExtensions(configured, deps.cwd, deps.agentDir, bus);
    const providers: PluginProviderEntry[] = [];
    for (const reg of result.runtime.pendingProviderRegistrations ?? []) {
      providers.push({ name: reg.name, config: reg.config, package: packageFromPath(reg.extensionPath, deps.agentDir), native: false });
    }
    for (const native of result.runtime.pendingNativeProviderRegistrations ?? []) {
      providers.push({ name: String(native.name ?? "unknown"), config: {} as ProviderConfigInput, package: packageFromPath(String(native.extensionPath ?? ""), deps.agentDir), native: true });
    }
    state = {
      ready: true,
      providers,
      errors: result.errors.map((e) => ({ path: e.path, error: String(e.error) })),
    };
  } catch (err) {
    state = { ready: true, providers: [], errors: [{ path: "<registry>", error: String(err) }] };
  }
  return state;
}

export function getPluginProviderState(): ProviderRegistryState {
  return state;
}

export function getRegisteredPluginProvider(name: string): PluginProviderEntry | undefined {
  return state.providers.find((p) => p.name === name);
}
```

> 注：`pendingNativeProviderRegistrations` 元素形状以 SDK 类型为准（本机
> `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1171`
> 附近）；若字段名不同（如 `provider`），按实际类型读取并仍产出
> `{name, package, native:true, config:{}}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: PASS（captured provider、package resolved）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/providers tests/test-providers.ts
git commit -m "feat(providers): add plugin provider registry capturing extension registrations"
```

---

### Task 2: 模型刷新（providers/refresh.ts）

**Files:**
- Create: `packages/server/src/providers/refresh.ts`
- Modify: `tests/test-providers.ts`（追加刷新段）

**Interfaces:**
- Consumes: Task 1 `getRegisteredPluginProvider(name)`；`config-manager.ts` 的 `AUTH_FILE()/MODELS_FILE()`（已导出）；SDK `ModelRuntime`、`getSupportedThinkingLevels`（config-manager 已用，import 同源）。
- Produces: `refreshPluginProvider(name: string): Promise<ProviderModels[]>`、`PluginProviderNotFoundError extends Error`。
  - `ProviderModels` 形状 = `ProvidersListing["providers"][number]["models"][number]`（id/name/contextWindow/maxTokens/reasoning/input/hasAuth/supportedThinkingLevels——从 `config-manager.ts` 的 ProvidersListing 复用类型）。

- [ ] **Step 1: 写失败测试（刷新 + 404 + 失败隔离）**

追加到 `tests/test-providers.ts`：

```ts
import { refreshPluginProvider } from "../packages/server/dist/providers/refresh.js";
import { PluginProviderNotFoundError } from "../packages/server/dist/providers/refresh.js";

let refreshed: string[] = [];
// 复用 Task 1 的测试扩展；断言 refresh 返回模型：
const models = await refreshPluginProvider("testprovider");
assert("refresh returns models", Array.isArray(models) && models.length >= 1);
assert("model id", models[0]?.id === "test-model");
// 未注册 → PluginProviderNotFoundError
let threw = false;
try { await refreshPluginProvider("nope"); } catch (err) { threw = err instanceof PluginProviderNotFoundError; }
assert("unregistered throws not-found", threw === true);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: FAIL（refreshPluginProvider 未定义）。

- [ ] **Step 3: 实现 `providers/refresh.ts`**

```ts
// providers/refresh.ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, AUTH_FILE, MODELS_FILE } from "../config-manager.js";
import { getRegisteredPluginProvider } from "./registry.js";
import type { ProvidersListing } from "../config-manager.js";

export type ProviderModels = ProvidersListing["providers"][number]["models"][number];

export class PluginProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`plugin provider not found: ${provider}`);
    this.name = "PluginProviderNotFoundError";
  }
}

export async function refreshPluginProvider(name: string): Promise<ProviderModels[]> {
  const entry = getRegisteredPluginProvider(name);
  if (entry === undefined || entry.native) {
    // native 注册本期无 refreshModels 语义 → 视作不可刷新
    throw new PluginProviderNotFoundError(name);
  }
  const runtime = await ModelRuntime.create({
    authPath: AUTH_FILE(),
    modelsPath: MODELS_FILE(),
    modelsStore: true,
    modelRefreshTimeoutMs: 60_000,
  });
  runtime.registerProvider(name, entry.config);
  try {
    await runtime.refresh({ providers: [name] });
  } finally {
    await runtime.dispose?.();
  }
  const models = await runtime.getModels(name);
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: m.reasoning,
    input: m.input,
    hasAuth: runtime.hasConfiguredAuth(m),
    supportedThinkingLevels: getSupportedThinkingLevels(m),
  }));
}
```

> 注：`ModelRuntime` 若公开 `dispose()` 则在 finally 调用；若无此方法删掉该行
> （以 `dist/core/model-runtime.d.ts` 实际导出为准）。刷新失败（网络/超时）
> 时错误向上抛，由路由层映射 500 agent_error；models-store 已有数据不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: PASS（refresh 返回模型；未注册抛 not-found）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/providers/refresh.ts tests/test-providers.ts
git commit -m "feat(providers): refresh plugin provider models via ModelRuntime"
```

---

### Task 3: config-manager 列表合并

**Files:**
- Modify: `packages/server/src/config-manager.ts`（`ProvidersListing` 接口 ~127 行；`liveProvidersListing` ~492 行）

**Interfaces:**
- Consumes: Task 1 `getPluginProviderState()`。
- Produces: 扩展后的 `ProvidersListing`：`{ providers: ProviderGroup[]; ready: boolean; errors: {path,error}[] }`，`ProviderGroup` 加 `via?: string`、`package?: string`。向后兼容（`ready`/`errors` 新字段，旧客户端忽略）。

- [ ] **Step 1: 写失败测试（合并行为）**

追加到 `tests/test-providers.ts`：

```ts
import { liveProvidersListing } from "../packages/server/dist/config-manager.js";
const listing = await liveProvidersListing();
const tp = listing.providers.find((p) => p.provider === "testprovider");
assert("plugin provider listed", tp !== undefined);
assert("via annotated", tp?.via === "test-provider-ext");
assert("models from store", tp?.models.length >= 1);
assert("ready flag", listing.ready === true);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: FAIL（via 未定义 / ready 未定义）。

- [ ] **Step 3: 实现合并**

```ts
// config-manager.ts —— ProvidersListing 接口增加：
export interface ProvidersListing {
  ready: boolean;
  errors: { path: string; error: string }[];
  providers: {
    provider: string;
    via?: string;      // 插件来源包名（仅插件 provider）
    package?: string;  // 与 via 相同（冗余，供前端匹配 compat 声明）
    models: { /* 原形状不变 */ }[];
  }[];
}
```

`liveProvidersListing()` 开头注入注册表态，分组循环里补标注，循环后补无模型插件 provider：

```ts
export async function liveProvidersListing(): Promise<ProvidersListing> {
  await migrateLegacyModelsJsonIfNeeded();
  const registry = await liveModelRegistry();
  const all: Model<Api>[] = registry.getAll();
  const customOnly = config.hideBuiltinProviders
    ? new Set(Object.keys((await readModelsJson()).providers))
    : undefined;
  const grouped = new Map<string, ProvidersListing["providers"][number]>();
  for (const m of all) {
    if (customOnly !== undefined && !customOnly.has(m.provider)) continue;
    let entry = grouped.get(m.provider);
    if (entry === undefined) {
      entry = { provider: m.provider, models: [] };
      grouped.set(m.provider, entry);
    }
    // 保留既有 push：id/name/contextWindow/maxTokens/reasoning/input/hasAuth/supportedThinkingLevels（getSupportedThinkingLevels(m)）
    entry.models.push({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      input: m.input,
      hasAuth: registry.hasConfiguredAuth(m),
      supportedThinkingLevels: getSupportedThinkingLevels(m),
    });
  }
  // 合并插件注册表：标注来源；models-store 无模型的插件 provider 以空模型列出
  const provState = getPluginProviderState();
  const named = new Map<string, ProvidersListing["providers"][number]>();
  for (const [key, e] of grouped) named.set(key, e);
  for (const p of provState.providers) {
    let entry = named.get(p.name);
    if (entry === undefined) {
      entry = { provider: p.name, models: [] };
      named.set(p.name, entry);
    }
    entry.via = p.package;
    entry.package = p.package;
  }
  return { ready: provState.ready, errors: provState.errors, providers: Array.from(named.values()) };
}
```

（保留 HIDE_BUILTIN_PROVIDERS 对内置 provider 的过滤语义；插件 provider 不受其影响——因为其 provider 名不在 models.json 键时 customOnly 不含它，但注册表合并路径无条件添加。若 `customOnly` 启用且插件 provider 想被隐藏，由后续版本处理，本期不特殊化。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/config-manager.ts tests/test-providers.ts
git commit -m "feat(providers): merge plugin provider registry into providers listing"
```

---

### Task 4: REST 端点（routes/config.ts）

**Files:**
- Modify: `packages/server/src/routes/config.ts`（`providersListingSchema` ~182 行；`GET /config/providers` ~358 行；auth 区之后）

**Interfaces:**
- Consumes: Task 2 `refreshPluginProvider`、`PluginProviderNotFoundError`；Task 3 的 `ProvidersListing` 新形状。
- Produces: `POST /config/providers/:provider/refresh` → 200 `{ provider, models: ProviderModels[] }` / 404 `not_found` / 500 `agent_error`。

- [ ] **Step 1: 写失败测试（HTTP 层）**

追加到 `tests/test-providers.ts`：

```ts
import { buildServer } from "../packages/server/dist/index.js";
const server = await buildServer(); // 复用 boot 的 server 实例或另建
const res = await server.inject({ method: "POST", url: "/api/v1/config/providers/testprovider/refresh" });
assert("refresh 200", res.statusCode === 200);
const body = JSON.parse(res.body);
assert("refresh body models", Array.isArray(body.models) && body.models.length >= 1);
const res404 = await server.inject({ method: "POST", url: "/api/v1/config/providers/nope/refresh" });
assert("refresh 404", res404.statusCode === 404);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: FAIL（404/无端点）。

- [ ] **Step 3: 实现 schema + 路由**

```ts
// providersListingSchema（182 行附近）改为：
const providersListingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ready", "errors", "providers"],
  properties: {
    ready: { type: "boolean" },
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "error"],
        properties: { path: { type: "string" }, error: { type: "string" } },
      },
    },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "models"],
        properties: {
          provider: { type: "string" },
          via: { type: "string" },
          package: { type: "string" },
          models: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
    },
  },
};
```

在 auth 路由区（DELETE /config/auth/:provider 之后 ~633 行）新增：

```ts
    "/config/providers/:provider/refresh": {
      post: {
        summary: "Refresh models for a plugin-provided provider",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "models"],
            properties: {
              provider: { type: "string" },
              models: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
```

handler（同文件内 auth 区后）：

```ts
      const refreshProvider = async (req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
        try {
          const models = await refreshPluginProvider(req.params.provider);
          return { provider: req.params.provider, models };
        } catch (err) {
          if (err instanceof PluginProviderNotFoundError) {
            return reply.code(404).send({ error: "not_found", message: err.message });
          }
          throw err; // 500 agent_error 由全局错误处理
        }
      };
```

路由注册（仿现有 auth 子插件，见 561 行附近结构）与 import（`refreshPluginProvider`、`PluginProviderNotFoundError` 加到 6-18 行 import 块）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx tsx tests/test-providers.ts`
Expected: PASS（200 + 404）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/config.ts tests/test-providers.ts
git commit -m "feat(providers): add POST /config/providers/:provider/refresh endpoint"
```

---

### Task 5: compat 声明（settings.json 块表单）

**Files:**
- Modify: `packages/server/src/extensions-settings-compat/index.ts`（`COMPAT_DECLARATIONS`）
- Modify: `tests/test-plugin-config.ts`（追加 compat 声明断言）

**Interfaces:**
- Consumes: plugin-config 框架（声明结构、PUT 部分更新、原子写）——已归档不动。
- Produces: `litellm` 与 `pi-provider-omniroute` 两个 compat 声明（source "compat"，file "settings.json"，嵌套 path）。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test-plugin-config.ts`（compat 段）：

```ts
import { validateCompatDeclarations, COMPAT_DECLARATIONS } from "../packages/server/src/extensions-settings-compat/index.js";
const res = validateCompatDeclarations(COMPAT_DECLARATIONS);
assert("compat decls valid", res.ok === true);
const litellm = COMPAT_DECLARATIONS.find((d) => d.package === "pi-provider-litellm");
const omni = COMPAT_DECLARATIONS.find((d) => d.package === "pi-provider-omniroute");
assert("litellm declared", litellm !== undefined && litellm.file === "settings.json");
assert("omniroute declared", omni !== undefined && omni.file === "settings.json");
assert("nested paths", omni?.fields.some((f) => f.path.startsWith("pi-provider-omniroute.")));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx tsx tests/test-plugin-config.ts`
Expected: FAIL（declared 未定义）。

- [ ] **Step 3: 实现两个声明**

`COMPAT_DECLARATIONS` 追加（字段结构照既有声明：`{kind, path, type|options, label, description?, defaultValue?}`）：

```ts
{
  package: "pi-provider-litellm",
  label: "pi-provider-litellm",
  file: "settings.json",
  source: "compat",
  description: "LiteLLM 代理配置（settings.json 的 `litellm` 块）。别名 provider 列表请用 Raw JSON 编辑。",
  fields: [
    { kind: "scalar", path: "litellm.baseUrl", type: "string", label: "Base URL", description: "LiteLLM 网关地址，如 https://litellm.example.com/v1" },
    { kind: "scalar", path: "litellm.headers", type: "string", label: "Headers (JSON)", description: "附加请求头，JSON 对象字符串；用 Raw JSON 编辑结构化内容", secret: true },
  ],
},
{
  package: "pi-provider-omniroute",
  label: "pi-provider-omniroute",
  file: "settings.json",
  source: "compat",
  description: "OmniRoute 聚合网关配置（settings.json 的 `pi-provider-omniroute` 块）。",
  fields: [
    { kind: "scalar", path: "pi-provider-omniroute.baseUrl", type: "string", label: "Base URL", description: "网关地址，默认 http://localhost:20128/v1" },
    { kind: "scalar", path: "pi-provider-omniroute.search.provider", type: "enum", label: "Search provider", enum: [{ value: "serper-search", label: "serper-search" }, { value: "brave-search", label: "brave-search" }, { value: "exa-search", label: "exa-search" }, { value: "tavily-search", label: "tavily-search" }] },
    { kind: "scalar", path: "pi-provider-omniroute.fetch.provider", type: "enum", label: "Fetch provider", enum: [{ value: "firecrawl", label: "firecrawl" }, { value: "jina-reader", label: "jina-reader" }, { value: "tavily-search", label: "tavily-search" }] },
  ],
},
```

- [ ] **Step 4: 跑测试确认通过 + settings.json 无关键保留验证**

Run: `npm run build && npx tsx tests/test-plugin-config.ts`
Expected: PASS。另在 `tests/test-providers.ts` 或手工验证：settings.json 有 `{other: {x: 1}, "pi-provider-omniroute": {baseUrl: "a"}}` 时，表单保存 `pi-provider-omniroute.baseUrl` → 文件保留 `other` 键（plugin-config PUT 已是部分更新，无需改代码；仅加断言）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/extensions-settings-compat/index.ts tests/test-plugin-config.ts
git commit -m "feat(compat): declare litellm and omniroute settings.json blocks"
```

---

### Task 6: api-client

**Files:**
- Modify: `packages/client/src/lib/api-client/index.ts`（类型 ~600 行附近 + 方法 ~2195 行附近）

**Interfaces:**
- Consumes: REST 契约（Task 4）。
- Produces: `refreshPluginProvider(provider: string): Promise<{ provider: string; models: ProviderModel[] }>`；`ProvidersListing` 类型补 `ready: boolean`、`errors: {path,error}[]`、`via?: string`、`package?: string`。

- [ ] **Step 1: 类型与方法**

```ts
// ProvidersListing 类型（~600 行）扩展：
export interface ProviderListingGroup {
  provider: string;
  via?: string;
  package?: string;
  models: ProviderModel[];
}
export interface ProvidersListing {
  ready: boolean;
  errors: { path: string; error: string }[];
  providers: ProviderListingGroup[];
}
// validator vProvidersListing（640 行）同步放宽：
function vProvidersListing(value: unknown, status: number): ProvidersListing {
  if (!isObject(value) || !Array.isArray(value.providers)) {
    fail(status, "expected { providers: [...] }");
  }
  return { ready: (value as { ready?: unknown }).ready === true, errors: Array.isArray((value as { errors?: unknown }).errors) ? (value as { errors: { path: string; error: string }[] }).errors : [], providers: (value as ProvidersListing).providers };
}
// 方法（2195 行 getProviders 之后）：
refreshPluginProvider: (provider: string) =>
  request(`/api/v1/config/providers/${encodeURIComponent(provider)}/refresh`, vProviderRefresh, { method: "POST" }),
```

```ts
function vProviderRefresh(value: unknown, status: number): { provider: string; models: ProviderModel[] } {
  if (!isObject(value) || !Array.isArray(value.models)) {
    fail(status, "expected { provider, models[] }");
  }
  return value as unknown as { provider: string; models: ProviderModel[] };
}
```

- [ ] **Step 2: 跑测试确认**

Run: `npm run build`
Expected: PASS（tsc + vite 编译）。

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/lib/api-client/index.ts
git commit -m "feat(api-client): refreshPluginProvider + listing types"
```

---

### Task 7: UI（SettingsPanel ProvidersTab）

**Files:**
- Modify: `packages/client/src/components/SettingsPanel.tsx`（ProvidersTab ~526-660 行）
- Modify: `packages/client/src/lib/api-client/index.ts`（类型已 Task 6）

**Interfaces:**
- Consumes: Task 6 方法/类型；既有 `PluginConfigModal`（齿轮打开配置表单；用法照 ExtensionsTab 齿轮——`getConfigDeclaration(package)` 匹配声明，`openPluginConfigFor(pkg)` 状态）。
- Produces: 插件 provider 卡片：`via 包名` 徽标、模型计数、刷新按钮（per-provider busy）、pending 提示、齿轮入口（有 compat 声明时）。

- [ ] **Step 1: ProvidersTab 状态与加载扩展**

```ts
// refresh() 里加第三个并行请求：
const [p, a, pc] = await Promise.all([api.getProviders(), api.getAuthSummary(), api.getPluginConfigs()]);
setProviders(p); setAuth(a); setPluginConfigs(pc);
// 新 state：
const [refreshing, setRefreshing] = useState<string | undefined>(undefined);
const [pluginConfigs, setPluginConfigs] = useState<PluginConfigsResponse | undefined>(undefined);
```

- [ ] **Step 2: 卡片渲染扩展**

```tsx
// 卡片头部，name 徽标旁（configured 徽标之后）：
{p.via !== undefined && (
  <span className="text-[10px] text-neutral-500">via {p.via}</span>
)}
// 模型计数（details 行）：
<span className="text-[11px] text-neutral-500">{p.models.length} model{p.models.length === 1 ? "" : "s"}</span>
// 操作区（Add/Replace key 旁）：
{p.via !== undefined && (
  <button
    onClick={() => void doRefresh(p.provider)}
    disabled={refreshing !== undefined}
    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
  >
    {refreshing === p.provider ? "Refreshing…" : "Refresh models"}
  </button>
)}
{p.via !== undefined && pluginConfigs?.declarations.some((d) => d.package === p.via) && (
  <button
    onClick={() => openPluginConfigFor(p.via!)}
    aria-label="Open plugin config"
    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
  >
    <Settings2 className="h-3.5 w-3.5" />
  </button>
)}
```

```ts
const doRefresh = async (provider: string): Promise<void> => {
  setRefreshing(provider);
  try {
    await api.refreshPluginProvider(provider);
    await refresh();
  } catch (err) {
    onError(`Refresh failed: ${errorCode(err)}`);
  } finally {
    setRefreshing(undefined);
  }
};
// 空态（models 为空且是插件 provider）：
{p.models.length === 0 && p.via !== undefined && (
  <p className="mt-1 text-[11px] text-neutral-500 italic">No models discovered — click Refresh models.</p>
)}
// pending 态（列表顶部，ready false）：
{providers.ready === false && (
  <p className="text-[11px] text-amber-400/90">
    Provider registry still loading — pull to refresh or reload.
  </p>
)}
```

`openPluginConfigFor(pkg)`：照 ExtensionsTab 齿轮实现（`setPluginConfigTarget(pkg)` 等）；`Settings2` 从 `lucide-react` 导入（文件已有 lucide 导入行）。齿轮仅在 `pluginConfigs.declarations` 有匹配声明时渲染。

- [ ] **Step 3: 跑测试确认**

Run: `npm run build`
Expected: PASS（tsc + vite）。

- [ ] **Step 4: 手工冒烟（可选，本机有容器则验证；无则跳过）**

浏览器打开 Settings → Providers：确认 omniroute/litellm 卡片出现 via 徽标、刷新按钮、齿轮。

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/components/SettingsPanel.tsx
git commit -m "feat(ui): plugin provider badges, refresh button, config gear in Providers tab"
```

---

### Task 8: 测试补齐（tests/test-providers.ts 全段）

**Files:**
- Modify: `tests/test-providers.ts`

- [ ] **Step 1: 独立开关测试**

```ts
// 新 boot：PLUGIN_CONFIG_CAPTURE=false（import dist 前设置 env）
// 断言：refreshPluginProviders() 仍 ready + 捕获 testprovider（注册表独立于 capture）
```

- [ ] **Step 2: 坏扩展隔离测试**

```ts
// agentDir/extensions/broken-ext/index.js 内容：throw new Error("boom");
// 断言：refreshPluginProviders() ready，errors 含 broken-ext，且 testprovider 仍注册
```

- [ ] **Step 3: compat 无关键保留（settings.json）测试**

```ts
// 写 settings.json {other:{x:1}}；经 plugin-config PUT 保存 omniroute.baseUrl；
// 断言 settings.json 保留 other 键 + 块写入
```

- [ ] **Step 4: 全量跑并提交**

Run: `npm run build && npx tsx tests/test-providers.ts && npx tsx tests/test-plugin-config.ts && npx tsx tests/test-config.ts && npx tsx tests/test-extensions.ts`
Expected: 全 PASS。

```bash
git add tests/test-providers.ts
git commit -m "test(providers): capture-off independence, broken extension isolation, settings.json preservation"
```

---

### Task 9: 文档与全量验证

**Files:**
- Modify: `docs/agent/api.md`（providers 列表新字段 + refresh 端点）
- Modify: `docs/agent/architecture.md`（providers 模块与数据流）
- Modify: `docs/agent/config.md`（若引入任何 env——本期无新 env 则注明无改动）
- Modify: `openspec/changes/optimize-providers-plugin-apikey/tasks.md`（勾选）

- [ ] **Step 1: 文档更新**

api.md：`GET /api/v1/config/providers` 响应含 `ready/errors` 与 per-provider `via/package`；新增 `POST /api/v1/config/providers/:provider/refresh`（404 not_found / 500 agent_error）。
architecture.md：新增 providers/registry.ts（启动后台捕获 `pendingProviderRegistrations`）、providers/refresh.ts（一次性 ModelRuntime 刷新写 models-store）、列表合并逻辑、与 plugin-config 的关系。

- [ ] **Step 2: 全量验证**

Run: `npm run check && npm run test:ci`
Expected: 全绿。`scripts/run-tests.sh --only providers,plugin-config,config,extensions` 通过。

- [ ] **Step 3: tasks.md 勾选 + validate + 提交**

```bash
python3 - <<'EOF'
import re
p = "openspec/changes/optimize-providers-plugin-apikey/tasks.md"
s = open(p).read()
s = re.sub(r"^- \[ \] (1\.1|1\.2|1\.3|1\.4|2\.1|2\.2|2\.3|3\.1|3\.2|4\.1|4\.2|4\.3|5\.1|5\.2|5\.3|6\.1|6\.2|7\.1|7\.2|7\.3|8\.1|8\.2|8\.3|8\.4|8\.5|8\.6|9\.1|9\.2|9\.3)", "- [x] \1", s, flags=re.M)
open(p, "w").write(s)
EOF
openspec validate --change optimize-providers-plugin-apikey
git add -A && git commit -m "docs(providers): api/architecture notes + tasks done"
```
