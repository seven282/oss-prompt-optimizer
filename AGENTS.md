# AGENTS.md

DeepSeek Harness 插件 `oss-prompt-optimizer`：把原始指令优化为专业提示词，通过 harness `llm` 服务完成（不直连 API、不触碰凭据）。输出形态三种（`outputStyle`）：`plain` 无标题纯文本（**默认**，最省 token）、`role-task-goal` 三要素标签（`角色：/任务：/目标：`）、`sections` 四段（`## Role / ## Task / ## Context / ## Format`）。

## 命令（CI 与本地一致）

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装（publish 前勿用 --frozen-lockfile 装本地）
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest run（13 个测试文件 / 480 用例，mock llm，无需真实密钥）
pnpm run build        # tsc -p tsconfig.build.json + node scripts/copy-client.mjs（client.js → lib/client.js）
```

- 单测单文件：`pnpm exec vitest run tests/meta.test.ts`。测试文件（13）：cache / command / config / context / diagnose / hook / llm / local / meta / optimizer / prompt / situation / validate。
- CI（`.github/workflows/ci.yml`）：`pnpm install --frozen-lockfile` → `pnpm audit --audit-level=high` → typecheck → test → build，node 22 / pnpm 10。
- **项目没有 linter**：devDeps 无 biome/eslint，`scripts` 无 lint。编辑器里的 biome `organizeImports` 提示是**已知且接受**的既有噪音（用户已确认不处理）——不要"顺手修复"，也不要引入 lint 工具。
- `pnpm prepare` = build；从 GitHub 源安装时 pnpm ≥10 会拒绝 `prepare`，需在 profile 的 pnpm-workspace.yaml 加 `allowBuilds: oss-prompt-optimizer: true`（README「安装」节有完整流程）。

## 架构（文件职责）

- `src/index.ts` — 入口，re-export 全部公共符号；`name`/`inject = ['llm','tools','systemPrompt','commands']`。
- `src/config.ts` — schemastery schema + `Config` interface。**未知配置键加载即抛错**（白名单 `CONFIG_KEYS` 由 schema keys 派生，在 `optimizer.ts`）。
- `src/templates.ts` — 角色文档骨架数据：`TemplateSet`（optimize/iterate × zh/en 四个骨架）、`DEFAULT_TEMPLATES`、加载期校验 `validateTemplateSet`；`META_PROMPT`/`META_PROMPT_EN`/`META_ITERATE` 定义于此、经 `meta.ts` re-export 保持公共面不变。自定义模板缺数据占位符、结构块或「视为纯数据」护栏即加载报错。
- `src/meta.ts` — 渲染与检测层：`buildOptimizePrompt`/`buildIteratePrompt`（占位符 `{{原始指令}}` 等中英共用、单遍替换）、`detectLanguage`（非空白字符汉字占比 ≥30% → 中文文档）、`detectTaskType`（关键词计分 + `resolveWritingTieBreak` 平局裁决：与 code 同分恒判 code；writing 凭写作动词同分赢 ops/analysis）、`ROLE_LIBRARY`/`SUB_TOPIC_TEMPLATES`/`matchScene`（`/template` 场景匹配）。改分类或模板先跑 `meta.test.ts`。
- `src/validate.ts` — 纯函数校验：四段正则 `^##\s*Role(?:\s*[:：]|\s*$)`、RTG 校验（`hasRoleTaskGoalLabels`/`hasValidRoleTaskGoal`，只认真实标签行）、纯度门 `hasMetaContent`（只扫末尾 300 字符防误伤正文）、四段→三要素折叠 `toRoleTaskGoal`、token 启发式 `estimateTokens`（CJK ≈1.5 token/字）。改段落/标签匹配逻辑先跑 `validate.test.ts`。
- `src/prompt.ts` — `PromptBuildContext` 收口系统提示词构建参数；`src/diagnose.ts` — 重试诊断文案与 selfRefine 指令（中英双语）；`src/llm.ts` — 流式文本组装、finish 错误翻译、`MaxTokensError`。三者均无 harness 依赖、可独立单测。
- `src/situation.ts` — 情境画像（角色/任务/目标三份）、子类检测、目标对齐（`goalAlignment`/`goalAnchors`）与漂移（`goalDrift`）；会话级目标沿用为内存 registry（TTL 30 分钟），重启即清空是**有意设计**——勿引入文件/Redis 持久化。
- `src/local.ts` — 本地模板路径：`localTemplateGate` 门控 + `buildLocalTemplate` 纯函数渲染（零 token），供 `optimizer.ts` 与 `/template <场景> <指令>` 预填共用。
- `src/context.ts` — 对话上下文采集；`src/cache.ts` — LRU+TTL 结果缓存；`src/errors.ts` — 稳定错误码；`src/events.ts` — 生命周期事件名（`prompt-optimizer/optimize:start|success|failure`）。
- `src/optimizer.ts` — 服务本体 `PromptOptimizerService`：只做编排（状态、校验/截断、重试管线、事件、路由）。失败返回原文+错误说明不 throw；运行时覆盖 `get/setMetaPromptLanguage`、`get/setAutoOptimizeAll`。
- `src/tool.ts` — `prompt_optimize` 工具；`src/hook.ts` — `agent/pre-step` 自动优化钩子；`src/command.ts` — 六个命令：`/optimize`、`/dream`（优化+需求感应附录）、`/auto-optimize`、`/optimizer-language`、`/optimize-stats`、`/template`。
- `client/client.js` — **手写 ModuleLoader 客户端（无打包器）**，build 时复制到 `lib/client.js`；`package.json` 的 `dsh.client` 声明它。按钮经 `slots.inject('conversation.input.left')` 注册 ✨（优化/取消/撤销一体）；语言自动检测后不再有中/EN 按钮。

## 关键约定（改代码前必读）

- **客户端→宿主唯一可靠 RPC 通道是 `ctx.remote.commands.execute(sessionId, ...)`**（strict descriptor 的 `commands` Remote）。自定义 `@Remote` 命名空间依赖 SRC discovery，在部署环境不可靠——客户端按钮一律驱动 `/optimize` 等命令，服务端返回机器可读 token（如 `AUTO_OPTIMIZE:ON/OFF`）供客户端映射。不要引入新的客户端直连通道。
- **输出形态默认 `plain`**：无标题纯文本、最省 token，`examples` 不注入。`sections` 四段保留为优化时的内部参考框架；`examples` 对 sections 直接注入、对 RTG 折叠为三要素后注入；`skipIfAlreadyOptimized` 同时识别四段与 RTG 形态（含中文标题变体）；`plain` 输出用 `hasSubstantialContent` 校验且禁止出现段落标题。
- **角色文档语言**：`metaPromptLanguage` 默认 `'auto'`——按指令语言自动检测（`detectLanguage`），`'中文'`/`'英文'` 固定。运行时 `/optimizer-language auto|中文|英文|status` 会话级覆盖，重启回落配置值。检测结果单次调用内贯穿（selfRefine 与重试诊断文案同语言），与 `outputLanguage` 独立。
- **命令命名**：短命令（`/optimize` 等）遵循生态惯例；改名需同步 `client.js` 调用、README、钩子前缀默认值（`/optimize `），一次原子变更。
- 所有注册（工具/systemPrompt 段落/钩子/命令）均为 effect 作用域，卸载自动清理。
- 文档语言：README.md 中文 + README.en.md 英文（头部互链语言切换，功能/配置变更须两处同步）；CHANGELOG 中文，代码注释中文为主。

## Windows 环境注意（本机是 PowerShell，不是 bash）

- 工具 shell 为 PowerShell 5.1：`&&` 非法，用 `;` 分隔；环境变量用 `$env:X="y"`。git-master skill 的 bash 前缀模板（`GIT_MASTER=1 ...`）在 PowerShell 下写成 `$env:GIT_MASTER="1"; git ...`。
- 仓库路径含空格（`E:\deepseek harness prompt-optimizer`）：命令中一律加引号；`dsh plugin add <路径>` 会拆散含空格路径，用 junction（README 安装节）。
- 测试绝不允许读取 `.credentials.yaml`（mock llm 流，社区/CI 无密钥环境可跑）。

## 发布流程（用户主导，勿自作主张）

- npm 发布由用户手动执行（npm login + publish，2FA OTP 需用户输入）；代理只负责：版本号/CHANGELOG/git 提交建议。
- npm latest 落后于本地版本属常态（分批发布）。动版本前先核实：`npm view oss-prompt-optimizer dist-tags --json`（截至 2026-08-22：latest = 1.6.6，本地已领先多个未发布版本）。
- 插件市场描述走 GitHub PR（deepseek-harness 官方仓库，用户为 CONTRIBUTOR 无合并权，需 upstream 合并；PR #1265 待合）。`MARKETPLACE.md` 是 gitignored 的内部上架文档。
