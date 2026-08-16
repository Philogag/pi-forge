// tests/test-plugin-config.ts（第 1 段）
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathGet,
  pathSet,
  validateConfigFilePath,
} from "../packages/server/src/plugin-config/paths.js";
import {
  ConfigFileError,
  putRaw,
  putValues,
  readDeclarationValues,
  validateValues,
} from "../packages/server/src/plugin-config/store.js";
import type {
  ConfigDeclaration,
  FieldDefinition,
} from "../packages/server/src/plugin-config/types.js";
import {
  captureExtensionSettings,
  normalizeRegistration,
} from "../packages/server/src/plugin-config/capture.js";
import { validateCompatDeclarations } from "../packages/server/src/extensions-settings-compat/index.js";
import {
  configurePluginConfigRegistry,
  getConfigDeclaration,
  getPluginConfigState,
  mergeDeclarations,
  refreshPluginConfigs,
} from "../packages/server/src/plugin-config/registry.js";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const decl: ConfigDeclaration = {
  package: "demo",
  file: "demo.json",
  label: "Demo",
  source: "compat",
  fields: [
    { kind: "scalar", path: "greeting", type: "string", label: "Greeting", required: true },
    { kind: "scalar", path: "retries", type: "number", label: "Retries", min: 0, max: 10 },
    {
      kind: "scalar",
      path: "color",
      type: "enum",
      label: "Color",
      enum: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
      ],
    },
    {
      kind: "multi-select",
      path: "tags",
      label: "Tags",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
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
  assert("putRaw replaces file", replaced.fresh === true && replaced.greeting === undefined);
  let threw = false;
  try {
    await putRaw(file, dir, "{ nope");
  } catch {
    threw = true;
  }
  assert("putRaw invalid json throws ConfigFileError", threw === true);
  let threwCode = "";
  try {
    await putRaw(file, dir, "{ nope");
  } catch (e) {
    threwCode = (e as ConfigFileError).code ?? "";
  }
  assert("putRaw invalid json error code is invalid_json", threwCode === "invalid_json");
  // stringCoerce preserves arrays (multi-select must not be flattened)
  await putValues(file, dir, { greeting: "hi", tags: ["a", "b"] }, { stringCoerce: true });
  const kept = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
  assert(
    "stringCoerce keeps arrays intact",
    JSON.stringify(kept.tags) === '["a","b"]' && typeof kept.greeting === "string",
  );
  // required field with empty value rejected
  const badR = validateValues(decl.fields, { greeting: "" });
  assert("validateValues rejects required empty", badR.ok === false && badR.field === "greeting");
  // Infinity rejected (would otherwise serialize to null)
  const badInf = validateValues(decl.fields, { greeting: "x", retries: Infinity });
  assert("validateValues rejects Infinity", badInf.ok === false && badInf.field === "retries");
  // pathSet string segment on existing array → ConfigFileError validation (no silent data loss)
  await writeFile(abs, JSON.stringify({ arr: [1, 2] }));
  let arrErr = "";
  try {
    await putValues(file, dir, { "arr.x": "y" });
  } catch (e) {
    arrErr = (e as ConfigFileError).code ?? "";
  }
  assert("putValues string segment on array → validation error", arrErr === "validation");
  // traversal branch
  let trav = "";
  try {
    await putValues("../evil.json", dir, { a: 1 });
  } catch (e) {
    trav = (e as ConfigFileError).code ?? "";
  }
  assert("putValues traversal → traversal error", trav === "traversal");
  // dangling symlink rejected
  const linkPath = join(dir, "dangling.json");
  await symlink(join(dir, "does-not-exist", "target.json"), linkPath);
  const dl = await validateConfigFilePath("dangling.json", dir);
  assert("path validation rejects dangling symlink", dl.ok === false);
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

async function mainRegistry(): Promise<void> {
  // M3: refresh before configure → error state, not a thrown rejection
  const unconfigured = await refreshPluginConfigs();
  assert(
    "refresh before configure → error state",
    unconfigured.status === "error" && unconfigured.ready === false,
  );
  const mk = (
    pkg: string,
    fields: FieldDefinition[],
    source: "extension-event" | "compat",
  ): ConfigDeclaration => ({
    package: pkg,
    file: source === "extension-event" ? "settings-extensions.json" : `${pkg}.json`,
    label: pkg,
    source,
    fields,
  });
  const cap = mk(
    "shared",
    [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    "extension-event",
  );
  const comp = mk(
    "shared",
    [
      { kind: "scalar", path: "a", type: "string", label: "A2" },
      { kind: "scalar", path: "b", type: "number", label: "B" },
    ],
    "compat",
  );
  const onlyCompat = mk(
    "only-compat",
    [{ kind: "scalar", path: "x", type: "string", label: "X" }],
    "compat",
  );
  const merged = mergeDeclarations([cap], [comp, onlyCompat]);
  const shared = merged.find((d) => d.package === "shared");
  assert(
    "merge keeps compat-only package",
    merged.some((d) => d.package === "only-compat"),
  );
  assert("merge: capture wins source", shared?.source === "extension-event");
  assert("merge: capture file wins", shared?.file === "settings-extensions.json");
  assert(
    "merge: capture field wins at path a",
    shared?.fields.find((f) => f.path === "a")?.label === "A",
  );
  assert("merge: compat supplements field b", shared?.fields.some((f) => f.path === "b") === true);
  // M4: duplicate capture packages are deduplicated (first wins)
  const dupCap = mk(
    "dup",
    [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    "extension-event",
  );
  const dupCap2 = mk(
    "dup",
    [{ kind: "scalar", path: "b", type: "string", label: "B" }],
    "extension-event",
  );
  const mergedDup = mergeDeclarations([dupCap, dupCap2], []);
  assert(
    "merge dedupes duplicate capture packages",
    mergedDup.length === 1 && mergedDup[0]!.package === "dup" && mergedDup[0]!.fields.length === 1,
  );
  // refresh 状态机（注入真实 capture：临时扩展目录）
  const dir = await mkdtemp(join(tmpdir(), "pi-forge-pc-reg-"));
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "extensions", "sample.js"),
    `export default function (api) {
  api.events.emit("pi-extension-settings:register", { name: "from-ext", settings: [{ id: "k", label: "K" }] });
};\n`,
  );
  configurePluginConfigRegistry({ cwd: dir, agentDir: dir, captureEnabled: true });
  const st = await refreshPluginConfigs();
  assert("refresh → ready", st.ready === true && st.status === "ready");
  assert("refresh captures extension declaration", getConfigDeclaration("from-ext") !== undefined);
  assert("refresh state accessible", getPluginConfigState().declarations.length >= 1);
  configurePluginConfigRegistry({ cwd: dir, agentDir: dir, captureEnabled: false });
  const st2 = await refreshPluginConfigs();
  assert(
    "capture disabled → no extension declarations",
    getConfigDeclaration("from-ext") === undefined && st2.ready === true,
  );
  if (failures > 0) process.exit(1);
  console.log("plugin-config registry: ALL PASS");
}

async function mainCapture(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-forge-pc-capture-"));
  // temp 全局扩展目录：agentDir/extensions/settings-sample.js
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "extensions", "settings-sample.js"),
    `export default function (api) {
  api.events.emit("pi-extension-settings:register", {
    name: "ext-settings-sample",
    settings: [
      { id: "greeting", label: "Greeting", defaultValue: "hi", values: ["hi", "hello"] },
      { id: "tags", label: "Tags", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "name", label: "Name" },
    ],
  });
};\n`,
  );
  const res = await captureExtensionSettings(dir, dir);
  assert(
    "capture loads temp extension",
    res.registrations.length === 1,
    JSON.stringify(res.registrations),
  );
  assert("capture records no load errors", res.errors.length === 0, JSON.stringify(res.errors));
  const decl = normalizeRegistration(res.registrations[0]!);
  assert("normalize: package = event name", decl.package === "ext-settings-sample");
  assert("normalize: file = settings-extensions.json", decl.file === "settings-extensions.json");
  const byPath = new Map(decl.fields.map((f) => [f.path, f]));
  const enumF = byPath.get("greeting");
  assert(
    "normalize: values → enum scalar",
    enumF?.kind === "scalar" && enumF.type === "enum" && (enumF.enum?.length ?? 0) === 2,
  );
  const multiF = byPath.get("tags");
  assert(
    "normalize: options → multi-select",
    multiF?.kind === "multi-select" && multiF.options.length === 2,
  );
  const strF = byPath.get("name");
  assert("normalize: bare id → string scalar", strF?.kind === "scalar" && strF.type === "string");
  // 非法负载被丢弃
  await writeFile(
    join(dir, "extensions", "bad-sample.js"),
    `export default function (api) {
  api.events.emit("pi-extension-settings:register", { nope: true });
  throw new Error("boom");
};\n`,
  );
  const res2 = await captureExtensionSettings(dir, dir);
  assert("capture drops invalid payloads", res2.registrations.length === 1);
  assert("capture surfaces load errors", res2.errors.length === 1, JSON.stringify(res2.errors));
  if (failures > 0) process.exit(1);
  console.log("plugin-config capture: ALL PASS");
}

async function mainCompat(): Promise<void> {
  const good: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    },
  ];
  assert("compat valid declaration → no errors", validateCompatDeclarations(good).length === 0);
  const badPath: ConfigDeclaration[] = [
    {
      package: "p",
      file: "../evil.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    },
  ];
  assert("compat rejects traversal file", validateCompatDeclarations(badPath).length === 1);
  const badField: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "", type: "string", label: "A" }],
    },
  ];
  assert("compat rejects empty field path", validateCompatDeclarations(badField).length >= 1);
  const dupPkg: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    },
    {
      package: "p",
      file: "q.json",
      label: "Q",
      source: "compat",
      fields: [{ kind: "scalar", path: "b", type: "string", label: "B" }],
    },
  ];
  assert("compat rejects duplicate package", validateCompatDeclarations(dupPkg).length === 1);
  const noEnum: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "a", type: "enum", label: "A" }],
    },
  ];
  assert("compat rejects enum without values", validateCompatDeclarations(noEnum).length === 1);
  const noOpts: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "multi-select", path: "a", label: "A", options: [] }],
    },
  ];
  assert(
    "compat rejects multi-select without options",
    validateCompatDeclarations(noOpts).length === 1,
  );
  const wrongSrc: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "extension-event",
      fields: [{ kind: "scalar", path: "a", type: "string", label: "A" }],
    },
  ];
  assert("compat rejects non-compat source", validateCompatDeclarations(wrongSrc).length === 1);
  const dupField: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [
        { kind: "scalar", path: "a", type: "string", label: "A" },
        { kind: "scalar", path: "a", type: "string", label: "A2" },
      ],
    },
  ];
  assert("compat rejects duplicate field path", validateCompatDeclarations(dupField).length === 1);
  const badSyntax: ConfigDeclaration[] = [
    {
      package: "p",
      file: "p.json",
      label: "P",
      source: "compat",
      fields: [{ kind: "scalar", path: "a[0]x", type: "string", label: "A" }],
    },
  ];
  assert("compat rejects invalid path syntax", validateCompatDeclarations(badSyntax).length === 1);
  if (failures > 0) process.exit(1);
  console.log("plugin-config compat: ALL PASS");
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
  assert("path validation accepts plain file", good.ok === true);
  assert("path validation accepts single json", good.ok === true);

  await mainStore();
  await mainCompat();
  await mainCapture();
  await mainRegistry();

  if (failures > 0) process.exit(1);
  console.log("plugin-config paths: ALL PASS");
}
void main();
