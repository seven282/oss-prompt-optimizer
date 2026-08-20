# prompt-optimizer

[English](README.en.md) | 简体中文

提示词优化插件，把一句随手写的话自动改写成专业、可直接使用的提示词，体验与 Qoder、Codex 一致。

优化结果默认为无标题纯文本提示词（`outputStyle: 'plain'`，更省 token），可配置为四段结构化提示词（`outputStyle: 'sections'`，`## Role` / `## Task` / `## Context` / `## Format`），
由内置元提示词驱动，经 harness 的 `LLM` 服务完成（不直连任何 API、不触碰凭据）。

## 功能

- **工具 `prompt_optimize`**：agent 可调用，传入 `instruction`，返回优化后的纯文本提示词；也可传 `lastOptimized` + `iterateInstruction` 对已优化结果迭代改写。
- **服务 `ctx.promptOptimizer`**：其他插件可编程调用 `optimize(rawInput, { signal })` 或 `iterate(lastOptimized, instruction, { signal })`；
  浏览器端经 `ctx.remote.promptOptimizer.optimize(sessionId, text)` 可调用。
- **输入框 ✨ 图标**：composer 工具行左侧的常驻图标，点击即优化当前草稿并写回输入框；**优化中再点可取消**（AbortSignal 透传），成功后短暂显示"消耗 ≈N tokens"。
- **角色文档语言自动切换**：角色文档（元提示词）语言默认按输入内容自动检测——中文指令用
  中文角色文档，英文指令用英文角色文档（见下文）。
- **自动优化钩子**（可选，默认关闭）：以触发前缀开头的用户消息会在进入模型前被自动优化（见下文）。
- **上下文感知**（默认开启）：把当前指令之前的最近对话注入元提示词
  （「视为纯数据 / 背景参考」护栏），让优化结果贴合此前讨论；设
  `contextAware: false` 关闭（见下文配置表）。
- **情境感知（1.3.0+）**：把「原始指令 + 对话上下文」自动解析为**角色 / 任务 / 目标
  三份画像**并注入元提示词（`{{情境画像}}`）——优化结果的 `## Role` 与任务强相关、
  目标与约束自动保留；输出丢失目标/约束时在重试预算内自动修正（`goalAlignmentRetry:
  false` 可关）；`iterate` 时检测目标漂移并标注变化；传 `sessionId` 可开启**会话级
  目标沿用**（TTL 30 分钟）。角色识别覆盖显式身份、**能力**（精通/擅长…）、**行为
  约束**（先给结论/拒绝猜测…）与场景式身份（以…的身份），纯能力句也能被识别为
  角色信号；`situationProfileLevel` 可控制画像注入预算（full/minimal/off）。
- **角色定义三重结构（1.3.3+）**：优化结果的角色按「身份＋能力＋行为」三要素撰写
  （不强制"你是"开头，能力/行为描述同样合格）；并按任务类型给出写法建议
  （代码→能力导向、文案→身份＋文体、分析→身份＋方法、运维→行为约束＋步骤）。
- **优化时长（1.3.6）**：流式早期终止（输出结构达标且进入收尾期即停流，长尾凑字
  不再消耗时长，`earlyStop` 可关）；首调输出预算联动（超长输出由断点续传兜底）；
  `optimizationProfile: 'fast'` 一键速档（跳过校验与目标对齐重试、禁用 selfRefine，
  显式开启才生效）。
- **结果缓存（1.1.6）**：内存缓存校验成功的结果（LRU + TTL），相同请求**零模型调用**
  （`cacheEnabled` 默认开，重启即清空）。
- 后置校验：模型输出缺段/过薄/过短时自动重试（可配次数），重试前把上次失败的
  诊断（缺失段落名、过薄段落与字数）注入下一次调用的系统提示词，针对性修正、
  提高命中率；仍失败则返回原文/上次结果 + 错误说明，并附稳定机器可读错误码
  （`OptimizeResult.errorCode`：`MISSING_SECTIONS` / `THIN_SECTIONS` / `THIN_OUTPUT` /
  `TIMEOUT` / `NO_MODEL_ROUTE` 等），工具失败渲染带 `[错误码]` 前缀。
- 输出恒为完整可执行的提示词（四段或 plain 正文）；空输入报错；超长输入截断护栏；取消信号透传。
![项目截图](./1.png)
![项目截图](./2.png)

## 输入框 ✨ 图标

插件自带浏览器客户端（`lib/client.js`，经 `dsh.client` 声明被 harness 加载）：
在输入框工具行左侧注册一个 ✨ 按钮——输入为空或优化进行中时置灰（⏳），
点击后调用 host 的 `promptOptimizer` Remote 服务优化当前草稿，并把优化后的
四段提示词直接写回输入框（`inputActions.setDraft`）。

**不满意可一键恢复**：优化成功后，按钮切换为撤销态（↺，品牌色）；只要
草稿仍是刚生成的优化结果（未手动编辑），点击即恢复为优化前的原文。
一旦手动修改了草稿，撤销态自动消失（避免覆盖后续编辑）。

**可访问性**：成功/失败/撤销均通过隐藏的 `aria-live` 区域播报（屏幕阅读器）。

- 无需配置；随插件安装即启用，重启 harness 后生效。
- 触发的是同一个 `ctx.promptOptimizer.optimize()`，与工具/钩子共享全部配置
  （temperature、maxTokens、outputLanguage 等）。

## 角色文档语言（自动检测）

优化器角色文档（元提示词/系统提示词本身）的语言**默认按输入内容自动检测**：
非空白字符中汉字占比 ≥30% 的指令用中文角色文档（如「帮我写一份周报」），其余
（英文、日文等）用英文角色文档（两版文档的安全默认）。`outputLanguage` 仍独立控制
优化结果的输出语言，两者互不影响。

运行时可通过输入框直接输入命令固定或恢复自动（会话级覆盖，重启回落到配置值）：

- `/optimizer-language auto` —— 恢复自动检测（默认）
- `/optimizer-language 中文` / `/optimizer-language 英文` —— 固定语言
- `/optimizer-language status` —— 查询当前模式

配置 `metaPromptLanguage: 'auto' | '中文' | '英文'`（默认 `'auto'`）决定重启后的初始模式；
显式值（`'中文'`/`'英文'`）固定语言，`'auto'` 跟随输入。

## 自动优化开关（命令方式）

运行时「发送前自动优化」开关可通过输入框直接输入命令控制：
- `/auto-optimize on` / `/auto-optimize off` / `/auto-optimize toggle` / `/auto-optimize status`

开启后 host 进入「发送前自动优化」模式，`agent/pre-step` 钩子会对**每条**用户
文本消息做优化（等同于配置 `autoOptimizeAll: true` 的运行时版本）。

## 自动优化钩子

在 `cordis.patch.yml` 中开启：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'prompt-optimizer'
      config:
        autoOptimize: true
        autoOptimizePrefix: '/optimize '
```

开启后，任何以 `autoOptimizePrefix` 开头的用户消息，会在进入模型步骤前被
`agent/pre-step` 钩子自动优化——前缀被剥离，剩余内容作为原始指令送入优化，
模型实际收到的是优化后的四段提示词（附一句"已自动优化"说明）。

- 安全设计：默认关闭；按消息显式触发（前缀命中才优化），不会改动普通对话。
- 优雅降级：未命中前缀、前缀后内容为空、或优化失败时，原消息原样进入模型。
- 每个步骤最多优化一条消息，避免一次步骤内多次模型调用。
- 钩子注册为 effect 作用域，插件卸载自动移除。

## 安装

已发布到 npm（`oss-prompt-optimizer`），三种方式任选：

**方式一：npm 直装（推荐，免构建授权）**
```sh
dsh plugin --profile web add oss-prompt-optimizer
```

**方式二：从 GitHub 安装（源码构建，需授权 prepare）**
```sh
dsh plugin --profile web add github:seven282/oss-prompt-optimizer
# 首次会因 pnpm ≥10 拒绝运行 prepare 而失败；把 pnpm 提示的包键加进该 profile 的
# pnpm-workspace.yaml 后重试：
#   allowBuilds:
#     oss-prompt-optimizer: true
# 建议锁定 commit：github:seven282/oss-prompt-optimizer#<sha>
```

**方式三：从本地目录安装（开发用）**
```sh
dsh plugin --profile web add <项目路径>
# Windows 下含空格路径会被拆散，先用 junction：
#   New-Item -ItemType Junction -Path "C:\dsh-po" -Target "E:\<你的项目路径>"
#   dsh plugin --profile web add C:\dsh-po
```

**卸载（可逆）**
```sh
dsh plugin --profile web remove oss-prompt-optimizer
```

安装/卸载后需**重启 harness**（`dsh web`）使 bundle 层生效。

## 配置

插件行（`cordis.patch.yml`）可传入以下字段，缺省值已内置于 schema：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `temperature` | number 0–2 | `0.2` | 采样温度 |
| `maxTokens` | int ≥1 | `1200` | 单次输出上限（token）；追求省 token 可下调至 `600-800` |
| `maxRetries` | int 0–5 | `1` | 缺段时额外重试次数 |
| `maxCalls` | int 1–20 | `4` | 单次优化的模型调用总预算（首次+扩容+重试合计）；超出降级返回原文并报 `TOO_MANY_CALLS` |
| `maxInputChars` | int ≥1 | `4000` | 原始指令截断上限（字符，硬兜底） |
| `maxInputTokens` | int ≥0 | `3000` | 原始指令截断上限（估算 token；优先用 harness tokenMeter，缺失回退启发式；`0` 关闭） |
| `timeoutMs` | int ≥1 | `60000` | 单次调用超时预算（毫秒） |
| `outputLanguage` | string | `'auto'` | 输出语言；`'auto'` 跟随指令语言，其他值（如 `'英文'`）固定输出语言 |
| `outputStyle` | `'sections'` \| `'plain'` | `'plain'` | 输出风格：无标题连贯正文（默认，更省 token）或四段标题 |
| `metaPromptLanguage` | `'auto'` \| `'中文'` \| `'英文'` | `'auto'` | 优化器角色文档（元提示词）的语言；`'auto'` 按指令语言自动检测（汉字占比 ≥30% 用中文文档，否则英文），`'中文'`/`'英文'` 固定。输出语言仍由 `outputLanguage` 独立控制。运行时可用 `/optimizer-language auto\|中文\|英文` 固定或恢复自动 |
| `extraInstructions` | string | 无 | 追加到元提示词的部署自定义规则（如领域要求/风格） |
| `examples` | array | 内置回退 | few-shot 示例对 `[{input, output}]`，注入元提示词示范（仅 `sections` 模式注入）；未配置时按任务类型 + 角色文档语言自动注入 1 对内置示例（code/writing/analysis/ops，中英各 4 对，`other` 回落文案类），显式配置覆盖内置 |
| `minSectionChars` | int ≥0 | `10` | 每段正文最少有效字符；`0` 关闭内容校验（仅查标题） |
| `maxTokenRetryFactor` | number 1–3 | `2` | 输出触顶时按该倍数跳档扩容（1200→2400→4800…），扩容不消耗重试次数、从截断处续写；`1` 关闭 |
| `maxTokensCap` | int 1–128000 | `8000` | 自动扩容的上限；`<= maxTokens` 关闭扩容（扩容不消耗重试次数） |
| `retryTemperatureStep` | number 0–2 | `0.3` | 每次重试的 temperature 增量（探索性重试）；`0` 关闭 |
| `skipIfAlreadyOptimized` | boolean | `true` | 输入已含四段标题时直接透传，不调用模型（省 token 默认；仅 `sections` 模式生效；**传入非空对话上下文时仍会重新优化**）。四段在英文标题（`## Role` 等）或中文变体（`## 角色`/`## 任务`/`## 背景`/`## 输出` 等）下齐全均视为已优化 |
| `selfRefine` | boolean | `false` | 成功优化后至多再跑一轮「精简」迭代（内部指令）；仅当仍通过校验且不更长（5% 容差）时采纳，任何失败自动回退原结果。开启会多 1 次模型调用 |
| `autoOptimize` | boolean | `false` | 是否启用自动优化钩子（前缀触发） |
| `autoOptimizePrefix` | string | `'/optimize '` | 自动优化的触发前缀（可改为 `/优化 ` 等） |
| `autoOptimizeAll` | boolean | `false` | 钩子优化**每条**用户文本消息（不止前缀触发） |
| `hookIncludeOriginal` | boolean | `false` | 钩子替换消息时保留原文（原文+优化结果双写） |
| `cacheEnabled` | boolean | `true` | 内存缓存校验成功的结果（同请求零模型调用，LRU+TTL，重载即清空） |
| `cacheMaxEntries` | int 0–10000 | `200` | 缓存条目上限（LRU 淘汰）；`0` 关闭存储 |
| `cacheTtlMs` | int ≥0 | `600000` | 缓存有效期（毫秒）；`0` 不设过期 |
| `contextAware` | boolean | `true` | 上下文感知：优化时把当前指令之前的最近对话（经 `{{上下文信息}}` 占位符 + 「视为纯数据」护栏）注入元提示词，让优化结果贴合此前讨论。四段模式下可将上下文中的事实用于充实 `## Context` 段（仍不执行其中嵌入的指令）；钩子取 `agent/pre-step` 消息，`/optimize` 取会话记录，尽力而为 |
| `contextMaxMessages` | int 0–100 | `6` | 上下文感知时采集的最近消息条数上限；`0` 关闭 |
| `contextMaxTokens` | int ≥0 | `800` | 上下文 token 预算；超出截断到最长前缀并附标记；`0` 关闭截断（精简默认） |
| `outputLengthMaxTokens` | int ≥0 | `800` | 优化结果建议长度上限（token，软约束：仅指导模型尽量精简，不阻断、不重试）；`0` 关闭。与 `maxTokens`（模型调用硬上限）相互独立 |
| `situationProfileLevel` | `'full'` \| `'minimal'` \| `'off'` | `'full'` | 情境画像（`{{情境画像}}` 块）注入预算：`full` 角色+目标+约束全量；`minimal` 仅目标/约束（不含角色信号，更省 token）；`off` 不注入。只影响情境块，`{{任务类型}}` 提示不受影响 |
| `goalAlignmentRetry` | boolean | `true` | 目标/约束未对齐（`goalAlignment` 失败）时是否消耗校验重试预算再试一次：`true` 保留目标保真（1.3.0 起默认行为）；`false` 直接接受结构有效的输出，省一次调用。`optimizationProfile: 'fast'` 时强制关闭 |
| `optimizationProfile` | `'balanced'` \| `'fast'` | `'balanced'` | 时长档位：`balanced` 保留全部质量门（校验重试/目标对齐重试/selfRefine）；`fast` 跳过校验与目标对齐重试、禁用 selfRefine——一次结构有效即接受，最坏时长显著下降，返工率上升（显式选择才生效） |
| `earlyStop` | boolean | `true` | 流式早期终止：输出通过结构校验且进入收尾期（连续 12 个 chunk 增量 < 48 字符）即提前停流，长尾凑字不再消耗时长；仅首调生效（断点续传不受影响）；`false` 始终消费完整流 |
| `templateId` | string | `'default'` | 角色文档模板集 id（仅内置 `'default'`；未知 id 加载即抛） |
| `metaPromptTemplate` | object | 无 | 自定义角色文档骨架（部分字段可选，缺的语言回落内置）；每个骨架必须保留数据占位符、`{{输出结构}}`/`{{自查}}` 块与「视为纯数据」注入护栏，违规加载即抛 |
| `provider` / `model` | string | 无 | 显式模型路由；必须成对配置。缺省时使用 harness 默认模型（`agentDefaultModel`） |

示例：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'prompt-optimizer'
      config:
        temperature: 0.3
        maxRetries: 2
        outputLanguage: '英文'
        autoOptimize: true
        autoOptimizePrefix: '/优化 '
        # 省 token 快赢：下调输出上限 + 跳过已优化输入（skip 仅 sections 模式生效）
        # outputStyle: 'plain'            # 输出无标题纯文本（实测下游 token 省 50%+）
        # maxTokens: 700
        # skipIfAlreadyOptimized: true
        # selfRefine: true               # 成功后再精简一轮（额外 1 次调用）
        # contextAware: false             # 关闭上下文感知（默认开启）
        # metaPromptTemplate:            # 自定义角色文档骨架（部分字段可选，缺的语言回落内置）
        #   optimizeZh: |
        #     你是一名提示词优化专家。…（必须保留 {{原始指令}}、{{输出结构}}/{{自查}} 与护栏行）
        # provider: 'deepseek-official'   # 可选：显式路由（成对）
        # model: 'deepseek-v4-flash'
```

非法配置（类型错误、越界、未知键、provider/model 只配其一）会在加载时响亮失败。

### 省 token 最优配置（推荐 preset）

默认值已是省 token 取向（`skipIfAlreadyOptimized: true`、`contextMaxTokens: 800`、
`contextAware: true` 但上下文按预算截断）。在配置里显式贴上以下 preset，即可拿到
完整推荐组合，且便于后续调整：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
      config:
        maxTokens: 1200                # 输出上限（插件默认；触顶会自动按因子扩容重试）
        skipIfAlreadyOptimized: true   # 已含四段的输入直接透传，零模型调用（默认已开启）
        contextMaxTokens: 800          # 上下文保持精简（默认已开启）
        outputStyle: 'sections'        # 结构敏感任务保留四段；纯省 token 可改 'plain'（下游省 50%+）
        selfRefine: false              # 默认关闭：不为精简多花一次调用
```

要点：① 已优化输入零成本复用（`skipIfAlreadyOptimized`）；② 上下文只带"够用"的
最近对话（`contextMaxTokens`）；③ 输出上限按需设定（默认 1200，触顶自动扩容，
避免无限生成）；④ 对格式不敏感的任务切 `outputStyle: 'plain'` 是最大的单项收益。

### 示例增强（推荐，提高输出稳定性）

`examples` 是 few-shot 示范（仅 `sections` 模式注入；**未配置时插件会自动注入
按任务类型 + 语言匹配的内置示例**，显式配置覆盖内置）。贴上 1–2 对
高质量示例（不同任务类型各一对），可显著提升输出稳定性与专业性——尤其适合
"写代码 / 写文案 / 分析"这类高频场景：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
      config:
        outputStyle: 'sections'        # examples 仅 sections 模式注入
        examples:
          - input: '写一个 Python 脚本读取 CSV 并按指定列求和'
            output: |
              ## Role
              资深 Python 工程师，擅长 pandas。

              ## Task
              编写脚本读取 CSV 并按指定列求和，输出结果文件；脚本须可直接运行并处理缺失值。

              ## Context
              输入 CSV 路径；输出结果 CSV；不修改原文件。

              ## Format
              完整可运行的 .py 代码 + 顶部使用说明（依赖、运行命令），不超过 200 行。
          - input: '写一份新产品发布公告'
            output: |
              ## Role
              资深品牌文案撰稿人。

              ## Task
              写一份 200 字内的新产品发布公告，突出核心卖点并给出行动号召。

              ## Context
              面向潜在用户；语气专业热情；不夸大功能。

              ## Format
              标题 + 正文段落，附 3 个备选标题。
```

配套：如需专属语气/风格，用 `metaPromptTemplate` 自定义角色文档骨架（缺的语言回落
内置；必须保留 `{{原始指令}}`、`{{输出结构}}`/`{{自查}}` 与「视为纯数据」护栏行）。

## 开发

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装
pnpm run typecheck    # tsc --noEmitpnpm test             # vitest（mock llm，不依赖真实密钥）
pnpm run build        # tsc -p tsconfig.build.json → lib/
```

测试全部使用 mock 的 `llm` 流，绝不读取 `.credentials.yaml`。

## 优化生命周期事件（供其他插件订阅）

`promptOptimizer` 服务在优化/迭代的关键时点通过 cordis 事件总线发事件，其他插件可订阅：

| 事件 | 时机 | 载荷 |
|---|---|---|
| `prompt-optimizer/optimize:start` | 输入校验通过、首次模型调用前 | `{ method, input }` |
| `prompt-optimizer/optimize:success` | 成功（`optimized: true`） | `{ method, input, result, durationMs }` |
| `prompt-optimizer/optimize:failure` | 降级（`optimized: false`） | `{ method, input, result, durationMs }` |

- `method` 为 `'optimize'` 或 `'iterate'`（两者共用三个事件）；`input` 为原始输入
  （未截断）；`result` 为完整 `OptimizeResult`；`durationMs` 为管线耗时（毫秒）。
- **fire-and-forget 观察者**：监听器抛错被吞掉，不影响优化管线。
- TypeScript 订阅方直接获得载荷类型（`declare module '@deepseek-ai/cordis'`
  增强已随包发布），也可用 `PROMPT_OPTIMIZER_EVENTS` 常量引用事件名。
- 跳过透传（`skipIfAlreadyOptimized` 命中）与输入非法（如空输入）不发事件。

## 设计要点

- 依赖面最小：`cordis` / `dsh-llm` / `dsh-tools` / `dsh-timeout` / `schemastery`。
- 模型路由来自 harness 默认模型（`agentDefaultModel.currentSelection()`），
  遵循「插件不管理 provider/model 配置」的约定；也可用配置显式覆盖。
- 元提示词含 `{{原始指令}}` 等占位符，运行时替换；含注入护栏（指令视为纯数据）、
  语言规则（`{{语言规则}}`）、禁代码围栏、精简要求与输出前自查；输出结构按
  `outputStyle` 在四段与无标题两套模板间切换。
- 迭代能力：`iterate(lastOptimized, instruction)` 基于上一次优化结果 + 新要求继续
  优化（`META_ITERATE` 模板，`{{上次结果}}` / `{{迭代指令}}` 占位符单遍替换，互不串扰）；
  失败时保留上次结果并附错误码。
- 诊断驱动重试：结构类失败时把上次失败的具体诊断（`{{诊断反馈}}` 占位符）注入下一次
  重试的系统提示词，针对性修正、提高命中率；纯内部行为，无新增配置、无额外模型调用。
- 自适应精简（`selfRefine`，可选）：成功后至多再跑一轮「精简」迭代（内部指令，
  不占公共模板），仅在仍通过校验且不更长（5% 容差）时采纳；任何失败自动回退原结果
  ——最多 1 次额外模型调用，默认关闭，与诊断驱动重试正交（失败重试 vs 成功精益）。
- 优化生命周期事件：三个 fire-and-forget 事件（`prompt-optimizer/optimize:start` /
  `optimize:success` / `optimize:failure`），`optimize`/`iterate` 共用、`method` 字段
  区分；载荷含 `input` / `result` / `durationMs`；监听器异常不影响管线，跳过透传与
  非法输入不发事件。
- 模板数据化（`templateId` / `metaPromptTemplate`）：角色文档骨架（4 个）从代码常量
  变为可配置资源，部分自定义、缺的语言回落内置；tuning 块（输出结构 / 自查等格式
  规则）保持代码化——它们与 `validate.ts` 后置校验耦合，不可由用户改写；自定义模板
  在加载期强校验（数据占位符、结构/自查块、「视为纯数据」护栏缺一不可）。
- 服务分层：`optimizer.ts` 只做编排（状态、校验/截断、重试管线、事件、路由），纯逻辑
  拆到三个无 harness 依赖的模块——`diagnose.ts`（重试诊断文案 / selfRefine 指令，
  中英双语文案可独立单测）、`llm.ts`（finish 错误翻译、流式文本组装、`MaxTokensError`）、
  `prompt.ts`（`PromptBuildContext` 收口系统提示词构建参数，三处调用点共用）；公共
  API 面不变（`MaxTokensError` 仍从入口导出），端到端测试零改动。
- 角色文档语言自动检测：`metaPromptLanguage: 'auto'`（默认）按指令非空白字符中汉字
  占比 ≥30% 选择中文/英文角色文档（纯函数 `detectLanguage`，含假名的日文等语言归
  英文文档）；`'中文'`/`'英文'` 固定语言，`/optimizer-language` 可运行时固定或恢复
  自动。检测结果在单次调用内传递（`optimize`/`iterate` 按各自输入检测，`selfRefine`
  沿用本轮语言，重试诊断文案同语言），与 `outputLanguage` 独立。
- 所有注册（工具、systemPrompt 段落、自动优化钩子、命令）均为 effect 作用域，
  插件卸载自动清理。
- 命令命名：本插件注册 `/optimize` 与 `/auto-optimize`（短命令，遵循生态惯例）。
  若未来与其他插件冲突，改名需同步 `client.js` 调用、README 与钩子前缀默认值
  （`/optimize `），建议一次性原子变更。

## License

[MIT](LICENSE) — 自由使用、修改与分发（含商业用途），详见 `LICENSE` 文件。
