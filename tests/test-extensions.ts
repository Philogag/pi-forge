/**
 * Extensions manager integration test.
 *
 * Boots the server in-process with a temp `PI_CONFIG_DIR` / `FORGE_DATA_DIR`
 * and installs a LOCAL fixture package (`tests/fixtures/ext-sample`) at
 * user scope. The SDK treats local paths as in-place references (install
 * only verifies the path exists; nothing is copied), so assertions check
 * `settings.json#packages[]` persistence rather than install-directory
 * layout.
 *
 * Coverage:
 *   - GET /config/extensions on an empty config → `{ packages: [] }`
 *   - POST /config/extensions/install (local fixture, user scope) → 200
 *   - GET lists the package with name from package.json + grouped
 *     resources (skills / prompts from the `pi` manifest)
 *   - settings.json#packages[] persisted after install
 *   - reinstall is idempotent — still exactly one listing entry
 *   - POST /config/extensions/remove for an unknown source → 404
 *     `package_not_found`
 *   - POST /config/extensions/remove of the installed source → 200
 *     `{ removed: true }`; GET empty again; settings entry dropped
 *   - install with a missing `scope` → 400
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const fixturePkg = resolve(__dirname, "fixtures", "ext-sample");

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

interface PackageJson {
  packages?: (string | { source?: string })[];
}

async function readSettingsPackages(configDir: string): Promise<PackageJson> {
  const raw = await readFile(join(configDir, "settings.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

function sourceOf(p: string | { source?: string }): string {
  return typeof p === "string" ? p : (p.source ?? "");
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ext-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-ext-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-ext-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-extensions] PI_CONFIG_DIR=${configDir}`);
  console.log(`[test-extensions] fixture=${fixturePkg}`);

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    // 1. empty list
    {
      const r = await jget(base, "/api/v1/config/extensions");
      assert("GET /config/extensions initial → 200", r.status === 200);
      assert(
        "  body is { packages: [] }",
        JSON.stringify(r.body) === '{"packages":[]}',
        JSON.stringify(r.body),
      );
    }

    // 2. install local fixture (user scope)
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", {
        source: fixturePkg,
        scope: "user",
      });
      assert("POST /config/extensions/install → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as { source?: string; scope?: string };
      assert("  body echoes source + scope", body.source !== undefined && body.scope === "user");
    }

    // 3. list shows the package with grouped resources
    {
      const r = await jget(base, "/api/v1/config/extensions");
      assert("GET after install → 200", r.status === 200);
      const list = (r.body as { packages: unknown[] }).packages;
      assert("  exactly one package listed", list.length === 1, JSON.stringify(list));
      const pkg = list[0] as {
        source: string;
        type: string;
        scope: string;
        name?: string;
        resources: { skills: { path: string }[]; prompts: { path: string }[] };
      };
      assert(
        "  package name from package.json",
        pkg.name === "forge-ext-sample",
        JSON.stringify(pkg),
      );
      assert("  scope is user", pkg.scope === "user");
      assert(
        "  resources.skills non-empty",
        Array.isArray(pkg.resources.skills) && pkg.resources.skills.length > 0,
        JSON.stringify(pkg.resources),
      );
      assert(
        "  resources.prompts non-empty",
        Array.isArray(pkg.resources.prompts) && pkg.resources.prompts.length > 0,
        JSON.stringify(pkg.resources),
      );
    }

    // 4. settings.json persisted (SDK normalizes local sources to a
    //    path relative to the scope base dir — still contains the name)
    {
      const settings = await readSettingsPackages(configDir);
      const found = (settings.packages ?? []).some((p) => sourceOf(p).includes("ext-sample"));
      assert(
        "settings.json#packages[] contains installed source",
        found,
        JSON.stringify(settings.packages),
      );
    }

    // 5. reinstall is idempotent — no duplicate listing entries
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", {
        source: fixturePkg,
        scope: "user",
      });
      assert("reinstall → 200", r.status === 200, JSON.stringify(r.body));
      const list = (await jget(base, "/api/v1/config/extensions")).body as {
        packages: unknown[];
      };
      assert(
        "  still exactly one entry",
        list.packages.length === 1,
        JSON.stringify(list.packages),
      );
    }

    // 6. remove unknown package → 404 package_not_found
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/remove", {
        source: "definitely-not-installed",
        scope: "user",
      });
      assert("remove unknown → 404", r.status === 404);
      assert(
        "  error is package_not_found",
        (r.body as { error?: string }).error === "package_not_found",
        JSON.stringify(r.body),
      );
    }

    // 7. remove installed → 200; list empty; settings entry dropped
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/remove", {
        source: fixturePkg,
        scope: "user",
      });
      assert("remove installed → 200", r.status === 200, JSON.stringify(r.body));
      assert("  removed: true", (r.body as { removed?: boolean }).removed === true);
      const list = (await jget(base, "/api/v1/config/extensions")).body as { packages: unknown[] };
      assert(
        "  list empty after remove",
        list.packages.length === 0,
        JSON.stringify(list.packages),
      );
      const settings = await readSettingsPackages(configDir);
      const stillThere = (settings.packages ?? []).some((p) => sourceOf(p).includes("ext-sample"));
      assert(
        "  settings.json#packages[] entry dropped",
        !stillThere,
        JSON.stringify(settings.packages),
      );
    }

    // 8. invalid body → 400
    {
      const r = await jsend(base, "POST", "/api/v1/config/extensions/install", { source: "x" });
      assert("install without scope → 400", r.status === 400, JSON.stringify(r.body));
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-extensions] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-extensions] PASS");
}

main().catch((err) => {
  console.error("[test-extensions] uncaught error:", err);
  process.exit(1);
});
