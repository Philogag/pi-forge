## 1. 服务端模块 extensions-manager.ts

- [x] 1.1 创建 `packages/server/src/extensions-manager.ts`：命名导出类型（PackageScope、ExtensionToolInfo、PackageResourcePath、PackageResources、InstalledPackage、PackagesListing）与函数签名（listPackages/installPackage/removePackage）
- [x] 1.2 实现内部 helper：createPackageManager（SettingsManager.create + reload + new DefaultPackageManager）、readPackageMeta（读 installedPath/package.json，失败返回 undefined）、inferType（npm/git）、withTimeout（120s，timer.unref）
- [x] 1.3 实现 `listPackages(cwd, agentDir)`：Promise.all[listConfiguredPackages, resolve, discoverExtensionResources]；tools 按 packageSource 分组、skills/prompts/themes 仅 origin==="package" 归包；配置包 + 元数据 + 资源组装，scope:source 去重
- [x] 1.4 实现 `installPackage`（installAndPersist + 120s 超时）与 `removePackage`（removeAndPersist → {removed}）
- [x] 1.5 类型检查通过（cd packages/server && npx tsc --noEmit exit 0）并提交

## 2. /api/v1/config/extensions REST 端点

- [x] 2.1 routes/config.ts import listPackages/installPackage/removePackage；新增 GET /config/extensions（tags:["config"]，200 schema 含 packages 数组完整结构），handler 用 internalError
- [x] 2.2 新增 POST /config/extensions/install（body {source minLength 1, scope enum}，200 {source,scope}；Fastify 自动 400）
- [x] 2.3 新增 POST /config/extensions/remove（body 同上，200 {removed:boolean}，404 errorSchema + {error:"package_not_found"}）
- [x] 2.4 类型检查通过并提交

## 3. api-client 方法

- [x] 3.1 客户端类型（ClientToolInfo/ClientResourcePath/ClientPackageResources/ClientInstalledPackage/ClientPackagesListing）与 validators（仿 vReloadResult + isObject 风格）
- [x] 3.2 新增 getExtensions()、installExtension(source, scope)、removeExtension(source, scope)（POST 带 body；reloadConfig 之后）
- [x] 3.3 类型检查通过（cd packages/client && npx tsc --noEmit exit 0）并提交

## 4. ExtensionsTab UI + tab 注册

- [x] 4.1 SettingsPanel.tsx：Tab union 加 "extensions"、visibleTabs 非 minimal 数组加 "extensions"（minimal 不加）、渲染分支加 ExtensionsTab、lucide 加 Settings2
- [x] 4.2 新增 ExtensionsTab 组件：加载/空列表文案；安装行（source 输入 + scope 下拉默认 user + Install 按钮 + 内联反馈）；包卡片（名/type/scope/version + Remove confirm + 齿轮 Settings2 预留入口）；details 展开四组资源空组隐藏；安装成功提示"仅新会话生效，运行中会话去 General Restart"
- [x] 4.3 类型检查 + prettier --write 通过并提交

## 5. 集成测试

- [x] 5.1 创建 fixture 包 tests/fixtures/ext-sample/（package.json 含 pi.skills/pi.prompts、skills/hello/SKILL.md、prompts/review.md；若 SDK 本地目录安装需 tarball 则测试内 npm pack 兜底）
- [x] 5.2 创建 tests/test-extensions.ts：8 场景（空列表 / 安装 200 / 列表含包且资源分组 / settings.json#packages[] 持久化 / 重复安装幂等 / 未知卸载 404 package_not_found / 卸载后列表空且安装目录删除 / 缺 scope 400）
- [x] 5.3 npm run build + npx tsx tests/test-extensions.ts 全部 PASS 并提交

## 6. 全量验证

- [x] 6.1 npm run check（tsc + eslint + prettier）通过
- [x] 6.2 scripts/run-tests.sh --only extensions,config,api 全部 PASS
- [x] 6.3 遗留改动提交；手动验证清单（MINIMAL_UI 无 Extensions tab、新会话生效/旧会话 Restart、四组资源展开）逐项确认
