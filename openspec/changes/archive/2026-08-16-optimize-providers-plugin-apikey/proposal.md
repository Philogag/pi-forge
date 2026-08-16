## Why

Providers 设置页不感知由插件提供的 apikey provider（如 pi-provider-litellm、pi-provider-omniroute）：`liveModelRegistry()` 每次调用新建 `ModelRuntime`，不含扩展注册的 provider，插件模型仅在被缓存进 models-store.json 后以裸 provider 名出现——无来源标注、无 key 语义、无模型刷新、无配置表单。用户在浏览器里无法发现、配置或刷新插件 provider，只能退回 TUI。现在处理：插件配置兼容框架（plugin-config）已落地，settings.json 块表单可复用；SDK 提供 `registerProvider`/`refreshModels`/models-store 持久化能力。收益：插件 provider 在 Providers 界面完整闭环——发现、标注来源、管理 key、表单化配置、按需刷新模型。

## What Changes

**进程级插件 provider 注册表（新增 `packages/server/src/providers/`）**
- From: 扩展注册的 provider 对 Providers 界面不可见（仅 models-store 缓存模型的裸 provider 名）
- To: 扩展加载时捕获 `api.registerProvider(name, config)` 到进程级注册表 `{name → {config, package}}`，列表合并并标注 `via <包名>`；独立于 PLUGIN_CONFIG_CAPTURE 开关
- Impact: non-breaking；config-manager.ts `liveProvidersListing()` 合并注册表

**按需模型刷新（新端点）**
- From: 插件 provider 模型无法在浏览器刷新（等价 /model 不可用）
- To: `POST /config/providers/:provider/refresh` 触发该 provider 模型重新发现（扩展提供 refreshModels 则 SDK 调用，否则 SDK 回退），结果写 models-store 持久化，卡片显示模型计数与错误
- Impact: non-breaking；新增 REST 端点 + api-client 方法

**插件 provider 配置表单化（复用兼容框架）**
- From: litellm/omniroute 的 settings.json 专属块只能在 TUI 或手改文件
- To: extensions-settings-compat 增补声明（`litellm` 块、`pi-provider-omniroute` 块：baseUrl/search/fetch），经 PluginConfigModal 表单编辑，部分更新保留未知键
- Impact: non-breaking；compat 声明新增，UI 齿轮入口复用

**UI 增强（ProvidersTab）**
- From: 插件 provider 卡片无来源标注、无刷新入口、无配置入口
- To: `via <包名>` 徽标 + 模型计数 + 「刷新模型」按钮 + 齿轮（settings.json 块表单）；刷新失败卡片级错误提示，不崩列表
- Impact: non-breaking；前端组件扩展

## Capabilities

### New Capabilities
- `plugin-provider-registry`: 进程级插件 provider 注册表——扩展加载时捕获 `registerProvider`，列表合并、来源标注（via 包名）、注册状态查询
- `plugin-provider-refresh`: 插件 provider 模型按需刷新——REST 端点触发重新发现（refreshModels 或 /v1/models 回退），models-store 持久化
- `plugin-provider-config`: 插件 provider 配置表单化——compat 声明 settings.json 专属块（litellm / pi-provider-omniroute），复用 plugin-config 表单/REST

### Modified Capabilities
（无——openspec/specs/ 下无既有 spec，全部为新增能力）

## Impact

- 新增模块：`packages/server/src/providers/registry.ts`、`refresh.ts`
- 修改：`packages/server/src/config-manager.ts`（liveProvidersListing 合并、注册表集成）、`packages/server/src/routes/config.ts`（refresh 端点、providers schema）、`packages/server/src/extensions-settings-compat/index.ts`（litellm/omniroute 声明）、`packages/client/src/components/SettingsPanel.tsx`（ProvidersTab 卡片）、`packages/client/src/lib/api-client/index.ts`（refresh 方法）
- 无新依赖；依赖 SDK `registerProvider`/`refreshModels`/models-store（已内置）
- 风险：SDK `loadExtensionsCached` runtime 注入 hook 可行性需在 design 验证（退路：加载后探测 `getRegisteredProviderIds()` 或扩展元数据）
