# Proposal: Settings Extensions 管理页

## Why

pi 的插件（package）是扩展能力的安装单元（npm/git，持久化在 `settings.json#packages[]`），一个包可贡献 extensions（注册工具）、skills、prompts、themes。目前 pi-forge 只能通过 Settings → Skills / Tools 间接看到包贡献的资源，安装/卸载/枚举包仍需手工编辑 `settings.json` 或命令行操作，缺乏一个统一的管理入口。用户需要一个类似 Providers 页的插件管理页：枚举已安装包、安装/卸载包、展开查看每个包贡献的 skill/prompt/tool/theme 等资源。

## What Changes

- 服务端新增插件（packages/extensions）管理 REST 面：
  - `GET /api/v1/config/extensions` — 枚举已安装包，每包附带其贡献资源清单（extensions→tools、skills、prompts、themes）与安装范围（user/project）
  - `POST /api/v1/config/extensions/install` — 安装一个包（npm spec 或 git 源），持久化到 `settings.json#packages[]`
  - `POST /api/v1/config/extensions/remove` — 卸载一个包（从设置移除并清理）
  - 安装/卸载**不**触发会话 reload：新包对新创建会话生效，运行中会话由用户在 Settings → General 手动 Restart
- Settings UI 新增 **Extensions** tab（非 minimal 模式），布局仿 Providers 页：
  - 每包一张卡片行：包名 + 类型（npm/git）+ 作用域（user/project）徽标 + 操作按钮（Update/Remove/Install 输入框）
  - 展开（`<details>`）列举该包贡献的 **tools / skills / prompts / themes** 四组资源及路径
  - 包级 **Settings** 入口本期不渲染（PiManifest 声明之外的包级配置暂不可枚举；后续变更可加回）
- 安装表单：输入 npm 包名（如 `pi-subagents`）或 git URL，选择作用域（user/project）
- 注意范围澄清：pi 包模型贡献 `extensions/skills/prompts/themes`，**不包含 providers**（自定义 provider 走 `models.json`）。展开信息如实展示四类资源；用户请求中的 "providers" 不实现为包贡献，设计文档中记录该决策

## Capabilities

### New Capabilities
- `extensions-manager`: 插件（package）的枚举、安装、卸载与贡献资源展示

### Modified Capabilities
- 无（主规范 `openspec/specs/` 目前为空；本变更为纯新增能力）

## Impact

- **Server**: `packages/server/src/routes/config.ts`（新增 `/config/extensions` 子面）、新模块 `packages/server/src/extensions-manager.ts`（包装 SDK `DefaultPackageManager`，复用 `extensions-discovery.ts` 的 resolve 镜像模式）、`session-registry.ts`（复用 `reloadSession` 使安装生效）
- **SDK**: `@earendil-works/pi-coding-agent` 的 `DefaultPackageManager`（`listConfiguredPackages` / `resolve` / `install` / `installAndPersist` / `remove` / `update` / `checkForAvailableUpdates` / `setProgressCallback`）
- **Client**: `packages/client/src/components/SettingsPanel.tsx`（新 `ExtensionsTab` + tab 注册）、`packages/client/src/lib/api-client/index.ts`（新 API 方法）
- **Tests**: `tests/test-config.ts`（或新 `tests/test-extensions.ts`）— 枚举/安装/卸载/404 场景
- 无破坏性变更；不改动主规范现有能力
