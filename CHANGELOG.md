# Changelog

## [1.7.5] - 2026-08-25

### Fixed
- **✨ 取消不再误报失败（P1，全面检查发现）**：dsh 协议中中止的 handler 以
  `kind:'error'` **resolve**（非 reject）——此前 error 分支未检查
  `controller.signal.aborted`，用户点取消会被显示为「优化失败」；现
  resolve-error 分支先识别取消
- **episode.all() 返回复制（P2）**：此前返回内部数组引用（注释声称 safe to
  mutate 但实际共享），改 `slice()` 防污染日志
- **adapt.resolveParams 注释对齐（P2）**：实际优先级为 Layer3 > Layer1 >
  base config（无 session hints 时）> Layer2 仅作字段级起点——注释与实现一致
- 测试 540 全绿（build 同步 lib/client.js）。

## [1.7.4] - 2026-08-25

### Fixed
- **✨ 取消功能回归**：`commands.execute` 恢复第四参 `signal`（AbortSignal）——
  1.7.3 只补了 `images=[]`（修复 "got 2" 报错）但未传 signal，导致取消按钮
  abort 仅作用于本地 controller、宿主请求无法感知取消（空跑浪费 token）；
  现调用形态 `execute(sessionId, line, [], signal)` 与 dsh rc.2 协议
  `(agentId, line, images, signal?)` 完全对齐
- 测试 540 全绿（build 同步 lib/client.js）。

## [1.7.3] - 2026-08-25

### Fixed
- **client.js ✨ 按钮 execute 签名修复**：dsh 0.1.1-rc.2 协议
  `commands.execute(agentId, line, images, signal?)` 需 **3 业务参数**，
  原调用 `(sessionId, line)` 缺 `images` → 报「expected 3 business
  argument(s)..., got 2」，优化按钮失效（1.7.0 修 AbortSignal 时误丢 images
  参数，遗留至今）；两处调用（优化 + `--stats`）补 `images=[]`
- 测试 540 全绿（build 同步 lib/client.js）。

## [1.7.2] - 2026-08-23

### Added
- 自迭代系统：三层架构（会话学习 + 智能默认值 + 用户覆盖），零 token 成本
- 新命令：`--set-profile`、`--set-local`、`--set-temperature`、`--clear`、`--insights`
- 新模块：episode.ts（行为采集）、preference.ts（偏好模型）、adapt.ts（三层决策）
- 新配置：`autoAdapt`（默认关）、`minAdaptEpisodes`（默认 10）

### Changed
- 优先级：用户覆盖 > 会话学习 > 智能默认值 > 基础配置

## [1.7.1] - 2026-08-23

### Changed
- FILL_RULES 从片段升级为完整四要素成品（20 子类 × 2 语言）
- buildLocalTemplate 简化，删除 5 个辅助函数，本地渲染质量提升

## [1.7.0] - 2026-08-23

### Fixed
- ✨ 按钮 AbortSignal 参数误传导致 rejected "images" 报错

### Removed
- dream 模式死代码（dreamInsightFeedback、senseNeedsSeparate 等）

## [1.6.9] - 2026-08-23

### Added
- 新配置 `sceneRefEnabled`（默认 `true`）：`false` 时跳过场景参考注入（省 ~200 input tokens）

### Changed
- plain 模式结构/自查块清空，常驻系统提示词最小化
- 场景参考/示例增加防照搬护栏
- 四段模式上下文提取规则优化：仅提取与任务相关的事实

## [1.6.8] - 2026-08-22

### Changed
- 默认输出形态 role-task-goal → plain（无标题纯文本，最省 token）
- 内置示例增加过配门控：相似指令不注入示例，防逐字搬运
- 内置示例瘦身：8 条最重示例 output 压缩约一半
- 系统提示词减负：任务类型提示压缩、结构块增加复杂度伸缩条款
- 长度预算可感化：追加字/词锚点（中文 ≈N/1.5 字，英文 ~0.75 words/token）

### Added
- 新配置 `maxTotalTokens`（默认 20000）：累计 token 预算硬门
- 简单指令极简档：≤16 字符短指令走极简系统提示词
- 结构细则后置：失败重试时由诊断文案精准下发

### Fixed
- 场景参考行「角色参考：」双前缀修复
- 缓存键纳入 outputLanguage（防跨语言串缓存）
- 纯度门只扫末尾 300 字符（正文提及关键词不再误伤）
- CJK 系数 1→1.5（减少中文过早截断）
- 分类平局裁决统一为 resolveWritingTieBreak

### Removed
- 造梦模式降本：senseNeeds 不再绕过 localTemplate
- 三重回声去重、画像噪声门控、自查瘦身

## [1.6.7] - 2026-08-21

### Fixed
- 分类 tie-break 修复：写作动词与 analysis 类词同分时判 writing

### Changed
- 默认输出形态 sections → role-task-goal（三要素标签）
- maxTokenRetryFactor 默认 2 → 1.5
- writing-copy / writing-resume 示例与关键词扩充

## [1.6.6] - 2026-08-21

### Changed
- RTG 模式下内置示例折叠为三要素再注入
- 子类示例从 2 个扩充到 15 个，覆盖 15 子类 + 4 大类
- 高频子类变体：述职报告、产品介绍PPT、生产发布、融资路演PPT

### Fixed
- hasValidRoleTaskGoal 正则误判内容行为标签

## [1.6.5] - 2026-08-21

### Added
- 三要素输出形态 `outputStyle: 'role-task-goal'`（`角色：/任务：/目标：`）

### Changed
- 四段保持为优化时内部参考框架，输出可配置为三行标签
- 默认保持 sections（零回归）

## [1.6.4] - 2026-08-21

### Added
- 新子类 `writing-presentation`（PPT/演示/述职/路演）

### Changed
- TASK_KEYWORDS.writing 补充生成/ppt/presentation 等关键词
- 内置示例改为数组格式，一个子类可挂多条
- 措辞自然化：去机械感，命令词弱化为引导式

## [1.6.3] - 2026-08-21

### Added
- 输出纯净性后置校验：检测夹带方法论/元内容附录

### Fixed
- 命中时注入「只输出提示词本身」诊断重试

## [1.6.2] - 2026-08-21

### Changed
- `auto` 语义改为 seed 优化（本地参考模板 + LLM 感知目标）
- 档位语义：off 全量 / auto seed 优化 / on 纯本地直出 / hybrid 对齐+精修

## [1.6.1] - 2026-08-21

### Added
- `localTemplate: 'hybrid'` 混合两档：本地直出后做目标感知对齐检查

### Changed
- 对齐达标直接返回本地成品（0 token），未达标走轻量 LLM 精修

## [1.6.0] - 2026-08-21

### Changed
- 本地直出丰富度增强：新增 FILL_RULES（21 子类 × zh/en 成品填充规则）

## [1.5.9] - 2026-08-21

### Fixed
- 本地直出输出净化：去除内部数据前缀/元标记，读作成品

## [1.5.8] - 2026-08-21

### Changed
- 默认输出风格 plain → sections（四段结构化提示词）

## [1.5.7] - 2026-08-21

### Added
- 内置示例新增 analysis-review 评估类（zh/en）

## [1.5.6] - 2026-08-21

### Added
- 本地零 token 模板直出：结构化子类场景本地渲染四段模板
- 配置 `localTemplate: 'auto' | 'on' | 'off'`
- `/template <场景> <指令>` 预填版

## [1.5.5] - 2026-08-21

### Fixed
- 任务分类歧义消解：写作动词与运维词同分时判 writing

## [1.5.4] - 2026-08-21

### Added
- 内置 few-shot 示例子类优先：子类命中时优先注入子类专用示例

## [1.5.3] - 2026-08-21

### Fixed
- 全量审查修复 13 项：dream 缓存键、英文翻译、错误码归因、配置白名单等

## [1.5.2] - 2026-08-21

### Added
- 新增 3 个高频子类：writing-polish、writing-resume、writing-speech

### Fixed
- ops 断链修复：补充部署/发布/上线关键词

## [1.5.1] - 2026-08-20

### Added
- 子类模板库 SUB_TOPIC_TEMPLATES（18 子类场景骨架）
- `/template <场景>` 命令：不调模型、零延迟零 token

## [1.5.0] - 2026-08-20

### Added
- 可替换分类器接口 TaskClassifier + heuristicClassifier 默认实现

## [1.4.9] - 2026-08-20

### Added
- 角色模板库 ROLE_LIBRARY：按任务类型预置角色参考
- dreamInsightFeedback：跨轮上下文洞察回填

## [1.4.8] - 2026-08-20

### Changed
- 情境感知启发式增强：主谓宾抽取、同义词归一、核心动作注入

## [1.4.7] - 2026-08-20

### Changed
- 四区块详略动态调配：按任务类型明确详略导向
- Context 极简规则：无额外背景时可写「无额外背景」

## [1.4.6] - 2026-08-20

### Added
- `/optimize-stats` 扩展 INPUT 统计
- 新增 `builtinExamples` 配置（默认 true）

## [1.4.5] - 2026-08-20

### Fixed
- 流式早停修复：默认改 false，加固防半句截断

## [1.4.4] - 2026-08-20

### Added
- 耗时测量分解：per-call 计时 + /optimize-stats 扩展
- README 快速档 preset

## [1.4.3] - 2026-08-20

### Added
- 近失配热启动：相似缓存指令以缓存结果为起点走 iterate 精修
- enrich 显式绕过：跳过缓存强制全新运行
- 需求感应 / 造梦模式 senseNeeds
- `/dream` 命令

## [1.4.2] - 2026-08-20

### Fixed
- 断点续传消息补注入护栏
- CI 新增 pnpm audit 步骤

## [1.4.1] - 2026-08-20

### Changed
- 输出按句断行规则：每句独占一行，段落间空一行

## [1.4.0] - 2026-08-20

### Added
- 内置默认示例集 BUILTIN_EXAMPLES：中英 × 4 任务类型共 8 对

## [1.3.9] - 2026-08-20

### Changed
- 模板文案精简：去除冗余修饰，每条规则一句为限

## [1.3.8] - 2026-08-20

### Changed
- 输出简洁度与逻辑一致性规则增强：全局精简、Role 简短、Context 无虚构、Format 四项齐全

## [1.3.7] - 2026-08-20

### Fixed
- 代码质量审查修复：早停阈值配置化、内存泄漏保护、类型安全、正则性能

## [1.3.6] - 2026-08-19

### Added
- 首调预算联动、goalAlignmentRetry 配置
- 流式早期终止 earlyStop、optimizationProfile 速档

## [1.3.5] - 2026-08-19

### Changed
- 任务类型 → 角色写法映射：code 能力导向、writing 身份+文体、analysis 身份+方法、ops 行为+步骤

## [1.3.4] - 2026-08-19

### Changed
- 角色抽取扩展：新增 capability/behavior 字段，纯能力句可过注入门槛

## [1.3.3] - 2026-08-19

### Changed
- Role 段规则升级：角色定义三重结构（身份+能力+行为）

## [1.3.2] - 2026-08-19

### Added
- 画像版本化、注入预算配置 situationProfileLevel
- 会话级目标注册表（TTL 30 分钟）

## [1.3.1] - 2026-08-19

### Added
- 两级任务分类 detectTaskSubtype（18 子类）
- 可衡量性检测、iterate 目标漂移检测

## [1.3.0] - 2026-08-19

### Added
- 情境感知层 P0：结构化三画像（角色/任务/目标）+ goalAlignment 校验

## [1.2.0] - 2026-08-19

### Added
- 任务类型感知 detectTaskType：按关键词打分分类
- 对话上下文去重、输出长度软预算
- skipIfAlreadyOptimized 识别中文标题变体

## [1.1.8] - 2026-08-19

### Changed
- 四段结构语义规则升级：Role 强相关、Task 完成标准、Context 无虚构、Format 四项齐全

## [1.1.7] - 2026-08-18

### Added
- 调用预算 maxCalls（默认 4）、运行统计、✨ 取消反馈、成本可见

## [1.1.6] - 2026-08-18

### Added
- 结果缓存 cacheEnabled（LRU + TTL），重复请求零模型调用

## [1.1.5] - 2026-08-18

### Changed
- 四段输出上下文感知：sections 模式下上下文充实 Context 段
- 优化时长根治：断点续传 + 跳档扩容

## [1.1.4] - 2026-08-18

### Changed
- 省 token 默认值：skipIfAlreadyOptimized 默认 true，contextMaxTokens 降到 800
- 输出触顶自动扩容 maxTokensCap

## [1.1.3] - 2026-08-18

### Added
- 上下文感知 contextAware：把最近对话注入元提示词
- 包含 1.1.0-1.1.2 全部特性（语言检测、迭代优化、错误码、诊断重试、自适应精简、模板数据化）

## [1.1.2] - 2026-08-18

### Added
- 角色文档语言自动检测 metaPromptLanguage
- 迭代优化 iterate
- 结构化错误码、诊断驱动重试、自适应精简 selfRefine
- 优化生命周期事件

## [1.0.3] - 2026-08-17

### Added
- 新增 outputStyle 配置（sections/plain）
- 元提示词新增精简要求

## [1.0.2] - 2026-08-17

### Changed
- GitHub 仓库改名：seven282/oss-prompt-optimizer

## [1.0.1] - 2026-08-16

### Changed
- npm 包改名：oss-prompt-optimizer

## [1.0.0] - 2026-08-16

### Added
- 首次发布：将原始指令优化为四段专业提示词
- 核心能力：服务 ctx.promptOptimizer.optimize()、工具 prompt_optimize、命令 /optimize
- 输入框 ✨ 按钮：一键优化、↺ 撤销
- 自动优化钩子（agent/pre-step）
- 质量保障：80 个 vitest 用例
