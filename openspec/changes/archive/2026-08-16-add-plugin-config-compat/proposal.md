## Why

pi 生态已有社区标准的插件设置系统 `@juanibiapina/pi-extension-settings`：扩展在加载时通过事件总线发出 `pi-extension-settings:register` 注册设置（`SettingDefinition{id, label, description?, defaultValue, values?, options?}`），持久化到 `~/.pi/agent/settings-extensions.json`（全局）与 `.pi/settings-extensions.json`（项目级），并在 pi TUI 提供 `/extension-settings` 交互界面。但 pi-forge 是**浏览器 UI**——用户无法在浏览器中查看或编辑这些插件配置文件，只能切回终端用 TUI 命令。此外，部分不走 `pi-extension-settings` 的插件在 `PI_CONFIG_DIR` 拥有自己的配置文件（任意 JSON 结构），pi-forge 对它们一无所知。上一变更 `add-extensions-manager` 已明确把"包级 settings 配置编辑"列为 Non-Goal（齿轮入口预留）——本次变更补上这一块：让 pi-forge 成为插件配置的**浏览器端编辑入口**，且与 `pi-extension-settings` 生态**完全兼容**（读写同一个文件、同一套注册语义）；对不走该生态的插件，在本仓库内提供**注册入口**（compat 文件夹）直接登记表单信息并绑定插件自身的 JSON 配置文件。

## What Changes

- 新增**插件配置兼容框架**：统一的 `ConfigDeclaration` 模型描述一个配置文件的结构（目标文件、字段的展示名/数据位置(JSON path)/类型/限制/描述），前端据此渲染表单
- 新增**两种注册来源**（同一模型、同一 UI）：
  1. **扩展事件捕获**（完全兼容）：服务器进程通过 SDK `loadExtensions()` 加载已安装包的扩展入口，订阅并捕获 `pi-extension-settings:register` 事件 → 自动生成指向 `settings-extensions.json` 的声明。任何已按社区标准注册设置的扩展无需任何改动即可在 pi-forge 中出现
  2. **compat 注册入口**（不走 pi-extension-settings 的插件）：本仓库 `packages/server/src/extensions-settings-compat/` 内直接登记表单信息（字段名/数据位置/类型/限制/描述）并**绑定插件自身的 JSON 配置文件**；本期仅支持 JSON 格式配置文件
- 新增 REST 面 `/api/v1/config/plugin-configs`：列出全部声明（含来源标注、当前值、文件存在性）、单个包声明、保存（表单字段级或全文 raw 两种写入）
- Settings → Extensions 包卡片新增**齿轮入口**（沿用 add-extensions-manager 预留位）：点击打开该包配置表单——标量字段（string/number/boolean/enum）、ordered multi-select、嵌套路径；并提供**全文 raw JSON 直接编辑**兜底，保证任何声明文件都可完整编辑
- 读写目标仅限 `PI_CONFIG_DIR`（`~/.pi/agent/`）内文件；写入走原子写（tmp + rename）；`settings-extensions.json` 严格保持 `pi-extension-settings` 的存储格式与字符串值语义，浏览器编辑与 pi TUI 双向互通
- 不触发会话 reload：扩展设置经 `getSetting()` 运行时读取，改文件即时生效

## Capabilities

### New Capabilities
- `plugin-config`: 插件配置文件结构注册（事件捕获与 compat 手动注册两种来源）、浏览器端表单渲染、raw 全文编辑、`PI_CONFIG_DIR` 内原子读写

### Modified Capabilities
- 无（`openspec/specs/` 当前为空，本变更为纯新增能力）

## Impact

- **Server**: 新模块 `packages/server/src/plugin-config-registry.ts`（双来源合并、缓存、启动后台预加载 init）、`packages/server/src/plugin-config-store.ts`（读取/字段级与 raw 写入、原子写）、`packages/server/src/extensions-settings-compat/`（注册入口，每插件一文件 + index 汇总）；`packages/server/src/index.ts`（启动时异步触发捕获预加载）；`packages/server/src/routes/config.ts`（挂 `/config/plugin-configs` 子面，复用 OpenAPI schema 模式）；`packages/server/src/extensions-manager.ts`（复用包枚举，取扩展入口路径）
- **SDK**: `@earendil-works/pi-coding-agent` 的 `loadExtensions()` / `createExtensionRuntime()`（事件捕获）、`DefaultPackageManager.resolve()`（扩展入口路径）；`jiti`（已随 SDK 依赖存在）
- **Client**: `packages/client/src/components/SettingsPanel.tsx`（ExtensionsTab 齿轮入口 + 新 `PluginConfigModal` 表单/raw 编辑器）、`packages/client/src/lib/api-client/index.ts`（新 API 方法）、复用 `CodeMirrorEditor`（raw JSON 编辑）
- **Tests**: 新 `tests/test-plugin-config.ts` — 三来源注册、值读取、字段级/raw 写入原子性、路径校验（拒绝越界）、`settings-extensions.json` 格式兼容往返
- 无破坏性变更；新端点默认空列表（无声明时 200 `{declarations: []}`）
