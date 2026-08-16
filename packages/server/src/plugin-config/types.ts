// packages/server/src/plugin-config/types.ts
export type DeclarationSource = "extension-event" | "compat";

/**
 * pi-extension-settings compatible store file inside PI_CONFIG_DIR.
 * Values written here are string-coerced to match the pi-side getSetting
 * semantics (see store.ts putValues `stringCoerce`).
 */
export const SETTINGS_EXTENSIONS_FILE = "settings-extensions.json";

export interface ConfigDeclaration {
  package: string;
  file: string;
  label: string;
  description?: string;
  source: DeclarationSource;
  fields: FieldDefinition[];
}

export interface ScalarField {
  kind: "scalar";
  path: string;
  type: "string" | "number" | "boolean" | "enum";
  label: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  secret?: boolean;
  enum?: { value: string; label: string }[];
}

export interface MultiSelectField {
  kind: "multi-select";
  path: string;
  label: string;
  description?: string;
  options: { id: string; label: string }[];
}

export type FieldDefinition = ScalarField | MultiSelectField;

export interface PluginConfigSummary {
  package: string;
  label: string;
  description?: string;
  file: string;
  source: DeclarationSource;
  exists: boolean;
  ready: boolean;
  fields: FieldDefinition[];
  values: Record<string, unknown>;
  /** Full parsed file content (single-package GET only) for the raw editor. */
  rawValue?: unknown;
}

export type SavePluginConfigBody =
  | { values?: Record<string, unknown>; raw?: never }
  | { raw?: string; values?: never };

export interface PluginConfigListResponse {
  ready: boolean;
  declarations: PluginConfigSummary[];
  errors: { path: string; error: string }[];
}

export interface SettingDefinitionLike {
  id: string;
  label?: string;
  description?: string;
  defaultValue?: string;
  values?: string[];
  options?: { id: string; label: string }[];
}
