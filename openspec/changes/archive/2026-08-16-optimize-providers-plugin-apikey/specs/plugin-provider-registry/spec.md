<!--
Delta spec: plugin-provider-registry
能力：进程级插件 provider 注册表——扩展加载时捕获 registerProvider，
列表合并、来源标注（via 包名）、注册状态查询。
-->

## ADDED Requirements

### Requirement: 插件 provider 注册捕获
pi-forge SHALL 在扩展加载期间捕获 `api.registerProvider(name, config)` 调用，将插件注册的 provider 记录到进程级注册表（`{name → {config, package}}`），其中 `package` 为声明该 provider 的扩展包名。

#### Scenario: 扩展注册 provider 被记录
- **WHEN** 已安装扩展在加载时调用 `pi.registerProvider("litellm", config)`
- **THEN** 进程级注册表包含 provider `litellm`，其 `config` 与注册时一致，`package` 为该扩展包名

#### Scenario: 重复注册覆盖
- **WHEN** 同一 provider 名被两次注册（如扩展重载）
- **THEN** 注册表保留最近一次注册的 config，不产生重复条目

### Requirement: 注册表独立于扩展事件捕获开关
插件 provider 注册表 SHALL 独立于 `PLUGIN_CONFIG_CAPTURE` 开关工作——关闭扩展事件捕获不得禁用 provider 注册捕获。

#### Scenario: 关闭事件捕获时 provider 仍可见
- **WHEN** `PLUGIN_CONFIG_CAPTURE=false` 且已安装注册 provider 的扩展
- **THEN** provider 注册表仍包含该扩展注册的 provider，且出现在 Providers 列表

### Requirement: Providers 列表合并与来源标注
`GET /config/providers` 返回的列表 SHALL 合并插件注册的 provider：插件 provider 显示为独立条目，并标注来源 `via <包名>`；无模型的插件 provider 也 SHALL 出现在列表中。

#### Scenario: 插件 provider 带来源标注
- **WHEN** 扩展注册了 provider `litellm`（包名 `pi-provider-litellm`）且已安装
- **THEN** Providers 列表包含 provider `litellm`，条目标注 `via pi-provider-litellm`

#### Scenario: 无模型插件 provider 仍列出
- **WHEN** 插件 provider 已注册但 models-store 尚无其模型
- **THEN** 该 provider 仍出现在 Providers 列表（可带空模型数组），以便用户配置与刷新

### Requirement: 注册失败隔离
单个扩展的 provider 注册失败（扩展加载错误或注册抛异常）SHALL NOT 影响其他 provider 的注册与列表。

#### Scenario: 坏扩展不影响内置 provider
- **WHEN** 某扩展加载时抛错，且内置 provider 已配置
- **THEN** Providers 列表仍正常返回内置 provider，且其余插件 provider 的注册不受影响

---

## MODIFIED Requirements

<!-- 无既有 spec，本变更全部为新增 -->
