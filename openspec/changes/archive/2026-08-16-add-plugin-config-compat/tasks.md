## 1. 类型定义与 JSON path 工具

- [x] 1.1 创建 `packages/server/src/plugin-config/types.ts`：命名导出 ConfigDeclaration、DeclarationSource、ScalarField、MultiSelectField、FieldDefinition、PluginConfigSummary、SavePluginConfigBody、PluginConfigListResponse、SettingDefinitionLike
- [x] 1.2 创建 `packages/server/src/plugin-config/paths.ts`：pathGet / pathSet（点分段 + `items[0]` 数组索引）、validateConfigFilePath（basename===file、.json 后缀、realpath 不越 PI_CONFIG_DIR → {ok, absPath}）
- [x] 1.3 创建 `tests/test-plugin-config.ts` path 单元测试段并先红后绿（嵌套/数组/缺失段、越界/嵌套/非 json 拒绝）
- [x] 1.4 类型检查通过并提交

## 2. 存储层 plugin-config/store.ts

- [x] 2.1 实现 `readDeclarationValues(file, piConfigDir, fields)`：一次读 → {exists, error?: "invalid_json", values}（缺失 exists:false；非法 JSON exists:true + error）
- [x] 2.2 实现 `putValues(file, piConfigDir, values, {stringCoerce})`：读-改-写保留未知键 + pathSet + 原子写（.tmp + rename，失败清理 tmp）
- [x] 2.3 实现 `putRaw(file, piConfigDir, raw)`：JSON.parse 校验 plain object + 原子替换；`validateValues(fields, values)`：类型/required/min/max/pattern/enum/多选 id/未知 path
- [x] 2.4 ConfigFileError（code: invalid_json/validation/io/traversal）+ makeLock 每文件串行；store 单元测试先红后绿
- [x] 2.5 提交

## 3. compat 注册入口

- [x] 3.1 创建 `packages/server/src/extensions-settings-compat/README.md`：注册指引 + 完整 ConfigDeclaration 示例（secret/number/enum/multi-select/嵌套 path）
- [x] 3.2 创建 `packages/server/src/extensions-settings-compat/index.ts`：`COMPAT_DECLARATIONS: ConfigDeclaration[]`（首期空）+ `validateCompatDeclarations`（file 非法/空 path/枚举无值/重复包名）
- [x] 3.3 compat 校验单元测试先红后绿并提交

## 4. 捕获模块 capture.ts + extensions-manager 辅助导出

- [x] 4.1 extensions-manager.ts 新增 `resolveEnabledExtensionPaths(cwd, agentDir)`：resolve().extensions 中 enabled 且有 metadata.source 的 path 去重
- [x] 4.2 创建 `plugin-config/capture.ts`：`captureExtensionSettings(cwd, agentDir)` = createEventBus + 订阅 `pi-extension-settings:register`（parseRegisterEvent 校验负载，非法丢弃）+ discoverAndLoadExtensions(entryPaths, cwd, agentDir, eventBus) → {registrations, errors}
- [x] 4.3 `normalizeRegistration`：options → multi-select；values → enum scalar；否则 string scalar；path=id、defaultValue 原样
- [x] 4.4 capture 单元测试（temp 扩展文件加载 + 非法负载丢弃 + 加载错误上报）先红后绿并提交

## 5. 注册表 plugin-config/registry.ts

- [x] 5.1 实现 RegistryState / RegistryDeps / configurePluginConfigRegistry / refreshPluginConfigs / getPluginConfigState / getConfigDeclaration / mergeDeclarations
- [x] 5.2 mergeDeclarations：同包 capture 整包优先（source 保留 extension-event），compat 未覆盖字段 path 追加；异包保留；compat 在前
- [x] 5.3 refresh 状态机：capture 抛错 → status:"error" 不抛出；captureEnabled=false → 无事件声明
- [x] 5.4 registry 单元测试（合并优先级 + 状态机 + 注入 temp 扩展）先红后绿并提交

## 6. REST 端点 /config/plugin-configs

- [x] 6.1 routes/config.ts 新增 GET /config/plugin-configs：200 {ready, declarations, errors}，每项含 exists/values/fields（readDeclarationValues）
- [x] 6.2 新增 GET /config/plugin-configs/:package：200 单项；未注册 404 {error:"not_found"}
- [x] 6.3 新增 PUT /config/plugin-configs/:package：values（validateValues + settings-extensions.json 强制 String 化）或 raw（JSON 校验）互斥；400 validation_failed/invalid_json、403 traversal、500 agent_error
- [x] 6.4 新增 POST /config/plugin-configs/reload：200 {reloaded:true}，fire-and-forget refresh
- [x] 6.5 创建 tests/test-plugin-config-api.ts 集成测试（捕获可见/字符串往返/单项回读/未知 404/raw 替换/互斥 400/未知 path 400）先红后绿并提交

## 7. 配置接线（env / cli / 启动预加载 / 失效钩子）

- [x] 7.1 config.ts 新增 `pluginConfigCapture: readBool("PLUGIN_CONFIG_CAPTURE", true)`；cli.ts 新增 `--plugin-config-capture` flag
- [x] 7.2 index.ts buildServer 内（路由注册后）：configurePluginConfigRegistry + `void refreshPluginConfigs()` 启动后台预加载
- [x] 7.3 routes/config.ts install/remove 成功分支追加 `void refreshPluginConfigs()` 失效钩子
- [x] 7.4 npm run build + 三个测试文件全部 PASS 并提交

## 8. api-client 方法

- [x] 8.1 api-client types.ts 追加 PluginConfigField / PluginConfigSummary / PluginConfigListResponse / SavePluginConfigBody
- [x] 8.2 index.ts 追加 getPluginConfigs / getPluginConfig(pkg) / savePluginConfig(pkg, body) / reloadPluginConfigs（request() + 内联 validator）
- [x] 8.3 cd packages/client && npx tsc --noEmit exit 0 并提交

## 9. UI：ExtensionsTab 齿轮 + PluginConfigModal

- [x] 9.1 SettingsPanel.tsx：openConfigPackage 状态贯通；ExtensionsTab 新增 onOpenConfig prop + declaredPackages Set（getPluginConfigs 匹配 p.name/p.source）；包卡片操作区条件渲染 Settings2 齿轮
- [x] 9.2 新建 components/PluginConfigModal.tsx：Modal 骨架 + 加载/错误/文件不存在提示 + 来源徽标 + Cancel/Save（busy）
- [x] 9.3 表单控件：string（secret 密码框）/number（min/max）/boolean/enum（select）/multi-select（勾选 + 上移下移重排）；字段 label/描述/限制摘要/行内校验
- [x] 9.4 Raw JSON 切换：dirty 确认 + CodeMirrorEditor（JSON）+ raw 保存分支；保存成功关闭、失败 banner 不关闭
- [x] 9.5 npm run build + 手动清单（无声明无齿轮/表单编辑/raw 保存/文件创建提示/ready=false 刷新按钮）并提交

## 10. 捕获关闭测试 + 文档 + 全量验证

- [x] 10.1 创建 tests/test-plugin-config-capture-off.ts：PLUGIN_CONFIG_CAPTURE=false → ready:true 且 declarations: []（有 temp 扩展文件也不出事件声明）
- [x] 10.2 docs/agent/api.md 增补四个端点；docs/agent/config.md 增补 env + CLI flag；docs/agent/architecture.md 增补 plugin-config/* 模块与 compat 入口数据流
- [x] 10.3 npm run build && npm run check（tsc + eslint + prettier）通过
- [x] 10.4 scripts/run-tests.sh --only plugin-config,extensions,config,api 全部 PASS
- [x] 10.5 手动验收：pi-extension-settings 互通（pi 内 getSetting 读到浏览器保存值）、compat 示例表单、安装/卸载后声明刷新；提交
