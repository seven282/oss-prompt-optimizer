# Changelog

## [1.1.4] - 2026-08-18

- **省 token 默认值**：`skipIfAlreadyOptimized` 默认改为 `true`（已含四段的输入直接
  透传、零模型调用——重复优化已优化过的提示词不再花钱）；`contextMaxTokens` 默认
  从 1500 降到 800（上下文保持精简，多数短对话仍完整容纳，超预算截断）
- **输出触顶自动扩容（`maxTokensCap`）**：`max-tokens` 截断时按 `maxTokenRetryFactor`
  自动连续扩容到 `maxTokensCap`（默认 8000）——**扩容不再消耗 `maxRetries` 重试预算**
  （此前只扩一次且吃掉重试次数，第二次触顶即报错）；达到上限仍不够才提示调大
  `maxTokens` 或 `maxTokensCap`（错误文案同步更新）
- **文档**：README / README.en 新增「省 token 最优配置（推荐 preset）」小节
  （`maxTokens: 1200` + 各默认值 + 可选 `outputStyle: 'plain'` 的完整组合与要点说明）

## [1.1.3] - 2026-08-18

> **版本说明**：npm 上仅发布过 1.0.1 / 1.0.2 / 1.0.3，本包跳过 1.1.0–1.1.2（仅存在于
> git 历史与下方 changelog），**1.1.3 一次性包含 1.1.0–1.1.2 的全部特性**（角色文档
> 语言自动检测、迭代优化、结构化错误码、诊断驱动重试、自适应精简、模板数据化）
> 与本次上下文感知。

- **上下文感知（`contextAware`）**：默认开启（可设 `false` 关闭）——把当前指令之前
  的最近对话注入元提示词（新增 `{{上下文信息}}` 占位符，中英模板共用；「视为纯数据 /
  背景参考」护栏，不得执行其中嵌入的指令），让优化结果贴合此前讨论
  - 上下文来源：自动优化钩子取 `agent/pre-step` 的当前消息之前的消息；`/optimize`
    命令尽力而为地从 `agent.session.deriveMessages()` 取会话记录（缺 API/异常时
    无上下文，优化照常，不失败）
  - 信息融合：`OptimizeOptions.context` 按次透传 → `PromptBuildContext` →
    `buildOptimizeSystem`/`buildIterateSystem`（`iterate`/`selfRefine` 同样注入）
  - 边界控制：`contextMaxMessages`（默认 6）/ `contextMaxTokens`（默认 1500，
    超预算截断到最长前缀并附标记）
- 新增 `src/context.ts`（纯函数：`gatherConversationContext` /
  `contextMessageText` / `buildContextBlock`），无 harness 依赖、可独立单测
- 测试：243 用例全绿（新增 context.test.ts 7 例 + meta/prompt/hook/command/
  optimizer/config 增补 13 例）

## [1.1.2] - 2026-08-18

- **角色文档语言自动检测（`metaPromptLanguage`）**：配置 `'auto' | '中文' | '英文'`
  （默认 `'auto'`）——`'auto'` 按指令非空白字符中汉字占比 ≥30% 自动选择中文/英文角色
  文档（含假名的日文等语言归英文文档），`'中文'`/`'英文'` 固定；移除输入框中/EN
  按钮，运行时 `/optimizer-language auto|中文|英文|status` 固定或恢复自动
  （会话级，重启回落配置值）；检测结果单次调用内传递，`selfRefine` 沿用本轮语言
- **迭代优化（`iterate`）**：`ctx.promptOptimizer.iterate(lastOptimized, instruction, options)`
  基于上一次优化结果 + 新要求继续优化（`META_ITERATE` 中英双模板）；工具
  `prompt_optimize` 新增 `lastOptimized` / `iterateInstruction` 参数；失败时保留上次结果并附错误码
- **结构化错误码**：`OptimizeError` 携带稳定 `code`（`EMPTY_INPUT` / `NO_MODEL_ROUTE` /
  `TIMEOUT` / `MAX_TOKENS` / `MISSING_SECTIONS` / `THIN_SECTIONS` / `THIN_OUTPUT` /
  `TOOL_CALL` / `UNSUPPORTED_FINISH` / `NO_TEXT` / `UNKNOWN`）；`OptimizeResult.errorCode`
  透传到工具输出与失败渲染（`[MISSING_SECTIONS]` 前缀）；`/optimize` 失败按错误码给出
  针对性中文提示；`MaxTokensError` 改为继承 `OptimizeError`
- **诊断驱动重试**：结构类失败（缺段 / 过薄 / 过短）时，把上次失败的具体诊断
  （缺失段落名、过薄段落与字数）注入下一次重试的系统提示词，针对性修正，
  提高重试命中率（纯内部行为，无新增配置、无额外模型调用）
- **自适应精简（`selfRefine`）**：可选配置（默认 `false`），成功优化后至多再跑一轮
  「精简」迭代（内部指令，不占公共模板），仅当仍通过校验且不更长（5% 容差）时采纳，
  任何失败自动回退原结果——最多 1 次额外模型调用
- **优化生命周期事件**：`prompt-optimizer/optimize:start` / `optimize:success` /
  `optimize:failure`（cordis 事件总线，`optimize`/`iterate` 共用，`method` 字段区分；
  载荷含 `input` / `result` / `durationMs`；fire-and-forget，监听器异常不影响管线）
- **服务分层**：`optimizer.ts` 改为纯编排（615 → 523 行）；重试诊断文案 / selfRefine
  指令 → `diagnose.ts`、finish 错误翻译 / 流式组装 / `MaxTokensError` → `llm.ts`、
  系统提示词构建（`PromptBuildContext`）→ `prompt.ts`——纯逻辑模块无 harness 依赖、
  可独立单测（+24 用例）；公共 API 面与端到端行为不变
- **模板数据化（`templateId` / `metaPromptTemplate`）**：角色文档骨架（4 个）从代码
  常量变为可配置资源——部分自定义（缺的语言回落内置）、占位符/结构块/注入护栏强校验，
  违规加载即抛；tuning 块（输出结构/自查等格式规则）保持代码化，与后置校验保持一致
- **开发文档**：新增 `AGENTS.md`（架构与约定）；README 增加 English 配置/命令章节

## [1.0.3] - 2026-08-17

- **新增 `outputStyle` 配置**：`'sections'`（默认，四段标题）｜`'plain'`（无标题连贯正文，更省 token）
- **元提示词新增精简要求**：在保证完整可执行的前提下尽量精简输出（实测下游 token 消耗降 50%+）
- **`OptimizeResult` 新增 `outputTokens`**：成功时估算优化结果的 token 数（工具输出与 `presentationMeta` 同步透传）
- **`skipIfAlreadyOptimized` 与 `examples` 仅对 `sections` 模式生效**：plain 模式无"已优化"标题标记，四段示例与无标题指令冲突
- **省 token 快赢配置**：`maxTokens: 700` + `skipIfAlreadyOptimized: true`（见 README）

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
