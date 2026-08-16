import type { ConfigDeclaration } from "../plugin-config/types.js";

// pi-provider-litellm —— LiteLLM 代理 provider 插件。
// 配置文件：settings.json 的 `litellm` 块。别名 provider 列表请用 Raw JSON 编辑。
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  {
    package: "pi-provider-litellm",
    label: "pi-provider-litellm",
    file: "settings.json",
    source: "compat",
    description:
      "LiteLLM 代理配置（settings.json 的 `litellm` 块）。别名 provider 列表请用 Raw JSON 编辑。",
    fields: [
      {
        kind: "scalar",
        path: "litellm.baseUrl",
        type: "string",
        label: "Base URL",
        description: "LiteLLM 网关地址，如 https://litellm.example.com/v1",
      },
      {
        kind: "scalar",
        path: "litellm.headers",
        type: "string",
        label: "Headers (JSON)",
        description: "附加请求头，JSON 对象字符串；用 Raw JSON 编辑结构化内容",
        secret: true,
      },
    ],
  },
];
