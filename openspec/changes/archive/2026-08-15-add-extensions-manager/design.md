# Design: Settings Extensions 管理页

## Context

现状（参见 proposal.md - Why）：pi 的插件安装单元是 **package**（npm/git，持久化于 `settings.json#packages[]`，SDK `DefaultPackageManager` 管理）。pi-forge 已有只读镜像 `packages/server/src/extensions-discovery.ts`：`discoverExtensionResources(cwd)` 通过 `SettingsManager.create(cwd, config.piConfigDir)` + `new DefaultPackageManager({ cwd, agentDir, settingsManager })` + `resolve()` 枚举包贡献的 tools/skills，供 Settings → Tools/Skills 与 allowlist 使用。但没有安装/卸载/枚举包的管理端点，UI 也没有统一入口。

SDK `DefaultPackageManager` 公开 API（`dist/core/package-manager.d.ts`）：
- `listConfiguredPackages(): ConfiguredPackage[]`（`{source, scope: "user"|"project", filtered, installedPath?}`）
- `resolve(onMissing?)` → `ResolvedPaths`（`{extensions, skills, prompts, themes}`，每项 `ResolvedResource{path, enabled, metadata:{source, scope, origin, baseDir?}}`）
- `install(source, {local?})` / `installAndPersist(source, {local?})` — 装但不持久化 / 装并写入 `settings.json#packages[]`
- `remove(source, {local?})` / `removeAndPersist(source, {local?}): Promise<boolean>`
- `update(source?)` / `checkForAvailableUpdates(): Promise<PackageUpdate[]>`（`{source, displayName, type: npm|git, scope}`）
- `setProgressCallback(cb)` — `ProgressEvent{type: start|progress|complete|error, action, source, message?}`
- `addSourceToSettings` / `removeSourceFromSettings` — 纯设置编辑

pi 包清单（`package.json#pi`，`PiManifest`）：**仅** `extensions / skills / prompts / themes`，**无 providers**（自定义 provider 走 `models.json`）。`ResolvedPaths` 同样只含这四类。

## Goals / Non-Goals

**Goals:**
- 提供 packages/extensions 的管理 REST 面：枚举（含每包贡献资源与作用域）、安装（npm/git，user/project 作用域）、卸载
- Settings 新增 Extensions tab，布局仿 Providers 页（卡片行 + 展开 details），展开列举 tools/skills/prompts/themes 四组资源
- 新安装的包对新会话生效；运行中会话不自动 reload，用户可到 Settings → General 手动 Restart（复用 /config/reload）
- 非 minimal 模式下可见（与 Providers/Agent 一致，属部署级配置面）

**Non-Goals:**
- 不实现 providers 作为包贡献（pi 模型不支持；自定义 provider 仍走 models.json）
- 不做包级 settings 配置编辑（右上角齿轮入口本变更不渲染，后续变更可加）
- 不做安装进度的 SSE 流式推送（同步等待 + 超时；`setProgressCallback` 预留）
- 不改动 `settings.json#packages[]` 格式（SDK 全权管理）
- 不支持临时作用域（temporary）安装
- 不包含插件更新能力（`update` / `checkForAvailableUpdates` 本期排除，后续可加）
- 安装/卸载后**不**自动 reload 运行中会话（仅新会话生效）

## Decisions

**D1. 新模块 `extensions-manager.ts` 包装 `DefaultPackageManager`（单例工厂）**
与 `extensions-discovery.ts` 同构：每次操作时 `SettingsManager.create(workspacePath, config.piConfigDir)` → `await settingsManager.reload?.()` → `new DefaultPackageManager({ cwd, agentDir, settingsManager })`。理由：SettingsManager 非线程安全、SDK 会在构造时读盘，函数内新建保证每次读到最新 `packages[]`。备选：模块级单例长期持有 —— 拒绝，配置随时可能被 CLI/其它进程改动。

**D2. REST 面挂在 `/api/v1/config/extensions`（config.ts）**
- `GET /config/extensions` → 200 `{ packages: [{ source, type: "npm"|"git", scope, installedPath?, version?, description?, resources: { tools: [{name, description}], skills: [{path}], prompts: [{path}], themes: [{path}] } }] }`
  - 数据来源：`listConfiguredPackages()` + `resolve()`（按 `metadata.source` 分组四类资源，`origin === "package"` 才归包）+ 读 `installedPath/package.json` 取 name/version/description
  - 单包失败不整体失败（镜像 `discoverExtensionResources` 的 errors 语义）
- `POST /config/extensions/install` body `{ source: string, scope: "user"|"project" }` → 200 `{ source, scope }`；`scope==="project"` ↔ SDK `{local: true}`；**不**触发 reload
- `POST /config/extensions/remove` body `{ source: string, scope: "user"|"project" }` → 200 `{ removed: true }`（`removeAndPersist` 返回 false → 404 `package_not_found`）；**不**触发 reload
- 错误：参数非法 → 400；包不存在 → 404 `package_not_found`；SDK 抛错（如 untrusted project）→ 400/403 归一；安装挂起 → `Promise.race` 120s 超时（npm install 可能久于 reload 的 30s）→ 500 `agent_error`

**D3. 安装/卸载后不自动 reload（仅新会话生效）**
运行中会话的扩展在 session start 时由 SDK `DefaultResourceLoader` 加载；安装/卸载不改动已加载的运行时。设计选择：**不**调用 `reloadAllLiveSessions()` —— 不打断任何进行中的 agent run（用户决策）。新包对新创建会话即时生效；运行中会话需用户在 Settings → General 手动 Restart（即 /config/reload，已有入口）。UI 安装成功提示文案说明这一点。备选：自动 reload —— 拒绝，用户明确选择不中断 run。

**D4. UI 布局仿 ProvidersTab**
`ExtensionsTab({ onError })`：
- 顶部说明段 + 安装行：source 输入框（npm 包名 / name@version / git URL / local path，SDK 自行解析）+ scope 选择（默认 **User**，可切 Project）+ Install 按钮（busy 禁用）
- 包卡片：`rounded border border-neutral-800 bg-neutral-900/40 p-3`；行内 包名（font-mono）+ type 徽标（npm/git）+ scope 徽标 + 版本；右侧操作按钮：Remove（confirm）；右上角齿轮图标（预留 settings 入口，`title` 说明）
- 展开 `<details>`：四组资源（Tools / Skills / Prompts / Themes），空组隐藏；每组列出条目（tools 显示 name，其余显示相对路径）
- 空列表 → "No packages installed."；加载 → "Loading extensions…"；错误走面板顶部 banner（onError）
- 请求期间按钮 pending；Remove 后刷新列表
- tab 注册：`Tab` union + `visibleTabs`（非 minimal 数组，插在 providers 之后）+ `{tab === "extensions" && <ExtensionsTab onError={setError} />}`

**D5. api-client 新增 3 个方法**
`getExtensions()` / `installExtension(source, scope)` / `removeExtension(source, scope)`，内联 validator；复用 `request(url, validator, {method, body})` 模式。

**D6. 作用域语义与去重**
`local: true` ↔ project 作用域（workspace `.pi/packages/` + 项目级 packages 设置），`false` ↔ user 全局（`~/.pi/agent`）。SDK `dedupePackages` 保证同 identity 项目优先 —— 列表按作用域展示即可，不去重逻辑复制到服务端。安装前由 SDK `assertProjectTrustedForScope` 校验项目信任，未信任 → 归一 403。

**D7. providers 不实现为包贡献**
用户请求中的 "skill/prompts/tool/providers 等" 里的 providers 在 pi 包模型中不存在。展开信息如实展示四类资源；若未来 pi 支持包级 provider 再扩展。文档与 UI 文案（"贡献资源"而非"providers"）已对齐。

## Risks / Trade-offs

- [npm install / git clone 慢或失败] → 120s 超时 + 明确错误消息；`installAndPersist` 失败时 `settings.json#packages[]` 不回写（SDK 先装后持久化），用户可重试
- [新装包对运行中会话不生效，用户误以为安装失败] → 安装成功提示文案明示"新会话生效，运行中会话请到 General 页 Restart"
- [单包损坏导致列表整体失败] → 列表枚举逐包容错（errors 数组语义，同 `discoverExtensionResources`）
- [并发安装同一包] → SDK 内部 npm/git 命令并发由 `runWithConcurrency` 管理；服务端不额外加锁（单用户场景可接受）
- [minimal 模式暴露管理面] → tab 隐藏（与 Providers 一致）；服务端端点不额外做 minimal 门禁（与 `/config/providers` 一致）
- [untrusted workspace 装 project 包] → SDK 抛错 → 403 `project_untrusted`，UI 提示先信任项目

## Migration Plan

- 部署：同仓单 PR，`npm run build` 后重启即可；无数据迁移（`settings.json#packages[]` 格式由 SDK 管理，新旧版本兼容）
- 回滚：还原提交重启；已装包留在 `packages[]` 中（不回滚时不清除），必要时用户在 UI 中 Remove
- 测试：`tests/test-config.ts` 增补 — GET 空列表、安装后列表含包及资源分组、重复安装幂等、未知 source 卸载 → 404、参数非法 → 400

## Open Questions

无（D2 的 UI 安装输入接受完整 source 字符串，SDK 自行解析 npm spec / git URL / local path，无需用户预定义格式）。
