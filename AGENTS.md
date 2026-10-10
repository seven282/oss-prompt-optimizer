# AGENTS.md

DeepSeek Harness 插件 `oss-prompt-optimizer`：把原始指令优化为专业提示词，通过 harness `llm` 服务完成（不直连 API、不触碰凭据）。输出形态三种（`outputStyle`）：`plain` 无标题纯文本（**默认**，最省 token）、`role-task-goal` 三要素标签（`角色：/任务：/目标：`）、`sections` 四段（`## Role / ## Task / ## Context / ## Format`）。

## 命令（CI 与本地一致）

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装（publish 前勿用 --frozen-lockfile 装本地）
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest run（32 个测试文件 / 854 用例，mock llm，无需真实密钥）
pnpm run build        # tsc -p tsconfig.build.json + node scripts/copy-client.mjs（client.js → lib/client.js）
pnpm preflight        # 门禁 P1–P10；加 --browser-e2e 追加 P11（真浏览器，须在沙箱外跑）
pnpm eval:grader      # 单独跑 P10：构建产物上的判官 + 金标集 + 择优/反馈反向控制自检（88 项）
pnpm e3               # 一次性 Profile 验收：安装 → 启动 → 卸载（Windows 上须在沙箱外跑）
pnpm e4               # 设置面真浏览器验收：换证 → 字段渲染 → 写盘（同样须在沙箱外跑）
```

- 单测单文件：`pnpm exec vitest run tests/meta.test.ts`。**测试文件全清单与逐文件用例数不在此处硬编码**（会过期）——权威来源是 `docs/vault/50-Testing/测试覆盖清单.md`，由 `node scripts/check-testcounts.mjs` 双向校验（漏列/多列都报错）。改测试后必须同步该表，否则 CI/本地校验失败。
- CI（`.github/workflows/ci.yml`）：`pnpm install --frozen-lockfile` → `pnpm audit --audit-level=high` → typecheck → test → build，node 22 / pnpm 10。
- `scripts/e3-acceptance.mjs`（`pnpm e3`）——**上架/发版前的本地验收**：在临时 `DSH_HOME` 里初始化出厂 `web` 模板 → 装指定产物 → 合成配置 → 启动 `dsh web` 校验 HTTP 200 与插件客户端模块 → 卸载 → 清理，含 3 条反向控制。**不进 CI**（需要真实宿主与网络）。两个坑已写进脚本注释：`dsh plugin add <路径>` 会**按空白重新切分参数**（含空格路径会被 pnpm 当 `owner/repo` GitHub 简写 ⇒ 产物先落到无空格目录）；新建 profile 是**空的**，必须先 `--from-default-profile web`。
- `scripts/e4-settings-browser.mjs`（`pnpm e4`，门禁 **P11**）——**设置面在真浏览器里的端到端验收**：临时 `DSH_HOME` + 出厂 `web` 模板 → 装本地产物 → `dsh web` 起在随机端口 → **真 Chromium** 完成 token→cookie 换证 → 断言客户端 bundle 真被取回（200，不是白屏）→ 打开设置面断言 `LIVE_CONFIG_KEYS` 八个字段全部渲染 → 改一个字段并断言它**写进 `profiles/e2e/cordis.patch.yml`**、UI 回读一致，含 2 条反向控制（假 token 不得进入应用；待写值不得已经在盘上）。这是唯一走完「用户真正摸到的那条链」的门禁 —— issue #3 恰恰活在所有假宿主都盖不住的缝里（假宿主不做换证、不取服务端下发的 bundle、不挂设置插槽）。**不进 CI、默认不跑**（需要真浏览器 + 一次真实宿主启动），接进 `pnpm preflight --browser-e2e`（P11 读子进程的 `--json` 证据判定）。用 `playwright-core` 驱动**本机已装的 Chrome/Edge**（`--channel`），**不下载浏览器**，也不进 `dependencies`/`devDependencies`（用 `--pw-root` 或 `PO_PLAYWRIGHT_CORE` 指向任意一份安装）。⚠️ 两个坑写进了注释：首启有**引导弹窗链**，弹窗在时页面上任何点击都会超时（看起来像选择器写错）；设置面**没有「保存」按钮**（0.2.0 的 `configForms` 改字段即落盘，所以「点保存」的诚实等价物是「改一个值 + 看磁盘 patch 变」）。
- **项目没有 linter**：devDeps 无 biome/eslint，`scripts` 无 lint。编辑器里的 biome `organizeImports` 提示是**已知且接受**的既有噪音（用户已确认不处理）——不要"顺手修复"，也不要引入 lint 工具。
- **`lib/` 是入库的发布产物**（1.8.5 起）。DSH STORE 只读**固定 Commit**、**不跑 install / prepare / build**，而 `main`/`types`/`exports` 全指向 `lib/` —— 只带 `src/` 的提交就是不可安装的包（1.8.4 被「更新暂缓」正是如此，而 `npm publish` 一切正常）。**改 `src/` 必须重建并同笔提交 `lib/`**，由 preflight **P8** 守着（发布路径必须存在、被 git 跟踪、无未提交漂移）。
- `pnpm prepublishOnly` = build（不再是 `prepare`）：构建只在发布时发生，git 源安装不再要求消费方允许执行构建脚本（pnpm ≥10/11 默认拦截 `prepare`）。
- **上架契约字段**：`engines.node >=22`、`engines.dsh` 与 `dsh.compatibility.dsh` 同值、`dsh.compatibility.dshReleases` 逐精确版本记录。范围**必须逐 tuple 用 `||` 枚举**——`>=0.1.5-rc.1 <0.2.0` 按 semver 预发布规则**匹配不到 `0.1.6-alpha.2`**。当前只声明 **`^0.2.0-rc.2`**（CLI/web 与桌面 `dsh-desktop-runtime` 同 tuple，P9 实测），它是设置面契约 `ctx.configForms` + volatile 表单落地的第一版。由 `tests/manifest-contract.test.ts` + preflight P8/P9 守着。

## 架构（文件职责）

- `src/index.ts` — 入口，re-export 全部公共符号；`name`；`inject = ['llm']`（1.8.2 起从 `['llm','tools','systemPrompt','commands']` 收敛 —— 其余服务经 `ctx.inject()` 按功能作用域注册，见 `src/compat/scope.ts`，任一缺失只关掉对应功能）。
- `src/config.ts` — schemastery schema + `Config` interface。**未知配置键加载即抛错**（白名单 `CONFIG_KEYS` 由 schema keys 派生，在 `optimizer.ts`）。
- `src/templates.ts` — 角色文档骨架数据：`TemplateSet`（optimize/iterate × zh/en 四个骨架）、`DEFAULT_TEMPLATES`、加载期校验 `validateTemplateSet`；`META_PROMPT`/`META_PROMPT_EN`/`META_ITERATE` 定义于此、经 `meta.ts` re-export 保持公共面不变。自定义模板缺数据占位符、结构块或「视为纯数据」护栏即加载报错。
- `src/meta.ts` — 渲染与检测层：`buildOptimizePrompt`/`buildIteratePrompt`（占位符 `{{原始指令}}` 等中英共用、单遍替换）、`detectLanguage`（非空白字符汉字占比 ≥30% → 中文文档）、`detectTaskType`（关键词计分 + `resolveWritingTieBreak` 平局裁决：与 code 同分恒判 code；writing 凭写作动词同分赢 ops/analysis）、`ROLE_LIBRARY`/`SUB_TOPIC_TEMPLATES`/`matchScene`（`/template` 场景匹配）。改分类或模板先跑 `meta.test.ts`。
- `src/validate.ts` — 纯函数校验：四段正则 `^##\s*Role(?:\s*[:：]|\s*$)`、RTG 校验（`hasRoleTaskGoalLabels`/`hasValidRoleTaskGoal`，只认真实标签行）、纯度门 `hasMetaContent`（只扫末尾 300 字符防误伤正文）、四段→三要素折叠 `toRoleTaskGoal`、token 启发式 `estimateTokens`（CJK ≈1.5 token/字）。改段落/标签匹配逻辑先跑 `validate.test.ts`。
- `src/prompt.ts` — `PromptBuildContext` 收口系统提示词构建参数；`src/diagnose.ts` — 重试诊断文案与 selfRefine 指令（中英双语）；`src/llm.ts` — 流式文本组装、finish 错误翻译、`MaxTokensError`。三者均无 harness 依赖、可独立单测。
- `src/situation.ts` — 情境画像（角色/任务/目标三份）、子类检测、目标对齐（`goalAlignment`/`goalAnchors`）与漂移（`goalDrift`）；会话级目标沿用为内存 registry（TTL 30 分钟），重启即清空是**有意设计**——勿引入文件/Redis 持久化。
- `src/local.ts` — 本地模板路径：`localTemplateGate` 门控 + `buildLocalTemplate` 纯函数渲染（零 token），供 `optimizer.ts` 与 `/template <场景> <指令>` 预填共用。
- `src/context.ts` — 对话上下文采集；`src/cache.ts` — LRU+TTL 结果缓存；`src/errors.ts` — 稳定错误码；`src/events.ts` — 生命周期事件名（`prompt-optimizer/optimize:start|success|failure`）+ 载荷里的模型身份：`GenAiSignal`（键为 OTel GenAI **规范属性名**，可直接 `span.setAttributes()`）与 `ModelRoute`（可移植路由，`reasoningEffort` 走字符串，**不让宿主类型渗进发布的 `.d.ts`**）。
- `src/judge.ts`（1.11.0）— 加权 rubric 判官：`DEFAULT_RUBRIC`（specificity/context/output-contract/fidelity/economy 恒用，safety 按需）、`buildJudgeSystem`/`buildJudgeUser`、`parseJudgeReport`（先理由后分数、整数分、不完整即不采信）、`aggregateJudge`。`resolveRubric` 遇未知维度 id **加载即抛错**。
- `src/eval.ts`（1.11.0）— 评测harness：`GOLDEN_SET`（14 例 / 8 core，含注入探针与模糊指令）、`checkDeterministic`、`buildRun`/`compareToBaseline`/`formatEvalRun`、`mineSessionInstructions`。**只存长度与分数，指令原文永不入库**。
- `src/select.ts`（1.12.0 P1-A）— best-of-N 择优的**纯排序层**：`selectCandidatePure`（先看结构门资格、再看分数，未超过 `minGain` 一律保基线）、`scoreCandidates`（门控先行、判官并发、失败候选不判）、`candidateTemperature`（候选 i = base + i·0.35）、`structuralScore`（无判官时的零成本兜底分）、`formatSelection`/`selectionToken`。判官经回调注入，本文件无宿主依赖。
- `src/feedback.ts`（1.12.0 P1-B）— 宿主 `messageFeedback.list` 的**只读计数层**：`normalizeItem`/`feedbackItems`/`mergeItems`（计数为「替换」而非累加）、`isStale`（60s TTL）、`feedbackBias`（负面占比 ≥50% → 温度 +0.1，≤20% → −0.1，样本 <3 不生效）、`formatFeedback`。**备注原文永不复制**——只记 rating、category、是否含备注。
- `src/optimizer.ts` — 服务本体 `PromptOptimizerService`：只做编排（状态、校验/截断、重试管线、事件、路由）。失败返回原文+错误说明不 throw；运行时覆盖 `get/setMetaPromptLanguage`、`get/setAutoOptimizeAll`。`scoreCandidate` 是评测与择优**共用**的评分口径（门控绝对优先、判官不完整即不计分），`judgeRoute` 是否为 `undefined` 是「跑不跑判官」的唯一开关（评测看 `evalJudge`，择优看 `selectJudge`——两者互不牵连）。
- `src/tool.ts` — `prompt_optimize` 工具；`src/hook.ts` — `agent/pre-step` 自动优化钩子；`src/command.ts` — 三个命令：`/optimize`（含 `--stats`/`--status`/`--select`/`--feedback` 等旗标）、`/optimize-eval`（`run`/`baseline`/`show`/`list`/`rubric`/`cases`）、`/template`。
- `src/settings.ts` + `src/live-config.ts`（1.13.1）— 设置面。`settings.ts` 只剩一件事：经 `scopedInject` 告诉 dsh-settings **不要为本 entry 自动生成第二个编辑器**（`configure({ auto: false }, ctx.fiber)`），取不到服务就静默保持 inactive（**不 warn**，老宿主是正常部署）。`live-config.ts` 是无宿主依赖的纯函数层，负责 volatile 引用：`plainConfig`（把引用解成普通值快照）/ `adoptLiveConfig`（把引用装回去，保持对象身份）/ `followVolatileUpdates`（订阅 `loader/volatile-update` 就地重读）。**`this.config` 必须是普通值快照**（构造期读的字段才有效），**`this.rawConfig` 才是 loader 传进来的那个带引用的对象**。
- `client/client.js` — **手写 ModuleLoader 客户端（无打包器）**，build 时复制到 `lib/client.js`；`package.json` 的 `dsh.client` 声明它。按钮经 `slots.inject('conversation.input.left')` 注册 ✨（优化/取消/撤销一体）；语言自动检测后不再有中/EN 按钮。设置页经 `slots.inject('settings.section')` 注册，表单来自 `ctx.get('configForms').get('<host entry id>')`（entry id = settings 命名空间 = `prompt-optimizer`）。
  ⚠️ **规则 R2**：`exports.inject` 只放真正不可缺的服务（当前只有 `remote`），**其余一律 `ctx.get('<name>')` 并判空**。
  `ctx.<name>` 直读一个不在 inject 里的服务会**抛错**且 `apply()` 不捕获 ⇒ 整个客户端半边不注册（✨ 按钮与设置页一起消失）。1.8.2 就是这样在真机上全废的。
  ⚠️ **规则 R2b**：`<a>.<b>` 是**独立的服务名**，不是 `<a>` 的属性。`ctx.get('remote').commands` 会被 cordis 改写成 `ctx['remote.commands']` 读、再次撞上 inject 门禁并抛错（1.8.3 真机全废的根因）。正解是整体 `ctx.get('remote.commands')`，且**按调用时**解析（命名空间可能在本插件 `apply()` 之后才挂载）。
  由 `tests/client-inject-contract.test.ts`（静态）、`tests/client-apply.test.ts`（动态真跑 `apply()`，宿主把 `remote`/`remote.commands` 注册为真 `Service`）与 `preflight` P7 守着。
  P7 的假宿主必须用**真 `Service` 子类**并把 `remote.commands` **也注册成服务**，再配一条「naive 写法在此宿主上必须抛」的反向控制——用 plain object 提供服务时 cordis 不会包装，嵌套读取不触发代理，断言会空过。

## 关键约定（改代码前必读）

- **客户端→宿主唯一可靠 RPC 通道是 `ctx.remote.commands.execute(sessionId, ...)`**（strict descriptor 的 `commands` Remote）。自定义 `@Remote` 命名空间依赖 SRC discovery，在部署环境不可靠——客户端按钮一律驱动 `/optimize` 等命令，服务端返回机器可读 token（如 `AUTO_OPTIMIZE:ON/OFF`）供客户端映射。不要引入新的客户端直连通道。
- **输出形态默认 `plain`**：无标题纯文本、最省 token，`examples` 不注入。`sections` 四段保留为优化时的内部参考框架；`examples` 对 sections 直接注入、对 RTG 折叠为三要素后注入；`skipIfAlreadyOptimized` 同时识别四段与 RTG 形态（含中文标题变体）；`plain` 输出用 `hasSubstantialContent` 校验且禁止出现段落标题。
- **角色文档语言**：`metaPromptLanguage` 默认 `'auto'`——按指令语言自动检测（`detectLanguage`），`'中文'`/`'英文'` 固定。运行时 `/optimizer-language auto|中文|英文|status` 会话级覆盖，重启回落配置值。检测结果单次调用内贯穿（selfRefine 与重试诊断文案同语言），与 `outputLanguage` 独立。
- **命令命名**：短命令（`/optimize` 等）遵循生态惯例；改名需同步 `client.js` 调用、README、钩子前缀默认值（`/optimize `），一次原子变更。
- **择优（`selectCandidates > 1`，1.12.0）与本地模板路径互斥**：本地路径（`localTemplate: on|hybrid`）在 LLM 管线之前就 return 了，因此不会产生候选、也不会择优。要吃到择优收益必须让指令走完整 LLM 管线（即 `localTemplate: 'off'`，当前默认）。择优的候选温度阶梯是 `base + i·0.35`（上限 2），只有**胜者**进缓存；`evalJudge` 与 `selectJudge` 是两颗独立开关，改一个不要顺手改另一个。
- 所有注册（工具/systemPrompt 段落/钩子/命令）均为 effect 作用域，卸载自动清理。
- **模型身份按 run 记，且不报没测到的东西**（1.13.0）：`stats.lastRunRoute` 与事件载荷的 `route`/`genAi`
  都描述**最近这次 run**——缓存命中、本地直出、跳过透传后为 `null`/不出现（**不沿用**上一次的模型）。
  `runRoute` 只在 `generateOnce` 赋值（唯一发出模型调用处），并在 `optimize()`/`iterate()` 开头清空；
  `genAi` 的五个 `gen_ai.usage.*` 计数**要么都在、要么都不在**（适配器没上报就不报 0，
  与 `RunUsage.calls` 同一条规矩）；`gen_ai.response.model` **不发**（宿主只报告被请求的模型）。
  持久化的路由加载时经 `normalizeRoute` 修复（非对象 / 缺 provider / 缺 model → null）。
- **客户端 i18n：翻译器不捕获，按调用现取；`locale: NS` 按需声明**（1.13.1）。三条规矩：
  ① `locale.bind(ns)` 虽然是**活闭包**（每次调用重读 `snapshot.active`，所以"被冻结"是错觉），
  但**在 `apply()` 时取到的那一份只认当时的 face**——宿主 locale 插件的 `apply()` 是 `async`，
  `await` 完原生 bootstrap 才 `ctx.provide('locale', …)`，本插件可能先跑完，此后每个标签都落到
  **原始 key**。所以一律 `ctx.get('locale')` **每次现取**（同 `remote.commands` 的规矩），
  字典注册也惰性化（首次取用时补注册）。② 两处 `slots.register` 在**有 face 时**才声明
  `locale: NS`：渲染器对"声明了命名空间却没人提供 face"的条目**直接抛错**（`SlotAssemblyError`），
  无条件声明会把"宿主没 i18n"升级成"设置页整体挂掉"。声明后渲染器会给出 `kit['t']`，
  组件优先用 `props.t`（其**身份随 locale revision 变化**，是 memo 失效的官方通道），
  原始查找留作回退。③ 回退路径下没有任何东西会触发重渲染，组件必须**自己订阅** locale 变化，
  否则页面停在首绘语言。另：`register` 对重复的"命名空间+语言"对会**抛错**（`already has locale`），
  更新会在旧 fiber 清理前重跑本文件，故注册要 try/catch 降级——否则抛错会带走 ✨ 按钮与设置页
  （与 1.8.2 / 1.8.3 同类故障）。
  ⚠️ **测这类回归必须用忠实假宿主**：`tests/client-apply.test.ts` 里旧的
  `bind: (ns) => (key) => \`${ns}:${key}\`` 是**冻结捕获**，与真实 `LocaleFace`（活闭包）相反，
  **本身就是这个 bug 的形状** ⇒ 断言永远空过。现按源码重建 `LocaleRuntime`（catalog 恒含 zh/en、
  重复注册抛错、disposer 按对象身份删除、`bind` 记忆活闭包、`translate` 走 fallback 链 → `common` → key）。
- 文档语言：README.md 中文 + README.en.md 英文（头部互链语言切换，功能/配置变更须两处同步）；CHANGELOG 中文，代码注释中文为主。

## Windows 环境注意（本机是 PowerShell，不是 bash）

- 工具 shell 为 PowerShell 5.1：`&&` 非法，用 `;` 分隔；环境变量用 `$env:X="y"`。git-master skill 的 bash 前缀模板（`GIT_MASTER=1 ...`）在 PowerShell 下写成 `$env:GIT_MASTER="1"; git ...`。
- 仓库路径含空格（`E:\deepseek harness prompt-optimizer`）：命令中一律加引号；`dsh plugin add <路径>` 会拆散含空格路径，用 junction（README 安装节）。
- 测试绝不允许读取 `.credentials.yaml`（mock llm 流，社区/CI 无密钥环境可跑）。

## 发布流程（用户主导，勿自作主张）

- npm 发布由用户手动执行（npm login + publish，2FA OTP 需用户输入）；代理只负责：版本号/CHANGELOG/git 提交建议。
- npm latest 落后于本地版本属常态（分批发布）。动版本前先核实：`npm view oss-prompt-optimizer dist-tags --json`（截至 2026-10-09：latest = **1.9.0**，本地 1.10.0–1.13.1 均未发布——领先三个 minor）。
- 插件市场描述走 GitHub upstream PR（`awesome-dsh-plugin/awesome-dsh-plugin`，用户为 CONTRIBUTOR 无合并权，需 upstream 合并）。**8 个 PR 全部已合并**（最新 #5499，1.8.x 描述，2026-10-09），无未关闭 PR；`gh` CLI 已装（`D:\gh-cli-zip\x\bin\gh.exe`），条目更新可全程走 Git Data API 自动完成。`MARKETPLACE.md` 是 gitignored 的内部上架文档。
