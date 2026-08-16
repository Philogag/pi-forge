// packages/server/src/plugin-config/store.ts
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  /** Full parsed file content (when the file exists and parses). Used by
   * the raw editor so it edits the WHOLE file, not just declared fields. */
  rawValue?: unknown;
}

const fileLocks = new Map<string, ReturnType<typeof makeLock>>();
function getLock(file: string) {
  let lock = fileLocks.get(file);
  if (lock === undefined) {
    lock = makeLock();
    fileLocks.set(file, lock);
  }
  return lock;
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    try {
      await rename(tmp, absPath);
    } catch (err) {
      // Docker single-file bind mounts reject rename() over the mount
      // point with EBUSY ("resource busy or locked") while the file
      // itself remains writable. Fall back to an in-place write through
      // the mount so the file is still persisted; atomicity (all-or-
      // nothing) is lost only for this deployment shape.
      if ((err as NodeJS.ErrnoException).code === "EBUSY") {
        await unlink(tmp).catch(() => undefined);
        const fh = await open(absPath, "w");
        try {
          await fh.writeFile(content, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        return;
      }
      throw err;
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw new ConfigFileError(`failed to write ${absPath}: ${(err as Error).message}`, "io");
  }
}

async function readFileState(
  file: string,
  piConfigDir: string,
): Promise<{
  abs: string;
  exists: boolean;
  error?: "invalid_json";
  root: Record<string, unknown>;
}> {
  const check = await validateConfigFilePath(file, piConfigDir);
  if (!check.ok) throw new ConfigFileError(check.error, "traversal");
  const { absPath } = check;
  try {
    const raw = await readFile(absPath, "utf8");
    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
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
  if (state.exists && state.error === undefined) out.rawValue = state.root;
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
    const coerce = (v: unknown): unknown =>
      opts?.stringCoerce === true && !Array.isArray(v) ? String(v) : v;
    for (const [path, value] of Object.entries(values)) {
      try {
        pathSet(root, path, coerce(value));
      } catch (err) {
        throw new ConfigFileError(
          `invalid value path "${path}": ${(err as Error).message}`,
          "validation",
        );
      }
    }
    await atomicWrite(absPath, `${JSON.stringify(root, null, 2)}\n`);
  });
}

export async function putRaw(file: string, piConfigDir: string, raw: string): Promise<void> {
  const check = await validateConfigFilePath(file, piConfigDir);
  if (!check.ok) throw new ConfigFileError(check.error, "traversal");
  const { absPath } = check;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
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
  const isEmpty = (v: unknown): boolean =>
    v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  for (const [path, value] of Object.entries(values)) {
    const f = byPath.get(path);
    if (f === undefined) return { ok: false, error: `unknown field path "${path}"`, field: path };
    if (f.kind === "multi-select") {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === "string" && f.options.some((o) => o.id === v))
      ) {
        return { ok: false, error: `field "${path}" must be an array of option ids`, field: path };
      }
      continue;
    }
    if (f.required === true && isEmpty(value)) {
      return { ok: false, error: `field "${path}" is required`, field: path };
    }
    switch (f.type) {
      case "string":
        if (typeof value !== "string")
          return { ok: false, error: `field "${path}" must be a string`, field: path };
        if (f.pattern !== undefined) {
          try {
            if (!new RegExp(f.pattern).test(value))
              return {
                ok: false,
                error: `field "${path}" does not match ${f.pattern}`,
                field: path,
              };
          } catch {
            return {
              ok: false,
              error: `field "${path}" has an invalid pattern in its declaration`,
              field: path,
            };
          }
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value))
          return { ok: false, error: `field "${path}" must be a finite number`, field: path };
        if (f.min !== undefined && value < f.min)
          return { ok: false, error: `field "${path}" must be >= ${f.min}`, field: path };
        if (f.max !== undefined && value > f.max)
          return { ok: false, error: `field "${path}" must be <= ${f.max}`, field: path };
        break;
      case "boolean":
        if (typeof value !== "boolean")
          return { ok: false, error: `field "${path}" must be a boolean`, field: path };
        break;
      case "enum":
        if (typeof value !== "string" || !f.enum?.some((e) => e.value === value)) {
          return {
            ok: false,
            error: `field "${path}" must be one of ${(f.enum ?? []).map((e) => e.value).join(", ")}`,
            field: path,
          };
        }
        break;
    }
  }
  return { ok: true };
}
