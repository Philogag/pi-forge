<!--
superpowers:brainstorming 产出的原始捕获。

本文件原样捕捉 brainstorming skill 的产出，不强制结构。
Skill 的自然产出通常是 decision log 格式（背景 → 决策链 Q1-Qn → 设计取舍），
但依对话内容可能有不同的组织方式。

design.md 从本文件萃取并重新整理为结构化设计文档。

不要将本文件的内容复制到 design.md — design.md 是独立的重组产物，
两者互补但不重叠。
-->

# brainstorm — optimize-providers-plugin-apikey

## 背景

用户需求（原文）：

> 优化 Providers 界面，自动感知并支持由插件提供的 apikey provider，比如 https://github.com/balcsida/pi-provider-litellm 或 https://github.com/Philogag/pi-provider-omniroute

分类：**architectural**（新子系统 + SDK 接口集成）。

## 探索发现

### pi-forge 现状

- `packages/client/src/components/SettingsPanel.tsx` **ProvidersTab**（526 行起）：`GET /config/providers` + `GET /config/auth`（readAuthSummary），卡片显示 provider 名 + key set/no key 徽标 + `via {source}`；Add/Replace key（setApiKey）/Remove（removeApiKey），password input 粘贴 key。
- `packages/server/src/config-manager.ts`：
  - `ProvidersListing`（126 行）`{providers:[{provider,models:[{id,name,contextWindow,maxTokens,reasoning,input,hasAuth,supportedThinkingLevels}]}]}`
  - `liveModelRegistry()`（365 行）= `new ModelRegistry(await liveModelRuntime())`
  - `liveModelRuntime()`（353 行）= `ModelRuntime.create({authPath:AUTH_FILE(), modelsPath:MODELS_FILE()})` —— **每次调用新建、不含扩展注册的 provider**
  - `liveProvidersListing()`（492 行）用 `registry.getAll()` 按 provider 分组（HIDE_BUILTIN_PROVIDERS 时只留 models.json 键）
  - `readAuthSummary()`（370 行）只列 auth.json 现有 provider（`configured:true, source:"stored"`）
  - `writeApiKey(provider,key)` 写 `auth[provider]={type:"api_key",key}`；`removeApiKey` 删键（`AuthProviderNotFoundError`→404）
- 路由 `packages/server/src/routes/config.ts`：`GET /config/auth`（authSummarySchema 163 行）、`PUT /config/auth/:provider`（body `{apiKey}`）、`DELETE /config/auth/:provider`。

**核心缺口**：`liveModelRegistry()` 每次新建、不含扩展注册的 provider；扩展 provider 仅当模型已缓存进 models-store.json 时才以裸 provider 名出现，无来源标注、无刷新、无配置表单。

### SDK provider API（@earendil-works/pi-coding-agent 0.84.2，dist/core/）

- `provider-composer.d.ts`：`ProviderConfigInput{name?,baseUrl?,apiKey?,api?,streamSimple?,headers?,authHeader?,oauth?:ExtensionOAuthConfig{name,isSubscription?,login(callbacks)→OAuthCredentials,refreshToken(credentials,signal),getApiKey,modifyModels?},models?:[...],refreshModels?(context:RefreshModelsContext)→Promise<models[]>}`；`AuthStatus{configured,source?:"stored"|"runtime"|"environment"|"fallback"|"models_json_key"|"models_json_command",label?}`；`composeModelProvider(providerId,base,modelConfig,extension)` 三层组合。
- `model-registry.d.ts`（ModelRegistry 同步 facade）：`getAll()/getAvailable()/find()/hasConfiguredAuth(model)/getProviderAuthStatus(provider)/getProvider()/getProviderDisplayName()/getRegisteredProviderConfig(providerName)→ProviderConfigInput|undefined/getRegisteredProviderIds():readonly string[]/registerProvider(name,config)/unregisterProvider/refresh(options)`。
- `model-runtime.d.ts`（ModelRuntime implements Models）：`static create({credentials?,authPath?,modelsPath?,modelsStore?,modelsStorePath?,allowModelNetwork?,modelRefreshTimeoutMs?,catalogBaseUrl?,signal?,refreshOnCreate?})`；`getProviders()/getModels()/getProviderAuthStatus()/setRuntimeApiKey()/removeRuntimeApiKey()/login(providerId,type,interaction)/logout()/listCredentials()/registerProvider()/unregisterProvider()`。
- `extensions/types.d.ts`（扩展 PiApi 面）：`pi.registerProvider(name:string,config:ProviderConfig)/pi.registerProvider(provider:Provider)/pi.unregisterProvider(name)`；`pi.registerTool(ToolDefinition)`；`runner.d.ts:102 registerProvider?`。

### 参考插件机制

- **pi-provider-litellm**（balcsida v2.0.6，Pi 0.81+）：默认 provider `litellm` + settings.json `litellm.providers` 别名（每个别名独立 provider 名，字段 baseUrl/apiKey/headers/displayName/enabled）；`/login litellm` api-key flow（存 `~/.pi/agent/auth.json`）+ SSO；env `LITELLM_BASE_URL/LITELLM_API_KEY/LITELLM_API_KEY_HELPER(!command)/LITELLM_HEADERS` fallback；模型发现 `/model/info`→`/v1/models` fallback，注册进 Pi 模型注册表，models-store.json 持久化；`/model` 触发刷新；settings.json `litellm` 块还有 skills:{enabled}/mcp:{enabled}。
- **pi-provider-omniroute**（Philogag v0.1.0）：provider `omniroute`；`/login omniroute` 标准 api-key flow（envApiKeyAuth 只问 key）→ auth.json；`OMNIROUTE_API_KEY` env fallback；baseUrl 解析优先 settings.json `pi-provider-omniroute` 块 {baseUrl,search:{provider},fetch:{provider}} → env → 默认 http://localhost:20128/v1；模型自动导入 GET /v1/models + lazy refresh（不阻塞加载）；工具 omniroute_web_search/omniroute_web_fetch；`/omniroute-settings` TUI 菜单。

两插件共同模式：registerProvider 注册 → 凭证 auth.json（api_key）→ 模型进 Pi models-store → settings.json 专属块配置。

## 决策链

### Q1 感知范围 → 「含模型发现/刷新」
provider 级感知（显示已安装扩展注册的 provider，标注来源 `via <包名>`，即使暂无模型）+ UI 触发模型发现/刷新（等价 /model 的 refreshModels）。

### Q2 key 写入 → 「直接写 auth.json」
沿用现有 `writeApiKey` 直接写 `auth[provider]={type:"api_key",key}`，不调 SDK login flow。扩展 ApiKeyAuth 从 auth.json 读，对 litellm/omniroute 均有效。

### Q3 配置管理 → 「纳入兼容框架」
在 extensions-settings-compat 注册 settings.json 块声明（litellm 块、pi-provider-omniroute 块），复用插件配置兼容框架的表单/原子写/REST（部分更新保留未知键 ✓）。

### Q4 刷新机制 → 「按需按钮 + 持久化」
每个插件 provider 卡片「刷新模型」按钮：路由触发该 provider 模型重新发现（扩展提供 refreshModels 则 SDK 调用，否则 SDK 回退 /v1/models），结果写 models-store 持久化；卡片显示模型数。

### 架构方案 → 「方案 A 进程级注册表」
- **A 注册表（采纳）**：新增 `providers/` 模块，扩展加载时捕获 `api.registerProvider(name, config)` 到进程级注册表（`{name → {config, package}}`），列表合并、刷新直通 SDK `registerProvider+refresh()`。改动集中、不扰会话 runtime。
- B 共享 ModelRuntime：进程级 runtime 直通扩展注册；更贴 SDK 但生命周期/并发复杂，多 runtime 注册不互通。
- C 最小捕获：只捕元数据、自实现 /v1/models；丢 refreshModels 语义、难覆盖 env/settings baseUrl。

## 设计概要（方案 A）

**新增 `packages/server/src/providers/`**
- `registry.ts`：捕获 `api.registerProvider` → `PluginProviderRegistry`（`{name → {config: ProviderConfigInput, package}}`）；独立于 PLUGIN_CONFIG_CAPTURE 开关、启动后台 fire-and-forget。
- `refresh.ts`：`refreshPluginProvider(name)` → `ModelRuntime.create({authPath, modelsPath, modelsStore…})` + `registerProvider(name, config)` + `refresh({providers:[name]})` → 写 models-store。
- 技术风险：`loadExtensionsCached(paths, cwd, eventBus?, runtime?)` 的 runtime 注入能否 hook `api.registerProvider` —— design 阶段验证；退路为加载后探测 `ModelRegistry.getRegisteredProviderIds()` 或扩展导出元数据。

**REST（routes/config.ts）**
- `GET /config/providers`（现有）：`liveProvidersListing()` 合并注册表 → 插件 provider 带 `via <包名>` + 模型计数。
- `POST /config/providers/:provider/refresh`（新）：按需刷新单 provider，返回模型列表 + 写 models-store。
- key 管理：复用 `PUT/DELETE /config/auth/:provider`（Q2）。
- 配置：复用 plugin-config REST；compat 增补 litellm（`litellm` 块）与 omniroute（`pi-provider-omniroute` 块：baseUrl/search.provider/fetch.provider 枚举）声明。

**UI（ProvidersTab + PluginConfigModal）**
- 插件 provider 卡片：`via <包名>` 徽标 + 模型计数 + 「刷新模型」按钮 + key 管理（现有）+ 齿轮（settings.json 块表单）。
- 刷新失败 → 卡片错误提示不崩列表；无模型 → 「未发现模型，点击刷新」；注册表未就绪 → pending 态。

**边界**
- refresh 超时（`modelRefreshTimeoutMs`）；坏扩展注册失败不影响内置 provider；启动竞态由刷新按钮兜底；settings.json 块不存在 → 表单默认/空。

## 开放问题（design 阶段验证）

1. SDK `loadExtensionsCached` 的 runtime 注入可行性（hook registerProvider 的捕获路径）。
2. 扩展注册的 provider 名与 auth.json 键、models-store 键的一致关系（别名 provider 如 litellm-anthropic 的 key 语义）。
3. models-store 持久化与 liveProvidersListing 现有 HIDE_BUILTIN_PROVIDERS 逻辑的交互。
