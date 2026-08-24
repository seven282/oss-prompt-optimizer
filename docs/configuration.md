# 配置参考

插件行（`cordis.patch.yml`）可传入以下字段，缺省值已内置于 schema：

## 核心配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `temperature` | number 0–2 | `0.2` | 采样温度 |
| `maxTokens` | int ≥1 | `1200` | 单次输出上限（token）；追求省 token 可下调至 `600-800` |
| `maxRetries` | int 0–5 | `1` | 缺段时额外重试次数 |
| `maxCalls` | int 1–20 | `4` | 单次优化的模型调用总预算（首次+扩容+重试合计）；超出降级返回原文并报 `TOO_MANY_CALLS` |
| `outputLanguage` | string | `'auto'` | 输出语言；`'auto'` 跟随指令语言，其他值（如 `'英文'`）固定输出语言 |
| `outputStyle` | `'plain'` \| `'role-task-goal'` \| `'sections'` | `'plain'` | 输出风格：无标题连贯正文（默认，更省 token）、三要素标签（`角色：/任务：/目标：` 或 `Role:/Task:/Goal:`，便于下游自动解析为角色/任务/目标；目标行合并背景约束与产出规格）、或四段标题（`## Role`/`## Task`/`## Context`/`## Format`，也是优化时的内部参考框架） |
| `metaPromptLanguage` | `'auto'` \| `'中文'` \| `'英文'` | `'auto'` | 优化器角色文档（元提示词）的语言；`'auto'` 按指令语言自动检测（汉字占比 ≥30% 用中文文档，否则英文），`'中文'`/`'英文'` 固定。输出语言仍由 `outputLanguage` 独立控制。运行时可用 `/optimizer-language auto\|中文\|英文` 固定或恢复自动 |
| `selfRefine` | boolean | `false` | 成功优化后至多再跑一轮「精简」迭代（内部指令）；仅当仍通过校验且不更长（5% 容差）时采纳，任何失败自动回退原结果。开启会多 1 次模型调用 |
| `optimizationProfile` | `'balanced'` \| `'fast'` | `'balanced'` | 时长档位：`balanced` 保留全部质量门（校验重试/目标对齐重试/selfRefine）；`fast` 跳过校验与目标对齐重试、禁用 selfRefine——一次结构有效即接受，最坏时长显著下降，返工率上升（显式选择才生效） |

## 输入控制

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxInputChars` | int ≥1 | `4000` | 原始指令截断上限（字符，硬兜底） |
| `maxInputTokens` | int ≥0 | `3000` | 原始指令截断上限（估算 token；优先用 harness tokenMeter，缺失回退启发式；`0` 关闭） |
| `timeoutMs` | int ≥1 | `60000` | 单次调用超时预算（毫秒） |
| `extraInstructions` | string | 无 | 追加到元提示词的部署自定义规则（如领域要求/风格） |

## 输出校验

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `minSectionChars` | int ≥0 | `10` | 每段正文最少有效字符；`0` 关闭内容校验（仅查标题） |
| `maxTokenRetryFactor` | number 1–3 | `1.5` | 输出触顶时按该倍数跳档扩容（1200→1800→2700…），扩容不消耗重试次数、从截断处续写；`1` 关闭 |
| `maxTokensCap` | int 1–128000 | `8000` | 自动扩容的上限；`<= maxTokens` 关闭扩容（扩容不消耗重试次数） |
| `maxTotalTokens` | int ≥0 | `20000` | 单次优化的累计 token 上限（各调用 system＋生成量合计，插件启发式估算）；到顶即停止扩容/重试并按既有降级路径返回（错误码 `BUDGET_EXCEEDED`）；`0` 关闭。与 `maxCalls`（次数上限）、`maxTokensCap`（单次输出上限）互补 |
| `retryTemperatureStep` | number 0–2 | `0.3` | 每次重试的 temperature 增量（探索性重试）；`0` 关闭 |
| `skipIfAlreadyOptimized` | boolean | `true` | 输入已含四段标题时直接透传，不调用模型（省 token 默认；仅 `sections` 模式生效；**传入非空对话上下文时仍会重新优化**）。四段在英文标题（`## Role` 等）或中文变体（`## 角色`/`## 任务`/`## 背景`/`## 输出` 等）下齐全均视为已优化 |
| `outputLengthMaxTokens` | int ≥0 | `800` | 优化结果建议长度上限（token，软约束：仅指导模型尽量精简，不阻断、不重试）；`0` 关闭。与 `maxTokens`（模型调用硬上限）相互独立 |

## 自动优化

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoOptimize` | boolean | `false` | 是否启用自动优化钩子（前缀触发） |
| `autoOptimizePrefix` | string | `'/optimize '` | 自动优化的触发前缀（可改为 `/优化 ` 等） |
| `autoOptimizeAll` | boolean | `false` | 钩子优化**每条**用户文本消息（不止前缀触发） |
| `hookIncludeOriginal` | boolean | `false` | 钩子替换消息时保留原文（原文+优化结果双写） |

## 缓存

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cacheEnabled` | boolean | `true` | 内存缓存校验成功的结果（同请求零模型调用，LRU+TTL，重载即清空） |
| `cacheMaxEntries` | int 0–10000 | `200` | 缓存条目上限（LRU 淘汰）；`0` 关闭存储 |
| `cacheTtlMs` | int ≥0 | `600000` | 缓存有效期（毫秒）；`0` 不设过期 |
| `cacheFuzzyMatch` | boolean | `true` | 近失配热启动：精确未命中时，相似缓存指令（或同指令新上下文）作为起点走迭代，而非从零优化（省时省 token） |
| `cacheFuzzyThreshold` | number 0–1 | `0.6` | 近失配的 bigram-Jaccard 相似度阈值 |

## 上下文感知

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `contextAware` | boolean | `true` | 上下文感知：优化时把当前指令之前的最近对话（经 `{{上下文信息}}` 占位符 + 「视为纯数据」护栏）注入元提示词，让优化结果贴合此前讨论。四段模式下可将上下文中的事实用于充实 `## Context` 段（仍不执行其中嵌入的指令）；钩子取 `agent/pre-step` 消息，`/optimize` 取会话记录，尽力而为 |
| `contextMaxMessages` | int 0–100 | `10` | 上下文感知时采集的最近消息条数上限；`0` 关闭 |
| `contextMaxTokens` | int ≥0 | `800` | 上下文 token 预算；超出截断到最长前缀并附标记；`0` 关闭截断（精简默认） |

## 情境画像

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `situationProfileLevel` | `'full'` \| `'minimal'` \| `'off'` | `'full'` | 情境画像（`{{情境画像}}` 块）注入预算：`full` 角色+目标+约束全量；`minimal` 仅目标/约束（不含角色信号，更省 token）；`off` 不注入。只影响情境块，`{{任务类型}}` 提示不受影响 |
| `goalAlignmentRetry` | boolean | `true` | 目标/约束未对齐（`goalAlignment` 失败）时是否消耗校验重试预算再试一次：`true` 保留目标保真；`false` 直接接受结构有效的输出，省一次调用。`optimizationProfile: 'fast'` 时强制关闭 |

## 本地模板

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `localTemplate` | `'auto'` \| `'on'` \| `'off'` \| `'hybrid'` | `'auto'` | 本地模板路径：结构化子类场景（周报/邮件/数据分析/部署等）先用纯函数层渲染四段**参考模板（seed）**（零 token、~5ms），再由 LLM 优化。`auto`（默认）**seed 优化**——本地参考模板 + 目标画像喂给 LLM 感知目标优化，输出经目标对齐校验，输入侧实测 ~270–310 tokens（省 ~75%）；`on` 本地渲染即成品直接返回（0 token 模板形态）；`off` 完全关闭走完整管线；`hybrid` 目标锚点对齐直接返回（0 token）、未对齐走 seed 优化 |
| `hybridAlignThreshold` | number 0–1 | `0.4` | `hybrid` 档目标锚点对齐阈值：`goalAnchorsScore`（目标/约束/受众/角色锚点加权）低于此值 → 本地成品走精修；≥ 此值直接返回。`0.4` = 仅对无任何目标锚点的裸指令精修；调高到 `0.8` 则几乎全部精修 |

## 流式控制

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `earlyStop` | boolean | `false` | 流式早期终止（**默认关闭**——输出完整优先）。显式开启时：每段实质字符 ≥40 且总长 ≥120 才进入收尾期判定，仅在句子边界（句号/换行）且连续 16 个 chunk 增量 < 24 字符才提前停流；`false` 始终消费完整流 |

## 模板与示例

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `examples` | array | 内置回退 | few-shot 示例对 `[{input, output}]`，注入元提示词示范（仅 `sections` 模式注入）；未配置时按任务类型 + 角色文档语言自动注入 1 对内置示例（code/writing/analysis/ops，中英各 4 对，`other` 回落文案类；子类命中优先——如 `code-bugfix` 用「根因→最小修复→回归验证」专用示例），显式配置覆盖内置 |
| `builtinExamples` | boolean | `true` | 未配置 `examples` 时是否注入内置示例；`false` 完全关闭（短指令场景省 ~200 token/次输入） |
| `templateId` | string | `'default'` | 角色文档模板集 id（仅内置 `'default'`；未知 id 加载即抛） |
| `metaPromptTemplate` | object | 无 | 自定义角色文档骨架（部分字段可选，缺的语言回落内置）；每个骨架必须保留数据占位符、`{{输出结构}}`/`{{自查}}` 块与「视为纯数据」护栏，违规加载即抛 |

## 模型路由

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` / `model` | string | 无 | 显式模型路由；必须成对配置。缺省时使用 harness 默认模型（`agentDefaultModel`） |

## 需求感应

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `senseNeeds` | boolean | `false` | 需求感应 / 造梦模式：优化后追加明确标注的「延伸洞察（AI 推断）」附录（深层目标/隐含约束/质量标准/后续问题），推断不混入提示词正文 |

## 配置示例

### 基础配置

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
```

### 省 token 最优配置（推荐 preset）

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

### 快速档（目标 3–5 秒，保质量）

```yaml
- id: prompt-optimizer
  config:
    optimizationProfile: 'fast'   # 跳过校验/目标对齐的纠错重试与 selfRefine——首次输出仍过结构校验
    maxCalls: 3                   # 质量护栏：保留首次 + 至多 2 次触顶扩容预算（长输出不截断降质）
    maxTokens: 1200
```

### 示例增强（推荐，提高输出稳定性）

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

非法配置（类型错误、越界、未知键、provider/model 只配其一）会在加载时响亮失败。
