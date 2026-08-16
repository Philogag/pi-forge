## Purpose

让 pi-forge 浏览器 UI 成为插件配置文件（`PI_CONFIG_DIR` 内）的编辑入口：插件通过三种来源注册配置文件结构，pi-forge 据此渲染表单并提供 raw 全文编辑，与 pi 生态的 `pi-extension-settings` 设置系统完全兼容互通。

## ADDED Requirements

### Requirement: 插件配置文件结构注册

系统 SHALL 支持两种来源的配置文件结构注册，并合并为统一的声明模型（声明包含：所属插件名、目标文件（相对 `PI_CONFIG_DIR`，JSON 文件）、字段列表、来源标注）：

1. **扩展事件捕获**：系统 SHALL 加载已安装插件的扩展入口，捕获 `pi-extension-settings:register` 事件（负载 `{ name, settings: SettingDefinition[] }`），自动生成指向 `settings-extensions.json` 的声明
2. **compat 手动注册**：系统 SHALL 加载本仓库 `compat/` 文件夹内的注册——为不走 `pi-extension-settings` 的插件直接登记表单信息并绑定其自身的 JSON 配置文件；本期仅支持 JSON 格式配置文件

多来源声明以插件名去重；同一插件多来源时按"事件捕获 > compat"优先级合并（高优先级缺失的字段由低优先级补充）。

#### Scenario: 捕获 pi-extension-settings 注册事件

- **WHEN** 已安装插件 A 的扩展入口在加载时发出 `pi-extension-settings:register`，含 2 个设置定义
- **THEN** 系统生成的声明归属插件 A、目标文件为 `settings-extensions.json`，且包含 2 个字段（类型由设置定义推导：有 `values` → 枚举，有 `options` → 多选，否则字符串）

#### Scenario: 扩展加载失败不影响其他插件

- **WHEN** 插件 B 的扩展入口加载抛错（如引用未初始化运行时能力）
- **THEN** 系统记录该错误但继续加载其余插件，插件 A 的注册仍被捕获

#### Scenario: 捕获功能被禁用

- **WHEN** 捕获开关被关闭
- **THEN** 系统不加载任何扩展代码，事件捕获来源不产生任何声明；compat 来源照常工作

#### Scenario: compat 注册绑定插件自身配置文件

- **WHEN** 本仓库 compat 目录为插件 C 登记了表单字段，声明绑定 `PI_CONFIG_DIR/plugin-c.json`
- **THEN** 系统按声明读取该文件渲染表单，保存时原子写入该文件，与 pi-extension-settings 无关联

### Requirement: 声明字段模型

声明字段 SHALL 描述单个表单控件，至少包含：展示名（label）、数据位置（JSON path，支持嵌套如 `auth.apiKey`）、类型（string / number / boolean / enum / multi-select）、可选描述与限制（required、min、max、pattern、enum 选项、多选项列表）。枚举与多选字段 SHALL 提供可读 label 与存储值 id 的映射。

#### Scenario: 嵌套路径定位

- **WHEN** 字段声明数据位置为 `auth.apiKey`，目标文件内容为 `{"auth": {"apiKey": "x"}}`
- **THEN** 表单读取显示值 `x`，保存时写回 `auth.apiKey` 且不破坏 `auth` 下其他键

#### Scenario: 缺少默认值的可选字段

- **WHEN** 字段未设置且文件/路径中不存在
- **THEN** 表单显示声明中的 defaultValue（如有），否则显示空值，保存时该字段按用户输入写入

### Requirement: 配置读取

系统 SHALL 提供列出全部插件配置声明的接口，每项包含：插件名、来源标注（event / manifest / compat）、目标文件路径、字段定义、当前值、目标文件是否存在。目标文件不存在或解析失败时，该项 SHALL 仍返回（标记异常），不导致整体失败。

#### Scenario: 文件不存在时列表示例可用

- **WHEN** 某插件声明目标文件 `foo.json` 但该文件不存在
- **THEN** 列表中该项正常返回，标注文件不存在，表单以 defaultValue/空值渲染，保存时创建文件

#### Scenario: 无任何声明

- **WHEN** 没有任何插件注册配置结构
- **THEN** 接口返回空列表 `{ declarations: [] }`（HTTP 200）

### Requirement: 表单字段级保存

系统 SHALL 支持按字段路径的部分更新：仅写入请求中提交的字段，保留目标文件中的未知键与其他字段；写入 SHALL 为原子操作（临时文件 + rename），失败时目标文件保持原状。写入 `settings-extensions.json` 时 SHALL 保持该文件存储格式（`{ extension: { id: value } }`）且值以字符串存储，与 `pi-extension-settings` 读取语义一致。

#### Scenario: 部分更新保留未知键

- **WHEN** 文件内容为 `{"a": {"x": 1}, "extra": true}`，请求仅更新字段 `a.x` 为 2
- **THEN** 保存后文件为 `{"a": {"x": 2}, "extra": true}`

#### Scenario: 兼容文件字符串值往返

- **WHEN** 通过事件捕获来源的表单把枚举字段 `debug` 保存为 `"on"`，再由 pi 端 `getSetting("ext", "debug")` 读取
- **THEN** 读取值等于 `"on"`，文件内以字符串存储

#### Scenario: 非法值被拒绝

- **WHEN** 请求提交的值违反字段限制（如 number 字段传非数字、required 字段传空）
- **THEN** 系统返回 400 且不写入文件

### Requirement: raw 全文编辑

系统 SHALL 为每个已注册配置提供全文 raw JSON 编辑能力：提交完整文件内容，写入前 SHALL 校验 JSON 合法；非法 JSON 返回 400 不写入；合法内容原子写入。raw 编辑 SHALL 允许编辑声明字段之外的内容。

#### Scenario: 非法 JSON 被拒绝

- **WHEN** raw 内容为 `{invalid json`
- **THEN** 返回 400 且文件内容不变

#### Scenario: raw 覆盖声明外内容

- **WHEN** raw 内容包含声明字段之外的新键，且 JSON 合法
- **THEN** 文件整体被新内容原子替换，新键保留

### Requirement: 文件路径安全

系统 SHALL 仅允许读写 `PI_CONFIG_DIR` 内的配置文件；目标文件解析必须经过校验，任何试图越出 `PI_CONFIG_DIR` 的路径（如 `../`、绝对路径、符号链接逃逸）SHALL 被拒绝（403）。目标文件 SHALL 为 JSON 文件。

#### Scenario: 越界路径被拒绝

- **WHEN** 请求声明或写入的目标文件为 `../../etc/passwd` 或绝对路径
- **THEN** 返回 403 且不执行任何读写

### Requirement: 浏览器端表单界面

Settings → Extensions 的每个包卡片 SHALL 在有注册声明时提供配置入口（齿轮），点击打开该包的配置表单：标量字段按类型渲染控件（string 输入 / number 输入 / boolean 开关 / enum 下拉 / multi-select 可排序多选），并提供 raw JSON 全文编辑切换。表单 SHALL 提供保存与取消；保存失败在界面中显示错误且不关闭。

#### Scenario: 无声明包不显示入口

- **WHEN** 已安装包没有任何注册声明
- **THEN** 该包卡片不显示配置齿轮入口（与 add-extensions-manager 预留行为一致）

#### Scenario: 保存成功反馈

- **WHEN** 用户在表单中修改字段并保存成功
- **THEN** 表单关闭或刷新为最新值，并给出成功提示
