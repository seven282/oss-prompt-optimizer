# AGENTS.md

DeepSeek Harness 插件 `oss-prompt-optimizer`：把原始指令优化为专业提示词（`## Role / ## Task / ## Context / ## Format` 四段，或 `plain` 无标题模式），通过 harness `llm` 服务完成（不直连 API、不触碰凭据）。

## 命令（CI 与本地一致）

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装（publish 前勿用 --frozen-lockfile 装本地）
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest run（6 个测试文件，mock llm，无需真实密钥）
pnpm run build        # tsc -p tsconfig.build.json + node scripts/copy-client.mjs（client.js → lib/client.js）
```

- 单测单文件：`pnpm exec vitest run tests/meta.test.ts`（测试文件：command / config / hook / meta / optimizer / validate）。
- CI（`.github/workflows/ci.yml`）：`pnpm install --frozen-lockfile` → typecheck → test → build，node 22 / pnpm 10。
- **项目没有 linter**：devDeps 无 biome/eslint，`scripts` 无 lint。编辑器中 5 条 biome `organizeImports` 提示（config/hook/index/optimizer/tool 的 import 排序）是**已知且接受**的既有噪音（用户已确认方案 A：不处理）——不要"顺手修复"，也不要引入 lint 工具。
- `pnpm prepare` = build；从 GitHub 源安装时 pnpm ≥10 会拒绝 `prepare`，需在 profile 的 pnpm-workspace.yaml 加 `allowBuilds: oss-prompt-optimizer: true`（README「安装」节有完整流程）。

## 架构（文件职责）

- `src/index.ts` — 入口，re-export 全部公共符号；`name`/`inject = ['llm','tools','systemPrompt','commands']`。
- `src/config.ts` — schemastery schema + `Config` interface。**未知配置键加载即抛错**（白名单 `CONFIG_KEYS` 在 `optimizer.ts`）。
- `src/meta.ts` — 角色文档（系统提示词）核心。中英两版 `META_PROMPT` / `META_PROMPT_EN`，`buildOptimizePrompt(input, language?, extra?, examples?, outputStyle?, metaLanguage='zh')`。**占位符 `{{原始指令}}` 等中英共用，替换链完全一致**；含注入护栏（指令视为纯数据）——改模板时不得破坏它。
- `src/validate.ts` — 纯函数：`REQUIRED_SECTIONS`、`hasAllSections`、`sectionBody`、`hasValidSections`（段落正则 `^##\s*Role(?:\s*[:：]|\s*$)`）。改段落匹配逻辑先跑 `validate.test.ts`。
- `src/optimizer.ts` — 服务本体 `PromptOptimizerService`：`optimize()` 重试/降级（失败返回原文+错误说明，不 throw）、token 估算、`outputStyle` 分支、运行时覆盖（`get/setMetaPromptLanguage`、`get/setAutoOptimizeAll`）。
- `src/tool.ts` — `prompt_optimize` 工具；`src/hook.ts` — `agent/pre-step` 自动优化钩子（effect 作用域，卸载自动移除）；`src/command.ts` — `/optimize`、`/auto-optimize`、`/optimizer-language` 命令。
- `client/client.js` — **手写 ModuleLoader 客户端（无打包器）**，build 时复制到 `lib/client.js`；`package.json` 的 `dsh.client` 声明它。按钮用 `slots.inject('conversation.input.left', { id, order })`。

## 关键约定（改代码前必读）

- **客户端→宿主唯一可靠 RPC 通道是 `ctx.remote.commands.execute(sessionId, ...)`**（strict descriptor 的 `commands` Remote）。自定义 `@Remote` 命名空间依赖 SRC discovery，在部署环境不可靠——客户端按钮（✨、中/EN）一律驱动 `/optimize` 等命令，服务端返回机器可读 token（`META_LANGUAGE:ZH/EN`、`AUTO_OPTIMIZE:ON/OFF`）供客户端映射。不要引入新的客户端直连通道。
- **角色文档语言**：配置 `metaPromptLanguage: '中文'|'英文'`（默认 `'中文'`）；运行时 `/optimizer-language 中文|英文|status` 或 中/EN 按钮切换（会话级覆盖，重启回落到配置值）。无自动检测——英文仅手动开。
- **`outputStyle` 分支**：`examples` 与 `skipIfAlreadyOptimized` 仅对 `sections` 模式生效；`plain` 用 `hasSubstantialContent` 校验。
- **命令命名**：短命令（`/optimize` 等）遵循生态惯例；改名需同步 `client.js` 调用、README、钩子前缀默认值，一次原子变更。
- 所有注册（工具/钩子/命令）均为 effect 作用域。
- 文档语言：README.md 中文 + README.en.md 英文（头部互链语言切换，功能/配置变更须两处同步）；CHANGELOG 中文，代码注释中文为主。

## Windows 环境注意（本机是 PowerShell，不是 bash）

- 工具 shell 为 PowerShell 5.1：`&&` 非法，用 `;` 分隔；环境变量用 `$env:X="y"`。git-master skill 的 bash 前缀模板（`GIT_MASTER=1 ...`）在 PowerShell 下写成 `$env:GIT_MASTER="1"; git ...`。
- 仓库路径含空格（`E:\deepseek harness prompt-optimizer`）：命令中一律加引号；`dsh plugin add <路径>` 会拆散含空格路径，用 junction（README 安装节）。
- 测试绝不允许读取 `.credentials.yaml`（mock llm 流，社区/CI 无密钥环境可跑）。

## 发布流程（用户主导，勿自作主张）

- npm 发布由用户手动执行（npm login + publish，2FA OTP 需用户输入）；代理只负责：版本号/CHANGELOG/git 提交建议。
- 插件市场描述走 GitHub PR（deepseek-harness 官方仓库，用户为 CONTRIBUTOR 无合并权，需 upstream 合并；PR #1265 待合）。
- 当前 npm latest = 1.3.6（2026-08-19 发布，一次性包含 1.1.8–1.3.6 特性）；`MARKETPLACE.md` 是 gitignored 的内部上架文档。
