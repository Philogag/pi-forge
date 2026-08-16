# Superpower Design: 插件配置文件兼容框架

> 本文档是 `add-plugin-config-compat` 变更的深度技术设计（brainstorming 产出）。需求事实源为 `proposal.md`、`specs/plugin-config/spec.md` 与 `design.md`，本文件只做实现层面的细化：组件边界、数据流、SDK 用法、错误处理、测试策略、边界条件。与 design.md 冲突时以 design.md 为准。

## 1. 范围回顾（用户确认的关键决策）

| 决策 | 结论 |
|---|---|
| 与 pi-extension-settings 的关系 | **完全兼容**：同事件（`pi-extension-settings:register`）、同存储文件（`~/.pi/agent/settings-extensions.json`）、同字符串值语义，浏览器编辑与 pi TUI 双向互通 |
| 注册来源 | **事件捕获 + compat 注册入口**（本期不做 manifest 声明式来源） |
| compat 定位 | 不走 pi-extension-settings 插件的**注册入口**：在本仓库 `packages/server/src/extensions-settings-compat/` 直接登记表单字段并绑定插件自身 JSON 配置文件（本期仅 JSON） |
| 捕获开关 | `PLUGIN_CONFIG_CAPTURE` 默认 **true**（可关）；关闭后仅 compat |
| 捕获时机 | **启动时后台预加载**（不阻塞启动）；reload 端点 / 装卸包后失效重捕 |
| 配置文件位置 | 仅 **PI_CONFIG_DIR**（`~/.pi/agent/`），单层 JSON 文件，路径校验拒绝越界 |
| UI 入口 | 仅 **Extensions 包卡片齿轮**（有声明才渲染）→ 模态表单 |
| 字段能力 | 标量（string/number/boolean/enum）+ multi-select + **嵌套 JSON path** + **raw 全文编辑**兜底 |
| 项目级本地设置 | 本期不做（`.pi/settings-extensions.json` 延后） |
| 会话 reload | 不做（扩展经 `getSetting()` 运行时读取，改文件即时生效） |

## 2. 组件边界

```
┌───────────────────────────────────────────────────────────────┐
│ Client (React)                                                │
│  SettingsPanel → ExtensionsTab                                │
│    └─ 包卡片有声明时渲染齿轮 → 打开 PluginConfigModal          │
│        ├─ 表单: string/number/boolean/enum/multi-select       │
│        ├─ 嵌套路径字段 (label + path + 限制 + 描述)            │
│        └─ Raw JSON 切换 → CodeMirrorEditor (复用)             │
│  api-client: getPluginConfigs / getPluginConfig /              │
│              savePluginConfig / reloadPluginConfigs            │
└───────────────┬───────────────────────────────────────────────┘
                │ REST /api/v1/config/plugin-configs*
┌───────────────▼───────────────────────────────────────────────┐
│ Server (Fastify)                                              │
│  routes/config.ts ── /config/plugin-configs 子面              │
│       │                                                       │
│       ▼                                                       │
│  plugin-config-registry.ts  (声明注册表)                      │
│    ├─ init(): 启动后台预加载捕获（index.ts 调用，fire-forget）│
│    ├─ source: capture (SDK loadExtensionsCached + eventBus)   │
│    ├─ source: compat  (src/compat/*.ts 常量, index.ts 汇总)   │
│    ├─ merge(): 事件捕获 > compat, 按包名去重, 字段级补充       │
│    └─ invalidate(): reload 端点 / 装卸包钩子                   │
│       │                                                       │
│       ▼                                                       │
│  plugin-config-store.ts  (文件读写, 原子写)                   │
│    ├─ readDeclaredFile(file) → {exists, json?}                │
│    ├─ getValues(file, fields) → Record<path, unknown>         │
│    ├─ putValues(file, values)  → 读-改-写, path-set, 原子写    │
│    ├─ putRaw(file, content)    → JSON 校验 + 原子替换          │
│    └─ makeLock(file) 串行化 (复用 concurrency.ts)              │
└───────────────┬───────────────────────────────────────────────┘
                │ SDK loadExtensionsCached / createEventBus /
                │   createExtensionRuntime / DefaultPackageManager
┌───────────────▼───────────────────────────────────────────────┐
│ ~/.pi/agent (PI_CONFIG_DIR)                                   │
│   settings-extensions.json  ·  插件自身配置 .json              │
└───────────────────────────────────────────────────────────────┘
```

**依赖注入约定**：`plugin-config-registry.ts` / `plugin-config-store.ts` 是仅有的直接 import SDK 捕获 API 与写 `PI_CONFIG_DIR` 文件的服务端模块；路由层只依赖二者的纯函数（AGENTS.md：路由不直接操作 SDK）。`extensions-manager.ts` 暴露包枚举结果给 registry（复用 `resolve()`，不重复实现）。

## 3. 数据模型（TS）

```ts
// types.ts（registry/store/路由/客户端共享形状，服务端为源）
export type DeclarationSource = "extension-event" | "compat";

export interface ConfigDeclaration {
  package: string;            // 注册 key（事件捕获 = 事件负载 name；compat = 插件名）
  file: string;               // 相对 PI_CONFIG_DIR 的单层 JSON 文件名（校验见 §5）
  label: string;              // 显示名
  description?: string;
  source: DeclarationSource;
  fields: FieldDefinition[];
}

export type FieldDefinition =
  | { kind: "scalar"; path: string; type: "string" | "number" | "boolean" | "enum";
      label: string; description?: string; defaultValue?: unknown;
      required?: boolean; min?: number; max?: number; pattern?: string; secret?: boolean;
      enum?: { value: string; label: string }[] }
  | { kind: "multi-select"; path: string; label: string; description?: string;
      options: { id: string; label: string }[] };

// REST 负载
export interface PluginConfigSummary {        // GET /plugin-configs 每项
  package: string; label: string; description?: string; file: string;
  source: DeclarationSource; exists: boolean; ready: boolean;
  fields: FieldDefinition[]; values: Record<string, unknown>;
}
export type SavePluginConfigBody =
  | { values?: Record<string, unknown>; raw?: never }   // 表单字段级（部分更新）
  | { raw?: string; values?: never };                   // 全文 raw 替换
```

**捕获归一映射**（`SettingDefinition` → `FieldDefinition`）：
- `values?: string[]` 存在 → `{ kind: "scalar", type: "enum", enum: values.map(v => ({value: v, label: v})) }`
- `options?: {id,label}[]` 存在 → `{ kind: "multi-select", options }`（互斥于 values，源保证）
- 否则 → `{ kind: "scalar", type: "string" }`
- 公共映射：`path = id`（settings-extensions.json 是扁平的 `{ext: {id: value}}`）、`label`、`description?`、`defaultValue = defaultValue`（字符串，兼容文件语义天然一致）

## 4. 捕获机制详解

**前提**（已对 SDK 0.84 验证）：
- `createEventBus()` 从 `@earendil-works/pi-coding-agent` index 导出，接口 `{emit(channel, data), on(channel, handler): unsub}`；`api.events.emit` 转发到传入的 eventBus → 捕获可行
- `loadExtensionsCached(paths, cwd, eventBus?, runtime?)` 导出；jiti 加载工厂并 `await factory(api)`；工厂内 `api.events.emit` 在 `createExtensionRuntime()` 下 `assertActive` 不抛错；注册方法（registerTool/on/registerCommand…）只写扩展对象；action 方法（sendMessage/exec…）抛 "runtime not initialized" 被捕获为该扩展 error
- `DefaultPackageManager.resolve()` → `ResolvedPaths.extensions: ResolvedResource{path, enabled, metadata:{source, scope, origin: "package"|"top-level", baseDir?}}` → 可得到每包的扩展入口路径与包身份

**流程**：
1. 收集扩展入口：`listPackages()`/`resolve()` 的 `extensions[]`，过滤 `metadata.origin === "package"`，按 `metadata.source || baseDir` 归组；仅取 enabled 项（与 Settings 列表一致）
2. 建 eventBus + 订阅：`eventBus.on("pi-extension-settings:register", (data) => { validate shape {name: string, settings: SettingDefinition[]}; registrations.push(data) })`
3. `const { extensions, errors } = await loadExtensionsCached(paths, config.workspacePath, eventBus, createExtensionRuntime())`
4. 归一 `registrations` → `Map<name, ConfigDeclaration>`（file = `settings-extensions.json`、source = `"extension-event"`）；`errors` 记入模块级 diagnostics（含 path 与 message），不阻断
5. 缓存结果；`status: "ready"`

**启动预加载**：`index.ts` 在 server ready 后 `void pluginConfigRegistry.init()`（fire-and-forget）；init 内部 try/catch，失败仅记 diagnostics、status = "error"；后续 GET 返回空 + `ready: false`，用户可点 UI 刷新触发 `POST /reload`。捕获期间 GET 不被阻塞（返回当前快照）。

**失效**：`invalidate()` 置 status="idle" 并触发一次重捕（去抖）；调用点：`POST /config/plugin-configs/reload`、`extensions-manager` 安装/卸载成功分支。SDK 工厂缓存由 `loadExtensionsCached` 管理（cwd 变化自动清）。

## 5. 存储层与路径安全（plugin-config-store.ts）

**读取**：`readDeclaredFile(file)` → 校验文件名（见下）→ `readFile(join(config.piConfigDir, file))` → 缺失 `{exists: false}`；parse 失败 `{exists: true, error: "invalid_json"}`（列表照常返回，值置空，UI 提示）。**写前**重读当前文件（读-改-写），保证未知键与并发改动保留。

**路径 get/set**：点分段解析（`"auth.apiKey"`、`"models[0].name"` → 段含 `[n]` 时按数组索引处理）；get 沿段下行，任一段缺失 → undefined；set 沿段创建中间对象/数组，值写入末段。

**原子写**（AGENTS.md 约定）：内容 → `writeFile(file + ".tmp", json)` → `rename(tmp, file)`；失败时删 tmp，目标文件不动。每文件操作经 `makeLock`（concurrency.ts）串行，防并发表单保存与 reload 竞态。

**兼容文件字符串语义**：`file === "settings-extensions.json"`（且来源 extension-event）→ 写入前所有值 `String()` 化，与 pi 端 `getSetting` 读取语义一致；其他 compat 声明的文件按字段类型写类型化值。`defaultValue` 为字符串时（捕获来源必然如此）无需转换。

**路径校验规则**（任何 file 参数，含声明与请求）：
1. `basename(file) === file`（拒绝 `/`、`\`、空）
2. `file.endsWith(".json")`
3. `realpath(join(config.piConfigDir, file))` 解析后必须仍在 `config.piConfigDir` 内（防符号链接逃逸）；不存在则跳过 realpath 检查（新建场景）但仍受 1/2 约束
违规 → 403（声明层面违规视为注册错误，请求层面违规返回 403）

## 6. REST API（routes/config.ts）

| 端点 | 行为 |
|---|---|
| `GET /config/plugin-configs` | 200 `{ declarations: PluginConfigSummary[], ready: boolean, errors?: {path, error}[] }`；每项含 `exists`、`values`（按字段 path 提取）；捕获未完成时 `ready: false` + 当前快照 |
| `GET /config/plugin-configs/:package` | 200 单项（同上单元素）；未注册 → 404 `{error:"not_found"}` |
| `PUT /config/plugin-configs/:package` | body `SavePluginConfigBody`（values 与 raw 互斥，同时传 → 400）；`values` 模式：路径校验 + 字段值校验（类型/required/min/max/pattern/enum/多选 id 集合）→ 读-改-写原子保存，返回 200 `{ok:true}`；`raw` 模式：JSON.parse 校验 → 原子替换；未注册包 → 404；校验失败/非法 JSON → 400；路径越界 → 403；IO → 500 `agent_error` |
| `POST /config/plugin-configs/reload` | 200 `{reloaded:true}`；触发 invalidate 重捕（异步完成，不阻塞响应） |

**字段值校验细则**：number 用 `typeof === "number" && !isNaN`；pattern 用 `new RegExp(pattern)`（声明端就捕获非法 regex）；enum 值必须在声明集合；multi-select 值为 string 数组且每个 id 在 options 中；unknown 字段路径（不在声明 fields 中）→ 400（表单模式只允许声明字段；raw 模式无此限制）。

## 7. UI 设计（ExtensionsTab 齿轮 → PluginConfigModal）

**齿轮入口**：ExtensionsTab 在包卡片操作区渲染齿轮（lucide `Settings` 图标，`title="Plugin config"`），仅当该包出现在声明列表（`getPluginConfigs()` 结果）时渲染；点击 → SettingsPanel 状态 `openConfigPackage` → 渲染 `PluginConfigModal`。无声明包不渲染（保持 add-extensions-manager 预留语义）。

**PluginConfigModal 状态机**：`loading`（GET 单项）→ `error`（banner，复用 onError 模式）→ `ready`。`ready` 内：
- 头部：插件名 + 来源徽标（`extension-event` → "extension" / `compat` → "compat"）+ 文件路径（font-mono）+ 文件存在性提示（不存在 → 提示"保存时将创建文件"）
- 表单区：按 `kind` 渲染控件——
  - `string`：`<input type="text">`（`secret` → `type="password"` + 显示/隐藏切换）
  - `number`：`<input type="number">`（min/max 约束到控件）
  - `boolean`：switch/checkbox
  - `enum`：`<select>`（value/label）
  - `multi-select`：可勾选列表 + 上移/下移排序（存储为有序 id 数组）
  - 每字段行：label + 类型徽标 + 描述（title/次级文本）+ 限制（required 红星、min/max/pattern 摘要）+ 校验错误行
- **Raw JSON 切换**：右上 toggle → `CodeMirrorEditor`（复用现有组件，JSON mode）全文编辑；切换时若表单有未保存改动 → 确认提示；raw 保存走 `{raw}` 分支
- 底部：Cancel（关闭，丢弃未保存）+ Save（busy 禁用；表单模式收集所有字段值 → `{values}`；成功后关闭并刷新列表/单项，提示"已保存"；失败 → 模态内 banner，不关闭）
- 刷新按钮（捕获未 ready 时显示"刷新注册" → `POST /reload`）

**api-client**（复用 `request(url, validator, {method, body})` 模式 + 内联 validator）：`getPluginConfigs()` / `getPluginConfig(package)` / `savePluginConfig(package, body)` / `reloadPluginConfigs()`。

## 8. 错误处理总表

| 场景 | 层 | 结果 |
|---|---|---|
| 扩展加载抛错（含 action 方法未初始化） | 捕获 | errors 记录，不阻断其他扩展；该包无声明（齿轮隐藏） |
| `pi-extension-settings:register` 负载形状非法 | 捕获 | 丢弃该条，记录 diagnostics |
| 捕获被禁用 | 注册表 | 事件来源为空；compat 照常 |
| 文件不存在 | 读取 | `exists:false`，表单 defaultValue/空渲染，保存时创建 |
| 文件非法 JSON | 读取 | `exists:true` + invalid_json 标记，值空；raw 保存可修复 |
| 值校验失败 / unknown path | PUT | 400，不写入 |
| raw 非法 JSON | PUT | 400，不写入 |
| 路径越界（声明或请求） | 校验 | 403（请求）/ 注册错误（声明） |
| 包未注册 | GET/PUT | 404 `not_found` |
| IO 失败 / 原子写失败 | PUT | 500 `agent_error`（tmp 残留清理） |
| 并发保存同一文件 | store | makeLock 串行，后写覆盖前写（单用户可接受） |

## 9. 测试策略（tests/test-plugin-config.ts）

**单元（无网络/无真实包）**：
- path get/set：嵌套对象、数组索引、缺失段、空路径
- 原子写：成功 rename；模拟 rename 失败 → 原文件不变、tmp 清理
- 字段校验：各类型/限制/unknown path/enum/多选 id
- 归一映射：SettingDefinition → FieldDefinition（values/enum、options/multi-select、默认 string）
- 合并优先级：capture 与 compat 同包 → capture 字段优先、缺失字段由 compat 补充；不同包各自独立

**集成（测试服务器，起真实捕获或注入假注册）**：
- 捕获场景：注入一个最小扩展工厂（`loadExtensionFromFactory` 风格，emit register 事件）→ 声明出现在 GET；加载抛错扩展 → 不阻断
- `settings-extensions.json` 往返：表单保存后文件为 `{"ext": {"id": "string"}}`，pi 端 `getSetting` 语义可读（字符串值断言）
- 字段级保存保留未知键；raw 替换全文；非法 JSON 400；越界 403（`../`、绝对路径、含 `/` 文件名）；未注册 404
- 空列表 200 `{declarations: []}`
- `PLUGIN_CONFIG_CAPTURE=false` → 无事件来源声明

**手动验收**：安装 `@juanibiapina/pi-extension-settings` + 一个注册设置的扩展 → 齿轮出现 → 改值保存 → pi 内 `/extension-settings` 或 `getSetting` 读到新值。

## 10. 边界条件

- **同插件名冲突**：事件负载 `name` 可能与另一包的 `metadata.source` 不一致 → 以事件负载 `name` 为 key（与 pi-extension-settings 语义一致），UI 显示该 key；compat 注册若想覆盖必须用同名
- **settings-extensions.json 含非字符串值**（用户手工编辑过）→ 读取原样展示（宽松），保存时该字段按当前表单值重写为字符串
- **`ready: false` 时用户保存** → 允许（compat 声明不受捕获影响）；事件来源字段不可见则无法表单保存（raw 仍可）
- **多选顺序**：有序数组存储；空数组合法；重排经 UI 上移/下移
- **secret 字段**：表单不回显明文？——决定：读取时回显（单用户本机工具，与 settings.json 处理一致），仅输入框类型隐藏
- **文件被 pi TUI 并发修改** → 读-改-写窗口极小（单文件锁 + 原子 rename），丢失更新可接受（单用户）

## 11. 明确延后项（不在本期）

- manifest 声明式注册来源（`package.json#pi.config`，用户已确认本期不做）
- 项目级本地设置（`.pi/settings-extensions.json`）读写
- 非 JSON 配置文件（YAML/TOML）支持
- 声明级删除（卸载插件时清理 compat 注册——本期 compat 是仓库代码，随 PR 管理）
- 配置变更 SSE/Webhook 推送
