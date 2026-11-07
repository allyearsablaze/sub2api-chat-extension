# 项目概述
Sub2API 独立静态对话前端，支持聊天、生图、编图及浏览器本地会话持久化。

# 工程环境与工具
使用 JavaScript ES modules、Vue 3、Vite 6、npm（package-lock.json）。开发入口为 index.html → src/ui/main.js → App.vue。

# 模块与依赖方向
- src/ui：Vue 界面、参数配置、队列及引擎接入。
- src/engine/runtime：Agent 执行、工具循环与工具注册；图片工具位于 runtime/tools。
- src/engine/model 与 model_provider：模型参数、协议及请求处理。
- src/engine/repository：IndexedDB、会话、附件与图片缓存。
- src/engine/common：通用错误、JSON 和时间工具。
界面调用引擎，运行时调用模型与仓储；具体依赖以工作区 import 为准。

# 构建与验证
- npm run build：Vite 构建至 dist，使用相对资源路径。
- npm run test:persistence：先构建，再用 Playwright 执行 tests/persistence.cjs；需要已安装依赖与 Chromium。
- npm run dev：端口 5180，/api、/v1、/v1beta 代理至 localhost:8080。
不自动安装依赖、浏览器或启动开发服务；按任务需要执行最小验证。

# 编码约定
现有引擎代码采用单引号、无分号、命名导出。遵循相关文件风格。
README 的“开发注意”记录工具注册、模型参数、会话及 Vue 状态约束；改动对应模块时先阅读相关条目。
新增工具字段必须在 registry.js 的白名单式注册中显式保留。

# 错误处理
引擎提供 src/engine/common/errors.js；图片工具使用 AppError。具体错误传播契约以直接调用链为准。

# 版本控制
使用 Git；.gitignore 排除 node_modules、dist、.DS_Store 和日志。保留已有工作区改动。

# 用户编码习惯
未确认：仓库未配置本地用户身份，不能仅根据提交作者推断当前用户。

# 未确认事项
Node/npm 版本要求、独立静态检查命令和真实服务集成验证方式未确认。
