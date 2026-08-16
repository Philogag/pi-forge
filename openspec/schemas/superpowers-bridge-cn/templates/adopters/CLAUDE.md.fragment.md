<!-- Source: opsx-use-superpower-cn-schema/templates/adopters/CLAUDE.md.fragment.md -->
<!-- 把这一节贴进你项目的 CLAUDE.md，让 agent 知道如何分流本仓库使用本 schema 的工作。 -->
<!-- 若你定制了 schema 名称或 bridge 仓库 URL，请对应修改；否则保持原样即可。 -->

## 变更工作流（会话启动先读）

本仓库采用 [`superpowers-bridge-cn`](https://github.com/JiangWay/openspec-schemas/tree/main/superpowers-bridge)（简体中文版，来源：sdd-tdd-workflow 技能包 `opsx-use-superpower-cn-schema`）衔接 OpenSpec 与 Superpowers。整合规则（语言、artifact 路径、PRECHECK）以该 skill 的 README 为准；以下是给 agent 的 routing 指引。

### 入口分流

| 你看到的触发 | 应该怎么做 |
|---|---|
| 用户以 narrative 开「设计讨论 / 头脑风暴」 | 先 verbal `superpowers:brainstorming`，**不**写到 `docs/superpowers/specs/`；对话收敛后依下方 5 条判据升级到 `/opsx:propose` |
| 用户直接调用 `/opsx:new` / `/opsx:ff` / `/opsx:propose` | 走 schema 既定流程；artifact instruction 会在每步注入 |
| 用户明确说 bug fix / typo / config 微调 / 文档更新 | 直接 PR，**不**建 change（见下方 skip 规则） |
| 已经在某个 change 中 | `/opsx:continue` 或 `/opsx:apply` / `/opsx:verify` / `/opsx:archive` 推进 |

### 何时**不**走 opsx（直接 PR）

| 情境 | 直接 PR? |
|---|---|
| 新功能 / 新 capability / 架构变更 / breaking change | ❌ 要走 opsx |
| Bug fix（不变更合约）/ 测试补写 / linter 规则 / 非破坏性升级 / typo / 文档 / config 值微调 | ✅ 直接 PR |

原则：**流程仪式跟风险成正比**。动到对外合约 / schema / 跨系统接口 / 合规边界 → opsx；其他 → 直接 PR。

### Verbal brainstorm 升级到 opsx 的 5 条判据

5 条**全满足**才升级（任一缺则继续 brainstorm，不写到 `docs/superpowers/specs/`）：

1. **Scope 锁定** —— 一句话讲清「包含/不包含什么」
2. **主要设计分歧已收敛** —— 替代方案选过，剩下 TBD 有明确 owner 与影响面
3. **跨系统依赖盘点过** —— 对方就绪 / 暂 mock / 真未知，三选一讲得清
4. **验收条件可陈述** —— 具体 pass 条件（例：`./mvnw clean verify` 通过 + N 个成果）
5. **对话进入收敛** —— 最近几轮在 confirm 不在发散

全满足 → 主动建议用户「要不要 `/opsx:propose`?」，用户 ack 后落地。永远不要自动触发。

### Front-door 反模式（别做）

- 让 brainstorming 写到 `docs/superpowers/specs/`
- 让 writing-plans 写到 `docs/superpowers/plans/`
- TBD 没收敛就升级到 opsx
- 对 bug fix / typo 也建 change

详细见 [superpowers-bridge README §进入与离开的判断](https://github.com/JiangWay/openspec-schemas/blob/main/superpowers-bridge/README.zh-TW.md#進入與離開的判斷entry--exit-gates)。
