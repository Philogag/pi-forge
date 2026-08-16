<!--
Delta spec: plugin-provider-refresh
能力：插件 provider 模型按需刷新——REST 端点触发重新发现
（refreshModels 或 /v1/models 回退），models-store 持久化。
-->

## ADDED Requirements

### Requirement: 按需刷新端点
pi-forge SHALL 提供 `POST /config/providers/:provider/refresh`，触发指定插件 provider 的模型重新发现；未注册的 provider SHALL 返回 404。

#### Scenario: 刷新已注册插件 provider
- **WHEN** 客户端对已注册的插件 provider `litellm` 调用刷新端点
- **THEN** 端点触发该 provider 的模型重新发现，返回更新后的模型列表

#### Scenario: 刷新未注册 provider 返回 404
- **WHEN** 客户端对未注册的 provider 名调用刷新端点
- **THEN** 端点返回 404（`not_found`），不执行任何刷新

### Requirement: 刷新机制与回退
刷新 SHALL 优先使用插件注册的 `refreshModels` 回调；插件未提供时 SHALL 回退到 SDK 的标准模型发现（`/v1/models`）。

#### Scenario: 插件定义 refreshModels 则调用
- **WHEN** 插件 provider 的 config 包含 `refreshModels` 且触发刷新
- **THEN** 该回调被调用，其返回的模型参与结果

#### Scenario: 无 refreshModels 时回退发现
- **WHEN** 插件 provider 的 config 不含 `refreshModels` 且触发刷新
- **THEN** 使用 SDK 标准模型发现路径（`/v1/models`），成功则返回发现的模型

### Requirement: 结果持久化
刷新发现的模型 SHALL 写入 models-store 持久化存储，后续 Providers 列表与模型选择可直接读取。

#### Scenario: 刷新后模型可再次读取
- **WHEN** 插件 provider 刷新成功且返回模型列表
- **THEN** 模型写入 models-store；再次调用 `GET /config/providers` 无需重新刷新即可看到这些模型

### Requirement: 刷新失败与超时
刷新失败（发现失败、鉴权失败、超时）SHALL 返回结构化错误（非 2xx），且 SHALL NOT 破坏已有模型数据或 Providers 列表。

#### Scenario: 刷新失败返回错误
- **WHEN** 插件 provider 刷新时发现端点不可达或返回鉴权错误
- **THEN** 端点返回结构化错误（含错误消息），已有 models-store 数据保持不变

#### Scenario: 刷新超时受限
- **WHEN** 插件 provider 的模型发现超过配置的刷新超时
- **THEN** 刷新中止并返回超时错误，不阻塞后续请求

---

## MODIFIED Requirements

<!-- 无既有 spec，本变更全部为新增 -->
