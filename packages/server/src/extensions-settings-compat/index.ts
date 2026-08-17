import type { ConfigDeclaration } from "../plugin-config/types.js";
import { isAllowedConfigFile } from "../plugin-config/paths.js";
import { COMPAT_DECLARATIONS as BILLION_CONTEXT_PI_DECLARATIONS } from "./billion-context-pi.js";
import { COMPAT_DECLARATIONS as LITELLM_DECLARATIONS } from "./pi-provider-litellm.js";
import { COMPAT_DECLARATIONS as OMNIROUTE_DECLARATIONS } from "./pi-provider-omniroute.js";
import { COMPAT_DECLARATIONS as QQ_INTEGRATION_DECLARATIONS } from "./pi-qq-integration.js";

// 每个需要兼容的插件对应一个文件（extensions-settings-compat/<package>.ts），
// 在此聚合。新增兼容插件：新建文件 + 在本数组追加。
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  ...BILLION_CONTEXT_PI_DECLARATIONS,
  ...LITELLM_DECLARATIONS,
  ...OMNIROUTE_DECLARATIONS,
  ...QQ_INTEGRATION_DECLARATIONS,
];

const SEGMENT_RE = /^[^[]+(?:\[\d+\])?$/;

function hasValidPathSyntax(path: string): boolean {
  return path.split(".").every((seg) => SEGMENT_RE.test(seg));
}

export function validateCompatDeclarations(decls: ConfigDeclaration[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const d of decls) {
    if (seen.has(d.package)) errors.push(`duplicate compat declaration for package "${d.package}"`);
    seen.add(d.package);
    if (d.source !== "compat")
      errors.push(`compat declaration "${d.package}" must set source: "compat"`);
    if (!isAllowedConfigFile(d.file)) {
      errors.push(`compat declaration "${d.package}" has invalid file "${d.file}"`);
    }
    const fieldPaths = new Set<string>();
    for (const f of d.fields) {
      if (f.path.length === 0)
        errors.push(`compat declaration "${d.package}" has a field with empty path`);
      if (!hasValidPathSyntax(f.path)) {
        errors.push(
          `compat declaration "${d.package}" field "${f.path}" has invalid path syntax ` +
            `(expected dotted segments like a.b or a[0].c)`,
        );
      }
      if (fieldPaths.has(f.path)) {
        errors.push(`compat declaration "${d.package}" has duplicate field path "${f.path}"`);
      }
      fieldPaths.add(f.path);
      if (
        f.kind === "scalar" &&
        f.type === "enum" &&
        (f.enum === undefined || f.enum.length === 0)
      ) {
        errors.push(`compat declaration "${d.package}" enum field "${f.path}" needs enum values`);
      }
      if (f.kind === "multi-select" && f.options.length === 0) {
        errors.push(
          `compat declaration "${d.package}" multi-select field "${f.path}" needs options`,
        );
      }
    }
  }
  return errors;
}

// 启动期由 registry 调用，注册错误打印 diagnostics 而不阻断
