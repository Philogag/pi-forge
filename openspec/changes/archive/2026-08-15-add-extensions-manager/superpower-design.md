# Superpower Design: Settings Extensions 管理页

> 本文档是 `add-extensions-manager` 变更的深度技术设计（brainstorming 产出）。需求事实源为 `proposal.md` 与 `design.md`，本文件只做实现层面的细化：组件边界、数据流、SDK 用法、错误处理、测试策略、边界条件。与 design.md 冲突时以 design.md 为准。

## 1. 范围回顾（用户确认的关键决策）

| 决策 | 结论 |
|---|---|
| 安装/卸载后生效方式 | **仅新会话生效**；运行中会话由用户手动 Restart（Settings → General / /config/reload） |
| 安装输入形态 | 单一 source 输入框（npm 包名、`name@version`、git URL、本地路径 —— SDK `parseSource` 解析） |
| 插件更新 | **本期不含**（无 `update` / `checkForAvailableUpdates`） |
| 安装默认作用域 | **User**（全局 `~/.pi/agent/packages`），可切 Project（workspace `.pi/packages`） |
| providers 澄清 | pi 包模型（`PiManifest`）只有 `extensions/skills/prompts/themes`，**无 providers**；展开信息如实展示四类资源 |

## 2. 组件边界

```
┌─────────────────────────────────────────────────────────┐
│ Client (React)                                          │
│  SettingsPanel → ExtensionsTab (仿 ProvidersTab)        │
│    ├─ 安装行: source 输入 + scope 选择 + Install 按钮    │
│    ├─ 包卡片列表（每包: 名/type/scope/版本 + Remove + 齿轮）│
│    └─ <details> 展开: Tools / Skills / Prompts / Themes  │
│  api-client: getExtensions / installExtension /          │
│              removeExtension                             │
└───────────────┬─────────────────────────────────────────┘
                │ REST /api/v1/config/extensions*
┌───────────────▼─────────────────────────────────────────┐
│ Server (Fastify)                                        │
│  routes/config.ts  ── /config/extensions 子面           │
│       │                                                 │
│       ▼                                                 │
│  extensions-manager.ts  (新模块，包装 SDK)              │
│    ├─ listPackages(cwd)  → PackagesListing              │
│    │     = listConfiguredPackages() + resolve() +       │
│    │       readPackageJson(installedPath)               │
│    ├─ installPackage(cwd, source, scope)                │
│    │     = SettingsManager.create + DefaultPackageManager│
│    │       .installAndPersist(source, {local})          │
│    └─ removePackage(cwd, source, scope)                 │
│          = .removeAndPersist(source, {local})           │
└───────────────┬─────────────────────────────────────────┘
                │ SDK DefaultPackageManager
┌───────────────▼─────────────────────────────────────────┐
│ ~/.pi/agent (PI_CONFIG_DIR)  ·  workspace/.pi           │
│   settings.json#packages[]  ·  packages/<name>/         │
└─────────────────────────────────────────────────────────┘
```

**依赖注入约定**：`extensions-manager.ts` 是唯一直接 import SDK `DefaultPackageManager` / `SettingsManager` 的服务端模块（`extensions-discovery.ts` 目前直接 new，本变更保持该模式；不抽公共工厂，避免过度设计）。路由层只依赖 `extensions-manager.ts` 的纯函数 —— 符合 AGENTS.md 约定（路由不直接操作 SDK 对象）。

## 3. 数据流

### 3.1 列表（GET /config/extensions）

```
request
  → extensions-manager.listPackages(workspacePath)
     1. SettingsManager.create(cwd, config.piConfigDir)
     2. await settingsManager.reload?.()          // 读盘，拿到最新 packages[]
     3. pm = new DefaultPackageManager({cwd, agentDir, settingsManager})
     4. configured = pm.listConfiguredPackages()  // {source, scope, filtered, installedPath?}
     5. resolved = await pm.resolve()             // 四类 ResolvedResource[]
     6. 分组: resolved.* 中 metadata.origin === "package" 且 metadata.source 非空
              → 归入对应包的 resources（tools 取 extension 条目按 source 分组）
     7. 每包读 installedPath/package.json → {name, version, description}
     8. 逐包容错（单包 package.json 读取失败 → 该包带 errors 字段，不整体抛）
  → 200 { packages: [...] }
```

**分组键**：`metadata.source`（用户可见包名，如 `pi-subagents`、`git+https://…`）—— 与 `extensions-discovery.ts` 现有 `packageSource` 语义一致，UI 按 source 分组展示。

**注意**：`resolve()` 的 extensions/skills/prompts/themes 中 `origin: "top-level"` 的条目（裸全局 skill 目录、项目 `.pi/skills` 等）**不属于任何包**，必须在列表/展开信息中排除（同 `discoverExtensionResources` 对 skills 的处理，见该文件第 100-110 行注释）。

### 3.2 安装（POST /config/extensions/install）

```
body: { source: string, scope: "user" | "project" }
  1. 校验 body（source 非空、scope 枚举合法）→ 400 {error:"validation_error"}
  2. pm.installAndPersist(source, { local: scope === "project" })
     - SDK 内部: parseSource → installNpm / installGit → 成功后 addSourceToSettings
     - 失败抛错（npm 404、git 失败、untrusted project）→ 错误归一（见 §5）
  3. 超时: Promise.race 120_000ms（npm install 冷启动可能 >30s）
  4. 成功 → 200 { source, scope }
  5. 不触发 reload（用户决策）
```

**幂等性**：SDK `packageSourcesMatch` / `findSuggestedConfiguredSource` 检测已装 source —— 重复安装同 source 时 SDK 行为需实测（预期：已装则提示/跳过）。服务端不额外加锁（单用户场景，SDK 内部 `runWithConcurrency` 管理命令并发）。

### 3.3 卸载（POST /config/extensions/remove）

```
body: { source: string, scope: "user" | "project" }
  1. 校验 body → 400
  2. removed = await pm.removeAndPersist(source, { local: scope === "project" })
  3. removed === false → 404 { error: "package_not_found", message }
  4. removed === true → 200 { removed: true }
```

## 4. 关键实现细节

### 4.1 响应类型（服务端 + client validator 对齐）

```ts
interface ExtensionToolInfo {
  name: string;          // pi.registerTool 注册名
  description?: string;  // 工具描述（可选）
}
interface PackageResourcePath { path: string }  // 相对/绝对路径展示
interface PackageResources {
  tools: ExtensionToolInfo[];
  skills: PackageResourcePath[];
  prompts: PackageResourcePath[];
  themes: PackageResourcePath[];
}
interface InstalledPackage {
  source: string;        // settings.json#packages[] 里的原始 source
  type: "npm" | "git";   // 由 installedPath/package.json 或 source 形态判定
  scope: "user" | "project";
  installedPath?: string;
  name?: string;         // package.json#name
  version?: string;      // package.json#version
  description?: string;
  resources: PackageResources;
  errors?: { path: string; error: string }[];  // 单包解析失败时
}
interface PackagesListing { packages: InstalledPackage[] }
```

`type` 判定：优先用 `resolve()` 结果推断不可行（ResolvedResource 无 type 字段）→ 从 source 形态推断（`^git+` / `^https?://` / `^git@` / 含 `:` → git；否则 npm），或读取 installedPath 下的 package.json（git 安装的包 package.json 存在）。实现时以 installedPath 存在性为主，source 形态兜底。

### 4.2 服务端模块签名

```ts
// packages/server/src/extensions-manager.ts
export interface ExtensionsManagerDeps {
  cwd: string;         // workspacePath
  agentDir: string;    // config.piConfigDir
}
export function listPackages(deps): Promise<PackagesListing>;
export function installPackage(deps, source: string, scope: "user"|"project"): Promise<{source, scope}>;
export function removePackage(deps, source: string, scope: "user"|"project"): Promise<{removed: boolean}>;
// 内部 helper
function createPackageManager(deps): Promise<{ pm: DefaultPackageManager }>;  // create + reload + new
function readPackageMeta(installedPath?: string): Promise<{name?, version?, description?} | undefined>;
function groupResources(resolved: ResolvedPaths): Record<string, PackageResources>;  // key = metadata.source
function inferType(source: string): "npm" | "git";
```

### 4.3 路由（routes/config.ts，`/config/extensions` 子面）

与现有 `configRoutes` 插件同构，放在文件末尾（`DELETE /config/tool-overrides` 路由之后、插件 `};` 之前），沿用内部 `internalError(reply, err)` 与 `errorSchema`。全部标记 `tags: ["config"]`。GET 不需要 auth 之外的额外校验（与 /config/providers 一致）。

### 4.4 客户端

`ExtensionsTab({ onError })`（SettingsPanel.tsx 内新增组件，与 ProvidersTab 同文件同风格）：

```tsx
function ExtensionsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [listing, setListing] = useState<PackagesListing | undefined>(undefined);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");  // 默认 User
  const [busy, setBusy] = useState(false);  // 安装/卸载共用
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const refresh = async () => { /* getExtensions() → setListing */ };
  useEffect(() => { void refresh(); }, []);
  const install = async () => { /* installExtension(source.trim(), scope) → refresh */ };
  const remove = async (p: InstalledPackage) => { /* confirm + removeExtension → refresh */ };
  // 渲染：安装行 + 卡片列表 + 展开 details（四组资源）
}
```

- 卡片行右侧：Remove 按钮（`confirm`，红系样式同 ProvidersTab）+ 齿轮图标（`Settings2` / `SlidersHorizontal` lucide 图标，`title="Package settings (reserved)"`，点击暂无动作或提示"该包无独立设置页"）
- 展开 `details`：`<summary>{count} resources</summary>` 风格；Tools 组显示 `name`，Skills/Prompts/Themes 组显示相对 `path`；空组不渲染
- 安装成功提示：内联成功文案（如 `Installed pi-subagents — takes effect on new sessions; restart running sessions from General.`），`reloaded` 概念不涉及

api-client（`index.ts`，config 区段，`reloadConfig` 之后）：

```ts
export const getExtensions = () => request("/api/v1/config/extensions", vPackagesListing);
export const installExtension = (source: string, scope: "user"|"project") =>
  request("/api/v1/config/extensions/install", vInstallResult, { method: "POST", body: { source, scope } });
export const removeExtension = (source: string, scope: "user"|"project") =>
  request("/api/v1/config/extensions/remove", vRemoveResult, { method: "POST", body: { source, scope } });
```

### 4.5 tab 注册

- `Tab` union 增加 `"extensions"`（providers 之后）
- `visibleTabs` 非 minimal 数组：`["providers", "extensions", "agent", …]`（minimal 数组**不加** —— 管理面与 Providers/Agent 同级隐藏）
- 渲染分支：`{tab === "extensions" && <ExtensionsTab onError={setError} />}`
- 文件头注释（Phase 8 文档块）补充 Extensions tab 说明

## 5. 错误归一与边界条件

| 场景 | 行为 |
|---|---|
| body 缺字段 / scope 非法 / source 空 | 400 `{error:"validation_error"}` |
| 卸载不存在的 source | 404 `{error:"package_not_found"}` |
| npm 包不存在 / git 克隆失败 | SDK 抛错 → 500 `{error:"agent_error", message}`（消息含 stderr 摘要，sanitize 后返回） |
| untrusted workspace 装 project 包 | SDK `assertProjectTrustedForScope` 抛错 → 403 `{error:"project_untrusted"}`（识别错误消息前缀映射，兜底 500） |
| 安装 >120s | `Promise.race` 超时 → 500 `{error:"agent_error", message:"timed out"}`（npm 子进程可能仍在后台，幂等可重试） |
| 单包 package.json 损坏 | 列表该包 `errors` 字段非空，其余包正常返回 |
| resolve() 整体抛错 | 列表 500（与 discoverExtensionResources 的 errors 数组不同 —— 列表主路径失败直接报错，UI 显示失败 banner） |
| 并发安装同一 source | 不做服务端锁；SDK 内部命令并发由 runWithConcurrency 串行化；重复安装幂等 |
| settings.json 写入失败（磁盘只读） | SDK addSourceToSettings 抛错 → 500，安装失败可重试 |

**安全**：source 是用户输入传给 SDK 子进程（npm/git）—— SDK 用 `spawnCommand` 数组参数形式（非 shell 拼接）执行，无注入面；服务端不二次拼接命令。错误消息 sanitize（剥离可能含密钥的 stderr 段，同 git-runner 的 sanitize 约定）。

## 6. 测试策略

### 6.1 集成测试（tests/test-config.ts 或新 tests/test-extensions.ts）

用**真实本地 fixture 包**而非 npm 网络依赖，保证 CI 稳定：

1. **列表空**：`GET /config/extensions` → 200 `{ packages: [] }`（临时 PI_CONFIG_DIR 无 packages）
2. **本地目录安装**：fixtures 目录建一个最小 pi 包（`package.json` 带 `"pi": { "extensions": [...], "skills": [...] }` + 一个 skill 文件），`POST /config/extensions/install { source: <abs path>, scope: "user" }` → 200；再 `GET` → 列表含该包、`resources.skills` 非空、`type` 正确
3. **幂等**：重复 install 同 source → 200（或明确错误），列表不产生重复条目
4. **卸载**：`POST /config/extensions/remove { source, scope }` → 200 `{removed: true}`；再 GET 空
5. **404**：remove 未知 source → 404 `package_not_found`
6. **400**：install body 缺 scope / source 空 → 400
7. **settings.json 持久化**：安装后读 `PI_CONFIG_DIR/settings.json`，`packages[]` 含该 source（`addSourceToSettings` 已写盘）
8. **卸载清理**：remove 后安装目录不存在（`removeAndPersist` 语义）

> 网络安装（真实 npm 包 / git URL）不做集成测试（CI 不稳定）；手动验证路径见 §6.2。

### 6.2 手动验证清单

- npm 包安装：`install "pi-subagents"` → 列表出现，展开显示 tools/skills
- git URL 安装：`install "git+https://github.com/…"` → 列表 type=git
- 新会话生效：安装后新建 session → `/extensions-commands` 或工具列表出现新工具；旧会话无 → General Restart 后出现
- minimal 模式：MINIMAL_UI=1 时 tab 不出现
- 展开四组资源为空组的隐藏行为

### 6.3 静态检查

`npm run check`（tsc + eslint + prettier）；client 单独 `tsc --noEmit`。

## 7. 明确不做（防范围蔓延）

- 插件更新（update / checkForAvailableUpdates）—— 后续版本
- 包级配置编辑（齿轮入口仅占位）
- 安装进度 SSE 推送
- providers 作为包贡献（pi 模型不支持）
- 临时作用域安装、minimal 模式显示、服务端安装锁
- 不触碰 `settings.json#packages[]` 格式与 SDK 内部实现

## 8. 验证标准（完成定义）

- [ ] `GET /config/extensions` 返回四类资源分组且 top-level 资源不误归包
- [ ] install（npm/git/local）持久化到 settings.json，新会话生效
- [ ] remove 清理安装目录并更新 settings
- [ ] 400/404/403/500 错误路径覆盖（§5 表）
- [ ] §6.1 集成测试全绿 + `npm run check` 通过
- [ ] UI：Providers 风格卡片、展开四组、安装行默认 User、齿轮占位
