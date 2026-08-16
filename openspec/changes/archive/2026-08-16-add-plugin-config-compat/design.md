# Design: 插件配置文件兼容框架

## Context

现状（参见 proposal.md - Why）：pi 生态的 `@juanibiapina/pi-extension-settings` 定义了插件设置注册的社区标准——扩展加载时经事件总线发出 `pi-extension-settings:register`，存储于 `~/.pi/agent/settings-extensions.json`（全局）。pi-forge 已有 `extensions-manager.ts`（包装 SDK `DefaultPackageManager`，含 `resolve()` 得到每包的扩展入口 `ResolvedResource{path, metadata:{source, scope, origin, baseDir}}`）与 Settings UI（Extensions tab 包卡片，齿轮入口已预留）。SDK 导出 `loadExtensions(paths, cwd, eventBus?, runtime?)`（jiti 加载扩展工厂，`api.events.emit` 转发到传入的 eventBus）、`createExtensionRuntime()`（未绑定 action 方法抛错、注册方法安全）、`createEventBus()`（`{emit(channel, data), on(channel, handler)}`）。pi-forge 单租户、运行于用户本机/容器，用户安装的包即 pi 本身也会执行的代码。

用户决策（提案前确认）：配置文件**仅限 PI_CONFIG_DIR**；UI 入口**仅 Extensions 包卡片齿轮**；字段能力**标量 + 嵌套路径 + raw 全文编辑兜底**；注册载体以**完全兼容或包含 pi-extension-settings** 为目标；捕获**默认开启可关**；捕获**启动时后台预加载**；本期范围**捕获 + compat**（manifest 声明式注册不做）；compat 目录为**不走 pi-extension-settings 插件的注册入口**，绑定其自身 JSON 配置文件。

## Goals / Non-Goals

**Goals:**
- 统一声明模型 + 双来源注册（事件捕获 / compat 手动注册），合并去重
- 与 `pi-extension-settings` **完全兼容**：同存储文件、同注册事件、字符串值语义，浏览器编辑与 pi TUI 双向互通
- REST 面：列出声明的包配置（含值）、单包详情、字段级保存、raw 全文保存、声明缓存刷新
- Extensions 包卡片齿轮 → 表单（标量/枚举/多选/嵌套路径）+ raw JSON 切换
- 读写仅限 `PI_CONFIG_DIR`，原子写，路径校验拒绝越界

**Non-Goals:**
- 不读写项目级 `.pi/settings-extensions.json`（用户决策：仅 PI_CONFIG_DIR；本地作用域后续变更可加）
- 不提供 `getSetting`/`setSetting` 运行时 API（那是 pi 会话内扩展的运行时能力，pi-forge 不替代）
- 不替代 pi TUI 的 `/extension-settings` 命令（终端用户仍可用；pi-forge 只提供浏览器入口）
- 保存配置不触发会话 reload（扩展经 `getSetting()` 运行时读取，改文件即时生效）
- 不修改 `pi-extension-settings` 本身或 `settings-extensions.json` 存储格式
- 不做 SSE/Webhook 推送配置变更

## Decisions

**D1. 统一声明模型 `ConfigDeclaration`**
```
interface ConfigDeclaration {
  package: string;            // 包/扩展名（registry key，如 "my-extension"）
  file: string;               // 相对 PI_CONFIG_DIR 的文件名，如 "settings-extensions.json"（仅单层文件名，禁止子目录，见 D5）
  label: string;              // 显示名
  description?: string;
  source: "extension-event" | "manifest" | "compat";
  fields: FieldDefinition[];
}
type FieldDefinition =
  | { kind: "scalar"; path: string; type: "string"|"number"|"boolean"|"enum"; label: string; description?;
      defaultValue?: unknown; required?: boolean; min?: number; max?: number; pattern?: string; secret?: boolean;
      enum?: { value: string; label: string }[] }
  | { kind: "multi-select"; path: string; label: string; description?; options: { id: string; label: string }[] };
```
`path` 为 JSON 路径（点分，支持嵌套如 `auth.apiKey`）。所有来源归一为该模型，UI 只消费它。选它而非直接暴露三套异构结构：单一渲染器、单一校验器、单一存储层。

**D2. 双来源注册 + 合并优先级（事件捕获 > compat）**
- **事件捕获**：`loadExtensions(packageEntryPaths, workspacePath, eventBus, runtime)` + `eventBus.on("pi-extension-settings:register", ...)`；对 `settings[]` 归一：`values` → enum 下拉、`options` → multi-select、否则 string。此来源与 pi 会话内注册**同一事件、同一文件**，实现"完全兼容"。
- **compat 注册入口**：`packages/server/src/extensions-settings-compat/<package>.ts` 导出 `CompatDeclaration` 常量（命名导出，遵循 AGENTS.md）；`compat/index.ts` 汇总。这是**不走 pi-extension-settings 插件的注册接口**——直接登记表单字段并绑定插件自身的 JSON 配置文件（本期仅 JSON；字段模型见 D1，含嵌套路径）。用于：不使用 `pi-extension-settings` 生态、但有独立配置文件的已知插件。
- 合并：按插件名 key 去重；同 key 时高优先级来源的字段优先，缺失字段由低优先级补充（合并而非整体覆盖——保证捕获失败时 compat 兜底仍生效）。来源标注保留，UI 展示。

备选：只做 compat 文件夹（最简单，但不通用）；只做事件捕获（无法覆盖不注册的插件，且加载失败无兜底）；再加 manifest 声明式来源（更完整，但本期范围用户已明确不做，后续变更可加）——前两者拒绝，第三个延后。

**D3. 事件捕获的安全与生命周期**
- 默认开启，受 `PLUGIN_CONFIG_CAPTURE`（config.ts 新增，CLI `--plugin-config-capture`）控制，默认 `true`。理由：捕获是"完全兼容"的核心路径；单租户下执行用户自装包代码与运行 pi 本身等价；文档明示风险。关闭时仅 compat。
- **启动时后台预加载**：服务器启动（`index.ts`）异步触发一次捕获（不阻塞启动；捕获中的错误仅记录 diagnostics）；SDK 侧 `loadExtensionsCached` 自带工厂缓存（cwd 变化 `clearExtensionCache`）。`POST /config/plugin-configs/reload` 清缓存重捕；包安装/卸载成功后同步失效。首次打开 Settings 时若捕获尚未完成，GET 返回当前已完成部分 + `ready: false` 标记，UI 轮询/手动刷新一次。
- **逐扩展容错**：`loadExtensions` 返回 `{extensions, errors}`，错误记入 diagnostics 不阻断；`api.events.emit` 在 `createExtensionRuntime()` 下可安全调用（`assertActive` 未触发），注册类方法（registerTool/on 等）只写扩展对象，action 方法（sendMessage 等）抛错被捕获为该扩展加载错误。
- 扩展入口路径来源：复用 `extensions-manager.ts` 的 `resolve()` → `extensions[]`，按 `metadata.origin === "package"` 过滤，`metadata.source`/`baseDir` 关联包身份。

备选：捕获机制默认关闭（更保守，但核心特性默认不可用）；懒加载（首开才捕获，用户已选启动预加载）；不用 jiti 改读扩展源码文本（脆弱，无法执行获得动态注册）——均拒绝。

**D4. 存储读写 `plugin-config-store.ts`**
- 读取：`readFile(join(config.piConfigDir, file))` → JSON.parse；文件缺失/解析失败返回 `{exists: false}`/异常标记，不整体失败。
- 写入（字段级）：读当前内容（缺失视为 `{}`）→ 对每个 `values[path]` 做路径 set（点分路径逐级创建对象，数组索引支持）→ JSON.stringify → 原子写（`.tmp` + `rename`，AGENTS.md 约定）。未知键保留（只改提交的路径）。
- 写入（raw）：校验 JSON → 原子替换全文。
- **兼容文件特殊处理**：当 `file === "settings-extensions.json"` 时强制字符串值语义（所有值 String() 化），保证 pi 端 `getSetting` 读回字符串；其他文件按字段类型写类型化值。该规则由声明来源驱动：extension-event 来源的字段一律字符串化。
- 并发：复用 `makeLock`（concurrency.ts）对单文件序列化读写。

**D5. 路径安全**
- 声明中 `file` 必须是**单层文件名**（`basename(file) === file`，拒绝 `/`、`\`、空串）且以 `.json` 结尾——根除子目录与 `..` 逃逸；配合 `join(config.piConfigDir, file)` 后 `realpath` 校验（防符号链接指向外部）不通过即 403。
- 声明来源可信度：compat 是仓库代码（可信）；manifest 来自用户安装的包（单租户，同 D3 信任模型）；事件捕获执行的代码本身已能读写用户文件（与 pi 等价），不新增信任面。

**D6. REST 面（routes/config.ts 挂 `/config/plugin-configs`）**
- `GET /config/plugin-configs` → 200 `{ declarations: [{ package, label, description?, file, source, exists, fields, values }] }`（`exists` = 文件存在，`values` 为按 path 提取的当前值）
- `GET /config/plugin-configs/:package` → 单包详情（同上单元素）
- `PUT /config/plugin-configs/:package` body `{ values?: Record<path, unknown> } | { raw?: string }`（二选一，都传 → 400）→ 200 `{ ok: true }`；包未注册 → 404 `not_found`；校验失败/非法 JSON → 400；路径越界 → 403；IO/SDK 错误 → 500 `agent_error`
- `POST /config/plugin-configs/reload` → 200 `{ reloaded: true }`（清缓存重捕，安装/卸载包后 UI 调用）
- 路由只依赖 registry/store 纯函数（AGENTS.md：路由不直接操作 SDK）

**D7. UI（ExtensionsTab 齿轮 → PluginConfigModal）**
- ExtensionsTab 包卡片齿轮：仅当该包在声明列表中时渲染（`onOpenConfig(packageName)` 上抛给 SettingsPanel）；点击打开 `PluginConfigModal`。
- `PluginConfigModal`：加载 `GET /config/plugin-configs/:package`；左侧/主区按 `kind` 渲染控件（string 输入 / number 输入 / boolean 开关 / enum 下拉 / multi-select 多选+上下移排序）；顶部标注来源徽标 + 文件路径 + 存在性；"Raw JSON" 切换 → `CodeMirrorEditor`（复用现有组件）全文编辑；保存 → PUT（表单模式收集 values / raw 模式提交 raw）；保存中 busy 禁用；失败在模态内 banner 显示（复用 `onError` 模式），不关闭；成功刷新并提示。
- api-client 新增 `getPluginConfigs()` / `getPluginConfig(name)` / `savePluginConfig(name, body)` / `reloadPluginConfigs()`，复用 `request()` + 内联 validator。

**D8. 缓存失效时机**
- `plugin-config-registry.ts` 模块级声明缓存（capture 结果）；失效时机：reload 端点、包安装/卸载成功后（extensions-manager 调用点旁加失效钩子）、cwd 变化（SDK 工厂缓存已处理）。compat 来源是仓库代码，随启动/构建加载，与 capture 同步刷新。

## Risks / Trade-offs

- [在服务器进程执行第三方扩展代码（安全）] → 单租户 + 用户自装包（与运行 pi 等价）的信任模型；`PLUGIN_CONFIG_CAPTURE=false` 可关；逐扩展错误隔离；只捕获注册事件不调用 action 方法
- [扩展加载慢/有副作用（网络、磁盘）] → 懒加载（首次打开 Settings 才做）+ 缓存；加载在请求内同步完成，超长则前端 loading 态；SDK 工厂缓存避免重复 import
- [扩展在加载时调用 action 方法导致该扩展注册失败] → `loadExtensions` 返回 errors，该扩展降级为"无声明"（齿轮隐藏）；重要插件用 compat 兜底
- [`settings-extensions.json` 被 pi TUI 同时写入 → 竞态/格式漂移] → 原子写 + `makeLock` 单文件串行；兼容文件只写字符串值；读取宽容（未知键保留）
- [manifest schema 版本演化] → 本期无 manifest 来源，不适用；compat 声明代码随仓库版本管理，字段模型只增不删（unknown 字段忽略）
- **compat 注册入口的维护责任** → 每插件一文件、结构常量、`index.ts` 汇总；只有需要兼容的插件才添加；随仓库版本管理可审查可回滚

## Migration Plan

- 部署：同仓单 PR；`npm run build` 重启即可；无数据迁移（新端点默认空列表）；`PLUGIN_CONFIG_CAPTURE` 默认开启无需配置
- 回滚：还原提交重启；已写入的 `settings-extensions.json` 内容向后兼容（pi TUI 可继续读）
- 测试：新 `tests/test-plugin-config.ts` — 双来源注册、合并优先级、值读取、字段级/raw 写入、原子性、字符串值往返、路径越界 403、非法 JSON 400、未注册包 404

## Open Questions

无（D3 的捕获开关默认值、D2 的合并优先级均已在设计内定，用户可在 brainstorming 阶段复核）。
