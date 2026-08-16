import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { api, ApiError } from "../lib/api-client";
import type {
  PluginConfigField,
  PluginConfigSummary,
  SavePluginConfigBody,
} from "../lib/api-client";

/**
 * Modal for editing a plugin's declared config (captured from
 * `pi-extension-settings:register` events, or registered in-repo via
 * `packages/server/src/extensions-settings-compat/`). Renders a declaration-driven form —
 * one row per field with type-appropriate controls — plus a raw JSON
 * editor that replaces the whole config file.
 */
export function PluginConfigModal({ pkg, onClose }: { pkg: string; onClose: () => void }) {
  const [summary, setSummary] = useState<PluginConfigSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  // Values as loaded from the server — the baseline for "did the user
  // change this field?" so untouched fields are never submitted (R4:
  // partial updates only write submitted fields) and discarded edits
  // really are discarded.
  const loadedRef = useRef<Record<string, unknown>>({});
  const closeTimerRef = useRef<number | undefined>(undefined);

  const rawTextOf = (s: PluginConfigSummary): string =>
    s.rawValue !== undefined ? JSON.stringify(s.rawValue, null, 2) : "{}";

  const load = async (): Promise<void> => {
    setError(undefined);
    setSavedAt(undefined);
    try {
      const s = await api.getPluginConfig(pkg);
      setSummary(s);
      loadedRef.current = { ...s.values };
      setFormValues(initFormValues(s));
      setFieldErrors({});
      setRawMode(false);
      setRawText(rawTextOf(s));
      setDirty(false);
    } catch (err) {
      setError(`Failed to load plugin config: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void load();
    // `load` closes over `pkg` only; the rest is mount-scoped state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const guardedClose = (): void => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    if (busy) return;
    onClose();
  };

  const setField = (path: string, value: unknown): void => {
    setFormValues((prev) => ({ ...prev, [path]: value }));
    setDirty(true);
  };

  const toggleMulti = (path: string, id: string): void => {
    const arr = Array.isArray(formValues[path]) ? (formValues[path] as string[]) : [];
    const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
    setField(path, next);
  };

  const moveMulti = (path: string, index: number, dir: -1 | 1): void => {
    const arr = Array.isArray(formValues[path]) ? (formValues[path] as string[]) : [];
    const target = index + dir;
    if (target < 0 || target >= arr.length) return;
    const next = [...arr];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setField(path, next);
  };

  const toggleRawMode = (): void => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    // Confirming discard really discards: reset the form to the loaded
    // values (raw mode edits live in rawText only) so switching back to
    // the form view can't resurrect stale edits.
    if (dirty && summary !== undefined) {
      setFormValues(initFormValues(summary));
      setFieldErrors({});
    }
    setError(undefined);
    if (!rawMode) setRawText(summary === undefined ? "{}" : rawTextOf(summary));
    setRawMode(!rawMode);
    setDirty(false);
  };

  const refreshRegistry = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.reloadPluginConfigs();
      await load();
      setError(undefined);
    } catch (err) {
      setError(`Failed to reload registry: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    if (rawMode) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        setError("Raw config is not valid JSON");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Raw config must be a JSON object");
        return;
      }
      await doSave({ raw: rawText });
      return;
    }
    if (summary === undefined) return;
    const errors = validateForm(summary.fields, formValues);
    setFieldErrors(errors);
    const first = Object.entries(errors)[0];
    if (first !== undefined) {
      setError(`Field "${first[0]}": ${first[1]}`);
      return;
    }
    await doSave({ values: buildValues(summary.fields, formValues, loadedRef.current) });
  };

  const doSave = async (body: SavePluginConfigBody): Promise<void> => {
    setBusy(true);
    try {
      await api.savePluginConfig(pkg, body);
      setError(undefined);
      setSavedAt(Date.now());
      setDirty(false);
      // Keep the modal open long enough to show the "Saved" feedback,
      // then close (matching the SettingsPanel save-toast pattern).
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(onClose, 1500);
    } catch (err) {
      setError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={guardedClose} title={`Plugin config — ${pkg}`} width="max-w-2xl">
      <div className="max-h-[80vh] space-y-3 overflow-y-auto p-4 text-sm text-neutral-200">
        {error !== undefined && (
          <p className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
        {summary === undefined && error === undefined && (
          <p className="text-xs italic text-neutral-500">Loading…</p>
        )}
        {summary !== undefined && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
              <span className="truncate font-mono">{summary.file}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                  summary.source === "compat"
                    ? "bg-neutral-800 text-neutral-500"
                    : "bg-emerald-900/40 text-emerald-300"
                }`}
              >
                {summary.source === "compat" ? "compat" : "captured"}
              </span>
            </div>
            {summary.description !== undefined && (
              <p className="text-xs text-neutral-400">{summary.description}</p>
            )}
            {!summary.exists && (
              <p className="rounded border border-amber-800/50 bg-amber-950/30 px-2 py-1 text-xs text-amber-400">
                Config file does not exist yet — it will be created on save.
              </p>
            )}
            {!summary.ready && (
              <div className="flex items-center justify-between gap-2 rounded border border-neutral-700 bg-neutral-900/50 px-2 py-1 text-xs text-neutral-400">
                <span>Extension capture still running — declarations may be incomplete.</span>
                <button
                  onClick={() => void refreshRegistry()}
                  disabled={busy}
                  className="shrink-0 rounded border border-neutral-600 px-2 py-0.5 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>
            )}

            {rawMode ? (
              <div>
                <p className="text-[11px] text-neutral-500">
                  Raw JSON editor — replaces the entire config file (including keys outside this
                  plugin's declaration). Invalid JSON is rejected on save.
                </p>
                <textarea
                  value={rawText}
                  onChange={(e) => {
                    setRawText(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                  rows={10}
                  className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                />
              </div>
            ) : (
              <div className="space-y-3">
                {summary.fields.length === 0 && (
                  <p className="text-xs italic text-neutral-500">
                    This plugin declares no config fields.
                  </p>
                )}
                {summary.fields.map((f) => (
                  <FieldRow
                    key={f.path}
                    field={f}
                    value={formValues[f.path]}
                    error={fieldErrors[f.path]}
                    onChange={(v) => setField(f.path, v)}
                    onToggleMulti={(id) => toggleMulti(f.path, id)}
                    onMoveMulti={(index, dir) => moveMulti(f.path, index, dir)}
                  />
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 border-t border-neutral-800 pt-3">
              <button
                onClick={toggleRawMode}
                disabled={busy}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {rawMode ? "Form view" : "Raw JSON"}
              </button>
              <div className="flex items-center gap-2">
                {savedAt !== undefined && (
                  <span
                    className="text-xs text-emerald-400 light:text-emerald-700"
                    aria-live="polite"
                  >
                    Saved
                  </span>
                )}
                <button
                  onClick={guardedClose}
                  disabled={busy}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void save()}
                  disabled={busy}
                  className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FieldRow({
  field,
  value,
  error,
  onChange,
  onToggleMulti,
  onMoveMulti,
}: {
  field: PluginConfigField;
  value: unknown;
  error: string | undefined;
  onChange: (v: unknown) => void;
  onToggleMulti: (id: string) => void;
  onMoveMulti: (index: number, dir: -1 | 1) => void;
}) {
  const constraints = constraintSummary(field);
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-neutral-200">{field.label}</span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
            {field.kind === "multi-select" ? "multi" : (field.type ?? "string")}
          </span>
          {field.secret === true && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
              secret
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-neutral-600">{field.path}</span>
      </div>
      {field.description !== undefined && (
        <p className="mt-1 text-[11px] text-neutral-500">{field.description}</p>
      )}
      {constraints.length > 0 && (
        <p className="mt-0.5 text-[10px] text-neutral-600">{constraints}</p>
      )}
      <div className="mt-1.5">
        {renderControl(field, value, onChange, onToggleMulti, onMoveMulti)}
      </div>
      {error !== undefined && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

function renderControl(
  f: PluginConfigField,
  value: unknown,
  onChange: (v: unknown) => void,
  onToggleMulti: (id: string) => void,
  onMoveMulti: (index: number, dir: -1 | 1) => void,
): ReactNode {
  const inputCls =
    "rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500";
  if (f.kind === "multi-select") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="space-y-1">
        {(f.options ?? []).map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={() => onToggleMulti(o.id)}
              className="accent-neutral-300"
            />
            <span>{o.label}</span>
          </label>
        ))}
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <span className="text-[10px] text-neutral-600">Order:</span>
            {selected.map((id, i) => (
              <span key={id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onMoveMulti(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="rounded border border-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                >
                  ↑
                </button>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                  {f.options?.find((o) => o.id === id)?.label ?? id}
                </span>
                <button
                  type="button"
                  onClick={() => onMoveMulti(i, 1)}
                  disabled={i === selected.length - 1}
                  title="Move down"
                  className="rounded border border-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                >
                  ↓
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  switch (f.type) {
    case "number":
      return (
        <input
          type="number"
          min={f.min}
          max={f.max}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} w-40 font-mono`}
        />
      );
    case "boolean":
      // settings-extensions.json stores strings ("true"/"false") — accept
      // both so a stored "false" doesn't display as checked.
      return (
        <input
          type="checkbox"
          checked={value === true || value === "true"}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-neutral-300"
        />
      );
    case "enum":
      return (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} text-neutral-100`}
        >
          <option value="">—</option>
          {(f.enum ?? []).map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      );
    default:
      return (
        <input
          type={f.secret === true ? "password" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`${inputCls} w-full font-mono`}
        />
      );
  }
}

/** Form value for a field, given the stored value (or its absence). */
function initValue(f: PluginConfigField, stored: unknown): unknown {
  return (
    stored ??
    f.defaultValue ??
    (f.kind === "multi-select" ? [] : f.type === "number" ? "" : f.type === "boolean" ? false : "")
  );
}

function initFormValues(s: PluginConfigSummary): Record<string, unknown> {
  return Object.fromEntries(s.fields.map((f) => [f.path, initValue(f, s.values[f.path])]));
}

function validateForm(
  fields: PluginConfigField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const err = validateField(f, values[f.path]);
    if (err !== undefined) errors[f.path] = err;
  }
  return errors;
}

function validateField(f: PluginConfigField, v: unknown): string | undefined {
  if (f.kind === "multi-select") {
    if (!Array.isArray(v)) return "Must be a list of option ids";
    const ids = new Set((f.options ?? []).map((o) => o.id));
    if (v.some((x) => typeof x !== "string" || !ids.has(x))) {
      return "Contains an unknown option id";
    }
    if (f.required === true && v.length === 0) return "Required";
    return undefined;
  }
  const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (f.required === true && empty) return "Required";
  if (empty) return undefined;
  switch (f.type) {
    case "number": {
      const n = Number(v);
      if (Number.isNaN(n)) return "Must be a number";
      if (f.min !== undefined && n < f.min) return `Must be >= ${f.min}`;
      if (f.max !== undefined && n > f.max) return `Must be <= ${f.max}`;
      return undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? undefined : "Must be a boolean";
    case "enum": {
      const valid = (f.enum ?? []).some((e) => e.value === v);
      return valid ? undefined : "Must be one of the declared values";
    }
    default: {
      if (typeof v !== "string") return "Must be a string";
      if (f.pattern !== undefined) {
        try {
          if (!new RegExp(f.pattern).test(v)) return `Must match ${f.pattern}`;
        } catch {
          // Declaration pattern invalid — skip client-side check; the
          // server owns the authoritative validation.
        }
      }
      return undefined;
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the partial-update payload: only fields the user actually
 * changed (vs. the loaded baseline) are submitted, so untouched fields
 * never get written as `""`/`[]` and unknown keys in the file are
 * preserved (spec R4). Empty number/enum inputs are dropped entirely;
 * empty multi-selects and strings are only written when they changed.
 */
function buildValues(
  fields: PluginConfigField[],
  values: Record<string, unknown>,
  loaded: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.path];
    const baseline = initValue(f, loaded[f.path]);
    if (f.kind === "multi-select") {
      const next = Array.isArray(v) ? v : [];
      if (!sameValue(next, baseline)) out[f.path] = next;
      continue;
    }
    if (f.type === "number") {
      // Optional empty number inputs are dropped instead of sent as 0
      // (and `" "` is not silently converted to 0 either).
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      const n = Number(v);
      if (!sameValue(n, baseline)) out[f.path] = n;
      continue;
    }
    if (f.type === "enum") {
      // The "—" placeholder option is an explicit unset; drop it so the
      // server doesn't reject the empty string as an unknown enum value.
      if (v === undefined || v === null || v === "") continue;
      if (!sameValue(v, baseline)) out[f.path] = v;
      continue;
    }
    if (v === undefined) continue;
    if (!sameValue(v, baseline)) out[f.path] = v;
  }
  return out;
}

function constraintSummary(f: PluginConfigField): string {
  const parts: string[] = [];
  if (f.required === true) parts.push("required");
  if (f.kind === "scalar") {
    if (f.type === "number") {
      if (f.min !== undefined && f.max !== undefined) parts.push(`${f.min}–${f.max}`);
      else if (f.min !== undefined) parts.push(`min ${f.min}`);
      else if (f.max !== undefined) parts.push(`max ${f.max}`);
    }
    if (f.type === "string" && f.pattern !== undefined) parts.push(`pattern ${f.pattern}`);
  }
  return parts.join(" · ");
}

function errorCode(err: unknown): string {
  return err instanceof ApiError ? err.code : (err as Error).message;
}
