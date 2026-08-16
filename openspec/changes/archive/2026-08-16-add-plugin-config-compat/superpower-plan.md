---
change: add-plugin-config-compat
design-doc: openspec/changes/add-plugin-config-compat/superpower-design.md
base-ref: 009564e7aa116c23191d07c1d379136b45c9246f
---

# 插件配置文件兼容框架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi-forge 增加插件配置兼容框架：服务器捕获 `pi-extension-settings:register` 事件（与 `pi-extension-settings` 生态完全兼容，读写同一个 `~/.pi/agent/settings-extensions.json`），并提供本仓库内 `compat/` 注册入口（绑定插件自身 JSON 配置文件）；浏览器端在 Extensions 包卡片上提供齿轮入口，用声明驱动的前端表单编辑这些配置。

**Architecture:** 服务端新增 `plugin-config/` 四模块（types/paths/store/capture/registry）+ `compat/` 注册目录；`extensions-manager.ts` 暴露扩展入口路径枚举辅助函数；`routes/config.ts` 挂 `/api/v1/config/plugin-configs` 子面四个端点；客户端 `ExtensionsTab` 包卡片按声明渲染齿轮 → 新建 `PluginConfigModal`（表单控件 + raw JSON 切换）。捕获默认开启（`PLUGIN_CONFIG_CAPTURE`，启动后台预加载，不阻塞启动）。

**Tech Stack:** TypeScript、Fastify（OpenAPI schema）、React + Zustand（SettingsPanel）、`@earendil-works/pi-coding-agent`（`createEventBus`/`discoverAndLoadExtensions`/`DefaultPackageManager`）、lucide-react、CodeMirror（raw JSON 复用 `CodeMirrorEditor`）。

**Spec:** `openspec/changes/add-plugin-config-compat/superpower-design.md`（需求事实源：`proposal.md`、`specs/plugin-config/spec.md`、`design.md`）

## Global Constraints

- 所有服务端模块使用命名导出（AGENTS.md 约定 1）；无 default export
- 操作环境变量读取只在 `packages/server/src/config.ts`；每个 env 都有对应 CLI flag（`cli.ts`）；路径统一用 `config.workspacePath` / `config.piConfigDir`
- 路由只在 `packages/server/src/index.ts` 注册（prefix `/api/v1`），路由文件只导出 Fastify plugin；路由不得直接 import SDK 对象，SDK 交互经 `extensions-manager.ts` / `plugin-config/*`
- 配置文件数据写入保持原子写（`.tmp` + `rename`）约定；同文件并发经 `makeLock`（`concurrency.ts`）串行
- 遍历校验失败返回 403；结构化错误：校验 400、未注册 404 `not_found`、SDK/IO 崩溃 500 `{error:"agent_error"}`
- `settings-extensions.json`（pi-extension-settings 兼容文件）所有值写入前强制 `String()` 化，与 pi 端 `getSetting` 读取语义一致；compat 声明的自有 JSON 文件按字段类型写类型化值
- SDK 只能从包根 `@earendil-works/pi-coding-agent` import（exports map 无子路径，`loadExtensionsCached`/`loadExtensions` 不在包根导出）；捕获用根导出的 `discoverAndLoadExtensions(paths, cwd, agentDir, eventBus)`
- 配置文件位置仅限 `PI_CONFIG_DIR` 单层 JSON 文件名（`basename(file) === file`、`.json` 后缀、`realpath` 不越界）
- 捕获运行于启动后台（fire-and-forget），GET 不等待捕获；`PLUGIN_CONFIG_CAPTURE` 默认 `true`
- 客户端 API 调用一律经 `packages/client/src/lib/api-client/index.ts` 的 `request()`；组件不直接 `fetch()`
- 测试运行：`npm run build` 后 `npx tsx tests/test-xxx.ts`；`npm run check`（tsc + eslint + prettier）
- 捕获来源 `name` 与包名不一致时以事件负载 `name` 为 key（与 pi-extension-settings 语义一致）

---

### Task 1: 类型定义与 JSON path 工具

**Files:**
- Create: `packages/server/src/plugin-config/types.ts`
- Create: `packages/server/src/plugin-config/paths.ts`
- Test: `tests/test-plugin-config.ts`（本任务只含 path 单元测试段）

**Interfaces:**
- Produces:
  - `export type DeclarationSource = "extension-event" | "compat"`
  - `export interface ConfigDeclaration { package: string; file: string; label: string; description?: string; source: DeclarationSource; fields: FieldDefinition[] }`
  - `export interface ScalarField { kind: "scalar"; path: string; type: "string"|"number"|"boolean"|"enum"; label: string; description?: string; defaultValue?: unknown; required?: boolean; min?: number; max?: number; pattern?: string; secret?: boolean; enum?: { value: string; label: string }[] }`
  - `export interface MultiSelectField { kind: "multi-select"; path: string; label: string; description?: string; options: { id: string; label: string }[] }`
  - `export type FieldDefinition = ScalarField | MultiSelectField`
  - `export interface PluginConfigSummary { package: string; label: string; description?: string; file: string; source: DeclarationSource; exists: boolean; ready: boolean; fields: FieldDefinition[]; values: Record<string, unknown> }`
  - `export type SavePluginConfigBody = { values?: Record<string, unknown>; raw?: never } | { raw?: string; values?: never }`
  - `export interface PluginConfigListResponse { ready: boolean; declarations: PluginConfigSummary[]; errors: { path: string; error: string }[] }`
  - `export interface SettingDefinitionLike { id: string; label?: string; description?: string; defaultValue?: string; values?: string[]; options?: { id: string; label: string }[] }`（捕获侧 pi-extension-settings 负载形状）
  - `export function pathGet(root: unknown, path: string): unknown`（点分段 + `items[0]` 数组索引）
  - `export function pathSet(root: Record<string, unknown>, path: string, value: unknown): void`（沿段创建中间对象）
  - `export async function validateConfigFilePath(file: string, piConfigDir: string): Promise<{ ok: true; absPath: string } | { ok: false; error: string }>`

- [ ] **Step 1: 编写 path 单元测试（先红）**

```ts
// tests/test-plugin-config.ts（第 1 段）
import { pathGet, pathSet } from "../packages/server/src/plugin-config/paths.js";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  // pathGet
  assert("pathGet nested object", pathGet({ a: { b: 1 } }, "a.b") === 1);
  assert("pathGet array index", pathGet({ models: [{ name: "x" }] }, "models[0].name") === "x");
  assert("pathGet missing → undefined", pathGet({ a: 1 }, "a.b.c") === undefined);
  assert("pathGet root scalar", pathGet({ a: 1 }, "a") === 1);
  // pathSet
  const root: Record<string, unknown> = {};
  pathSet(root, "auth.apiKey", "k1");
  assert("pathSet creates intermediates", JSON.stringify(root) === '{"auth":{"apiKey":"k1"}}');
  pathSet(root, "models[0].name", "m1");
  assert("pathSet array index", JSON.stringify(root.models) === '[{"name":"m1"}]');
  pathSet(root, "auth.apiKey", "k2");
  assert("pathSet overwrites leaf", (root.auth as Record<string, unknown>).apiKey === "k2");
  // validateConfigFilePath
  const bad1 = await validateConfigFilePath("../escape.json", "/tmp/pi");
  assert("path validation rejects traversal", bad1.ok === false);
  const bad2 = await validateConfigFilePath("nested/settings.json", "/tmp/pi");
  assert("path validation rejects nested", bad2.ok === false);
  const bad3 = await validateConfigFilePath("settings.yaml", "/tmp/pi");
  assert("path validation rejects non-json", bad3.ok === false);
  const good = await validateConfigFilePath("settings-extensions.json", "/tmp/pi");
  assert("path validation accepts single json", good.ok === true);

  if (failures > 0) process.exit(1);
  console.log("plugin-config paths: ALL PASS");
}
void main();
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: FAIL（module not found / exports missing）

- [ ] **Step 3: 实现 types.ts 与 paths.ts**

```ts
// packages/server/src/plugin-config/paths.ts
import { basename, join, sep } from "node:path";
import { realpath } from "node:fs/promises";

export function parseSegments(path: string): (string | number)[] {
  return path.split(".").flatMap((seg) => {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(seg);
    if (m === null) return [seg];
    return m[2] !== undefined ? [m[1], Number(m[2])] : [m[1]];
  });
}

export function pathGet(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parseSegments(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      cur = Array.isArray(cur) ? (cur as unknown[])[seg] : undefined;
    } else {
      cur = typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
    }
  }
  return cur;
}

export function pathSet(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parseSegments(path);
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (typeof seg === "number") {
      const arr = cur as unknown[];
      if (!Array.isArray(arr)) throw new Error(`pathSet: expected array at "${path}"`);
      if (arr[seg] === undefined || arr[seg] === null || typeof arr[seg] !== "object") arr[seg] = {};
      cur = arr[seg] as Record<string, unknown>;
    } else {
      const obj = cur as Record<string, unknown>;
      if (obj[seg] === undefined || obj[seg] === null || typeof obj[seg] !== "object") obj[seg] = {};
      cur = obj[seg] as Record<string, unknown>;
    }
  }
  const last = segs[segs.length - 1];
  if (typeof last === "number") (cur as unknown[])[last] = value;
  else (cur as Record<string, unknown>)[last] = value;
}

export async function validateConfigFilePath(
  file: string,
  piConfigDir: string,
): Promise<{ ok: true; absPath: string } | { ok: false; error: string }> {
  if (file.length === 0 || basename(file) !== file) {
    return { ok: false, error: "config file must be a single filename (no path separators)" };
  }
  if (!file.endsWith(".json")) {
    return { ok: false, error: "config file must end in .json" };
  }
  const abs = join(piConfigDir, file);
  try {
    const real = await realpath(abs);
    const realDir = await realpath(piConfigDir);
    if (real !== realDir && !real.startsWith(realDir + sep)) {
      return { ok: false, error: "config file escapes PI_CONFIG_DIR" };
    }
  } catch {
    // not yet created — constraints 1+2 above already prevent traversal
  }
  return { ok: true, absPath: abs };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: PASS（paths: ALL PASS）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/plugin-config/types.ts packages/server/src/plugin-config/paths.ts tests/test-plugin-config.ts
git commit -m "feat(plugin-config): add declaration types and json-path utils"
```

### Task 2: 存储层 plugin-config/store.ts

**Files:**
- Create: `packages/server/src/plugin-config/store.ts`
- Test: `tests/test-plugin-config.ts`（追加 store 单元测试段）

**Interfaces:**
- Consumes: `validateConfigFilePath`（paths.ts）、`pathGet`/`pathSet`（paths.ts）、`FieldDefinition`（types.ts）、`makeLock`（`packages/server/src/concurrency.ts`）
- Produces:
  - `export interface DeclarationValues { exists: boolean; error?: "invalid_json"; values: Record<string, unknown> }`
  - `export async function readDeclarationValues(file: string, piConfigDir: string, fields: FieldDefinition[]): Promise<DeclarationValues>`（一次读：exists + 按字段 path 提取 values；文件缺失 → exists:false + 空 values；非法 JSON → exists:true + error:"invalid_json" + 空 values）
  - `export async function putValues(file: string, piConfigDir: string, values: Record<string, unknown>, opts?: { stringCoerce?: boolean }): Promise<void>`（读-改-写：重读现有文件保留未知键 → 逐字段 pathSet → 原子写；stringCoerce 时所有值 String() 化；文件不存在则从空对象开始）
  - `export async function putRaw(file: string, piConfigDir: string, raw: string): Promise<void>`（JSON.parse 校验 → 必须是 plain object → 原子替换）
  - `export function validateValues(fields: FieldDefinition[], values: Record<string, unknown>): { ok: true } | { ok: false; error: string; field?: string }`
  - `export class ConfigFileError extends Error { constructor(message: string, public readonly code: "invalid_json" | "validation" | "io" | "traversal") }`（路由层按 code 映射 400/403/500）

- [ ] **Step 1: 编写 store 单元测试（先红）**

```ts
// tests/test-plugin-config.ts（追加第 2 段）
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  putRaw, putValues, readDeclarationValues, validateValues,
} from "../packages/server/src/plugin-config/store.js";
import type { ConfigDeclaration } from "../packages/server/src/plugin-config/types.js";

const decl: ConfigDeclaration = {
  package: "demo",
  file: "demo.json",
  label: "Demo",
  source: "compat",
  fields: [
    { kind: "scalar", path: "greeting", type: "string", label: "Greeting", required: true },
    { kind: "scalar", path: "retries", type: "number", label: "Retries", min: 0, max: 10 },
    { kind: "scalar", path: "color", type: "enum", label: "Color", enum: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] },
    { kind: "multi-select", path: "tags", label: "Tags", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  ],
};

async function mainStore(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-forge-pc-store-"));
  const file = "demo.json";
  const abs = join(dir, file);
  // read missing
  const miss = await readDeclarationValues(file, dir, decl.fields);
  assert("read missing file → exists:false", miss.exists === false);
  assert("read missing file → empty values", Object.keys(miss.values).length === 0);
  // putValues creates file + preserves unknown keys
  await writeFile(abs, JSON.stringify({ other: { keep: 1 } }));
  await putValues(file, dir, { greeting: "hi", retries: 3, color: "red", tags: ["a", "b"] });
  const saved = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
  assert("putValues preserves unknown keys", (saved.other as Record<string, unknown>).keep === 1);
  assert("putValues writes nested + typed", saved.greeting === "hi" && saved.retries === 3);
  assert("putValues writes multi-select array", JSON.stringify(saved.tags) === '["a","b"]');
  // stringCoerce
  await putValues(file, dir, { retries: 5 }, { stringCoerce: true });
  const coerced = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
  assert("stringCoerce converts to string", coerced.retries === "5");
  // readDeclarationValues roundtrip
  const got = await readDeclarationValues(file, dir, decl.fields);
  assert("read extracts declared paths", got.values.greeting === "hi");
  // invalid json
  await writeFile(abs, "{ not json");
  const bad = await readDeclarationValues(file, dir, decl.fields);
  assert("invalid json → error flag", bad.error === "invalid_json" && bad.exists === true);
  // putRaw replaces whole file
  await putRaw(file, dir, JSON.stringify({ fresh: true }));
  const replaced = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
  assert("putRaw replaces file", replaced.fresh === true && (replaced as Record<string, unknown>).greeting === undefined);
  let threw = false;
  try { await putRaw(file, dir, "{ nope"); } catch { threw = true; }
  assert("putRaw invalid json throws ConfigFileError", threw === true);
  // validateValues
  const okV = validateValues(decl.fields, { greeting: "x", retries: 1, color: "red", tags: ["a"] });
  assert("validateValues accepts valid", okV.ok === true);
  const badV = validateValues(decl.fields, { greeting: "x", retries: 99 });
  assert("validateValues rejects max", badV.ok === false && badV.field === "retries");
  const badE = validateValues(decl.fields, { greeting: "x", color: "green" });
  assert("validateValues rejects enum", badE.ok === false && badE.field === "color");
  const badT = validateValues(decl.fields, { greeting: "x", tags: ["zzz"] });
  assert("validateValues rejects multi id", badT.ok === false && badT.field === "tags");
  const badU = validateValues(decl.fields, { greeting: "x", unknownPath: 1 });
  assert("validateValues rejects unknown path", badU.ok === false && badU.field === "unknownPath");
  if (failures > 0) process.exit(1);
  console.log("plugin-config store: ALL PASS");
}
```
（在 `main()` 内 `await mainStore()` 串行调用；`decl` 放文件顶部，`putValues` 数字校验用例在 store 实现中允许 number 也接受字符串？——统一严格：number 字段接受 `typeof === "number"`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: FAIL（store module not found）

- [ ] **Step 3: 实现 store.ts**

```ts
// packages/server/src/plugin-config/store.ts
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeLock } from "../concurrency.js";
import { pathGet, pathSet, validateConfigFilePath } from "./paths.js";
import type { FieldDefinition } from "./types.js";

export class ConfigFileError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_json" | "validation" | "io" | "traversal",
  ) {
    super(message);
    this.name = "ConfigFileError";
  }
}

export interface DeclarationValues {
  exists: boolean;
  error?: "invalid_json";
  values: Record<string, unknown>;
}

const fileLocks = new Map<string, ReturnType<typeof makeLock>>();
function getLock(file: string) {
  let lock = fileLocks.get(file);
  if (lock === undefined) { lock = makeLock(); fileLocks.set(file, lock); }
  return lock;
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absPath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw new ConfigFileError(`failed to write ${absPath}: ${(err as Error).message}`, "io");
  }
}

async function readFileState(file: string, piConfigDir: string): Promise<{ abs: string; exists: boolean; error?: "invalid_json"; root: Record<string, unknown> }> {
  const check = await validateConfigFilePath(file, piConfigDir);
  if (!check.ok) throw new ConfigFileError(check.error, "traversal");
  const { absPath } = check;
  try {
    const raw = await readFile(absPath, "utf8");
    let root: unknown;
    try { root = JSON.parse(raw); } catch {
      return { abs: absPath, exists: true, error: "invalid_json", root: {} };
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      return { abs: absPath, exists: true, error: "invalid_json", root: {} };
    }
    return { abs: absPath, exists: true, root: root as Record<string, unknown> };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { abs: absPath, exists: false, root: {} };
    }
    throw new ConfigFileError(`failed to read ${absPath}: ${(err as Error).message}`, "io");
  }
}

export async function readDeclarationValues(
  file: string,
  piConfigDir: string,
  fields: FieldDefinition[],
): Promise<DeclarationValues> {
  const state = await readFileState(file, piConfigDir);
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const v = pathGet(state.root, f.path);
    if (v !== undefined) values[f.path] = v;
  }
  const out: DeclarationValues = { exists: state.exists, values };
  if (state.error !== undefined) out.error = state.error;
  return out;
}

export async function putValues(
  file: string,
  piConfigDir: string,
  values: Record<string, unknown>,
  opts?: { stringCoerce?: boolean },
): Promise<void> {
  const check = await validateConfigFilePath(file, piConfigDir);
  if (!check.ok) throw new ConfigFileError(check.error, "traversal");
  const { absPath } = check;
  await getLock(file)(async () => {
    const state = await readFileState(file, piConfigDir);
    const root = state.root;
    for (const [path, value] of Object.entries(values)) {
      pathSet(root, path, opts?.stringCoerce === true ? String(value) : value);
    }
    await atomicWrite(absPath, `${JSON.stringify(root, null, 2)}\n`);
  });
}

export async function putRaw(file: string, piConfigDir: string, raw: string): Promise<void> {
  const check = await validateConfigFilePath(file, piConfigDir);
  if (!check.ok) throw new ConfigFileError(check.error, "traversal");
  const { absPath } = check;
  let root: unknown;
  try { root = JSON.parse(raw); } catch {
    throw new ConfigFileError("raw config is not valid JSON", "invalid_json");
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new ConfigFileError("raw config must be a JSON object", "invalid_json");
  }
  await getLock(file)(() => atomicWrite(absPath, `${JSON.stringify(root, null, 2)}\n`));
}

export function validateValues(
  fields: FieldDefinition[],
  values: Record<string, unknown>,
): { ok: true } | { ok: false; error: string; field?: string } {
  const byPath = new Map(fields.map((f) => [f.path, f]));
  for (const [path, value] of Object.entries(values)) {
    const f = byPath.get(path);
    if (f === undefined) return { ok: false, error: `unknown field path "${path}"`, field: path };
    if (f.kind === "multi-select") {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && f.options.some((o) => o.id === v))) {
        return { ok: false, error: `field "${path}" must be an array of option ids`, field: path };
      }
      continue;
    }
    switch (f.type) {
      case "string":
        if (typeof value !== "string") return { ok: false, error: `field "${path}" must be a string`, field: path };
        if (f.pattern !== undefined) {
          try { if (!new RegExp(f.pattern).test(value)) return { ok: false, error: `field "${path}" does not match ${f.pattern}`, field: path }; }
          catch { return { ok: false, error: `field "${path}" has an invalid pattern in its declaration`, field: path }; }
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) return { ok: false, error: `field "${path}" must be a number`, field: path };
        if (f.min !== undefined && value < f.min) return { ok: false, error: `field "${path}" must be >= ${f.min}`, field: path };
        if (f.max !== undefined && value > f.max) return { ok: false, error: `field "${path}" must be <= ${f.max}`, field: path };
        break;
      case "boolean":
        if (typeof value !== "boolean") return { ok: false, error: `field "${path}" must be a boolean`, field: path };
        break;
      case "enum":
        if (typeof value !== "string" || !f.enum?.some((e) => e.value === value)) {
          return { ok: false, error: `field "${path}" must be one of ${(f.enum ?? []).map((e) => e.value).join(", ")}`, field: path };
        }
        break;
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: PASS（store: ALL PASS）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/plugin-config/store.ts tests/test-plugin-config.ts
git commit -m "feat(plugin-config): add atomic config file store with path-set writes"
```

### Task 3: compat 注册入口

**Files:**
- Create: `packages/server/src/extensions-settings-compat/index.ts`
- Create: `packages/server/src/extensions-settings-compat/README.md`
- Test: `tests/test-plugin-config.ts`（追加 compat 校验测试段）

**Interfaces:**
- Consumes: `ConfigDeclaration`（types.ts）
- Produces:
  - `export const COMPAT_DECLARATIONS: ConfigDeclaration[]`（本仓库手动注册表；首期为 `[]`，结构就位 + README 指引）
  - `export function validateCompatDeclarations(decls: ConfigDeclaration[]): string[]`（返回错误列表：file 非法、字段 path 为空、type/enum 冲突等；空数组 → `[]`）

- [ ] **Step 1: 创建 compat 目录与 README（含完整示例）**

```markdown
<!-- packages/server/src/extensions-settings-compat/README.md -->
# Compat 注册入口

为不走 `pi-extension-settings` 的插件在 pi-forge 中提供浏览器端配置表单。
每个包一个文件（如 `compat/<package-name>.ts`），导出 `ConfigDeclaration`，
在 `extensions-settings-compat/index.ts` 汇总到 `COMPAT_DECLARATIONS`。

```ts
// compat/my-plugin.ts —— 示例
import type { ConfigDeclaration } from "../plugin-config/types.js";
export const myPluginDeclaration: ConfigDeclaration = {
  package: "my-plugin",
  file: "my-plugin.json",      // 仅 PI_CONFIG_DIR 下单层 JSON 文件名
  label: "My Plugin",
  description: "本地手动注册的示例",
  source: "compat",
  fields: [
    { kind: "scalar", path: "apiKey", type: "string", label: "API Key", secret: true, description: "调用密钥" },
    { kind: "scalar", path: "timeoutMs", type: "number", label: "Timeout (ms)", min: 0, max: 60000 },
    { kind: "scalar", path: "level", type: "enum", label: "Log Level", enum: [{ value: "info", label: "Info" }, { value: "debug", label: "Debug" }] },
    { kind: "multi-select", path: "features", label: "Features", options: [{ id: "cache", label: "Cache" }, { id: "sync", label: "Sync" }] },
  ],
};
```

字段能力：string / number / boolean / enum / multi-select；`path` 支持嵌套点路径与数组索引（如 `auth.apiKey`、`models[0].name`）；`secret` 字段输入框以密码形式显示。
```

- [ ] **Step 2: 创建 compat/index.ts 并实现校验（TDD：先写校验测试）**

```ts
// tests/test-plugin-config.ts（追加第 3 段）
import { validateCompatDeclarations } from "../packages/server/src/extensions-settings-compat/index.js";

async function mainCompat(): Promise<void> {
  const good: ConfigDeclaration[] = [{ package: "p", file: "p.json", label: "P", source: "compat", fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }] }];
  assert("compat valid declaration → no errors", validateCompatDeclarations(good).length === 0);
  const badPath: ConfigDeclaration[] = [{ package: "p", file: "../evil.json", label: "P", source: "compat", fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }] }];
  assert("compat rejects traversal file", validateCompatDeclarations(badPath).length === 1);
  const badField: ConfigDeclaration[] = [{ package: "p", file: "p.json", label: "P", source: "compat", fields: [{ kind: "scalar", path: "", type: "string", label: "A" }] }];
  assert("compat rejects empty field path", validateCompatDeclarations(badField).length === 1);
  const dupPkg: ConfigDeclaration[] = [
    { package: "p", file: "p.json", label: "P", source: "compat", fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }] },
    { package: "p", file: "q.json", label: "Q", source: "compat", fields: [{ kind: "scalar", path: "b", type: "string", label: "B" }] },
  ];
  assert("compat rejects duplicate package", validateCompatDeclarations(dupPkg).length === 1);
  if (failures > 0) process.exit(1);
  console.log("plugin-config compat: ALL PASS");
}
```

```ts
// packages/server/src/extensions-settings-compat/index.ts
import { basename } from "node:path";
import type { ConfigDeclaration } from "../plugin-config/types.js";

export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  // 每个需要兼容的插件在此追加声明；详见 ./README.md
];

export function validateCompatDeclarations(decls: ConfigDeclaration[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const d of decls) {
    if (seen.has(d.package)) errors.push(`duplicate compat declaration for package "${d.package}"`);
    seen.add(d.package);
    if (d.source !== "compat") errors.push(`compat declaration "${d.package}" must set source: "compat"`);
    if (d.file.length === 0 || basename(d.file) !== d.file || !d.file.endsWith(".json")) {
      errors.push(`compat declaration "${d.package}" has invalid file "${d.file}"`);
    }
    for (const f of d.fields) {
      if (f.path.length === 0) errors.push(`compat declaration "${d.package}" has a field with empty path`);
      if (f.kind === "scalar" && f.type === "enum" && (f.enum === undefined || f.enum.length === 0)) {
        errors.push(`compat declaration "${d.package}" enum field "${f.path}" needs enum values`);
      }
      if (f.kind === "multi-select" && f.options.length === 0) {
        errors.push(`compat declaration "${d.package}" multi-select field "${f.path}" needs options`);
      }
    }
  }
  return errors;
}

// 启动期由 registry 调用，注册错误打印 diagnostics 而不阻断
```

- [ ] **Step 3: 运行确认通过**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: PASS（compat: ALL PASS）

- [ ] **Step 4: 提交**

```bash
git add packages/server/src/extensions-settings-compat/ tests/test-plugin-config.ts
git commit -m "feat(plugin-config): add in-repo compat registration entry"
```

### Task 4: 捕获模块 capture.ts + extensions-manager 辅助导出

**Files:**
- Modify: `packages/server/src/extensions-manager.ts`（新增 `resolveEnabledExtensionPaths`）
- Create: `packages/server/src/plugin-config/capture.ts`
- Test: `tests/test-plugin-config.ts`（追加 capture 单元测试段：归一映射 + temp 扩展文件加载）

**Interfaces:**
- Consumes: `createEventBus`、`discoverAndLoadExtensions`（`@earendil-works/pi-coding-agent` 包根）、`resolveEnabledExtensionPaths`（extensions-manager）、`SettingDefinitionLike`/`ConfigDeclaration`/`FieldDefinition`（types.ts）
- Produces:
  - `export async function resolveEnabledExtensionPaths(cwd: string, agentDir: string): Promise<string[]>`（extensions-manager.ts：`DefaultPackageManager.resolve().extensions` 中 `enabled && metadata.source` 非空 的 path，去重）
  - `export interface CapturedRegistration { name: string; settings: SettingDefinitionLike[] }`
  - `export interface CaptureResult { registrations: CapturedRegistration[]; errors: { path: string; error: string }[] }`
  - `export async function captureExtensionSettings(cwd: string, agentDir: string): Promise<CaptureResult>`（建 eventBus → 订阅 `pi-extension-settings:register`（校验负载形状，非法丢弃）→ `resolveEnabledExtensionPaths` → `discoverAndLoadExtensions(paths, cwd, agentDir, eventBus)` → 返回注册与 errors）
  - `export function normalizeRegistration(reg: CapturedRegistration): ConfigDeclaration`（归一映射：`options` → multi-select；`values` → enum scalar；否则 string scalar；`path = id`、`defaultValue` 字符串原样）

- [ ] **Step 1: 编写 capture 单元测试（先红）**

```ts
// tests/test-plugin-config.ts（追加第 4 段）
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureExtensionSettings, normalizeRegistration } from "../packages/server/src/plugin-config/capture.js";
import type { CapturedRegistration } from "../packages/server/src/plugin-config/capture.js";

async function mainCapture(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-forge-pc-capture-"));
  // temp 全局扩展目录：agentDir/extensions/settings-sample.js
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(join(dir, "extensions", "settings-sample.js"), `export default function (api) {
  api.events.emit("pi-extension-settings:register", {
    name: "ext-settings-sample",
    settings: [
      { id: "greeting", label: "Greeting", defaultValue: "hi", values: ["hi", "hello"] },
      { id: "tags", label: "Tags", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "name", label: "Name" },
    ],
  });
};\n`);
  const res = await captureExtensionSettings(dir, dir);
  assert("capture loads temp extension", res.registrations.length === 1, JSON.stringify(res.registrations));
  assert("capture records no load errors", res.errors.length === 0, JSON.stringify(res.errors));
  const decl = normalizeRegistration(res.registrations[0]);
  assert("normalize: package = event name", decl.package === "ext-settings-sample");
  assert("normalize: file = settings-extensions.json", decl.file === "settings-extensions.json");
  const byPath = new Map(decl.fields.map((f) => [f.path, f]));
  const enumF = byPath.get("greeting");
  assert("normalize: values → enum scalar", enumF?.kind === "scalar" && enumF.type === "enum" && (enumF.enum?.length ?? 0) === 2);
  const multiF = byPath.get("tags");
  assert("normalize: options → multi-select", multiF?.kind === "multi-select" && multiF.options.length === 2);
  const strF = byPath.get("name");
  assert("normalize: bare id → string scalar", strF?.kind === "scalar" && strF.type === "string");
  // 非法负载被丢弃
  await writeFile(join(dir, "extensions", "bad-sample.js"), `export default function (api) {
  api.events.emit("pi-extension-settings:register", { nope: true });
  throw new Error("boom");
};\n`);
  const res2 = await captureExtensionSettings(dir, dir);
  assert("capture drops invalid payloads", res2.registrations.length === 1);
  assert("capture surfaces load errors", res2.errors.length === 1, JSON.stringify(res2.errors));
  if (failures > 0) process.exit(1);
  console.log("plugin-config capture: ALL PASS");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: FAIL（capture module not found）

- [ ] **Step 3: 实现**

```ts
// packages/server/src/extensions-manager.ts —— 追加（复用既有 createPackageManager）
export async function resolveEnabledExtensionPaths(cwd: string, agentDir: string): Promise<string[]> {
  const pm = await createPackageManager(cwd, agentDir);
  const resolved = await pm.resolve();
  const paths = new Set<string>();
  for (const r of resolved.extensions) {
    if (!r.enabled) continue;
    const src = r.metadata.source;
    if (typeof src !== "string" || src.length === 0) continue;
    paths.add(r.path);
  }
  return [...paths];
}
```

```ts
// packages/server/src/plugin-config/capture.ts
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { resolveEnabledExtensionPaths } from "../extensions-manager.js";
import type { ConfigDeclaration, FieldDefinition, SettingDefinitionLike } from "./types.js";

export interface CapturedRegistration {
  name: string;
  settings: SettingDefinitionLike[];
}
export interface CaptureResult {
  registrations: CapturedRegistration[];
  errors: { path: string; error: string }[];
}

function parseRegisterEvent(data: unknown): CapturedRegistration | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.name !== "string" || d.name.length === 0) return undefined;
  if (!Array.isArray(d.settings)) return undefined;
  const settings: SettingDefinitionLike[] = [];
  for (const s of d.settings) {
    if (typeof s !== "object" || s === null) return undefined;
    const rec = s as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
    const out: SettingDefinitionLike = { id: rec.id };
    if (typeof rec.label === "string") out.label = rec.label;
    if (typeof rec.description === "string") out.description = rec.description;
    if (typeof rec.defaultValue === "string") out.defaultValue = rec.defaultValue;
    if (Array.isArray(rec.values) && rec.values.every((v) => typeof v === "string")) out.values = rec.values as string[];
    if (
      Array.isArray(rec.options) &&
      rec.options.every((o) => typeof o === "object" && o !== null && typeof (o as Record<string, unknown>).id === "string")
    ) {
      out.options = (rec.options as { id: string; label?: string }[]).map((o) => ({
        id: o.id,
        label: typeof o.label === "string" ? o.label : o.id,
      }));
    }
    settings.push(out);
  }
  return { name: d.name, settings };
}

export async function captureExtensionSettings(cwd: string, agentDir: string): Promise<CaptureResult> {
  const eventBus = createEventBus();
  const registrations: CapturedRegistration[] = [];
  eventBus.on("pi-extension-settings:register", (data: unknown) => {
    const parsed = parseRegisterEvent(data);
    if (parsed !== undefined) registrations.push(parsed);
  });
  const entryPaths = await resolveEnabledExtensionPaths(cwd, agentDir);
  const result = await discoverAndLoadExtensions(entryPaths, cwd, agentDir, eventBus);
  return { registrations, errors: result.errors };
}

export function normalizeRegistration(reg: CapturedRegistration): ConfigDeclaration {
  const fields: FieldDefinition[] = reg.settings.map((s) => {
    const base = { path: s.id, label: s.label ?? s.id } as const;
    if (s.options !== undefined && s.options.length > 0) {
      return { kind: "multi-select", ...base, description: s.description, options: s.options };
    }
    if (s.values !== undefined && s.values.length > 0) {
      return {
        kind: "scalar", ...base, type: "enum", description: s.description,
        defaultValue: s.defaultValue, enum: s.values.map((v) => ({ value: v, label: v })),
      };
    }
    return { kind: "scalar", ...base, type: "string", description: s.description, defaultValue: s.defaultValue };
  });
  return {
    package: reg.name,
    file: "settings-extensions.json",
    label: reg.name,
    source: "extension-event",
    fields,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: PASS（capture: ALL PASS）
注意：`discoverAndLoadExtensions` 还会扫描 `.pi/extensions` 与 `agentDir/extensions` 目录——本测试即利用后者；真实环境中任何扩展（包或顶层）注册设置都合法。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/extensions-manager.ts packages/server/src/plugin-config/capture.ts tests/test-plugin-config.ts
git commit -m "feat(plugin-config): capture pi-extension-settings register events"
```

### Task 5: 注册表 plugin-config/registry.ts

**Files:**
- Create: `packages/server/src/plugin-config/registry.ts`
- Test: `tests/test-plugin-config.ts`（追加 registry 单元测试段：合并优先级 + refresh 状态）

**Interfaces:**
- Consumes: `captureExtensionSettings`/`normalizeRegistration`（capture.ts）、`COMPAT_DECLARATIONS`/`validateCompatDeclarations`（compat/index.ts）、`ConfigDeclaration`（types.ts）
- Produces:
  - `export type RegistryStatus = "idle" | "loading" | "ready" | "error"`
  - `export interface RegistryState { status: RegistryStatus; ready: boolean; declarations: ConfigDeclaration[]; errors: { path: string; error: string }[] }`
  - `export interface RegistryDeps { cwd: string; agentDir: string; captureEnabled: boolean }`
  - `export function configurePluginConfigRegistry(deps: RegistryDeps): void`
  - `export async function refreshPluginConfigs(): Promise<RegistryState>`（capture → normalize → merge(COMPAT) → 更新状态；捕获抛错 → status:"error" 不抛出）
  - `export function getPluginConfigState(): RegistryState`
  - `export function getConfigDeclaration(pkg: string): ConfigDeclaration | undefined`
  - `export function mergeDeclarations(capture: ConfigDeclaration[], compat: ConfigDeclaration[]): ConfigDeclaration[]`（同包：capture 整包优先（source 保留 extension-event），compat 中 capture 未覆盖的字段 path 追加；异包各自保留；输出顺序 compat 在前、capture 新增在后）

- [ ] **Step 1: 编写 merge/refresh 单元测试（先红）**

```ts
// tests/test-plugin-config.ts（追加第 5 段）
import {
  configurePluginConfigRegistry, getConfigDeclaration, getPluginConfigState, mergeDeclarations, refreshPluginConfigs,
} from "../packages/server/src/plugin-config/registry.js";

async function mainRegistry(): Promise<void> {
  const mk = (pkg: string, fields: FieldDefinition[], source: "extension-event" | "compat"): ConfigDeclaration => ({
    package: pkg, file: source === "extension-event" ? "settings-extensions.json" : `${pkg}.json`,
    label: pkg, source, fields,
  });
  const cap = mk("shared", [{ kind: "scalar", path: "a", type: "string", label: "A" }], "extension-event");
  const comp = mk("shared", [
    { kind: "scalar", path: "a", type: "string", label: "A2" },
    { kind: "scalar", path: "b", type: "number", label: "B" },
  ], "compat");
  const onlyCompat = mk("only-compat", [{ kind: "scalar", path: "x", type: "string", label: "X" }], "compat");
  const merged = mergeDeclarations([cap], [comp, onlyCompat]);
  const shared = merged.find((d) => d.package === "shared");
  assert("merge keeps compat-only package", merged.some((d) => d.package === "only-compat"));
  assert("merge: capture wins source", shared?.source === "extension-event");
  assert("merge: capture file wins", shared?.file === "settings-extensions.json");
  assert("merge: capture field wins at path a", shared?.fields.find((f) => f.path === "a")?.label === "A");
  assert("merge: compat supplements field b", shared?.fields.some((f) => f.path === "b") === true);
  // refresh 状态机（注入真实 capture：临时扩展目录）
  const dir = await mkdtemp(join(tmpdir(), "pi-forge-pc-reg-"));
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(join(dir, "extensions", "sample.js"), `export default function (api) {
  api.events.emit("pi-extension-settings:register", { name: "from-ext", settings: [{ id: "k", label: "K" }] });
};\n`);
  configurePluginConfigRegistry({ cwd: dir, agentDir: dir, captureEnabled: true });
  const st = await refreshPluginConfigs();
  assert("refresh → ready", st.ready === true && st.status === "ready");
  assert("refresh captures extension declaration", getConfigDeclaration("from-ext") !== undefined);
  assert("refresh state accessible", getPluginConfigState().declarations.length >= 1);
  configurePluginConfigRegistry({ cwd: dir, agentDir: dir, captureEnabled: false });
  const st2 = await refreshPluginConfigs();
  assert("capture disabled → no extension declarations", getConfigDeclaration("from-ext") === undefined && st2.ready === true);
  if (failures > 0) process.exit(1);
  console.log("plugin-config registry: ALL PASS");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: FAIL（registry module not found）

- [ ] **Step 3: 实现 registry.ts**

```ts
// packages/server/src/plugin-config/registry.ts
import { COMPAT_DECLARATIONS, validateCompatDeclarations } from "../extensions-settings-compat/index.js";
import { captureExtensionSettings, normalizeRegistration } from "./capture.js";
import type { ConfigDeclaration, FieldDefinition } from "./types.js";

export type RegistryStatus = "idle" | "loading" | "ready" | "error";
export interface RegistryState {
  status: RegistryStatus;
  ready: boolean;
  declarations: ConfigDeclaration[];
  errors: { path: string; error: string }[];
}
export interface RegistryDeps {
  cwd: string;
  agentDir: string;
  captureEnabled: boolean;
}

let deps: RegistryDeps | undefined;
let state: RegistryState = { status: "idle", ready: false, declarations: [], errors: [] };

export function configurePluginConfigRegistry(d: RegistryDeps): void {
  deps = d;
}

export function mergeDeclarations(capture: ConfigDeclaration[], compat: ConfigDeclaration[]): ConfigDeclaration[] {
  const compatByPkg = new Map(compat.map((d) => [d.package, d]));
  const out: ConfigDeclaration[] = [];
  const seen = new Set<string>();
  for (const cd of capture) {
    const cp = compatByPkg.get(cd.package);
    seen.add(cd.package);
    if (cp === undefined) { out.push(cd); continue; }
    const compatFields = new Map(cp.fields.map((f) => [f.path, f]));
    const capturePaths = new Set(cd.fields.map((f) => f.path));
    const supplement: FieldDefinition[] = [];
    for (const [p, f] of compatFields) {
      if (!capturePaths.has(p)) supplement.push(f);
    }
    out.push({ ...cd, fields: [...cd.fields, ...supplement] });
  }
  for (const cp of compat) {
    if (!seen.has(cp.package)) out.push(cp);
  }
  return out;
}

export async function refreshPluginConfigs(): Promise<RegistryState> {
  if (deps === undefined) throw new Error("plugin-config registry not configured");
  state = { ...state, status: "loading", ready: false };
  const compatErrors = validateCompatDeclarations(COMPAT_DECLARATIONS);
  try {
    const captured = deps.captureEnabled
      ? await captureExtensionSettings(deps.cwd, deps.agentDir)
      : { registrations: [], errors: [] };
    const captureDecls = captured.registrations.map(normalizeRegistration);
    const declarations = mergeDeclarations(captureDecls, COMPAT_DECLARATIONS);
    const errors = [
      ...captured.errors,
      ...compatErrors.map((e) => ({ path: "<compat>", error: e })),
    ];
    state = { status: "ready", ready: true, declarations, errors };
  } catch (err) {
    state = {
      status: "error",
      ready: false,
      declarations: state.declarations,
      errors: [...state.errors, { path: "<registry>", error: (err as Error).message }],
    };
  }
  return state;
}

export function getPluginConfigState(): RegistryState {
  return state;
}

export function getConfigDeclaration(pkg: string): ConfigDeclaration | undefined {
  return state.declarations.find((d) => d.package === pkg);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx tests/test-plugin-config.ts`
Expected: PASS（registry: ALL PASS）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/plugin-config/registry.ts tests/test-plugin-config.ts
git commit -m "feat(plugin-config): declaration registry with capture+compat merge"
```

### Task 6: REST 端点 /config/plugin-configs

**Files:**
- Modify: `packages/server/src/routes/config.ts`
- Test: `tests/test-plugin-config-api.ts`（新建，集成：buildServer + 临时 PI_CONFIG_DIR）

**Interfaces:**
- Consumes: `getPluginConfigState`/`getConfigDeclaration`/`refreshPluginConfigs`（registry.ts）、`readDeclarationValues`/`putRaw`/`putValues`/`validateValues`/`ConfigFileError`（store.ts）、`config`（`../config.js`）、`errorSchema`（`./_schemas.js`）、`PluginConfigSummary`/`SavePluginConfigBody`/`PluginConfigListResponse`（types.ts）
- Produces: 端点（FastifyPlugin 内 `configRoutes` 增补，tags: ["config"]）：
  - `GET /config/plugin-configs` → 200 `PluginConfigListResponse`（每项含 values 按字段 path 提取；文件缺失 exists:false；非法 JSON exists:true 且 values 空；捕获未 ready 时 ready:false 照常返回快照）
  - `GET /config/plugin-configs/:package` → 200 `PluginConfigSummary` | 404 `{error:"not_found"}`
  - `PUT /config/plugin-configs/:package`（body `{values?}` 或 `{raw?}`，互斥）→ 200 `{ok:true}`；校验失败 400 `{error:"validation_failed", message, field?}`；raw 非法 JSON 400 `{error:"invalid_json"}`；越界 403 `{error:"traversal"}`；IO 500 `{error:"agent_error"}`；未注册 404
  - `POST /config/plugin-configs/reload` → 200 `{reloaded:true}`（fire-and-forget 触发 refresh）

- [ ] **Step 1: 编写集成测试（先红）**

```ts
// tests/test-plugin-config-api.ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function jget(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}
async function jsend(base: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-pc-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-pc-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-pc-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD; delete process.env.JWT_SECRET; delete process.env.API_KEY;

  // 捕获源：临时全局扩展
  await mkdir(join(configDir, "extensions"), { recursive: true });
  await writeFile(join(configDir, "extensions", "settings-sample.js"), `export default function (api) {
  api.events.emit("pi-extension-settings:register", {
    name: "ext-settings-sample",
    settings: [{ id: "greeting", label: "Greeting", defaultValue: "hi", values: ["hi", "hello"] }],
  });
};\n`);

  const buildModule = (await import(resolve(repoRoot, "packages/server/dist/index.js"))) as unknown as {
    buildServer: () => Promise<{ listen: (o: { port: number; host: string }) => Promise<string>; close: () => Promise<void> }>;
  };
  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });
  const pc = (p: string) => `${base}/api/v1/config/plugin-configs${p}`;

  try {
    // 1. 捕获注册可见（先 reload 确保捕获完成）
    await jsend(base, "POST", "/api/v1/config/plugin-configs/reload", undefined);
    {
      const r = await jget(base, "/api/v1/config/plugin-configs");
      assert("GET list → 200", r.status === 200);
      const list = r.body as { ready: boolean; declarations: { package: string }[] };
      assert("list includes captured declaration", list.declarations.some((d) => d.package === "ext-settings-sample"), JSON.stringify(r.body));
    }
    // 2. 表单保存 → settings-extensions.json 字符串值
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", { values: { greeting: "hello" } });
      assert("PUT values → 200 {ok:true}", r.status === 200 && (r.body as { ok: boolean }).ok === true);
      const raw = JSON.parse(await readFile(join(configDir, "settings-extensions.json"), "utf8")) as Record<string, unknown>;
      assert("settings-extensions.json is string-typed", raw["ext-settings-sample"] !== undefined && (raw["ext-settings-sample"] as Record<string, unknown>).greeting === "hello");
    }
    // 3. GET 单项回读
    {
      const r = await jget(base, "/api/v1/config/plugin-configs/ext-settings-sample");
      const d = r.body as { exists: boolean; values: Record<string, unknown> };
      assert("GET :package → 200 + value", r.status === 200 && d.exists === true && d.values.greeting === "hello");
    }
    // 4. 未注册包
    {
      const r = await jget(base, "/api/v1/config/plugin-configs/unknown-pkg");
      assert("GET unknown → 404 not_found", r.status === 404 && (r.body as { error: string }).error === "not_found");
      const p = await jsend(base, "PUT", "/api/v1/config/plugin-configs/unknown-pkg", { values: { a: 1 } });
      assert("PUT unknown → 404", p.status === 404);
    }
    // 5. raw 替换 + 非法 raw
    {
      const ok = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", { raw: JSON.stringify({ ext: { greeting: "raw-edited" } }) });
      assert("PUT raw → 200", ok.status === 200);
      const back = JSON.parse(await readFile(join(configDir, "settings-extensions.json"), "utf8")) as Record<string, unknown>;
      assert("raw replaced file", (back["ext-settings-sample"] as Record<string, unknown>).greeting === "raw-edited");
      const bad = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", { raw: "{ nope" });
      assert("PUT invalid raw → 400", bad.status === 400 && (bad.body as { error: string }).error === "invalid_json");
    }
    // 6. values 与 raw 互斥
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", { values: { greeting: "hi" }, raw: "{}" });
      assert("PUT both values+raw → 400", r.status === 400);
    }
    // 7. 遍历/非法文件被拒（compat 声明无法在运行时注入，此处验证 PUT body 不越界即可——values 只按声明 path 校验）
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", { values: { "../evil": "x" } });
      assert("PUT unknown path → 400", r.status === 400);
    }
    // 8. 空声明列表（独立配置：capture 关闭由 Task 7 覆盖）
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  console.log("plugin-config API: ALL PASS");
}
void main();
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npx tsx tests/test-plugin-config-api.ts`
Expected: FAIL（路由不存在 → 404/500）

- [ ] **Step 3: 实现路由（追加到 routes/config.ts 的 configRoutes 插件内）**

```ts
// routes/config.ts —— imports 增补
import {
  getConfigDeclaration, getPluginConfigState, refreshPluginConfigs,
} from "../plugin-config/registry.js";
import {
  ConfigFileError, putRaw, putValues, readDeclarationValues, validateValues,
} from "../plugin-config/store.js";
import type { PluginConfigListResponse, PluginConfigSummary, SavePluginConfigBody } from "../plugin-config/types.js";

// 路由（置于 configRoutes 插件函数内、/config/extensions 端点之后）
function pluginConfigSummary(d: { package: string; label: string; description?: string; file: string; source: "extension-event" | "compat"; fields: import("../plugin-config/types.js").FieldDefinition[] }, ready: boolean, res: { exists: boolean; error?: "invalid_json"; values: Record<string, unknown> }): PluginConfigSummary {
  const out: PluginConfigSummary = {
    package: d.package, label: d.label, description: d.description, file: d.file,
    source: d.source, exists: res.exists, ready, fields: d.fields, values: res.values,
  };
  return out;
}

fastify.get("/config/plugin-configs", {
  schema: {
    tags: ["config"],
    response: {
      200: {
        type: "object", required: ["ready", "declarations", "errors"],
        properties: {
          ready: { type: "boolean" },
          declarations: { type: "array", items: { type: "object" } },
          errors: { type: "array", items: { type: "object", required: ["path", "error"], properties: { path: { type: "string" }, error: { type: "string" } } } },
        },
      },
    },
  },
}, async (_req, reply) => {
  const st = getPluginConfigState();
  const declarations: PluginConfigSummary[] = [];
  for (const d of st.declarations) {
    const res = await readDeclarationValues(d.file, config.piConfigDir, d.fields);
    declarations.push(pluginConfigSummary(d, st.ready, res));
  }
  const body: PluginConfigListResponse = { ready: st.ready, declarations, errors: st.errors };
  return reply.send(body);
});

fastify.get("/config/plugin-configs/:package", {
  schema: { tags: ["config"], params: { type: "object", required: ["package"], properties: { package: { type: "string" } } } },
}, async (req, reply) => {
  const { package: pkg } = req.params as { package: string };
  const d = getConfigDeclaration(pkg);
  if (d === undefined) return reply.code(404).send({ error: "not_found" });
  const st = getPluginConfigState();
  const res = await readDeclarationValues(d.file, config.piConfigDir, d.fields);
  return reply.send(pluginConfigSummary(d, st.ready, res));
});

fastify.put("/config/plugin-configs/:package", {
  schema: {
    tags: ["config"],
    body: {
      type: "object", additionalProperties: false,
      properties: {
        values: { type: "object", additionalProperties: true },
        raw: { type: "string" },
      },
    },
  },
}, async (req, reply) => {
  const { package: pkg } = req.params as { package: string };
  const d = getConfigDeclaration(pkg);
  if (d === undefined) return reply.code(404).send({ error: "not_found" });
  const body = req.body as SavePluginConfigBody;
  if (body.values !== undefined && body.raw !== undefined) {
    return reply.code(400).send({ error: "validation_failed", message: "provide either values or raw, not both" });
  }
  try {
    if (body.raw !== undefined) {
      await putRaw(d.file, config.piConfigDir, body.raw);
    } else {
      const values = body.values ?? {};
      const check = validateValues(d.fields, values);
      if (!check.ok) {
        return reply.code(400).send({ error: "validation_failed", message: check.error, field: check.field });
      }
      const stringCoerce = d.file === "settings-extensions.json";
      await putValues(d.file, config.piConfigDir, values, { stringCoerce });
    }
    return reply.send({ ok: true });
  } catch (err) {
    if (err instanceof ConfigFileError) {
      if (err.code === "traversal") return reply.code(403).send({ error: "traversal", message: err.message });
      if (err.code === "invalid_json" || err.code === "validation") return reply.code(400).send({ error: err.code, message: err.message });
    }
    return reply.code(500).send({ error: "agent_error", message: (err as Error).message });
  }
});

fastify.post("/config/plugin-configs/reload", {
  schema: { tags: ["config"] },
}, async (_req, reply) => {
  void refreshPluginConfigs();
  return reply.send({ reloaded: true });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npx tsx tests/test-plugin-config-api.ts`
Expected: PASS（plugin-config API: ALL PASS）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/config.ts tests/test-plugin-config-api.ts
git commit -m "feat(plugin-config): add /config/plugin-configs REST endpoints"
```

### Task 7: 配置接线（env / cli / 启动预加载 / 失效钩子）

**Files:**
- Modify: `packages/server/src/config.ts`（`pluginConfigCapture: boolean`）
- Modify: `packages/server/src/cli.ts`（`--plugin-config-capture` flag）
- Modify: `packages/server/src/index.ts`（启动配置 + fire-and-forget refresh）
- Modify: `packages/server/src/routes/config.ts`（install/remove 成功后 `void refreshPluginConfigs()`）
- Test: `tests/test-plugin-config-api.ts`（追加 PLUGIN_CONFIG_CAPTURE=false 场景——独立进程重跑不便，改为第二段 env 断言 + 手动验证；集成用例放在 Task 10）

**Interfaces:**
- Consumes: `configurePluginConfigRegistry`/`refreshPluginConfigs`（registry.ts）、`readBool`（config.ts 内部）、cli flag 模式（cli.ts）
- Produces:
  - `config.pluginConfigCapture: boolean`（env `PLUGIN_CONFIG_CAPTURE`，默认 true，`readBool("PLUGIN_CONFIG_CAPTURE", true)`）
  - CLI `--plugin-config-capture`（boolean，默认 true，映射到 config）
  - `buildServer()` 内（路由注册后、listen 前）：`configurePluginConfigRegistry({ cwd: config.workspacePath, agentDir: config.piConfigDir, captureEnabled: config.pluginConfigCapture }); void refreshPluginConfigs();`
  - install/remove 成功分支：`void refreshPluginConfigs();`

- [ ] **Step 1: config.ts + cli.ts**

```ts
// packages/server/src/config.ts —— 在 config 对象中新增（跟随相邻布尔字段模式）
pluginConfigCapture: readBool("PLUGIN_CONFIG_CAPTURE", true),
```

```ts
// packages/server/src/cli.ts —— 新增 flag（跟随相邻布尔 flag 模式，映射到 pluginConfigCapture）
`--plugin-config-capture` → boolean, 默认 true, 写入 config.pluginConfigCapture
```

- [ ] **Step 2: index.ts 启动接线**

在 `buildServer()` 内 `await fastify.register(...)` 路由块（prefix `/api/v1`）**之后**、返回 fastify 之前：

```ts
// 启动后台预加载插件配置注册表（fire-and-forget，不阻塞启动；GET 返回当前快照）
configurePluginConfigRegistry({
  cwd: config.workspacePath,
  agentDir: config.piConfigDir,
  captureEnabled: config.pluginConfigCapture,
});
void refreshPluginConfigs();
```
（import 增补：`configurePluginConfigRegistry, refreshPluginConfigs` from `./plugin-config/registry.js`）

- [ ] **Step 3: install/remove 失效钩子**

`routes/config.ts` 中 POST /config/extensions/install 成功分支与 POST /config/extensions/remove 成功分支各追加 `void refreshPluginConfigs();`（import 已有）。

- [ ] **Step 4: env=false 场景测试**

在 `tests/test-plugin-config-api.ts` 追加第二段：`process.env.PLUGIN_CONFIG_CAPTURE = "false"` 设于 buildServer 前 → GET 列表不含扩展声明、`ready:true`；随后 `PLUGIN_CONFIG_CAPTURE = "true"` + `POST /reload` → 声明出现。注意 env 在模块加载期被 config.ts 读取——第二段须在**同一进程内重启**不可行，改为：将 PLUGIN_CONFIG_CAPTURE=false 断言放入 Task 10 的独立测试文件 `tests/test-plugin-config-capture-off.ts`（照抄 test-plugin-config-api 的 boot 骨架，仅改 env + 断言空声明列表）。本任务仅保证编译通过 + reload 端点手动验证。

- [ ] **Step 5: 构建 + 全量单测 + 提交**

Run: `npm run build && npx tsx tests/test-plugin-config.ts && npx tsx tests/test-plugin-config-api.ts`
Expected: ALL PASS

```bash
git add packages/server/src/config.ts packages/server/src/cli.ts packages/server/src/index.ts packages/server/src/routes/config.ts
git commit -m "feat(plugin-config): wire capture env, startup preload and invalidation hooks"
```

### Task 8: api-client 方法

**Files:**
- Modify: `packages/client/src/lib/api-client/types.ts`
- Modify: `packages/client/src/lib/api-client/index.ts`
- 验证：`cd packages/client && npx tsc --noEmit`

**Interfaces:**
- Consumes: `request()`（index.ts 既有）、validator 模式（`vReloadResult`/`isObject` 风格）
- Produces（types.ts）:
  - `export type PluginConfigField = { kind: "scalar" | "multi-select"; path: string; label: string; description?: string; type?: "string"|"number"|"boolean"|"enum"; defaultValue?: unknown; required?: boolean; min?: number; max?: number; pattern?: string; secret?: boolean; enum?: { value: string; label: string }[]; options?: { id: string; label: string }[] }`
  - `export interface PluginConfigSummary { package: string; label: string; description?: string; file: string; source: "extension-event" | "compat"; exists: boolean; ready: boolean; fields: PluginConfigField[]; values: Record<string, unknown> }`
  - `export interface PluginConfigListResponse { ready: boolean; declarations: PluginConfigSummary[]; errors: { path: string; error: string }[] }`
  - `export type SavePluginConfigBody = { values?: Record<string, unknown>; raw?: never } | { raw?: string; values?: never }`
- Produces（index.ts，api 对象上新增 4 方法）:
  - `getPluginConfigs(): Promise<PluginConfigListResponse>`
  - `getPluginConfig(pkg: string): Promise<PluginConfigSummary>`
  - `savePluginConfig(pkg: string, body: SavePluginConfigBody): Promise<{ ok: true }>`
  - `reloadPluginConfigs(): Promise<{ reloaded: true }>`

- [ ] **Step 1: types.ts 追加上述类型**

（照 `ClientPackagesListing` 风格放置于 extensions 类型附近）

- [ ] **Step 2: index.ts 追加 validators 与 4 方法**

```ts
// validators（照 vReloadResult / isObject 风格；错误处理与既有方法一致）
const vPluginConfigList: Validator<PluginConfigListResponse> = (v, status) => {
  if (status !== 200) throw new ApiError(`GET /config/plugin-configs failed: ${status}`, status);
  return v as PluginConfigListResponse;
};
const vPluginConfig: Validator<PluginConfigSummary> = (v, status) => {
  if (status !== 200) throw new ApiError(`GET /config/plugin-configs/:package failed: ${status}`, status);
  return v as PluginConfigSummary;
};
const vSavePluginConfig: Validator<{ ok: true }> = (v, status) => {
  if (status !== 200) throw new ApiError(`PUT /config/plugin-configs/:package failed: ${status}`, status);
  return v as { ok: true };
};
const vReloadPluginConfigs: Validator<{ reloaded: true }> = (v, status) => {
  if (status !== 200) throw new ApiError(`POST /config/plugin-configs/reload failed: ${status}`, status);
  return v as { reloaded: true };
};

// api 对象上（reloadConfig 之后、getExtensions 附近）
getPluginConfigs: () => request(`/config/plugin-configs`, vPluginConfigList),
getPluginConfig: (pkg: string) => request(`/config/plugin-configs/${encodeURIComponent(pkg)}`, vPluginConfig),
savePluginConfig: (pkg: string, body: SavePluginConfigBody) =>
  request(`/config/plugin-configs/${encodeURIComponent(pkg)}`, vSavePluginConfig, { method: "PUT", body }),
reloadPluginConfigs: () => request(`/config/plugin-configs/reload`, vReloadPluginConfigs, { method: "POST" }),
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `cd packages/client && npx tsc --noEmit`
Expected: exit 0

```bash
git add packages/client/src/lib/api-client/types.ts packages/client/src/lib/api-client/index.ts
git commit -m "feat(plugin-config): add api-client methods"
```

### Task 9: UI —— ExtensionsTab 齿轮 + PluginConfigModal

**Files:**
- Modify: `packages/client/src/components/SettingsPanel.tsx`
- Create: `packages/client/src/components/PluginConfigModal.tsx`
- 验证：`npm run build` + 手动清单

**Interfaces:**
- Consumes: `api.getPluginConfigs/getPluginConfig/savePluginConfig/reloadPluginConfigs`（api-client）、`PluginConfigSummary`/`SavePluginConfigBody`/`PluginConfigField`（api-client types）、`Modal`（`./Modal.jsx`）、`CodeMirrorEditor`（`./CodeMirrorEditor.jsx`）、`errorCode`（SettingsPanel 既有工具）、lucide `Settings2`
- Produces:
  - SettingsPanel.tsx：
    - `SettingsPanel` 状态 `openConfigPackage: string | undefined`；`tab === "extensions"` 渲染 `ExtensionsTab onError={setError} onOpenConfig={setOpenConfigPackage}`；`openConfigPackage !== undefined` 时渲染 `<PluginConfigModal package={openConfigPackage} onClose={() => setOpenConfigPackage(undefined)} />`
    - `ExtensionsTab` 新 prop `onOpenConfig: (pkg: string) => void`；新增状态 `declaredPackages: Set<string>`（refresh 时 `api.getPluginConfigs()` 填充：匹配规则 `d.package === p.name || (p.name === undefined && d.package === p.source)`）；包卡片操作区（Remove 按钮左侧）条件渲染齿轮：
    ```tsx
    {declaredPackages.has(p.name ?? p.source) && (
      <button
        onClick={() => onOpenConfig(p.name ?? p.source)}
        title="Plugin config"
        className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    )}
    ```
- 新建 `components/PluginConfigModal.tsx`：

- [ ] **Step 1: PluginConfigModal 骨架与加载/错误/空状态**

```tsx
// packages/client/src/components/PluginConfigModal.tsx（骨架）
import { useEffect, useState } from "react";
import { Modal } from "./Modal.jsx";
import { api, errorCode } from "../lib/api-client/index.js"; // errorCode 位置以实际为准
import type { PluginConfigSummary } from "../lib/api-client/types.js";

export function PluginConfigModal({ pkg, onClose }: { pkg: string; onClose: () => void }) {
  const [summary, setSummary] = useState<PluginConfigSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setError(undefined);
    try { setSummary(await api.getPluginConfig(pkg)); } catch (err) { setError(`Failed to load plugin config: ${errorCode(err)}`); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pkg]);

  return (
    <Modal onClose={onClose} title={`Plugin config — ${pkg}`}>
      <div className="w-[38rem] max-w-full space-y-3 p-4 text-sm text-neutral-200">
        {error !== undefined && <p className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">{error}</p>}
        {summary === undefined && error === undefined && <p className="text-xs italic text-neutral-500">Loading…</p>}
        {summary !== undefined && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span className="font-mono">{summary.file}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 uppercase tracking-wider">
                {summary.source}
              </span>
            </div>
            {!summary.exists && (
              <p className="text-xs text-amber-400">Config file does not exist yet — it will be created on save.</p>
            )}
            {/* 表单区由 Step 2 实现 */}
            {/* raw 区由 Step 3 实现 */}
            <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
              <button onClick={onClose} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800">Cancel</button>
              <button disabled={busy} onClick={void 0} className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">Save</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: 字段表单控件（string/number/boolean/enum/multi-select）**

在 `PluginConfigModal` 内实现（每个字段行：label + 类型徽标 + description + 限制摘要 + 校验错误）：

```tsx
// 状态：const [formValues, setFormValues] = useState<Record<string, unknown>>({});
// 初始化（summary 加载后）：
//   Object.fromEntries(summary.fields.map(f => [f.path, summary.values[f.path] ?? f.defaultValue ?? (f.kind==="multi-select" ? [] : f.type==="number" ? undefined : f.type==="boolean" ? false : "")]))
// 控件映射（onChange 写 formValues[field.path]）：
//   string: <input type={f.secret ? "password" : "text"} ...>
//   number: <input type="number" min={f.min} max={f.max} value={String(formValues[f.path] ?? "")} onChange={e => set(Number(e.target.value))} ...>
//   boolean: <input type="checkbox" checked={Boolean(formValues[f.path])} ...>
//   enum: <select value={String(formValues[f.path] ?? "")}> {f.enum.map(e => <option value={e.value}>{e.label}</option>)} </select>
//   multi-select: 可勾选列表（checkbox + id 顺序数组）+ 上移/下移按钮（重排 formValues[f.path] 数组）
// 行内校验：调用客户端最小校验（类型/enum/min/max），错误在字段下红字显示，Save 时若校验失败不提交
```

- [ ] **Step 3: Raw JSON 切换**

```tsx
// 状态：const [rawMode, setRawMode] = useState(false); const [rawText, setRawText] = useState(""); const [dirty, setDirty] = useState(false);
// 切到 raw：若 dirty → window.confirm("Discard unsaved form changes?")；setRawText(JSON.stringify(读到的文件原始内容或当前 values, null, 2))
// raw 模式渲染：<CodeMirrorEditor value={rawText} onChange={setRawText} language="json" onSaveShortcut={() => save()} />（语言参数以 CodeMirrorEditor 实际 props 为准）
// 保存分支：rawMode ? savePluginConfig(pkg, { raw: rawText }) : savePluginConfig(pkg, { values: formValues })
// 成功：onClose()（或短暂提示后关闭）；失败：setError(...)，模态不关闭
```

- [ ] **Step 4: 接线齿轮 + 构建**

- SettingsPanel.tsx：`onOpenConfig` prop 贯通 + `openConfigPackage` 状态 + 渲染 `<PluginConfigModal>`（在 SettingsPanel 根 div 内、tab 内容之后）
- Run: `npm run build`
- 手动验证清单（dev 模式）：无声明包无齿轮；有声明包齿轮出现；打开模态表单编辑 enum/多选/secret；raw 切换与保存；文件不存在提示；保存后 GET 回读一致；捕获关闭时 refresh 按钮（可选：ready=false 时显示"Refresh registrations"调用 reloadPluginConfigs）

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/components/SettingsPanel.tsx packages/client/src/components/PluginConfigModal.tsx
git commit -m "feat(plugin-config): settings gear + plugin config modal"
```

### Task 10: 捕获关闭测试 + 文档 + 全量验证

**Files:**
- Create: `tests/test-plugin-config-capture-off.ts`
- Modify: `docs/agent/api.md`、`docs/agent/config.md`、`docs/agent/architecture.md`
- 验证：`npm run check` + `scripts/run-tests.sh --only plugin-config,extensions,config,api` + 手动清单

**Interfaces:**
- Consumes: 全部既有端点与模块
- Produces:
  - `tests/test-plugin-config-capture-off.ts`：boot 骨架照抄 `tests/test-plugin-config-api.ts`，但 buildServer 前 `process.env.PLUGIN_CONFIG_CAPTURE = "false"`；断言：`GET /config/plugin-configs` → `ready:true` 且 `declarations: []`（无事件来源声明）

- [ ] **Step 1: 捕获关闭集成测试**

（照 Task 6 Step 1 骨架，仅 env 与断言不同；同目录 temp 扩展文件存在但声明列表为空）

- [ ] **Step 2: 文档更新**

- `docs/agent/api.md`：新增 `/config/plugin-configs` 四个端点（路径、请求/响应形状、400/403/404/500 语义、`ready`/`errors` 字段）
- `docs/agent/config.md`：新增 `PLUGIN_CONFIG_CAPTURE` env（默认 true）+ CLI `--plugin-config-capture`
- `docs/agent/architecture.md`：新增 `plugin-config/*` 模块（registry/store/capture/paths）与 `compat/` 注册入口、数据流（捕获 → registry → store → REST → UI）
- `packages/server/src/extensions-settings-compat/README.md` 已在 Task 3 创建

- [ ] **Step 3: 全量验证**

Run: `npm run build && npm run check`
Expected: tsc + eslint + prettier 全过
Run: `scripts/run-tests.sh --only plugin-config,extensions,config,api`
Expected: 全部 PASS（plugin-config 前缀匹配三个新测试文件）

- [ ] **Step 4: 手动验收清单**

- [ ] 安装 `@juanibiapina/pi-extension-settings` + 一个注册设置的扩展（如 pi-extension-settings 示例）→ Settings → Extensions 该包卡片出现齿轮
- [ ] 打开模态：enum 下拉 / multi-select / secret 字段渲染正确；文件存在性提示正确
- [ ] 保存后 pi 内 `/extension-settings` 或 `getSetting()` 读到新值（字符串语义互通）
- [ ] compat 声明示例（compat/README.md 的 my-plugin 示例临时注册）→ 齿轮出现、表单编辑其自有 JSON 配置文件、嵌套 path 生效
- [ ] Raw 切换：非法 JSON 保存 → 400 提示不关闭；合法 → 替换文件
- [ ] `PLUGIN_CONFIG_CAPTURE=false` 启动 → 无事件声明，compat 声明仍可见
- [ ] 安装/卸载包后声明列表自动刷新

- [ ] **Step 5: 提交**

```bash
git add tests/test-plugin-config-capture-off.ts docs/agent/api.md docs/agent/config.md docs/agent/architecture.md
git commit -m "docs(plugin-config): capture-off test and agent docs"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec.md 6 条 Requirement 全部有任务对应——R1 注册接口/来源（Task 3/4/5）、R2 读取（Task 2/6）、R3 字段保存/raw（Task 2/6）、R4 路径安全（Task 1/2/6）、R5 浏览器表单界面（Task 9）、R6 捕获开关与启动（Task 7/10）；场景 1-10 落在 Task 4/6/10 测试中。
- **占位符扫描**：无 TBD/“similar to”引用；所有代码步骤含完整实现或明确的既有模式引用。
- **类型一致性**：`ConfigDeclaration`/`FieldDefinition`/`PluginConfigSummary`/`SavePluginConfigBody` 在 server（types.ts）与 client（api-client types）两侧同名同构；`readDeclarationValues`（store）替代早期设计中的 `getValues`，在 Task 2/6 全链路一致；`validateConfigFilePath` 返回 `{ok, absPath}` 联合类型在 Task 1/2 一致。
