/**
 * Plugin config REST endpoints integration test.
 *
 * Boots the server in-process with temp WORKSPACE_PATH / PI_CONFIG_DIR /
 * FORGE_DATA_DIR and a temp global extension (`<configDir>/extensions/
 * settings-sample.js`) that emits `pi-extension-settings:register`.
 *
 * The plugin-config registry is configured + refreshed on the DIST module
 * (the same module instance the server routes read state from) before
 * boot, so capture is deterministic even without the boot-time wiring.
 * POST /config/plugin-configs/reload is fire-and-forget (returns 200
 * immediately), so capture-dependent assertions poll GET
 * /config/plugin-configs until `ready === true` and the target
 * declaration is listed (max ~5s).
 *
 * Coverage:
 *   - POST /config/plugin-configs/reload → 200 { reloaded: true }
 *   - GET /config/plugin-configs → 200 with captured declaration + ready
 *   - PUT /config/plugin-configs/:package { values } → string-coerced
 *     write into settings-extensions.json (root-level, store semantics)
 *   - GET /config/plugin-configs/:package → exists + values
 *   - unknown package → 404 not_found (GET + PUT)
 *   - PUT { raw } replaces the file; invalid raw → 400 invalid_json
 *   - values + raw together → 400 validation_failed
 *   - PUT values with undeclared path → 400 validation_failed
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(base: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  base: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

/** Poll GET /config/plugin-configs until ready && declaration present. */
async function waitForList(
  base: string,
  pkg: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; last: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const r = await jget(base, "/api/v1/config/plugin-configs");
    last = r.body;
    if (r.status === 200) {
      const list = r.body as { ready?: boolean; declarations?: { package?: string }[] };
      if (
        list.ready === true &&
        Array.isArray(list.declarations) &&
        list.declarations.some((d) => d.package === pkg)
      ) {
        return { ok: true, last };
      }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  return { ok: false, last };
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
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  // 捕获源：临时全局扩展（discoverAndLoadExtensions 扫描 agentDir/extensions）
  await mkdir(join(configDir, "extensions"), { recursive: true });
  await writeFile(
    join(configDir, "extensions", "settings-sample.js"),
    `export default function (api) {
  api.events.emit("pi-extension-settings:register", {
    name: "ext-settings-sample",
    settings: [{ id: "greeting", label: "Greeting", defaultValue: "hi", values: ["hi", "hello"] }],
  });
};\n`,
  );

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  // 预配置 + 预刷新 dist 注册表模块（与服务端路由共享同一模块实例），
  // 确保捕获完成后再 boot；reload 端点本身 fire-and-forget，后续断言仍轮询。
  const registryModule = (await import(
    resolve(repoRoot, "packages/server/dist/plugin-config/registry.js")
  )) as unknown as {
    configurePluginConfigRegistry: (d: {
      cwd: string;
      agentDir: string;
      captureEnabled: boolean;
    }) => void;
    refreshPluginConfigs: () => Promise<unknown>;
  };
  registryModule.configurePluginConfigRegistry({
    cwd: workspacePath,
    agentDir: configDir,
    captureEnabled: true,
  });
  await registryModule.refreshPluginConfigs();

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    // 1. reload（fire-and-forget）→ 轮询直到 ready && 声明可见
    {
      const r = await jsend(base, "POST", "/api/v1/config/plugin-configs/reload", undefined);
      assert(
        "POST reload → 200 {reloaded:true}",
        r.status === 200 && (r.body as { reloaded?: boolean }).reloaded === true,
        JSON.stringify(r.body),
      );
      const w = await waitForList(base, "ext-settings-sample");
      assert("GET list ready + includes captured declaration", w.ok, JSON.stringify(w.last));
    }
    // 2. GET list 形状
    {
      const r = await jget(base, "/api/v1/config/plugin-configs");
      assert("GET list → 200", r.status === 200);
      const list = r.body as {
        ready: boolean;
        declarations: { package: string }[];
        errors: { path: string; error: string }[];
      };
      assert("  list.ready === true", list.ready === true);
      assert(
        "  declarations contains ext-settings-sample",
        Array.isArray(list.declarations) &&
          list.declarations.some((d) => d.package === "ext-settings-sample"),
        JSON.stringify(list),
      );
      assert("  errors is an array", Array.isArray(list.errors), JSON.stringify(list.errors));
    }
    // 3. 表单保存 → settings-extensions.json（store 语义：值写于文件根，stringCoerce）
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", {
        values: { greeting: "hello" },
      });
      assert(
        "PUT values → 200 {ok:true}",
        r.status === 200 && (r.body as { ok?: boolean }).ok === true,
        JSON.stringify(r.body),
      );
      const raw = JSON.parse(
        await readFile(join(configDir, "settings-extensions.json"), "utf8"),
      ) as Record<string, unknown>;
      assert(
        "settings-extensions.json is string-typed",
        raw.greeting === "hello" && typeof raw.greeting === "string",
        JSON.stringify(raw),
      );
    }
    // 4. GET 单项回读
    {
      const r = await jget(base, "/api/v1/config/plugin-configs/ext-settings-sample");
      const d = r.body as { exists: boolean; values: Record<string, unknown> };
      assert(
        "GET :package → 200 + value",
        r.status === 200 && d.exists === true && d.values.greeting === "hello",
        JSON.stringify(r.body),
      );
    }
    // 5. 未注册包
    {
      const r = await jget(base, "/api/v1/config/plugin-configs/unknown-pkg");
      assert(
        "GET unknown → 404 not_found",
        r.status === 404 && (r.body as { error?: string }).error === "not_found",
        JSON.stringify(r.body),
      );
      const p = await jsend(base, "PUT", "/api/v1/config/plugin-configs/unknown-pkg", {
        values: { a: 1 },
      });
      assert("PUT unknown → 404", p.status === 404, JSON.stringify(p.body));
    }
    // 6. raw 替换 + 非法 raw
    {
      const ok = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", {
        raw: JSON.stringify({ ext: { greeting: "raw-edited" } }),
      });
      assert("PUT raw → 200", ok.status === 200, JSON.stringify(ok.body));
      const back = JSON.parse(
        await readFile(join(configDir, "settings-extensions.json"), "utf8"),
      ) as Record<string, unknown>;
      assert(
        "raw replaced file",
        (back.ext as Record<string, unknown> | undefined)?.greeting === "raw-edited",
        JSON.stringify(back),
      );
      const bad = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", {
        raw: "{ nope",
      });
      assert(
        "PUT invalid raw → 400 invalid_json",
        bad.status === 400 && (bad.body as { error?: string }).error === "invalid_json",
        JSON.stringify(bad.body),
      );
    }
    // 6b. GET :package exposes the FULL file as rawValue (raw editor needs
    //     keys outside the declaration, e.g. other extensions' settings)
    {
      const r = await jget(base, "/api/v1/config/plugin-configs/ext-settings-sample");
      const d = r.body as { rawValue?: Record<string, unknown> };
      assert(
        "GET :package rawValue includes undeclared keys",
        r.status === 200 &&
          d.rawValue !== undefined &&
          (d.rawValue.ext as Record<string, unknown> | undefined)?.greeting === "raw-edited" &&
          d.rawValue.ext !== undefined,
        JSON.stringify(d.rawValue),
      );
    }
    // 7. values 与 raw 互斥
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", {
        values: { greeting: "hi" },
        raw: "{}",
      });
      assert("PUT both values+raw → 400", r.status === 400, JSON.stringify(r.body));
    }
    // 8. 未声明字段路径被拒
    {
      const r = await jsend(base, "PUT", "/api/v1/config/plugin-configs/ext-settings-sample", {
        values: { "../evil": "x" },
      });
      assert("PUT unknown path → 400", r.status === 400, JSON.stringify(r.body));
    }
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
