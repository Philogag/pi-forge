import type { ConfigDeclaration } from "../plugin-config/types.js";

// @philogag/pi-provider-omniroute —— OmniRoute 聚合网关 provider 插件（v0.1.0）。
// 配置文件：settings.json 的 `pi-provider-omniroute` 块。
// baseUrl 解析：块内 baseUrl → OMNIROUTE_BASE_URL env → 默认 http://localhost:20128/v1。
// 枚举对齐 v0.1.0 的 STATIC_FALLBACK_PROVIDERS / FETCH_PROVIDERS。
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  {
    package: "@philogag/pi-provider-omniroute",
    label: "pi-provider-omniroute",
    file: "settings.json",
    source: "compat",
    description:
      "OmniRoute 聚合网关配置（settings.json 的 `pi-provider-omniroute` 块；baseUrl → OMNIROUTE_BASE_URL env → 默认 http://localhost:20128/v1）。",
    fields: [
      {
        kind: "scalar",
        path: "pi-provider-omniroute.baseUrl",
        type: "string",
        label: "Base URL",
        description: "网关地址，默认 http://localhost:20128/v1",
      },
      {
        kind: "scalar",
        path: "pi-provider-omniroute.search.provider",
        type: "enum",
        label: "Search provider",
        enum: [
          { value: "serper-search", label: "serper-search" },
          { value: "brave-search", label: "brave-search" },
          { value: "perplexity-search", label: "perplexity-search" },
          { value: "exa-search", label: "exa-search" },
          { value: "tavily-search", label: "tavily-search" },
          { value: "firecrawl", label: "firecrawl" },
          { value: "google-pse-search", label: "google-pse-search" },
          { value: "linkup-search", label: "linkup-search" },
          { value: "ollama-search", label: "ollama-search" },
          { value: "searchapi-search", label: "searchapi-search" },
          { value: "youcom-search", label: "youcom-search" },
          { value: "searxng-search", label: "searxng-search" },
          { value: "zai-search", label: "zai-search" },
          { value: "duckduckgo-free", label: "duckduckgo-free" },
        ],
      },
      {
        kind: "scalar",
        path: "pi-provider-omniroute.fetch.provider",
        type: "enum",
        label: "Fetch provider",
        enum: [
          { value: "firecrawl", label: "firecrawl" },
          { value: "jina-reader", label: "jina-reader" },
          { value: "tavily-search", label: "tavily-search" },
          { value: "tinyfish", label: "tinyfish" },
        ],
      },
    ],
  },
];
