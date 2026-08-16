/**
 * Plugin config capture-off integration test.
 *
 * Boots the server in-process with PLUGIN_CONFIG_CAPTURE=false (set before
 * importing the server module so config.ts reads it at load time). A temp
 * global extension that emits `pi-extension-settings:register` exists under
 * <configDir>/extensions/, yet the plugin-config list must contain NO
 * extension-event declarations and still report ready: true.
 *
 * Compat declarations are independent of the capture switch: the in-tree
 * billion-context-pi compat entry (file "acp.json") must still appear.
 *
 * Coverage:
 *   - GET /config/plugin-configs → 200, ready: true
 *   - capture disabled → no "extension-event" sourced declarations
 *   - capture disabled → compat declarations still present
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-pc-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-pc-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-pc-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  // Capture must be OFF when the server config module loads.
  process.env.PLUGIN_CONFIG_CAPTURE = "false";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  // A temp extension that would register settings if capture were enabled.
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
      listen: (o: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    const r = await jget(base, "/api/v1/config/plugin-configs");
    assert("GET list → 200", r.status === 200, String(r.status));
    const list = r.body as { ready: boolean; declarations: unknown[] };
    assert("list.ready === true", list.ready === true, JSON.stringify(list));
    assert(
      "no extension-event declarations when capture disabled",
      Array.isArray(list.declarations) &&
        list.declarations.every((d) => (d as { source?: string }).source !== "extension-event"),
      JSON.stringify(list.declarations),
    );
    assert(
      "compat declarations still present when capture disabled",
      Array.isArray(list.declarations) &&
        list.declarations.some((d) => (d as { package?: string }).package === "billion-context-pi"),
      JSON.stringify(list.declarations),
    );
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) process.exit(1);
  console.log("plugin-config capture-off: ALL PASS");
}
void main();
