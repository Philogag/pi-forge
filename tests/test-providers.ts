/**
 * Plugin provider registry integration tests (Task 1 + Batch A review fixes
 * of the optimize-providers-plugin-apikey change).
 *
 * Boots the server in-process with temp WORKSPACE_PATH / PI_CONFIG_DIR /
 * FORGE_DATA_DIR and temp extensions under `<configDir>/extensions/` that
 * register providers via the standard extension factory protocol
 * (`pi.registerProvider(...)`), which the SDK queues into
 * `ExtensionRuntimeState.pendingProviderRegistrations`.
 *
 * The provider registry is configured + refreshed on the DIST module (the
 * same module instance the server routes read state from) before boot, so
 * capture is deterministic — except the production-boot section at the top,
 * which boots with a virgin registry (no manual configure/refresh) to prove
 * the index.ts boot wiring (Task E attention point 1).
 *
 * Coverage:
 *   - production boot: buildServer without manual configure/refresh → poll
 *     GET /config/providers (waitFor-style, 5s) until ready===true &&
 *     testprovider present, proving index.ts wires the registry at boot
 *   - refreshPluginProviders() → ready, captures "testprovider", package
 *     resolved to "test-provider-ext" from the extension path
 *   - duplicate registration of the same name → single entry, most recent
 *     config wins (registry dedup)
 *   - broken extension (module throws) → isolated in errors, other
 *     providers still captured
 *   - native pi-ai registration → captured with native: true; refresh
 *     re-registers the Provider object (refreshModels honored)
 *   - refreshPluginProvider("testprovider") → models from the extension's
 *     `refreshModels` callback, persisted to models-store.json (M1)
 *   - refreshPluginProvider(<rejecting callback>) → error propagates
 *   - refreshPluginProvider(<unregistered>) → PluginProviderNotFoundError
 *   - scoped npm package (`node_modules/@scope/pkg`) → package "@scope/pkg"
 *   - Task 8: capture-off independence (fresh boot with PLUGIN_CONFIG_CAPTURE
 *     =false set before a query-string-busted dist import: providers registry
 *     still captures testprovider, plugin-config list has no extension-event
 *     declarations while compat declarations remain)
 *   - Task 8: broken extension isolated at the HTTP layer (GET providers 200,
 *     testprovider present, error only in the errors array)
 *   - Task 8: settings.json unknown-key preservation via plugin-config PUT
 *     (write {other:{x:1}} → PUT omniroute.baseUrl → other kept + block written)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-pv-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-pv-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-pv-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  // 临时扩展：agentDir/extensions/test-provider-ext/index.js。标准 pi 扩展
  // 工厂协议 —— 加载时调用 pi.registerProvider，SDK 队列进
  // pendingProviderRegistrations（pi-forge 从不 bindCore，队列保持稳定）。
  // api 必填（provider 级）：SDK applyExtension 对自定义模型要求 api。
  // 注册两次同名：注册表按 Map.set 去重，最后一次注册的 config 生效。
  await mkdir(join(configDir, "extensions", "test-provider-ext"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "test-provider-ext", "index.js"),
    `export default function (pi) {
  pi.registerProvider("testprovider", {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    refreshModels: async () => [{ id: "test-model", name: "Test Model", contextWindow: 8000, maxTokens: 4000, reasoning: false, input: ["text"] }],
  });
  pi.registerProvider("testprovider", {
    baseUrl: "http://127.0.0.1:2/v1",
    api: "openai-completions",
    refreshModels: async () => [{ id: "test-model", name: "Test Model", contextWindow: 8000, maxTokens: 4000, reasoning: false, input: ["text"] }],
  });
};\n`,
  );

  // 坏扩展：模块顶层抛错 → SDK 隔离进 LoadExtensionsResult.errors，
  // 不影响其他扩展加载。
  await mkdir(join(configDir, "extensions", "broken-ext"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "broken-ext", "index.js"),
    `throw new Error("boom");\n`,
  );

  // refreshModels 回调 reject 的扩展：刷新必须把错误抛给调用方，
  // 而不是静默返回空列表。
  await mkdir(join(configDir, "extensions", "fail-provider-ext"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "fail-provider-ext", "index.js"),
    `export default function (pi) {
  pi.registerProvider("failprov", {
    baseUrl: "http://127.0.0.1:3/v1",
    api: "openai-completions",
    refreshModels: async () => { throw new Error("refresh exploded"); },
  });
};\n`,
  );

  // native 注册：pi.registerProvider(Provider 对象) → SDK 队列进
  // pendingNativeProviderRegistrations。radiusProvider 是 pi-ai 导出的
  // 现成 Provider 工厂；id 即注册名（SDK registerNativeProvider 按 id 键控）。
  await mkdir(join(configDir, "extensions", "native-provider-ext"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "native-provider-ext", "index.js"),
    `import { radiusProvider } from "@earendil-works/pi-ai/providers/all";
export default function (pi) {
  pi.registerProvider(radiusProvider({ id: "nativeprov" }));
};\n`,
  );

  // scoped npm 包布局：configDir/node_modules/@scope/pkg（pi manifest 指向
  // index.js）。通过 configuredPaths 显式传入 → 注册表包名应解析为 "@scope/pkg"。
  const scopedPkgDir = join(configDir, "node_modules", "@scope", "pkg");
  await mkdir(scopedPkgDir, { recursive: true });
  await writeFile(
    join(scopedPkgDir, "package.json"),
    JSON.stringify({ name: "@scope/pkg", version: "1.2.3", pi: { extensions: ["index.js"] } }),
  );
  await writeFile(
    join(scopedPkgDir, "index.js"),
    `export default function (pi) {
  pi.registerProvider("scopeprov", { baseUrl: "http://127.0.0.1:4/v1", api: "openai-completions" });
};\n`,
  );

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
      inject: (opts: {
        method: string;
        url: string;
        payload?: unknown;
      }) => Promise<{ statusCode: number; body: string }>;
    }>;
  };

  // ---- 生产 boot 接线（Task E 待关注点 1 修复验证）----
  // 不手动 configure/refresh：直接 buildServer，证明 index.ts 的 boot 接线
  // （configurePluginProviderRegistry + void refreshPluginProviders()）真正
  // 生效。此段必须放在下方「预配置/预刷新」之前——此刻 dist 注册表为 virgin
  // 状态（deps 未配置、ready:false、空列表），若接线缺失，GET
  // /config/providers 将永远 ready:false 且无 testprovider。轮询模式照
  // test-plugin-config-api.ts 的 waitForList（5s 上限）。注册表依赖扩展
  // 加载（扩展工厂同步注册）；若未来扩展加载变慢导致超时，可放宽上限。
  const prodServer = await buildModule.buildServer();
  let prodListing: { ready: boolean; providers: { provider: string }[] } | undefined;
  const prodDeadline = Date.now() + 5000;
  while (Date.now() < prodDeadline) {
    const pr = await prodServer.inject({ method: "GET", url: "/api/v1/config/providers" });
    const parsed = JSON.parse(pr.body) as { ready: boolean; providers: { provider: string }[] };
    if (
      parsed.ready === true &&
      Array.isArray(parsed.providers) &&
      parsed.providers.some((p) => p.provider === "testprovider")
    ) {
      prodListing = parsed;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    "production boot: registry ready via index.ts wiring",
    prodListing?.ready === true,
    JSON.stringify(prodListing),
  );
  assert(
    "production boot: testprovider captured via index.ts wiring",
    prodListing !== undefined && prodListing.providers.some((p) => p.provider === "testprovider"),
    JSON.stringify(prodListing?.providers),
  );
  await prodServer.close();

  // 预配置 + 预刷新 dist 注册表模块（与服务端路由共享同一模块实例），
  // 确保捕获完成后再 boot。
  const registryModule = (await import(
    resolve(repoRoot, "packages/server/dist/providers/registry.js")
  )) as unknown as {
    configurePluginProviderRegistry: (d: {
      cwd: string;
      agentDir: string;
      configuredPaths?: Promise<string[]>;
    }) => void;
    refreshPluginProviders: () => Promise<{
      ready: boolean;
      providers: { name: string; package: string; native: boolean; config: { baseUrl?: string } }[];
      errors: { path: string; error: string }[];
    }>;
    getPluginProviderState: () => unknown;
  };
  registryModule.configurePluginProviderRegistry({
    cwd: workspacePath,
    agentDir: configDir,
  });
  const st = await registryModule.refreshPluginProviders();
  assert("registry ready", st.ready === true, JSON.stringify(st.errors));
  const found = st.providers.find((p) => p.name === "testprovider");
  assert("captured provider", found !== undefined, JSON.stringify(st.providers));
  assert("package resolved", found?.package === "test-provider-ext", found?.package);
  // m7a: 重复注册覆盖 —— 同名只保留单条目，且最后一次注册的 config 生效。
  assert(
    "dedup single entry",
    st.providers.filter((p) => p.name === "testprovider").length === 1,
    JSON.stringify(st.providers),
  );
  assert(
    "last registration config wins",
    found?.config.baseUrl === "http://127.0.0.1:2/v1",
    found?.config.baseUrl,
  );
  // m7b: 坏扩展隔离 —— errors 含 broken-ext，testprovider 仍在。
  assert(
    "broken extension isolated in errors",
    st.errors.some((e) => e.path.includes("broken-ext") && e.error.includes("boom")),
    JSON.stringify(st.errors),
  );
  assert(
    "providers kept despite broken extension",
    st.providers.some((p) => p.name === "testprovider"),
    JSON.stringify(st.providers),
  );
  // native 注册被捕获（按 provider.id 命名）。
  const nativeEntry = st.providers.find((p) => p.name === "nativeprov");
  assert("native provider captured", nativeEntry?.native === true, JSON.stringify(st.providers));

  // Task 2：模型刷新（复用同一测试扩展的 refreshModels）。一次性
  // ModelRuntime 注册 + refresh 触发 refreshModels 回调；未注册名抛
  // PluginProviderNotFoundError。
  const refreshModule = (await import(
    resolve(repoRoot, "packages/server/dist/providers/refresh.js")
  )) as unknown as {
    refreshPluginProvider: (name: string) => Promise<{ id: string; name: string }[]>;
    PluginProviderNotFoundError: new (provider: string) => Error;
    PluginProviderNotRefreshableError: new (provider: string) => Error;
  };
  const models = await refreshModule.refreshPluginProvider("testprovider");
  assert(
    "refresh returns models",
    Array.isArray(models) && models.length >= 1,
    JSON.stringify(models),
  );
  assert("model id", models[0]?.id === "test-model", models[0]?.id);
  // M1: 刷新成功后模型写入 models-store.json（SDK 只在扩展主动 persist 时写，
  // pi-forge 补齐非 persist 扩展的持久化）。
  const storeRaw = await readFile(join(configDir, "models-store.json"), "utf8");
  const store = JSON.parse(storeRaw) as {
    testprovider?: { models?: { id?: string }[]; checkedAt?: number };
  };
  assert(
    "models persisted to models-store.json",
    (store.testprovider?.models?.length ?? 0) >= 1,
    storeRaw,
  );
  assert("persisted model id", store.testprovider?.models?.[0]?.id === "test-model", storeRaw);
  // fix(providers): the runtime backing sessions must see plugin providers —
  // createAgentModelRuntime registers captured providers and restores their
  // persisted catalog, so POST /sessions/:id/model resolves them instead of
  // failing with unknown_provider (and session runs with no_api_key).
  const cmAgent = (await import(
    resolve(repoRoot, "packages/server/dist/config-manager.js")
  )) as unknown as {
    createAgentModelRuntime: () => Promise<{
      getModels: (providerId?: string) => Promise<{ id: string }[]>;
    }>;
  };
  const agentRuntime = await cmAgent.createAgentModelRuntime();
  const pluginModels = await agentRuntime.getModels("testprovider");
  assert(
    "plugin provider models visible on agent runtime",
    Array.isArray(pluginModels) && pluginModels.some((m) => m.id === "test-model"),
    JSON.stringify(pluginModels),
  );
  // m7c: refreshModels 回调 reject → 错误传播，而非静默空列表。
  let failMsg = "";
  try {
    await refreshModule.refreshPluginProvider("failprov");
  } catch (err) {
    failMsg = err instanceof Error ? err.message : String(err);
  }
  assert("failing refreshModels propagates", failMsg.includes("refresh exploded"), failMsg);
  // native: pi.registerProvider(Provider 对象) → refresh 走 registerNativeProvider，
  // 其 refreshModels（若存在）参与标准刷新管线；不再抛 NotRefreshableError。
  let nativeErr = "";
  let nativeModels: unknown = null;
  try {
    nativeModels = await refreshModule.refreshPluginProvider("nativeprov");
  } catch (err) {
    nativeErr = err instanceof Error ? err.name : String(err);
  }
  assert(
    "native provider refresh no longer throws not-refreshable",
    nativeErr === "" && Array.isArray(nativeModels),
    `err=${nativeErr} models=${JSON.stringify(nativeModels)}`,
  );
  let threw = false;
  try {
    await refreshModule.refreshPluginProvider("nope");
  } catch (err) {
    threw = err instanceof refreshModule.PluginProviderNotFoundError;
  }
  assert("unregistered throws not-found", threw === true);

  // m1: scoped 包名解析 —— 显式 configuredPaths 传入 scoped 包目录，
  // 注册表包名应为 "@scope/pkg"（auto-discovery 仍加载 extensions/）。
  registryModule.configurePluginProviderRegistry({
    cwd: workspacePath,
    agentDir: configDir,
    configuredPaths: Promise.resolve([scopedPkgDir]),
  });
  const st2 = await registryModule.refreshPluginProviders();
  const scopeEntry = st2.providers.find((p) => p.name === "scopeprov");
  assert("scoped provider captured", scopeEntry !== undefined, JSON.stringify(st2.providers));
  assert("scoped package resolved", scopeEntry?.package === "@scope/pkg", scopeEntry?.package);
  assert(
    "top-level extensions still captured with configuredPaths",
    st2.providers.some((p) => p.name === "testprovider"),
    JSON.stringify(st2.providers),
  );

  // ---- Task 3：config-manager 列表合并 ----
  // 无 refreshModels 的插件 provider：注册表有它、models-store 无模型且从未
  // 刷新 → 列表应以空 models 数组列出（spec「无模型插件 provider 仍列出」）。
  await mkdir(join(configDir, "extensions", "no-refresh-ext"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "no-refresh-ext", "index.js"),
    `export default function (pi) {
  pi.registerProvider("norefreshprov", {
    baseUrl: "http://127.0.0.1:5/v1",
    api: "openai-completions",
  });
};\n`,
  );
  // 回到默认 configuredPaths（顶层 extensions/ 扫描）再刷新一次，注册表
  // 现在包含 testprovider / nativeprov / failprov / norefreshprov。
  registryModule.configurePluginProviderRegistry({
    cwd: workspacePath,
    agentDir: configDir,
  });
  const st3 = await registryModule.refreshPluginProviders();
  assert(
    "norefresh provider captured",
    st3.providers.some((p) => p.name === "norefreshprov"),
    JSON.stringify(st3.providers),
  );

  // 列表合并：注册表 provider 进列表（via/package 标注），models-store 持久化
  // 模型无需再次刷新即可读到（M1 列表侧：registerProvider 后 SDK phase-1
  // store-restore）。
  const cmModule = (await import(
    resolve(repoRoot, "packages/server/dist/config-manager.js")
  )) as unknown as {
    liveProvidersListing: () => Promise<{
      ready: boolean;
      errors: { path: string; error: string }[];
      providers: {
        provider: string;
        via?: string;
        package?: string;
        models: { id: string }[];
      }[];
    }>;
  };
  const listing = await cmModule.liveProvidersListing();
  assert("listing ready flag", listing.ready === true, JSON.stringify(listing.errors));
  assert(
    "listing errors typed array",
    Array.isArray(listing.errors) &&
      listing.errors.every((e) => typeof e.path === "string" && typeof e.error === "string"),
    JSON.stringify(listing.errors),
  );
  const tp = listing.providers.find((p) => p.provider === "testprovider");
  assert(
    "plugin provider listed",
    tp !== undefined,
    JSON.stringify(listing.providers.map((p) => p.provider)),
  );
  assert("via annotated", tp?.via === "test-provider-ext", tp?.via);
  assert("package annotated", tp?.package === "test-provider-ext", tp?.package);
  assert("models from store", (tp?.models.length ?? 0) >= 1, JSON.stringify(tp?.models));
  const nr = listing.providers.find((p) => p.provider === "norefreshprov");
  assert(
    "no-refresh provider listed with empty models",
    nr !== undefined && nr.models.length === 0,
    JSON.stringify(nr),
  );
  const np = listing.providers.find((p) => p.provider === "nativeprov");
  assert(
    "native provider listed with via",
    np !== undefined && np.via === "native-provider-ext",
    JSON.stringify(np),
  );

  // ---- Task 8 Step 3 准备：plugin-config 注册表预刷新 + 预写 settings.json ----
  // compat 声明（pi-provider-omniroute 等）来自 COMPAT_DECLARATIONS，与 capture
  // 开关无关；先同步刷新一次，后续 PUT 保存时无需等待 boot 的 fire-and-forget
  // 刷新（照 test-plugin-config-api.ts 的骨架）。settings.json 先以
  // {other:{x:1}} 存在，随后经 PUT 部分更新验证无关键保留。
  const pcModule = (await import(
    resolve(repoRoot, "packages/server/dist/plugin-config/registry.js")
  )) as unknown as {
    configurePluginConfigRegistry: (d: {
      cwd: string;
      agentDir: string;
      captureEnabled: boolean;
    }) => void;
    refreshPluginConfigs: () => Promise<unknown>;
  };
  pcModule.configurePluginConfigRegistry({
    cwd: workspacePath,
    agentDir: configDir,
    captureEnabled: true,
  });
  await pcModule.refreshPluginConfigs();
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ other: { x: 1 } }));

  // boot 冒烟（骨架照 test-plugin-config-api.ts）
  const fastify = await buildModule.buildServer();
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  await fastify.close();

  // ---- Task 4：REST 刷新端点（HTTP 层，server.inject）----
  const server = await buildModule.buildServer();
  // 刷新已注册插件 provider → 200 + 模型列表（refreshModels 回调）。
  const res = await server.inject({
    method: "POST",
    url: "/api/v1/config/providers/testprovider/refresh",
  });
  assert("refresh 200", res.statusCode === 200, `${res.statusCode} ${res.body}`);
  const body = JSON.parse(res.body) as {
    provider: string;
    models: { id: string }[];
  };
  assert("refresh provider name", body.provider === "testprovider", body.provider);
  assert(
    "refresh body models",
    Array.isArray(body.models) && body.models.length >= 1,
    JSON.stringify(body.models),
  );
  // 未注册 provider → 404 not_found。
  const res404 = await server.inject({
    method: "POST",
    url: "/api/v1/config/providers/nope/refresh",
  });
  assert(
    "refresh 404",
    res404.statusCode === 404 && JSON.parse(res404.body).error === "not_found",
    `${res404.statusCode} ${res404.body}`,
  );
  // native 注册 → 200：registerNativeProvider + 标准刷新管线（radiusProvider 无
  // refreshModels → 空模型列表，不抛错）。
  const resNative = await server.inject({
    method: "POST",
    url: "/api/v1/config/providers/nativeprov/refresh",
  });
  assert(
    "refresh native 200 with models array",
    resNative.statusCode === 200 && Array.isArray(JSON.parse(resNative.body).models),
    `${resNative.statusCode} ${resNative.body}`,
  );
  // M1 全链路：刷新后 GET 列表无需再次刷新即可读到模型；列表顶层
  // ready/errors、via/package 标注同步进 HTTP 响应。
  const listRes = await server.inject({ method: "GET", url: "/api/v1/config/providers" });
  assert("listing 200", listRes.statusCode === 200, `${listRes.statusCode} ${listRes.body}`);
  const listing2 = JSON.parse(listRes.body) as {
    ready: unknown;
    errors: unknown;
    providers: {
      provider: string;
      via?: string;
      package?: string;
      models: { id: string }[];
    }[];
  };
  assert(
    "listing top-level ready",
    typeof listing2.ready === "boolean" && listing2.ready === true,
    JSON.stringify(listing2),
  );
  assert(
    "listing top-level errors",
    Array.isArray(listing2.errors) &&
      listing2.errors.every((e) => typeof (e as { path: string; error: string }).path === "string"),
    JSON.stringify(listing2.errors),
  );
  // Task 8 Step 2：坏扩展隔离的 HTTP 层 —— 列表仍 200 且含 testprovider，
  // broken-ext 只出现在 errors 数组（错误不阻断其他 provider 的注册与列表）。
  assert(
    "broken extension isolated in HTTP listing errors",
    Array.isArray(listing2.errors) &&
      listing2.errors.some((e) => (e as { path: string }).path.includes("broken-ext")),
    JSON.stringify(listing2.errors),
  );
  const tp2 = listing2.providers.find((p) => p.provider === "testprovider");
  assert(
    "M1: models visible in list after refresh",
    (tp2?.models.length ?? 0) >= 1,
    JSON.stringify(tp2),
  );
  assert("via in HTTP listing", tp2?.via === "test-provider-ext", tp2?.via);
  assert("package in HTTP listing", tp2?.package === "test-provider-ext", tp2?.package);
  const nr2 = listing2.providers.find((p) => p.provider === "norefreshprov");
  assert(
    "no-refresh provider empty models via HTTP",
    nr2 !== undefined && Array.isArray(nr2.models) && nr2.models.length === 0,
    JSON.stringify(nr2),
  );
  // ---- Task 8 Step 3：settings.json 无关键保留（HTTP 层）----
  // spec「部分更新保留未知键」：PUT 保存 @philogag/pi-provider-omniroute.baseUrl，
  // settings.json 其余键（other）必须保留，且 omniroute 块被写入。
  const putRes = await server.inject({
    method: "PUT",
    url: "/api/v1/config/plugin-configs/@philogag%2Fpi-provider-omniroute",
    payload: { values: { "pi-provider-omniroute.baseUrl": "http://x" } },
  });
  assert(
    "settings PUT 200",
    putRes.statusCode === 200 && (JSON.parse(putRes.body) as { ok?: boolean }).ok === true,
    `${putRes.statusCode} ${putRes.body}`,
  );
  const settingsRaw = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as {
    other?: { x?: number };
    "pi-provider-omniroute"?: { baseUrl?: string };
  };
  assert(
    "settings.json preserves unknown keys",
    settingsRaw.other?.x === 1,
    JSON.stringify(settingsRaw),
  );
  assert(
    "settings.json block written",
    settingsRaw["pi-provider-omniroute"]?.baseUrl === "http://x",
    JSON.stringify(settingsRaw),
  );
  await server.close();

  // ---- Task 8 Step 1：独立开关（PLUGIN_CONFIG_CAPTURE=false 新 boot）----
  // capture 开关在服务端 config 模块加载时读取；dist 模块此前已以默认值加载，
  // 故用 query-string 动态 import 创建全新模块实例（Node 按 specifier 缓存，
  // `?captureoff` 触发整图重求值），使该实例在加载时读到
  // PLUGIN_CONFIG_CAPTURE=false —— 与 test-plugin-config-capture-off.ts 的
  // 「先设 env 再 import」等价。SDK 包（裸 specifier 不带 query）仍共享，
  // 但 config / providers registry / plugin-config registry 全部为全新单例。
  process.env.PLUGIN_CONFIG_CAPTURE = "false";
  const bust = "?captureoff";
  const offIndex = (await import(
    resolve(repoRoot, "packages/server/dist/index.js") + bust
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (o: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const offRegistry = (await import(
    resolve(repoRoot, "packages/server/dist/providers/registry.js") + bust
  )) as unknown as {
    configurePluginProviderRegistry: (d: { cwd: string; agentDir: string }) => void;
    refreshPluginProviders: () => Promise<{
      ready: boolean;
      providers: { name: string }[];
      errors: { path: string; error: string }[];
    }>;
  };
  offRegistry.configurePluginProviderRegistry({ cwd: workspacePath, agentDir: configDir });
  const offSt = await offRegistry.refreshPluginProviders();
  assert("capture-off registry ready", offSt.ready === true, JSON.stringify(offSt.errors));
  assert(
    "capture-off registry still captures testprovider",
    offSt.providers.some((p) => p.name === "testprovider"),
    JSON.stringify(offSt.providers),
  );
  const offServer = await offIndex.buildServer();
  const offBase = await offServer.listen({ port: 0, host: "127.0.0.1" });
  try {
    // 列表接口照常合并注册表（独立于 capture 开关）。
    const pr = await fetch(`${offBase}/api/v1/config/providers`);
    assert("capture-off providers listing 200", pr.status === 200, String(pr.status));
    const plist = (await pr.json()) as { providers: { provider: string }[] };
    assert(
      "capture-off listing includes plugin provider",
      plist.providers.some((p) => p.provider === "testprovider"),
      JSON.stringify(plist.providers.map((p) => p.provider)),
    );
    // plugin-config：capture 关闭 → 无 extension-event 声明；compat 照常出现。
    // boot 的 refreshPluginConfigs() 是 fire-and-forget，轮询到 ready 再断言。
    let clist:
      | { ready: boolean; declarations: { source?: string; package?: string }[] }
      | undefined;
    for (let i = 0; i < 50; i += 1) {
      const cr = await fetch(`${offBase}/api/v1/config/plugin-configs`);
      const parsed = (await cr.json()) as {
        ready: boolean;
        declarations: { source?: string; package?: string }[];
      };
      if (parsed.ready === true) {
        clist = parsed;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert("capture-off plugin-config list ready", clist?.ready === true, JSON.stringify(clist));
    assert(
      "no extension-event declarations when capture off",
      clist !== undefined &&
        Array.isArray(clist.declarations) &&
        clist.declarations.every((d) => d.source !== "extension-event"),
      JSON.stringify(clist?.declarations),
    );
    assert(
      "compat declarations still present when capture off",
      clist !== undefined &&
        Array.isArray(clist.declarations) &&
        clist.declarations.some((d) => d.package === "@philogag/pi-provider-omniroute"),
      JSON.stringify(clist?.declarations),
    );
  } finally {
    await offServer.close();
  }

  await rm(workspacePath, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
  console.log("providers: ALL PASS");
}
void main();
