<!-- packages/server/src/extensions-settings-compat/README.md -->
# Compat 注册入口

为不走 `pi-extension-settings` 的插件在 pi-forge 中提供浏览器端配置表单。

**约定：每个插件一个文件**（`extensions-settings-compat/<package>.ts`），文件导出
`COMPAT_DECLARATIONS: ConfigDeclaration[]`，在 `index.ts` 汇总到聚合的
`COMPAT_DECLARATIONS`。新增兼容插件三步：新建文件 → `index.ts` 追加导入与展开 →
`tests/test-plugin-config.ts` 补断言。

已注册插件：

| 文件 | package | 目标文件 |
|---|---|---|
| `billion-context-pi.ts` | `billion-context-pi` | `acp.json` |
| `pi-provider-litellm.ts` | `pi-provider-litellm` | `settings.json`（`litellm` 块） |
| `pi-provider-omniroute.ts` | `@philogag/pi-provider-omniroute` | `settings.json`（`pi-provider-omniroute` 块） |

```ts
// my-plugin.ts —— 示例
import type { ConfigDeclaration } from "../plugin-config/types.js";
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  {
    package: "my-plugin",      // npm 全名；scoped 插件须含 @scope/
    file: "my-plugin.json",    // 仅 PI_CONFIG_DIR 下单层 JSON 文件名
    label: "My Plugin",
    description: "本地手动注册的示例",
    source: "compat",
    fields: [
      { kind: "scalar", path: "apiKey", type: "string", label: "API Key", secret: true, description: "调用密钥" },
      { kind: "scalar", path: "timeoutMs", type: "number", label: "Timeout (ms)", min: 0, max: 60000 },
      { kind: "scalar", path: "level", type: "enum", label: "Log Level", enum: [{ value: "info", label: "Info" }, { value: "debug", label: "Debug" }] },
      { kind: "multi-select", path: "features", label: "Features", options: [{ id: "cache", label: "Cache" }, { id: "sync", label: "Sync" }] },
    ],
  },
];
```

字段能力：string / number / boolean / enum / multi-select；`path` 支持嵌套点路径与数组索引（如 `auth.apiKey`、`models[0].name`）；`secret` 字段输入框以密码形式显示。`package` 必须与插件包名一致（scoped 插件用完整 `@scope/name`，否则 provider/扩展列表的配置按钮无法匹配）。
