import {
  COMPAT_DECLARATIONS,
  validateCompatDeclarations,
} from "../extensions-settings-compat/index.js";
import { makeDedupe } from "../concurrency.js";
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

export function mergeDeclarations(
  capture: ConfigDeclaration[],
  compat: ConfigDeclaration[],
): ConfigDeclaration[] {
  const compatByPkg = new Map(compat.map((d) => [d.package, d]));
  // Deduplicate capture-side declarations by package (first wins; a later
  // registration with the same name is dropped rather than rendered twice).
  const seenCapture = new Set<string>();
  const out: ConfigDeclaration[] = [];
  const seen = new Set<string>();
  for (const cd of capture) {
    if (seenCapture.has(cd.package)) continue;
    seenCapture.add(cd.package);
    const cp = compatByPkg.get(cd.package);
    if (cp === undefined) {
      out.push(cd);
      continue;
    }
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

const refreshDedupe = makeDedupe<string, RegistryState>();

export async function refreshPluginConfigs(): Promise<RegistryState> {
  if (deps === undefined) {
    // Not configured (boot wiring missing) — surface as error state rather
    // than throwing, since every caller is a fire-and-forget `void` call.
    state = {
      status: "error",
      ready: false,
      declarations: state.declarations,
      errors: [
        ...state.errors,
        { path: "<registry>", error: "plugin-config registry not configured" },
      ],
    };
    return state;
  }
  // Dedupe concurrent refreshes (startup preload, /reload, install/remove
  // hooks can overlap) so later runs don't clobber earlier ones mid-flight.
  return refreshDedupe("refresh", refreshImpl);
}

async function refreshImpl(): Promise<RegistryState> {
  if (deps === undefined) return state; // guarded by refreshPluginConfigs
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
  // Shallow copy so callers cannot mutate the module-level state.
  return { ...state, declarations: [...state.declarations], errors: [...state.errors] };
}

export function getConfigDeclaration(pkg: string): ConfigDeclaration | undefined {
  return state.declarations.find((d) => d.package === pkg);
}
