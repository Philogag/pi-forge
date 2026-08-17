import type { ConfigDeclaration } from "../plugin-config/types.js";

// pi-qq-integration —— 通过 QQ Bot 控制 pi 的扩展（v0.5.3，Star-233/pi-qq-integration）。
// 配置文件：~/.pi/agent/qq-integration-config.json（即 PI_CONFIG_DIR 下单文件）。
// 字段对齐 README 的 Configuration 表；allowedUsers/allowedGroups 为动态 openid 数组
// （无枚举值，不做表单控件，请在 Raw JSON 中编辑）；settings.defaultSession 由扩展自动更新。
export const COMPAT_DECLARATIONS: ConfigDeclaration[] = [
  {
    package: "pi-qq-integration",
    label: "pi-qq-integration",
    file: "qq-integration-config.json",
    source: "compat",
    description:
      "QQ Bot 接入配置（~/.pi/agent/qq-integration-config.json）。appSecret 敏感，请勿提交到 git；" +
      "allowedUsers / allowedGroups（openid 白名单数组）与 settings.defaultSession（自动更新）请在 Raw JSON 中编辑。",
    fields: [
      {
        kind: "scalar",
        path: "appId",
        type: "string",
        label: "AppID",
        description: "QQ 开放平台机器人的 AppID（必填）",
        required: true,
      },
      {
        kind: "scalar",
        path: "appSecret",
        type: "string",
        label: "AppSecret",
        description: "QQ 开放平台机器人 AppSecret（必填，敏感）",
        required: true,
        secret: true,
      },
      {
        kind: "scalar",
        path: "instanceId",
        type: "string",
        label: "Instance ID",
        description: "多实例签名与 #to <ID> 路由目标，默认进程 PID",
      },
      {
        kind: "scalar",
        path: "role",
        type: "enum",
        label: "Multi-instance role",
        description: "auto=文件锁选举 leader；leader=强制持有 QQ 连接；follower=经 IPC 连接 leader",
        defaultValue: "auto",
        enum: [
          { value: "auto", label: "auto" },
          { value: "leader", label: "leader" },
          { value: "follower", label: "follower" },
        ],
      },
      {
        kind: "scalar",
        path: "autoConnect",
        type: "boolean",
        label: "Auto connect",
        description: "启动时自动连接 QQ Bot；关闭后需手动 /qq-connect",
        defaultValue: true,
      },
      {
        kind: "scalar",
        path: "settings.forwardDesktopMessages",
        type: "boolean",
        label: "Forward desktop messages",
        description: "把 pi 终端输入的消息转发到 QQ（默认关闭）",
        defaultValue: false,
      },
      {
        kind: "scalar",
        path: "settings.forwardToolCalls",
        type: "boolean",
        label: "Forward tool calls",
        description: "把工具调用及其结果转发到 QQ；与 lastMessageOnly 互斥（开启自动关另一个）",
        defaultValue: false,
      },
      {
        kind: "scalar",
        path: "settings.lastMessageOnly",
        type: "boolean",
        label: "Last message only",
        description: "每次运行仅转发最后一条 assistant 回复；与 forwardToolCalls 互斥",
        defaultValue: false,
      },
    ],
  },
];
