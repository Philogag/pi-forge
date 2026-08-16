<!--
Delta spec: plugin-provider-config
能力：插件 provider 配置表单化——compat 声明 settings.json 专属块
（litellm / pi-provider-omniroute），复用 plugin-config 表单/REST。
-->

## ADDED Requirements

### Requirement: 插件 provider 配置声明
pi-forge SHALL 在 extensions-settings-compat 中为插件 provider 的 settings.json 专属块提供配置声明（`litellm` 块、`pi-provider-omniroute` 块：baseUrl/search.provider/fetch.provider），使这些配置项可通过 plugin-config 表单编辑。

#### Scenario: litellm 配置可表单化
- **WHEN** 打开已安装 pi-provider-litellm 的配置表单
- **THEN** 表单包含 `litellm` 块的声明字段（如 baseUrl、headers），保存后写入 settings.json 的 `litellm` 块

#### Scenario: omniroute 配置可表单化
- **WHEN** 打开已安装 pi-provider-omniroute 的配置表单
- **THEN** 表单包含 `pi-provider-omniroute` 块的声明字段（baseUrl、search.provider、fetch.provider），枚举字段以下拉选择呈现

### Requirement: 部分更新保留未知键
通过表单保存 settings.json 块时 SHALL 只更新提交的字段，settings.json 中的其他键（含插件自身的未声明键与其他插件块）SHALL 保持不变。

#### Scenario: 更新 omniroute baseUrl 保留其余
- **WHEN** 表单提交仅修改 `pi-provider-omniroute.baseUrl`
- **THEN** settings.json 中 `pi-provider-omniroute` 块的 search/fetch 及其他键保持不变

### Requirement: 配置块缺失时的默认行为
settings.json 不存在或不含目标块时，配置表单 SHALL 正常打开并渲染声明字段（空值或 defaultValue），保存时创建对应块，且不破坏 settings.json 的其余内容。

#### Scenario: 首次保存创建配置块
- **WHEN** settings.json 尚无 `pi-provider-omniroute` 块，用户在表单填写 baseUrl 并保存
- **THEN** settings.json 被写入含该 baseUrl 的 `pi-provider-omniroute` 块，文件其余内容（若有）保持不变

---

## MODIFIED Requirements

<!-- 无既有 spec，本变更全部为新增 -->
