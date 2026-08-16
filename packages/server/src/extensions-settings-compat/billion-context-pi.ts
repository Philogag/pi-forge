import type { ConfigDeclaration } from "../plugin-config/types.js";

// billion-context-pi —— 上下文压缩插件（Active Context Pruning）。
// 配置文件：~/.pi/agent/acp.json（PI_CONFIG_DIR 内）。字段对应上游
// CONFIGURATION.md 的 ACTIVE 键；prompts 长文本建议使用 Raw JSON 编辑。
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  {
    package: "billion-context-pi",
    label: "billion-context-pi",
    description:
      "上下文压缩插件（Active Context Pruning）。配置文件在 ~/.pi/agent/acp.json（PI_CONFIG_DIR 内）。" +
      "字段对应上游 CONFIGURATION.md 的 ACTIVE 键；prompts 长文本建议使用 Raw JSON 编辑。",
    file: "acp.json",
    source: "compat",
    fields: [
      {
        kind: "scalar",
        path: "debug",
        type: "boolean",
        label: "Debug",
        description: "启用日志 debug 级输出（ACP_DEBUG 也可覆盖）",
      },
      {
        kind: "scalar",
        path: "autoUpdate",
        type: "boolean",
        label: "Auto update",
        description: "启动时检查 npm 新版本并自动安装；false 避免启动网络调用",
      },
      {
        kind: "scalar",
        path: "modelContextLimit",
        type: "number",
        label: "Model context limit",
        description: "覆盖上下文限制（tokens）；留空则自动读取模型窗口",
        min: 0,
      },
      {
        kind: "scalar",
        path: "toolBashDefaultTimeout",
        type: "number",
        label: "Bash default timeout",
        description: "bash 工具默认超时（秒）；0 恢复 pi 的无界行为",
        min: 0,
      },
      {
        kind: "scalar",
        path: "toolOutputMaxBytes",
        type: "number",
        label: "Tool output cap",
        description: "工具结果文本硬上限（字节）；0 禁用",
        min: 0,
      },
      {
        kind: "scalar",
        path: "delegate.enabled",
        type: "boolean",
        label: "Delegate enabled",
        description: "启用 acp_delegate / acp_delegate_wait / acp_delegate_cancel 工具族",
      },
      {
        kind: "scalar",
        path: "delegate.displayUsage",
        type: "enum",
        label: "Delegate usage display",
        description: "子代理 token 用量报告方式",
        enum: [
          { value: "separate", label: "separate — 独立累计（默认）" },
          { value: "merged", label: "merged — 并入主会话用量" },
        ],
      },
      {
        kind: "scalar",
        path: "compress.maxContextLimit",
        type: "string",
        label: "Compress max limit",
        description: '强制压缩阈值，如 "75%" 或 0.75',
      },
      {
        kind: "scalar",
        path: "compress.emergencyThresholdPercent",
        type: "string",
        label: "Emergency threshold",
        description: "紧急截断阈值，须 >= maxContextLimit",
      },
      {
        kind: "scalar",
        path: "compress.nudgeGrowthTokens",
        type: "number",
        label: "Nudge growth tokens",
        description: "软压缩提示的 token 增长步长",
        min: 0,
      },
      {
        kind: "scalar",
        path: "acknowledgePromptsRisk",
        type: "boolean",
        label: "Acknowledge prompts risk",
        description: "确认覆盖压缩提示规则的风险；prompts 覆盖生效的前提",
      },
    ],
  },
];
