# prompt-optimizer

[English](README.en.md) | 简体中文

提示词优化插件，把一句随手写的话自动改写成专业、可直接使用的提示词，体验与 Qoder、Codex 一致。

优化结果默认为无标题纯文本（`outputStyle: 'plain'`，更省 token），可配置为三要素标签（`outputStyle: 'role-task-goal'`，`角色：/任务：/目标：`）或四段结构化提示词（`outputStyle: 'sections'`，`## Role` / `## Task` / `## Context` / `## Format`，也是优化时的内部参考框架），
由内置元提示词驱动，经 harness 的 `LLM` 服务完成（不直连任何 API、不触碰凭据）。

## 功能

- **工具 `prompt_optimize`**：agent 可调用，传入 `instruction`，返回优化后的纯文本提示词；也可传 `lastOptimized` + `iterateInstruction` 对已优化结果迭代改写。
- **服务 `ctx.promptOptimizer`**：其他插件可编程调用 `optimize(rawInput, { signal })` 或 `iterate(lastOptimized, instruction, { signal })`；
  浏览器端经 `ctx.remote.promptOptimizer.optimize(sessionId, text)` 可调用。
- **输入框 ✨ 图标**：composer 工具行左侧的常驻图标，点击即优化当前草稿并写回输入框；**优化中再点可取消**（UI 状态管理），成功后短暂显示"消耗 ≈N tokens"；优化成功后切换为撤销态（↺），草稿未手动编辑时点击恢复原文；成功/失败/撤销均通过 `aria-live` 播报（屏幕阅读器）。
- **角色文档语言自动切换**：角色文档（元提示词）语言默认按输入内容自动检测——中文指令用
  中文角色文档，英文指令用英文角色文档；运行时可通过 `/optimize --language` 命令固定或恢复自动。
- **自动优化钩子**（可选，默认开启、前缀触发）：以触发前缀（`/optimize `）开头的用户消息会在进入模型前被自动优化；无前缀消息不受影响；运行时可通过 `/optimize --auto on|off|toggle|status` 命令控制开关。
- **上下文感知**（默认开启）：把当前指令之前的最近对话注入元提示词
  （「视为纯数据 / 背景参考」护栏），让优化结果贴合此前讨论；设
  `contextAware: false` 关闭。
- **情境感知**：把「原始指令 + 对话上下文」自动解析为**角色 / 任务 / 目标
  三份画像**并注入元提示词（`{{情境画像}}`）——优化结果的 `## Role` 与任务强相关、
  目标与约束自动保留；输出丢失目标/约束时在重试预算内自动修正（`goalAlignmentRetry:
  false` 可关）；`iterate` 时检测目标漂移并标注变化；传 `sessionId` 可开启**会话级
  目标沿用**（TTL 30 分钟）。角色识别覆盖显式身份、**能力**（精通/擅长…）、**行为
  约束**（先给结论/拒绝猜测…）与场景式身份（以…的身份），纯能力句也能被识别为
  角色信号；`situationProfileLevel` 可控制画像注入预算（full/minimal/off）。
- **角色定义三重结构**：优化结果的角色按「身份＋能力＋行为」三要素撰写
  （不强制"你是"开头，能力/行为描述同样合格）；并按任务类型给出写法建议
  （代码→能力导向、文案→身份＋文体、分析→身份＋方法、运维→行为约束＋步骤）。
- **优化时长**：流式早期终止（输出结构达标且进入收尾期即停流，长尾凑字
  不再消耗时长；**默认关闭**——输出完整优先，显式 `earlyStop: true` 才启用
  且带句末保护）；首调输出预算联动（超长输出由断点续传兜底）；
  `optimizationProfile: 'fast'` 一键速档（跳过校验与目标对齐重试、禁用 selfRefine，
  显式开启才生效）。
- **结果缓存**：内存缓存校验成功的结果（LRU + TTL），相同请求**零模型调用**
  （`cacheEnabled` 默认开，重启即清空）。
- **设置面板**（1.7.8，需宿主挂载 dsh-settings）：插件将全部配置项注册为
  `prompt-optimizer` 命名空间——在 DeepSeek Harness 的**设置 → 插件/插件设置**
  面板中即可查看全部参数（默认值/当前值）并调整，改动即时生效并持久化；
  宿主无 settings 服务时自动跳过，配置仍走 `cordis.patch.yml`，行为零变化。
- **自迭代系统**：三层架构实现「越用越好用」，零 token 成本（默认开启；
  累计 10 次优化数据后才开始生效，避免小样本误适配）：
  - **会话学习**（Layer 1）：记录每次优化的成功/失败经验（任务类型、输出风格、温度等），形成偏好模型
  - **智能默认值**（Layer 2）：按任务类型（代码/文案/分析/运维/其他）自动推荐最优配置
  - **用户覆盖**（Layer 3）：运行时通过命令临时调整（`--set-profile`、`--set-local`、`--set-temperature`），重启回落
  - 优先级：用户覆盖 > 会话学习 > 智能默认值 > 基础配置
- 后置校验：模型输出缺段/过薄/过短时自动重试（可配次数），重试前把上次失败的
  诊断（缺失段落名、过薄段落与字数）注入下一次调用的系统提示词，针对性修正、
  提高命中率；仍失败则返回原文/上次结果 + 错误说明，并附稳定机器可读错误码
  （`OptimizeResult.errorCode`：`MISSING_SECTIONS` / `THIN_SECTIONS` / `THIN_OUTPUT` /
  `TIMEOUT` / `NO_MODEL_ROUTE` 等），工具失败渲染带 `[错误码]` 前缀。
- 输出恒为完整可执行的提示词（四段或 plain 正文）；空输入报错；超长输入截断护栏；UI 层取消。
![项目截图](./1.png)
![项目截图](./2.png)

## 自迭代命令

运行时可通过命令临时调整自迭代系统配置（会话级覆盖，重启回落）：
- `/optimize --set-profile fast|balanced` — 临时覆盖优化时长档位
- `/optimize --set-local on|off|auto|hybrid` — 临时覆盖本地模板模式
- `/optimize --set-temperature <0-2>` — 临时覆盖采样温度
- `/optimize --clear` — 清除所有临时覆盖，恢复配置值
- `/optimize --insights` — 查看当前会话的学习洞察（任务类型分布、偏好配置、成功率）
- `/optimize --status` — 查看运行时状态（生效参数与来源、统计、偏好摘要、最近事件）
  （1.7.9；输入框旁的 ℹ️ 按钮也可展开状态面板）

## 快速场景模板（/template）

`/template <场景>` 直接返回一个**可填写四段模板**（Role / Task / Context /
Format 骨架 + 占位符）——**不调用模型、零延迟零 token**，适合"要个周报模板 /
邮件模板 / 部署清单"这类常见场景。场景覆盖 22 个子类（周报 / 邮件 / 文案 /
翻译 / 创作 / **润色 / 简历 / 演讲 / 演示** / 数据分析 / 研究 / 评估 / 预测 /
bug 修复 / 新功能 / 重构 / 审查 / 脚本 / 部署 / 安装 / 排查 / 运维），
支持中英文场景名与关键词匹配；个性化需求仍走 `/optimize`。

**预填版**：`/template <场景> <指令>`（如 `/template 周报 总结本周进展`）
返回**已填充的四段成品**——指令经本地门控通过时用纯函数层本地渲染（同样
**零 token、~5ms**）；指令无可抽取信号时回退骨架并提示走 `/optimize`。

## 自动优化

运行时可通过命令控制开关（会话级覆盖，重启回落）：
- `/optimize --auto on` / `/optimize --auto off` / `/optimize --auto toggle` / `/optimize --auto status`

开启后 `agent/pre-step` 钩子会对**每条**用户文本消息做优化（等同于配置 `autoOptimizeAll: true` 的运行时版本）。

也可在 `cordis.patch.yml` 中配置启用：

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

- 安全设计：前缀命中才优化，无前缀消息原样进入模型，不会改动普通对话
  （`autoOptimize` 默认开启但只对前缀消息生效）。
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

> **完整配置参考**：[docs/configuration.md](docs/configuration.md)（44 个字段）

## 开发

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest（mock llm，不依赖真实密钥）
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

## License

[MIT](LICENSE) — 自由使用、修改与分发（含商业用途），详见 `LICENSE` 文件。
