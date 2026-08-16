# Retrospective: optimize-providers-plugin-apikey

> Written: 2026-08-16 (after verify passed + manual dogfood fixes)
> Commit range: `affcd102..1da5b17`
> Worktree: `.worktrees/feat-optimize-providers-plugin-apikey`（待整合主线）

---

## 0. Evidence

- **Commit range**: `affcd102..1da5b17` (18 commits)
- **Diff size**: +1795 / -181 lines across 21 files
- **Tasks done**: 29/29 (`grep -cE '^\s*- \[x\]' tasks.md` → 29; 0 remaining)
- **Active hours**: ~1.5 cycles（propose + apply + verify + manual dogfood 修复）
- **Subagent dispatches**: 6 workers + 4 reviewers + 1 fix worker（含 2 次看门狗超时截断，产出仍有效）
- **New external dependencies**: none（复用 SDK 公开队列 `pendingProviderRegistrations` 与 `ModelRuntime`，零新增依赖）
- **Bugs encountered post-verify**: 2（① native provider 不可刷新——手工 dogfood 发现；② omniroute compat 目标文件错误——两次修正后对齐 v0.1.0）
- **OpenSpec validate state at archive**: 见归档前 `openspec validate --all`（apply 后通过）
- **Test coverage signal**: 145 assertions across 4 files（test-providers 53 / test-plugin-config 69 / test-plugin-config-api 18 / capture-off 5）+ 既有回归全绿

Commit chain:

```
affcd102 planning artifacts (openspec change + plan.md)
cf672a6 feat(providers): registry capturing extension registrations
9314bba feat(providers): refresh via ModelRuntime
c698db4 feat(providers): address batch A review (timeout, persistence, package parsing)
f2c6a8e feat(providers): merge plugin provider registry into providers listing
dd300ce feat(providers): POST /config/providers/:provider/refresh endpoint
d48d968 feat(compat): declare litellm and omniroute settings.json blocks
7876525 feat(api-client): refreshPluginProvider + listing types
4950c85 feat(ui): plugin provider badges, refresh button, config gear
f195bf7 test(providers): capture-off, isolation, settings preservation
9f4c5ac docs(providers): api/architecture notes + tasks done
b7eaee1 feat(providers): wire registry boot-time preload
be9faa3 docs(verify): verification report (PASS WITH WARNINGS)
425ff14 feat(providers): refresh native-registered plugin providers [dogfood fix ①]
68c55b3 fix(plugin-config): omniroute compat → omniroute.json [wrong direction]
477a4b1 fix(plugin-config): omniroute compat → settings.json block (v0.1.0) [dogfood fix ②]
3776236 fix(plugin-config): scoped package name matches provider via [dogfood fix ③]
e001afc refactor(plugin-config): split COMPAT_DECLARATIONS per-plugin files
1da5b17 fix(plugin-config): scoped name in settings PUT test (regression from 3776236)
```

---

## 1. Wins

- [evidence: my-pi-forge 手工验证] **全链路真实环境打通**：注册捕获 → 列表 via 徽标 → 刷新 → models-store 持久化 → 容器重启自动恢复（无需手动刷新）
- [evidence: 425ff14] **native provider 刷新支持**：单参数 `pi.registerProvider(provider)` 插件（omniroute）真实可刷新，走 `registerNativeProvider` 标准管线
- [evidence: 3776236 + e001afc] **scoped 包名全链路一致 + compat 每插件一文件**：声明 package 与 provider via / 扩展 name 精确匹配，配置按钮在真实插件上显示
- [evidence: 无新依赖] 全部复用 SDK 公开 API（队列读取、ModelRuntime、models-store），零新增依赖与导入面

## 2. Misses

- 🔴 [blocking | evidence: 425ff14] Batch A 审查对 m3（native 注册）的处置错误——把 native 标为「不可刷新」抛错；真实插件 omniroute 正是单参 native 注册，导致刷新 400。教训：**「少见形态」处置需查真实插件用法，不能仅凭接口形状判断**
- 🔴 [blocking | evidence: 68c55b3 → 477a4b1] omniroute 配置机制两次误判：先按旧调研（settings.json 块）→ 误读源码把迁移残留函数 `resolveOmnirouteConfigPath`（omniroute.json）当活跃路径 → 改错成 omniroute.json → 用户指出 v0.1.0 后重新核实（`readOmnirouteConfig` 读 settings.json 块）→ 修正。**源码阅读须区分活跃实现 vs 迁移残留；README 与源码不一致时以源码+实测为准**
- 🟡 [painful | evidence: 1da5b17] 3776236 只跑了 test-plugin-config.ts 就提交，scoped 改名导致 test-providers.ts 的 settings PUT 段 404 回归漏网（e001afc 全量测试才暴露）。**每次提交后跑全部相关测试文件，不能抽样**
- 📌 [nit | evidence: 手工验证] omniroute 插件模块加载时闭包捕获 baseUrl，改配置后需重启容器才生效——文档化即可，非本仓库缺陷

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 2.x refresh 持久化 | 列表侧 `registerProvider` + 显式 `await refresh({allowNetwork:false})` + pi-forge 自写 models-store | 评审 M1：SDK store-restore 只对已 compose provider 生效；allowNetwork 只禁网络阶段 |
| 5.x compat omniroute | 目标文件 settings.json→omniroute.json→settings.json | 两次误判后对齐 v0.1.0 官方机制（settings.json 块） |
| 7.x UI 齿轮 | 匹配规则 `d.package === p.via` 需声明用 scoped 全名 | omniroute 是 @scope/ 包，无 scope 名失配 |
| — 新增 | native provider 刷新支持（425ff14） | 原 plan 未覆盖；手工 dogfood 发现真实缺口 |
| — 新增 | COMPAT_DECLARATIONS 拆分为每插件一文件（e001afc） | 用户需求（非 plan 内） |

## 4. Skill / workflow compliance

| Skill | Used |
|-------|------|
| superpowers:brainstorming | ✓（brainstorm.md，Q1-Q4 决策链） |
| superpowers:writing-plans | ✓（plan.md，微步 checklist） |
| superpowers:using-git-worktrees | ✓（worktree + 符号链接 node_modules） |
| superpowers:subagent-driven-development | ✓（6 批次串行 + ledger） |
| (transitive) superpowers:test-driven-development | ✓（每任务测试先行） |
| (transitive) superpowers:requesting-code-review | ✓（A/B 评审 + 修复） |
| superpowers:finishing-a-development-branch | ✓（本次收尾） |

### Deliberately Skipped Skills

（空白——全部技能均实际使用）

## 5. Surprises

- omniroute **v0.1.0 即 npm latest**（不是 v0.0.2）；其官方配置机制是 settings.json 块（README 正确），旧 omniroute.json 仅是迁移源
- 我上一轮「omniroute.json 生效」的实测结论是错误因果：真正生效的是更早 PUT 的 settings.json 块，重启后才被闭包读到
- SDK `pendingProviderRegistrations` 公开队列让捕获零侵入（无需 Proxy hook）——比预期更干净

## 6. Promote candidates → long-term learning

- [ ] 🔴 **提交后跑全部相关测试文件，不抽样** → **Promote to project CLAUDE.md** (`AGENTS.md` 测试段)
  > **Why**: 3776236 抽样测试漏掉 scoped 回归，e001afc 全量才暴露
  > **How to apply**: 任何 schema/签名/包名改动提交前，`for t in tests/test-*相关*.ts; npx tsx $t` 全跑

- [ ] 🔴 **源码阅读区分活跃实现 vs 迁移残留** → **Promote to memory** (type: feedback)
  > **Why**: 把 `resolveOmnirouteConfigPath`（旧 omniroute.json）误当活跃读取点，得出相反结论
  > **How to apply**: 找配置读取点时沿「实际调用链」读（谁 import 谁、谁在 provider 构造里被调用），并用运行时实测验证，不信同名残留函数

- [ ] 🟡 **手工 dogfood（真实插件+生产环境）纳入变更验收** → **Promote to project CLAUDE.md**
  > **Why**: 3 个真实缺陷（native 刷新、配置机制、scoped 名）全部由 my-pi-forge 实测暴露，单测/评审未覆盖
  > **How to apply**: provider/扩展/配置类变更 verify 后，若有测试环境则部署实测关键路径（刷新、表单保存、按钮可见）

- [ ] 📌 **插件闭包捕获配置 → 改配置需重启** → **One-off** (记录即可)
  > **Why**: omniroute 模块加载时解析 baseUrl 并闭包捕获；这是插件行为，本仓库无法规避
  > **How to apply**: compat 声明 description 中提示重启生效；不做代码变更
