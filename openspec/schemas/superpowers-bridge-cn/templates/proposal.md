## Why

<!--
说明本次变更的动机。解决什么问题？为什么是现在？

硬限制：50 ≤ 字符数 ≤ 1000（OpenSpec zod schema 会 validate）
- 太短：会收到 `Why section must be at least 50 characters` error
- 太长：会收到 `Why section should not exceed 1000 characters` error

建议结构：现状痛点 → 为什么现在处理 → 预期收益（各 1-2 句）
-->

## What Changes

<!--
描述将发生什么变化。明确写出新增能力、修改内容或移除项。

对于有明确前后对比的行为变更，使用 From/To 格式（markdown 无 inline diff）：

**<Section or Behavior Name>**
- From: <当前状态 / 需求>
- To: <未来状态 / 需求>
- Reason: <为什么需要这个变更>
- Impact: <breaking / non-breaking, 谁受影响>

多个变更可重复此 block；纯新增或纯删除可用简单列表描述。
-->

## Capabilities

### New Capabilities
<!--
将引入的能力。把 <name> 替换为 kebab-case 标识符。
命名规则见 openspec/specs/README.md：使用复合名词（至少 2 个 word），
例如 `user-auth`、`data-export`、`api-rate-limiting`，不用纯单词。
每个能力创建 specs/<name>/spec.md
-->
- `<name>`: <该能力涵盖内容的简要描述>

### Modified Capabilities
<!--
需求（REQUIREMENTS）发生变化的既有能力（不只是实现变化）。
仅当 spec 层面的行为发生变化时列出。每个都需要一个 delta spec 文件。
使用 openspec/specs/ 下已存在的 spec 名称。若无需求变化则留空。
-->
- `<existing-name>`: <哪些需求在变化>

## Impact

<!-- 受影响的代码、API、依赖、系统 -->
