# Changelog

## [1.0.2] - 2026-08-17

- **GitHub 仓库改名**：`seven282/deepseek-harness-prompt-optimizer` → `seven282/oss-prompt-optimizer`
  （旧 URL 由 GitHub 自动重定向；npm `repository` 字段、README/MARKETPLACE 引用同步更新）
- Publish to npm：`oss-prompt-optimizer@1.0.2`

## [1.0.1] - 2026-08-16

- **改名：npm 包 `deepseek-harness-prompt-optimizer` → `oss-prompt-optimizer`**
  （旧名弃用；避免与 DeepSeek 官方及 OpenPrompt 系列项目关联，改用自创开源品牌名 OSS）
- Add `repository` field to `package.json`（指向 GitHub 仓库，满足插件市场防冒名校验）
- Publish to npm：`oss-prompt-optimizer@1.0.1`

## [1.0.0] - 2026-08-16

- 首次发布（npm 包名 `deepseek-harness-prompt-optimizer`，原 `prompt-optimizer` 被占用后改名）
- 核心能力：将原始指令经 harness `llm` 服务优化为 `## Role / ## Task / ## Context / ## Format` 四段专业提示词
- 交付形态：
  - 服务 `ctx.promptOptimizer.optimize()`（含按次参数覆盖）
  - 工具 `prompt_optimize`（模型可调用，输出含四段结构）
  - 命令 `/optimize`（输入框手输）与 `/auto-optimize`（运行时切换"发送前自动优化"）
  - 输入框 ✨ 按钮：一键优化、↺ 撤销、加载/错误反馈、aria-live 播报
  - 自动优化钩子（`agent/pre-step`：前缀触发或全量模式，可选双写原文）
- 配置项：`temperature` / `maxTokens` / `maxRetries` / `maxInputChars` / `maxInputTokens`
  / `timeoutMs` / `outputLanguage` / `extraInstructions` / `examples` / `minSectionChars`
  / `maxTokenRetryFactor` / `retryTemperatureStep` / `skipIfAlreadyOptimized`
  / `autoOptimize` / `autoOptimizePrefix` / `autoOptimizeAll` / `hookIncludeOriginal`
  / `provider` / `model`
- 质量保障：80 个 vitest 用例（mock llm，不依赖真实密钥）；TypeScript 严格模式
