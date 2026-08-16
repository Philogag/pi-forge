<!-- packages/server/src/extensions-settings-compat/README.md -->
# Compat 注册入口

为不走 `pi-extension-settings` 的插件在 pi-forge 中提供浏览器端配置表单。
每个包一个文件（如 `compat/<package-name>.ts`），导出 `ConfigDeclaration`，
在 `extensions-settings-compat/index.ts` 汇总到 `COMPAT_DECLARATIONS`。

```ts
// compat/my-plugin.ts —— 示例
import type { ConfigDeclaration } from "../plugin-config/types.js";
export const myPluginDeclaration: ConfigDeclaration = {
  package: "my-plugin",
  file: "my-plugin.json",      // 仅 PI_CONFIG_DIR 下单层 JSON 文件名
  label: "My Plugin",
  description: "本地手动注册的示例",
  source: "compat",
  fields: [
    { kind: "scalar", path: "apiKey", type: "string", label: "API Key", secret: true, description: "调用密钥" },
    { kind: "scalar", path: "timeoutMs", type: "number", label: "Timeout (ms)", min: 0, max: 60000 },
    { kind: "scalar", path: "level", type: "enum", label: "Log Level", enum: [{ value: "info", label: "Info" }, { value: "debug", label: "Debug" }] },
    { kind: "multi-select", path: "features", label: "Features", options: [{ id: "cache", label: "Cache" }, { id: "sync", label: "Sync" }] },
  ],
};
```

字段能力：string / number / boolean / enum / multi-select；`path` 支持嵌套点路径与数组索引（如 `auth.apiKey`、`models[0].name`）；`secret` 字段输入框以密码形式显示。
