import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { resolveEnabledExtensionPaths } from "../extensions-manager.js";
import { SETTINGS_EXTENSIONS_FILE } from "./types.js";
import type {
  ConfigDeclaration,
  FieldDefinition,
  MultiSelectField,
  ScalarField,
  SettingDefinitionLike,
} from "./types.js";

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
    if (typeof s !== "object" || s === null) continue; // skip malformed setting
    const rec = s as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    const out: SettingDefinitionLike = { id: rec.id };
    if (typeof rec.label === "string") out.label = rec.label;
    if (typeof rec.description === "string") out.description = rec.description;
    if (typeof rec.defaultValue === "string") out.defaultValue = rec.defaultValue;
    if (Array.isArray(rec.values) && rec.values.every((v) => typeof v === "string"))
      out.values = rec.values;
    if (
      Array.isArray(rec.options) &&
      rec.options.length > 0 &&
      rec.options.every((o) => typeof o === "object" && o !== null && typeof o.id === "string")
    ) {
      out.options = rec.options.map((o) => ({
        id: o.id,
        label: typeof o.label === "string" ? o.label : o.id,
      }));
    }
    settings.push(out);
  }
  if (settings.length === 0) return undefined;
  return { name: d.name, settings };
}

export async function captureExtensionSettings(
  cwd: string,
  agentDir: string,
): Promise<CaptureResult> {
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
      // exactOptionalPropertyTypes: build without undefined-valued optionals
      const f: MultiSelectField = { kind: "multi-select", ...base, options: s.options };
      if (s.description !== undefined) f.description = s.description;
      return f;
    }
    if (s.values !== undefined && s.values.length > 0) {
      const f: ScalarField = {
        kind: "scalar",
        ...base,
        type: "enum",
        enum: s.values.map((v) => ({ value: v, label: v })),
      };
      if (s.description !== undefined) f.description = s.description;
      // A default that is not among the declared values would leave the form
      // with a value the select cannot represent — drop it.
      if (s.defaultValue !== undefined && s.values.includes(s.defaultValue)) {
        f.defaultValue = s.defaultValue;
      }
      return f;
    }
    const f: ScalarField = { kind: "scalar", ...base, type: "string" };
    if (s.description !== undefined) f.description = s.description;
    if (s.defaultValue !== undefined) f.defaultValue = s.defaultValue;
    return f;
  });
  return {
    package: reg.name,
    file: SETTINGS_EXTENSIONS_FILE,
    label: reg.name,
    source: "extension-event",
    fields,
  };
}
