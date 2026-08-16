# Tasks — optimize-providers-plugin-apikey

## 1. provider 注册表（providers/registry.ts）

- [x]  新增 `packages/server/src/providers/registry.ts`：`PluginProviderEntry { name, config: ProviderConfigInput, package: string }`、`PluginProviderRegistry`（Map，`register(name, config, package)` / `list()` / `get(name)` / `isRegistered(name)` / `clear()`）
- [x]  新增 `capturePluginProviders({ cwd, agentDir, configuredPaths })`：后台 fire-and-forget 调 `discoverAndLoadExtensions(configuredPaths, cwd, agentDir, eventBus?)`，从 `result.runtime.pendingProviderRegistrations` 读 `{name, config, extensionPath}` 填充注册表；`pendingNativeProviderRegistrations` 仅标记存在（via 包名，不展开 config）
- [x]  包名解析：从 `extensionPath` 解析包名（`node_modules/<pkg>/…` 或 `agentDir/extensions/<pkg>.pi-extension/…`），`Extension.sourceInfo` 兜底；失败回退 `"extension"`
- [x]  捕获错误隔离：加载 errors 记入注册表状态（`errors: {path, error}[]`），单个扩展失败不影响其他；注册表导出 `getErrors()` 供列表带出

## 2. 模型刷新（providers/refresh.ts）

- [x]  新增 `refreshPluginProvider(name)`：`ModelRuntime.create({ authPath: AUTH_FILE(), modelsPath: MODELS_FILE(), modelsStore: true, modelRefreshTimeoutMs })` → `runtime.registerProvider(name, config)` → `runtime.refresh({ providers: [name] })` → 返回该 provider 模型列表
- [x]  未注册 provider → 抛 `PluginProviderNotFoundError`（路由映射 404）；刷新失败/超时 → 结构化错误（含消息），不动已有 models-store 数据
- [x]  native Provider 注册（无 ProviderConfigInput 形态）刷新路径：验证 `getRegisteredProviderConfig` 覆盖与否，不覆盖则标记「仅展示不可刷新」

## 3. config-manager 集成

- [x]  `liveModelRuntime()` / `liveProvidersListing()` 合并注册表：插件 provider 标注 `via <包名>`、补模型计数；注册表有但 models-store 无模型的 provider 以空模型数组列出；`HIDE_BUILTIN_PROVIDERS` 只过滤 models.json 键
- [x]  `liveProvidersListing()` 带出注册表 `ready`/`errors`（注册表未就绪 → pending 态标识）

## 4. REST 端点（routes/config.ts）

- [x]  `GET /config/providers` 响应 schema 扩展（`via`/`package`/`ready`/`errors` 字段，`additionalProperties` 兼容）
- [x]  新增 `POST /config/providers/:provider/refresh`：调 `refreshPluginProvider`，成功返回模型列表；`not_found` 404 / `agent_error` 500（OpenAPI 注册于 index.ts 自动挂载）
- [x]  key 管理不动（复用现有 `PUT/DELETE /config/auth/:provider`，Q2 决策）

## 5. compat 声明（extensions-settings-compat）

- [x]  新增 `litellm` 声明：file `settings.json`、`litellm` 块（baseUrl/headers 标量字段 + providers 别名区提示 Raw）
- [x]  新增 `pi-provider-omniroute` 声明：file `settings.json`、`pi-provider-omniroute` 块（baseUrl 字符串、search.provider/fetch.provider 枚举下拉）
- [x]  保存走 plugin-config PUT（部分更新保留未知键，settings.json 其他键不动）；测试断言 settings.json 无关键保留

## 6. api-client（client/src/lib/api-client）

- [x]  新增 `refreshPluginProvider(provider)` → `POST /api/v1/config/providers/:provider/refresh`
- [x]  类型：`ProvidersListing`/`ProviderListing` 补 `via?`/`package?`/`ready`/`errors` 字段

## 7. UI（SettingsPanel.tsx ProvidersTab + PluginConfigModal）

- [x]  ProvidersTab 插件 provider 卡片：`via <包名>` 徽标 + 模型计数 + 「刷新模型」按钮（loading 态、错误 banner 卡片级提示不崩列表）+ pending 态（注册表未就绪）
- [x]  插件 provider 卡片齿轮入口 → PluginConfigModal 打开 settings.json 块表单（litellm / pi-provider-omniroute 声明）
- [x]  无模型插件 provider 显示「未发现模型，点击刷新」空态

## 8. 测试（tests/test-providers.ts）

- [x]  注册捕获：临时扩展（agentDir/extensions/<pkg>.pi-extension）注册 provider → 注册表含 `{name, config, package}`；重复注册覆盖
- [x]  独立开关：`PLUGIN_CONFIG_CAPTURE=false` 时注册表仍工作（声明捕获照常）
- [x]  列表合并：`GET /config/providers` 含插件 provider（via 标注、模型计数、无模型空数组）
- [x]  刷新：已注册 provider 刷新返回模型且 models-store 持久化（二次 GET 可见）；未注册 → 404；刷新失败（坏 baseUrl）→ 结构化错误、已有数据不变
- [x]  坏扩展隔离：损坏扩展不阻断其他 provider 注册与列表
- [x]  compat 声明：litellm/omniroute 声明可加载、表单保存保留 settings.json 无关键

## 9. 文档与全量验证

- [x]  docs/agent/api.md（providers refresh 端点、providers 列表扩展）、docs/agent/architecture.md（providers 模块数据流）、docs/agent/config.md（无新 env；若有超时配置则记录）
- [x]  全量验证：`npm run check`、`npm run test:ci`、`scripts/run-tests.sh --only providers,plugin-config,config,extensions`
- [x]  tasks.md 全部勾选、openspec validate 通过、提交
