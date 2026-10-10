# AGENTS.md

DeepSeek Harness 插件 `oss-prompt-optimizer`：把原始指令优化为专业提示词，通过 harness `llm` 服务完成
（不直连 API、不触碰凭据）。输出形态三种（`outputStyle`）：`plain` 无标题纯文本（**默认**，最省 token）、
`role-task-goal` 三要素标签（`角色：/任务：/目标：`）、`sections` 四段（`## Role / ## Task / ## Context / ## Format`）。

本文件面向**改造者与 agent**。面向用户的内容见 `README.md`；兼容性设计的唯一权威见
`docs/compatibility.md`；版本历史见 `CHANGELOG.md`。

## 命令（CI 与本地一致）

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装（publish 前勿用 --frozen-lockfile 装本地）
pnpm run typecheck    # tsc --noEmit（src/tests）+ tsc -p tsconfig.client.json（客户端 client/*.js）
pnpm test             # vitest run（mock llm，无需真实密钥；文件数与用例数见下方"单测单文件"一条）
pnpm run build        # tsc -p tsconfig.build.json + node scripts/copy-client.mjs（client.js → lib/client.js）
pnpm preflight        # 门禁 P1–P10；加 --browser-e2e 追加 P11（真浏览器，须在沙箱外跑）
pnpm eval:grader      # 单独跑 P10：构建产物上的判官 + 金标集 + 择优/反馈反向控制自检（88 项）
pnpm e3               # 一次性 Profile 验收：安装 → 启动 → 卸载（须在沙箱外跑）
pnpm e4               # 设置面真浏览器验收：换证 → 字段渲染 → 写盘（须在沙箱外跑）
pnpm check:docs       # 文档门禁：每个语言对的标题层级与互链、相对链接、脚本名、术语、行宽（提示级）
```

- CI（`.github/workflows/ci.yml`）：`permissions: contents: read` + `concurrency` 取消旧 run；
  主 job（ubuntu，timeout 15min）= `pnpm install --frozen-lockfile` → `pnpm typecheck`

- 单测单文件：`pnpm exec vitest run tests/meta.test.ts`。**测试文件全清单与逐文件用例数不在此处硬编码**
  （会过期）——权威来源是 `docs/vault/50-Testing/测试覆盖清单.md`，由 `node scripts/check-testcounts.mjs`
  双向校验（漏列/多列都报错）。改测试后必须同步该表。
- CI（`.github/workflows/ci.yml`）：`permissions: contents: read` + `concurrency` 取消旧 run。
  主 job（ubuntu，15min）= install → typecheck → test → build → preflight（offline）；
  `windows-test` job 只跑 typecheck + test（历史上两次真机事故都是 Windows 特有）；
  `audit` job **advisory**（`continue-on-error`，不阻断）。node 22 / pnpm 12（`packageManager` 已钉）。
- **项目没有 linter**：devDeps 无 biome/eslint，`scripts` 无 lint。编辑器里的 biome `organizeImports`
  提示是**已知且接受**的既有噪音——不要"顺手修复"，也不要引入 lint 工具。客户端 `client/*.js`
  的静态检查由 `tsconfig.client.json`（`checkJs`，非 strict）承担，不要因此引入 linter。

## 验收脚本与门禁

| 脚本 / 门禁 | npm | 步骤号 | 证明什么 | 前置 |
|---|---|---|---|---|
| `scripts/preflight.mjs` | `pnpm preflight` | P1–P10 | 依赖面 / inject 解析 / 产物一致 / 构建测试 / 兼容报告 / 启动独立性 / 客户端契约 / 产物新鲜度 / 双端兼容 / 判官标定 | 无（`--offline` 跳过联网步骤） |
| `scripts/e3-acceptance.mjs` | `pnpm e3` | E3.x | 一次性 Profile：装指定产物 → `dsh web` 校验 HTTP 200 与插件客户端模块 → 卸载 → 清理（3 条反向控制） | 真实 dsh 版本 + 沙箱外 |
| `scripts/e4-settings-browser.mjs` | `pnpm e4` | E4.x | **设置面在真浏览器里**：token→cookie 换证 → bundle 200 → `LIVE_CONFIG_KEYS` 八字段渲染 → 改字段写进 `cordis.patch.yml` 并回读（RC1/RC2） | 真浏览器 + 沙箱外 |
| — | `pnpm preflight --browser-e2e` | P11 | 跑 e4 并**读其 `--json` 证据**判定（不读 stdout） | 同上 |

P1–P11 各自证明什么、每步的反向控制，见 `docs/compatibility.md` 第六节。

**e3 / e4 / P11 都不进 CI**，都支持 `--json <path>` 出机器可读证据，都须在沙箱外跑
（`dsh web` 会调 `reg.exe`，沙箱拦下后宿主零输出挂住）。三个已踩过的坑写进了脚本注释：

- `dsh plugin add <路径>` 会**按空白重新切分参数**（含空格路径会被 pnpm 当 `owner/repo` GitHub 简写
  ⇒ 产物先落到无空格目录）；新建 profile 是**空的**，必须先 `--from-default-profile web`。
- e4 首启有**引导弹窗链**，弹窗在时页面上任何点击都会超时（看起来像选择器写错）。
- 设置面**没有「保存」按钮**（0.2.0 的 `configForms` 改字段即落盘），所以"点保存"的诚实等价物是
  "改一个值 + 看磁盘 patch 变"。同一原因：被中断的 e4 运行**不会删临时 home**，收尾要按名检查 `%TEMP%\dsh-brw-*`。

## 文件职责

| 文件 | 职责 | 不要做的事 |
|---|---|---|
| `src/index.ts` | 入口：re-export 全部公共符号；`name`；`inject = ['llm']`（1.8.2 起从四项收敛，其余服务经 `ctx.inject()` 按功能作用域注册，见 `src/compat/scope.ts`） | 不要把服务加回 `inject` |
| `src/config.ts` | schemastery schema + `Config` interface + `LIVE_CONFIG_KEYS` 白名单 | 未知配置键**加载即抛错**；不要给构造期一次性解析的字段标 `.volatile()` |
| `src/templates.ts` | 角色文档骨架数据：`TemplateSet`（optimize/iterate × zh/en）、`DEFAULT_TEMPLATES`、`validateTemplateSet`；`META_PROMPT(_EN)` / `META_ITERATE(_EN)` 定义于此、经 `meta.ts` re-export 保持公共面不变 | 缺占位符、结构块或「视为纯数据」护栏的模板**加载报错** |
| `src/meta.ts` | 渲染与检测：`buildOptimizePrompt` / `buildIteratePrompt`（中英共用占位符、单遍替换）、`detectLanguage`（非空白汉字占比 ≥30% → 中文文档）、`detectTaskType` + `resolveWritingTieBreak`（与 code 同分恒判 code）、`ROLE_LIBRARY` / `SUB_TOPIC_TEMPLATES` / `matchScene` | 改分类或模板先跑 `meta.test.ts` |
| `src/validate.ts` | 纯函数校验：四段正则、RTG 标签校验（`RTG_LABELS` / `RTG_LABELS_EN`）、纯度门 `hasMetaContent`（只扫末尾 300 字符）、四段→三要素折叠、token 启发式 `estimateTokens` | 改段落/标签匹配先跑 `validate.test.ts` |
| `src/prompt.ts` / `diagnose.ts` / `llm.ts` | 系统提示词构建参数收口 / 重试诊断文案与 selfRefine 指令（中英双语）/ 流式文本组装、finish 错误翻译 | 三者均无 harness 依赖，可独立单测 |
| `src/situation.ts` | 情境画像（角色/任务/目标）、子类检测、目标对齐与漂移；会话级目标沿用为**内存 registry**（TTL 30 分钟） | 重启即清空是**有意设计**——勿引入文件/Redis 持久化 |
| `src/local.ts` | 本地模板路径：`localTemplateGate` 门控 + `buildLocalTemplate` 纯函数渲染（零 token） | 供 `optimizer.ts` 与 `/template <场景> <指令>` 预填共用 |
| `src/context.ts` / `cache.ts` / `errors.ts` | 上下文采集 / LRU+TTL 缓存 / 稳定错误码 | — |
| `src/events.ts` | 生命周期事件名 + 载荷里的模型身份：`GenAiSignal`（OTel 规范属性名）与 `ModelRoute`（可移植路由，`reasoningEffort` 走字符串） | **不让宿主类型渗进发布的 `.d.ts`** |
| `src/judge.ts` | 加权 rubric 判官：`DEFAULT_RUBRIC`、`buildJudgeSystem`/`buildJudgeUser`、`parseJudgeReport`（先理由后分数、整数分、不完整即不采信）、`aggregateJudge` | `resolveRubric` 遇未知维度 id **加载即抛错** |
| `src/eval.ts` | 评测 harness：`GOLDEN_SET`（14 例 / 8 core）、`checkDeterministic`、`buildRun`/`compareToBaseline`/`formatEvalRun`、`mineSessionInstructions` | **只存长度与分数，指令原文永不入库** |
| `src/select.ts` | best-of-N 纯排序层：`selectCandidatePure`（门控先行、未超过 `minGain` 保基线）、`scoreCandidates`、`candidateTemperature`（`base + i·0.35`）、`structuralScore` | 判官经回调注入，本文件无宿主依赖 |
| `src/feedback.ts` | 宿主 `messageFeedback.list` 的只读计数层：`normalizeItem`/`feedbackItems`/`mergeItems`（计数为替换而非累加）、`isStale`（60s TTL）、`feedbackBias` | **备注原文永不复制**——只记 rating、category、是否含备注 |
| `src/optimizer.ts` | 服务本体 `PromptOptimizerService`：只做编排（状态、校验/截断、重试管线、事件、路由） | 失败返回原文+错误说明**不 throw**；`judgeRoute === undefined` 是「跑不跑判官」的唯一开关 |
| `src/tool.ts` / `hook.ts` / `command.ts` | `prompt_optimize` 工具 / `agent/pre-step` 自动优化钩子 / 三个命令（`/optimize`、`/optimize-eval`、`/template`） | 命令改名需同步 `client.js`、README、钩子前缀默认值，一次原子变更 |
| `src/settings.ts` + `src/live-config.ts` | 设置面：前者只剩「告诉 dsh-settings 不要为本 entry 自动生成第二个编辑器」（`configure({ auto: false })`）；后者是无宿主依赖的纯函数层（`plainConfig` / `adoptLiveConfig` / `followVolatileUpdates`） | **`this.config` 必须是普通值快照**，`this.rawConfig` 才是 loader 传进来的带引用对象 |
| `src/persistence.ts` / `episode.ts` / `preference.ts` / `adapt.ts` / `status.ts` | 状态持久化（原子写 + 去抖）/ episode 日志与裁剪 / 偏好模型 / 自迭代适配 / 状态渲染 | 持久化只存**行为元数据**，不存指令原文 |
| `client/client.js` | **手写 ModuleLoader 客户端（无打包器）**，build 复制到 `lib/client.js`；✨ 按钮经 `slots.inject('conversation.input.left')`，设置页经 `slots.inject('settings.section')` | 见下「客户端 i18n」与规则 R2 / R2b |
| `client/globals.d.ts` + `tsconfig.client.json` | 客户端半边的静态检查：`checkJs`（非 strict）+ DOM lib + 宿主 `__ModuleLoader__` 环境声明 | 检查必须保持**能报错**（注入未定义标识符须失败）；改 `client.js` 后跑 `pnpm check:client` |

## 硬约定（改代码前必读）

- **客户端→宿主唯一可靠 RPC 通道是 `ctx.remote.commands.execute(sessionId, ...)`**（strict descriptor 的
  `commands` Remote）。自定义 `@Remote` 命名空间依赖 SRC discovery，在部署环境不可靠 ⇒ 客户端按钮一律驱动
  `/optimize` 等命令，服务端返回机器可读 token（如 `AUTO_OPTIMIZE:ON/OFF`）供客户端映射。**不要引入新的客户端直连通道。**
- **输出形态默认 `plain`**：无标题纯文本、最省 token，`examples` 不注入。`sections` 四段保留为优化时的内部参考框架；
  `examples` 对 sections 直接注入、对 RTG 折叠为三要素后注入；`skipIfAlreadyOptimized` 同时识别四段与 RTG 形态（含中文标题变体）。
- **角色文档语言**：`metaPromptLanguage` 默认 `'auto'`（按指令语言自动检测）；运行时 `/optimize --language` 会话级覆盖，
  重启回落。检测结果单次调用内贯穿，与 `outputLanguage` 独立。
- **择优与本地模板路径互斥**：`localTemplate: on|hybrid` 在 LLM 管线之前就 return，因此不产生候选。要吃到择优收益
  必须让指令走完整管线（即默认的 `off`）。`evalJudge` 与 `selectJudge` 是两颗独立开关，改一个不要顺手改另一个。
- 所有注册（工具 / systemPrompt 段落 / 钩子 / 命令 / 设置项）均为 effect 作用域，卸载自动清理。
- **模型身份按 run 记，且不报没测到的东西**：`stats.lastRunRoute` 与载荷的 `route` / `genAi` 都描述**最近这次 run** ——
  缓存命中、本地直出、跳过透传后为 `null` / 不出现（**不沿用**上一次的模型）。`runRoute` 只在 `generateOnce` 赋值
  （唯一发出模型调用处），并在 `optimize()` / `iterate()` 开头清空；五个 `gen_ai.usage.*` 计数**要么都在、要么都不在**；
  `gen_ai.response.model` **不发**（宿主只报告被请求的模型）。持久化的路由加载时经 `normalizeRoute` 修复。
- **客户端 i18n：翻译器不捕获，按调用现取；`locale: NS` 按需声明**。三条规矩：
  ① `locale.bind(ns)` 是活闭包，但**在 `apply()` 时取到的那一份只认当时的 face**（宿主 locale 插件的 `apply()` 是
  async，`await` 完原生 bootstrap 才 `provide`），本插件可能先跑完 ⇒ 一律 `ctx.get('locale')` 每次现取，字典注册也惰性化；
  ② 两处 `slots.register` 只在**有 face 时**才声明 `locale: NS`（渲染器对"声明了却没人提供"的条目直接抛
  `SlotAssemblyError`）；声明后优先用渲染器给的 `props.t`（其身份随 locale revision 变化，是 memo 失效的官方通道）；
  ③ 回退路径下没有任何东西会触发重渲染，组件必须**自己订阅** locale 变化。另：`register` 对重复的"命名空间+语言"对会
  **抛错**（`already has locale`），更新会在旧 fiber 清理前重跑本文件 ⇒ 注册要 try/catch 降级。
  ⚠️ 测这类回归必须用**忠实假宿主**：`bind: (ns) => (key) => \`${ns}:${key}\`` 是**冻结捕获**，
  与真实 `LocaleFace`（活闭包）相反，**本身就是这个 bug 的形状** ⇒ 断言永远空过。
- **临时文件逐个点名删除**：删除临时产物时**严禁**用前缀/通配符做批量 `rm`（`rmSync` 不进回收站 ⇒ 不可恢复；
  本仓库同时存在 gitignored 的高价值内容与临时产物）。提交暂存也用 `git add -u` + 新文件逐个点名，**禁用 `git add -A`**。

## 兼容性

三条规则（细节、失败模式表、事故档案、升级验证流程见 **`docs/compatibility.md`**）：

- **R1** — `src/**` 只静态 import `@deepseek-ai/cordis` 与自有 `dependencies`；其余宿主包经
  `src/compat/loader.ts` 同步懒加载（失败返回 `null`，永不抛错）。宿主导入只允许**顶层 `import type`**
  （内联 `type` 修饰符在 `verbatimModuleSyntax` 下仍会留下运行时导入）。
- **R2** — `client/client.js` 的 `exports.inject` 只放真正不可缺的服务（当前只有 `remote`）；
  其余一律 `ctx.get('<name>')` 判空。
- **R2b** — 带点服务名（`remote.commands`）是**独立服务名**，必须整体 `ctx.get('remote.commands')`，
  且在**调用时**解析。

守卫：`tests/policy-static-imports.test.ts`、`tests/client-inject-contract.test.ts`、
`tests/client-apply.test.ts`、preflight **P1 / P6 / P7**。

## 命名与写作规范

### 术语表（一个概念只用一个词）

| 中文 | 英文 | 含义 |
|---|---|---|
| 优化 | optimize | 把原始指令改写成专业提示词（`/optimize <指令>`） |
| 迭代 | iterate | 在已有优化结果上按新要求继续改写 |
| 择优 | best-of-N selection | 同一条指令生成多个候选并保留最好的一个 |
| 候选 | candidate | 择优过程中生成的一个结果 |
| **门控** | candidate gate | 结构校验 + 注入金丝雀检查，决定**候选资格** |
| **门禁** | preflight gate | 发版前必跑的检查步骤 P1–P11 |
| 判官 | judge | 给候选/用例打分的 LLM 角色 |
| 金标集 | golden set | 内置评测用例集（14 例，8 例 core） |
| 元提示词 / 角色文档 | meta-prompt / role document | 驱动优化的系统提示词 |
| 画像 | profile | 情境感知产出的角色 / 任务 / 目标三份描述 |
| 护栏 | guardrail | 阻止指令或上下文被当作指令执行的约束 |
| 降级 | degradation | 宿主能力缺失时的功能缩减（打印 WARN，不失效） |
| 透传 | pass-through | 已优化过的输入不再优化，原样交回 |
| 台账 | ledger | 真实用量的累计记录 |
| 采纳率 | acceptance | 用户接受优化结果的比例 |

⚠️「门控」与「门禁」必须区分：前者是候选资格，后者是发版检查。混用会让文档无处可查。

### 命名规则

| 类别 | 规则 | 现状 |
|---|---|---|
| 包 / 插件 id | 仓库与 npm 包名 `oss-prompt-optimizer`；settings 命名空间与 entry id `prompt-optimizer` | 文档中首次出现时并列一次 |
| 命令 | `/<动词>` 或 `/optimize-<名词>`；旗标 `--<名词>` | `/optimize`、`/template`、`/optimize-eval` |
| 事件 | `<命名空间>/<对象>:<时点>` | `prompt-optimizer/optimize:start\|success\|failure` |
| 配置键 | camelCase；布尔不加 `is` 前缀；数值带单位后缀 | `cacheTtlMs`、`maxInputChars`、`selectMinGain` |
| 常量 | SCREAMING_SNAKE；`<域>_<MAX\|MIN>_<名词>[_<单位>]`（MAX/MIN 紧跟名词，单位最后） | `STATUS_MAX_EVENTS`、`JUDGE_MIN_SCORE`、`EPISODE_INPUT_MAX_CHARS`；全局上限可无域前缀（`MAX_TEMPERATURE`） |
| 语言变体 | **裸名 = 默认语言（中文），`_EN` = 英文** | `META_PROMPT` / `META_PROMPT_EN`、`RTG_LABELS` / `RTG_LABELS_EN` |
| CSS 类 | 客户端全部 `po-` 前缀；**类名描述元素，不描述动作猜测** | `.po-status-toggle`（切换状态面板）、`.po-field-input` |
| 文件 | `docs/` 下全小写 kebab-case 英文名 | `configuration.md`、`compatibility.md`、`subcategory-examples.md` |

### 注释与文档规范

- **源码注释用英文**；`README.md` / `AGENTS.md` / `CHANGELOG.md` / `docs/*.md` 用中文，`docs/*.en.md` 用英文。
- **文件头 ≤ 15 行**，三段式：① 一句话做什么 ② 一条关键不变量 ③ `@see docs/xxx.md`。**不写叙事、不写感叹**；
  设计推导与事故经过写进 `docs/compatibility.md` 或 `CHANGELOG.md`，源码里只留一行引用。
- 不重复类型与签名已表达的信息（`@param model The model id` 这类噪声删除）。
- 文档预算：一句 ≤ 25 词 / 60 字，一段 ≤ 3 句，列表项 ≤ 2 行，一节 ≤ 2 屏。超限就拆子列表或移进 `docs/`。
- 版本号**不内联**在功能描述里；版本历史唯一权威是 `CHANGELOG.md`。
- **语言对必须逐节同序同层且互链**：`README.md` ↔ `README.en.md`、`docs/configuration.md` ↔
  `docs/configuration.en.md`、`docs/compatibility.md` ↔ `docs/compatibility.en.md`。
  （`subcategory-examples.md` 暂只有中文，是已知的有意取舍；新增语言对时一并加进 `scripts/check-docs.mjs` 的 `PAIRS`。）
- `CHANGELOG.md` 用中文，`### ` 只用 `Added / Changed / Deprecated / Removed / Fixed / Security` 六类（其余作子条目）。
- `pnpm check:docs` 会校验上面可机器判定的部分——含每个语言对的标题层级与双向互链。

## Windows 环境注意（本机是 PowerShell，不是 bash）

- 工具 shell 为 PowerShell 5.1：`&&` 非法，用 `;` 分隔；环境变量用 `$env:X="y"`。
- 仓库路径含空格（`E:\deepseek harness prompt-optimizer`）：命令中一律加引号；`dsh plugin add <路径>` 会拆散
  含空格路径，用 junction（见 README 安装节）。
- 测试绝不允许读取 `.credentials.yaml`（mock llm 流，社区/CI 无密钥环境可跑）。

## 发布流程（用户主导，勿自作主张）

- **上架契约字段**：`engines.node >=22`、`engines.dsh` 与 `dsh.compatibility.dsh` 同值、
  `dsh.compatibility.dshReleases` 逐精确版本记录。范围**必须逐 tuple 用 `||` 枚举**——`>=0.1.5-rc.1 <0.2.0`
  按 semver 预发布规则**匹配不到 `0.1.6-alpha.2`**。当前只声明 **`^0.2.0-rc.2`**（CLI/web 与桌面
  `dsh-desktop-runtime` 同 tuple，P9 实测），它是设置面契约 `ctx.configForms` + volatile 表单落地的第一版。
  由 `tests/manifest-contract.test.ts` + P8/P9 守着。
- **`lib/` 是入库的发布产物**（1.8.5 起）。DSH STORE 只读**固定 Commit**、**不跑 install / prepare / build**，
  而 `main`/`types`/`exports` 全指向 `lib/` —— 只带 `src/` 的提交就是不可安装的包（1.8.4 被「更新暂缓」正是如此，
  而 `npm publish` 一切正常）。**改 `src/` 必须重建并同笔提交 `lib/`**，由 P8 守着。
- `prepublishOnly` = build（不再是 `prepare`）：构建只在发布时发生，git 源安装不再要求消费方允许执行构建脚本。
- npm 发布由用户手动执行（npm login + publish，2FA OTP 需用户输入）；代理只负责版本号 / CHANGELOG / git 提交建议。
- npm latest 落后于本地版本属常态（分批发布）。动版本前先核实：
  `npm view oss-prompt-optimizer dist-tags --json`（截至 2026-10-09：latest = **1.9.0**，本地 1.10.0–1.13.1 均未发布）。
- 插件市场描述走 GitHub upstream PR（`awesome-dsh-plugin/awesome-dsh-plugin`，用户为 CONTRIBUTOR 无合并权）。
  **8 个 PR 全部已合并**（最新 #5499，2026-10-09），无未关闭 PR；`gh` CLI 已装，条目更新可全程走 Git Data API 自动完成。
  `MARKETPLACE.md` 是 gitignored 的内部上架文档。
