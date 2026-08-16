// packages/server/src/plugin-config/paths.ts
import { basename, join, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";

export function parseSegments(path: string): (string | number)[] {
  return path.split(".").flatMap((seg) => {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(seg);
    if (m === null) return [seg];
    const key = m[1] ?? seg;
    const idx = m[2];
    return idx !== undefined ? [key, Number(idx)] : [key];
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
  if (segs.length === 0) throw new Error(`pathSet: empty path`);
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!; // i < len-1 → always defined
    const next = segs[i + 1];
    // When the next segment is an array index, the created container must
    // be an array (e.g. `models[0].name` → `{"models":[{...}]}`).
    const createContainer = (): Record<string, unknown> | unknown[] =>
      typeof next === "number" ? [] : {};
    if (typeof seg === "number") {
      const arr = cur as unknown[];
      if (!Array.isArray(arr)) throw new Error(`pathSet: expected array at "${path}"`);
      let child = arr[seg];
      if (child === undefined || child === null || typeof child !== "object") {
        child = createContainer();
        arr[seg] = child;
      }
      cur = child;
    } else {
      if (Array.isArray(cur)) throw new Error(`pathSet: expected object at "${path}"`);
      const obj = cur as Record<string, unknown>;
      let child = obj[seg];
      if (child === undefined || child === null || typeof child !== "object") {
        child = createContainer();
        obj[seg] = child;
      }
      cur = child;
    }
  }
  const last = segs[segs.length - 1];
  if (last === undefined) throw new Error(`pathSet: empty path`);
  if (typeof last === "number") {
    if (!Array.isArray(cur)) throw new Error(`pathSet: expected array at "${path}"`);
    (cur as unknown[])[last] = value;
  } else {
    if (Array.isArray(cur)) throw new Error(`pathSet: expected object at "${path}"`);
    (cur as Record<string, unknown>)[last] = value;
  }
}

/** Pure syntax check shared by `validateConfigFilePath` and the compat
 *  validator: a single `<name>.json` inside PI_CONFIG_DIR. Nothing else
 *  is allowed (spec R6: only PI_CONFIG_DIR JSON files). */
export function isAllowedConfigFile(file: string): boolean {
  return file.length > 0 && basename(file) === file && file.endsWith(".json");
}

export async function validateConfigFilePath(
  file: string,
  piConfigDir: string,
): Promise<{ ok: true; absPath: string } | { ok: false; error: string }> {
  if (!isAllowedConfigFile(file)) {
    return { ok: false, error: "config file must be a single filename (no path separators)" };
  }
  const abs = join(piConfigDir, file);
  try {
    const real = await realpath(abs);
    const realDir = await realpath(piConfigDir);
    if (real !== realDir && !real.startsWith(realDir + sep)) {
      return { ok: false, error: "config file escapes PI_CONFIG_DIR" };
    }
  } catch {
    // File absent, or a dangling symlink. A dangling symlink must be
    // rejected (it would escape PI_CONFIG_DIR once its target exists);
    // a genuinely absent file is fine (it will be created on save).
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        return { ok: false, error: "config file is a dangling symlink" };
      }
    } catch {
      // ENOENT — file does not exist yet.
    }
  }
  return { ok: true, absPath: abs };
}
