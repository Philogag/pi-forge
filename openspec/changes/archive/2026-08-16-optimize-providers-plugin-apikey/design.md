## Context

pi-forge 的 Providers 设置页（`SettingsPanel.tsx` ProvidersTab）通过 `GET /config/providers` 展示 provider 与模型，数据来自 `config-manager.ts` 的 `liveModelRegistry()`——它每次调用新建 `ModelRuntime.create({authPath, modelsPath})`，**不含扩展注册的 provider**。由插件（pi-provider-litellm、pi-provider-omniroute 等）通过 `pi.registerProvider(name, config)` 注册的 provider，仅当模型被缓存进 models-store.json 后才以裸 provider 名出现在列表中：无来源标注、无 key 语义、无模型刷新、无配置表单。用户在浏览器无法发现、配置或刷新插件 provider。

SDK（@earendil-works/pi-coding-agent 0.84.2）关键能力：
- `ExtensionRuntimeState.pendingProviderRegistrations: Array<{name, config: ProviderConfig, extensionPath}>`（dist/core/extensions/types.d.ts:1171）——扩展加载期间（runner.bindCore 前）的 `registerProvider` 调用排入该公开队列；pi-forge 无 runner、从不 bindCore，队列稳定可读。
- `loadExtensionsCached(paths, cwd, eventBus?, runtime?)` / `discoverAndLoadExtensions(configuredPaths, cwd, agentDir?, eventBus?)` → `LoadExtensionsResult{extensions, errors, runtime}`。
- `ModelRegistry`（同步 facade）：`registerProvider(name, config)` / `refresh(options)` / `getRegisteredProviderIds()` / `getRegisteredProviderConfig(name)`。
- `ModelRuntime.create({authPath, modelsPath, modelsStorePath?, modelRefreshTimeoutMs?, …})`：凭证、模型、models-store 持久化一条龙；`registerProvider` 后 `refresh()` 走 `refreshModels` 回调或标准发现，结果写 models-store。
- `ProviderConfigInput{name?, baseUrl?, apiKey?, headers?, oauth?, models?, refreshModels?(context) → Promise<models[]>}`。

参考插件模式：litellm（默认 provider `litellm` + settings.json `litellm.providers` 别名；auth.json 存 key；模型 `/model/info`→`/v1/models` 发现入 models-store）、omniroute（provider `omniroute`；settings.json `pi-provider-omniroute` 块 {baseUrl, search:{provider}, fetch:{provider}}；/v1/models lazy refresh）。

约束：无新依赖；AGENTS.md 约定（命名导出、config.ts 集中 env、路由仅注册于 index.ts、原子写、结构化错误）；不扰 AgentSession 运行时；插件配置兼容框架（plugin-config + extensions-settings-compat）已归档可复用。

## Goals / Non-Goals

**Goals:**
- 插件注册的 provider 在 Providers 界面可见：来源标注（`via <包名>`）、key 管理、模型列表与计数
- 浏览器按需触发插件 provider 模型发现/刷新，结果持久化到 models-store
- 插件 provider 的 settings.json 专属块配置表单化（复用 plugin-config 兼容框架）
- 捕获机制独立于 `PLUGIN_CONFIG_CAPTURE` 开关；单个坏扩展不影响其他 provider

**Non-Goals:**
- 不做 OAuth/SSO 登录流（key 一律直接写 auth.json）
- 不修改 AgentSession 运行时的扩展加载（会话内 provider 注册保持 SDK 默认）
- 不做 provider 的启停/排序/默认切换
- 不实现 SDK login 交互（浏览器无 TUI /login 等价）

## Decisions

### D1：注册捕获 = 读 `pendingProviderRegistrations` 队列（非 Proxy hook）
- **选择**：扩展加载后读 `result.runtime.pendingProviderRegistrations`，取 `{name, config, extensionPath}` 构造注册表 `{name → {config, package}}`。
- **理由**：该队列是公开字段，加载期（bindCore 前）稳定；pi-forge 无 runner、不 bindCore，队列不会被消费；零侵入、无 Proxy 包装风险。
- **已考虑 alternative**：Proxy 包装 runtime hook `registerProvider`——接口面大（ExtensionActions 全量）、易碎；native Provider 重载走 `pendingNativeProviderRegistrations`，队列同样可读。

### D2：独立扩展加载（providers 注册表与 capture 解耦）
- **选择**：providers/registry 启动后台 fire-and-forget 调 `discoverAndLoadExtensions(configuredPaths, cwd, config.piConfigDir, eventBus?)`，从结果读注册队列与 errors；`PLUGIN_CONFIG_CAPTURE` 不影响它。
- **理由**：规格要求注册表独立于 capture 开关；不动已归档的 capture 流程（回归风险小）；jiti 缓存使二次加载轻量。
- **已考虑 alternative**：把扩展加载抽成共享基础设施、capture 与 registry 共用一次加载——更省资源，但需重构已归档代码并新增回归面；列为后续候选（见 Migration Plan）。

### D3：刷新 = 一次性 ModelRuntime + registerProvider + refresh()
- **选择**：`POST /config/providers/:provider/refresh` → `ModelRuntime.create({authPath: AUTH_FILE(), modelsPath: MODELS_FILE(), modelsStore: true, modelRefreshTimeoutMs})` → `runtime.registerProvider(name, config)` → `runtime.refresh({providers:[name]})` → 从 runtime 读该 provider 模型返回；models-store 由 SDK 写入持久化。
- **理由**：SDK 的 `refresh()` 自动走 `refreshModels` 回调（litellm /model/info）或标准发现回退（/v1/models），与 /model 等价；models-store 与 AgentSession 共享路径，刷新后全 UI 可见。
- **已考虑 alternative**：pi-forge 自实现 /v1/models 发现——丢 refreshModels 语义、难覆盖 env/settings baseUrl 解析；SDK 组合（composeModelProvider 三层）本就处理这些。

### D4：key 管理复用 `writeApiKey`（直接写 auth.json）
- **选择**：不改 key 写入路径；`PUT/DELETE /config/auth/:provider` 原样工作（auth[provider] = {type:"api_key", key}）。扩展 ApiKeyAuth 从 auth.json 读，对 litellm/omniroute 有效。
- **理由**：用户 Q2 决策；两参考插件 /login 的落点就是 auth.json。
- **已考虑 alternative**：SDK `ModelRuntime.login(providerId, "api-key", {apiKey})`——需要进程级 runtime 实例与 interaction 回调，浏览器场景复杂化且无额外收益。

### D5：列表合并与来源标注
- **选择**：`liveProvidersListing()` 合并 `ModelRegistry.getAll()`（models-store 缓存模型）与注册表：注册表存在的 provider 标注 `via <包名>`、补模型计数；注册表有但 models-store 无模型的 provider 也列出（空模型数组）。HIDE_BUILTIN_PROVIDERS 逻辑只过滤 models.json 键，不动插件 provider。
- **理由**：规格 R「无模型插件 provider 仍列出」；来源标注让用户区分内置/插件/缓存。

### D6：配置表单化复用 compat 声明
- **选择**：extensions-settings-compat 增补两个声明：`litellm`（file "settings.json"，`litellm` 块：baseUrl/headers 标量 + providers 别名区提示 Raw）、`pi-provider-omniroute`（file "settings.json"，`pi-provider-omniroute` 块：baseUrl 字符串、search.provider/fetch.provider 枚举下拉）。保存走 plugin-config 的 PUT（部分更新保留未知键 ✓，settings.json 其他键不动）。
- **理由**：用户 Q3 决策；复用已归档的声明/表单/REST/原子写，无新增 UI 体系。

### D7：UI 增强
- **选择**：ProvidersTab 插件 provider 卡片增加 `via <包名>` 徽标、模型计数、「刷新模型」按钮（loading 态）、齿轮入口（PluginConfigModal 打开 settings.json 块表单）；刷新失败卡片级错误提示（banner），不崩列表；注册表未就绪显示 pending 态（可刷新兜底）。
- **理由**：与现有卡片交互一致；错误隔离。

## Risks / Trade-offs

- [Risk] 扩展被加载两次（capture + providers registry）→ Mitigation: jiti 缓存使二次加载轻量；扩展 register 副作用（事件订阅/tool 记录）幂等；若出现实测副作用问题，升级为共享加载（见 Migration）。
- [Risk] models-store 并发写（refresh 与 AgentSession 运行时同时写）→ Mitigation: SDK models-store 写入为覆盖式持久化，幂等；refresh 与列表读取同路径，冲突窗口小；接受最后写入者胜。
- [Risk] `pendingProviderRegistrations` 在 bindCore 后被消费——pi-forge 从不 bindCore → 无此路径；若未来引入 runner 绑定需迁移。
- [Risk] 刷新失败/超时 → Mitigation: 结构化错误（404 未注册 / 400 校验 / 500 agent_error + 消息）；不动已有 models-store 数据；卡片错误提示。
- [Risk] 别名 provider（litellm.providers 配置的 litellm-anthropic 等）依赖 settings.json 配置存在才注册 → Mitigation: 注册表捕获的就是注册后的结果（配置后再注册自然可见）；配置表单保存后需重载扩展或重启生效（文档说明）。
- [Trade-off] 独立加载 vs 共享加载：v1 独立（简单、隔离、回归小）→ 接受双加载成本；共享重构为后续候选。
- [Trade-off] 不实现 SDK login：env fallback（LITELLM_API_KEY 等）状态不展示在 UI → 接受（本期范围外；auth.json 写入即可用）。

## Migration Plan

1. 实现顺序：providers/registry → providers/refresh → config-manager 合并 → routes → compat 声明 → api-client → SettingsPanel。
2. 验证：`npm run build`；新增 tests/test-providers.ts（注册捕获/列表合并/刷新/错误/独立开关）；`scripts/run-tests.sh --only providers,plugin-config,config,extensions`。
3. 手工验收：安装 pi-provider-omniroute → 重启 → ProvidersTab 见 `omniroute · via pi-provider-omniroute` → 填 key（写 auth.json）→ 「刷新模型」→ 模型出现并持久化；settings.json 齿轮 → omniroute 块表单 → baseUrl 保存 → 文件保留 search/fetch 键。
4. 回滚：端点/UI 均为新增，移除 providers/ 模块与相关代码即可；无数据迁移。
5. 后续候选（不进本期）：扩展加载共享基础设施（capture+registry 一次加载）；env fallback 状态展示；native Provider 注册的完整刷新路径。

## Open Questions

1. 包名解析：`extensionPath`（node_modules/<pkg>/… 或 agentDir/extensions/<pkg>.pi-extension/…）与 `Extension.sourceInfo` 的取包名优先级——design 按 extensionPath 段解析，sourceInfo 兜底；实现时以实测两插件为准。
2. native Provider 注册（`pendingNativeProviderRegistrations`）本期仅标记存在（via 包名），刷新路径依赖 `getRegisteredProviderConfig` 是否覆盖 Provider 形态——实现时验证，若不覆盖则该类 provider 仅展示不可刷新。
3. `ModelRuntime.create` 的 `modelsStore` 选项语义（true vs modelsStorePath）——refresh 复用 `MODELS_FILE()` 路径，实现时确认不覆盖 AgentSession 的 store 锁。
