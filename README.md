# prompt-optimizer

DeepSeek Harness 插件：将用户原始指令自动优化为专业、结构化的提示词。

优化结果默认为四段结构化提示词（`## Role` / `## Task` / `## Context` / `## Format`），可配置为无标题的纯文本提示词（`outputStyle: 'plain'`，更省 token），
由内置元提示词驱动，经 harness 的 `llm` 服务完成（不直连任何 API、不触碰凭据）。

## 功能

- **工具 `prompt_optimize`**：agent 可调用，传入 `instruction`，返回优化后的纯文本提示词。
- **服务 `ctx.promptOptimizer`**：其他插件可编程调用 `optimize(rawInput, { signal })`；
  浏览器端经 `ctx.remote.promptOptimizer.optimize(sessionId, text)` 可调用。
- **输入框 ✨ 图标**：composer 工具行左侧的常驻图标，点击即优化当前草稿并写回输入框。
- **自动优化钩子**（可选，默认关闭）：以触发前缀开头的用户消息会在进入模型前被自动优化（见下文）。
- 后置校验：模型输出缺段时自动重试（可配次数），仍失败则返回原文 + 错误说明。
- 输出恒含四段；空输入报错；超长输入截断护栏；取消信号透传。
![项目截图](./1.png)
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
| `maxInputChars` | int ≥1 | `4000` | 原始指令截断上限（字符，硬兜底） |
| `maxInputTokens` | int ≥0 | `3000` | 原始指令截断上限（估算 token；优先用 harness tokenMeter，缺失回退启发式；`0` 关闭） |
| `timeoutMs` | int ≥1 | `60000` | 单次调用超时预算（毫秒） |
| `outputLanguage` | string | `'auto'` | 输出语言；`'auto'` 跟随指令语言，其他值（如 `'英文'`）固定输出语言 |
| `outputStyle` | `'sections'` \| `'plain'` | `'sections'` | 输出风格：四段标题（默认）或无标题连贯正文（更省 token） |
| `extraInstructions` | string | 无 | 追加到元提示词的部署自定义规则（如领域要求/风格） |
| `examples` | array | `[]` | few-shot 示例对 `[{input, output}]`，注入元提示词示范（仅 `sections` 模式注入） |
| `minSectionChars` | int ≥0 | `10` | 每段正文最少有效字符；`0` 关闭内容校验（仅查标题） |
| `maxTokenRetryFactor` | number 1–3 | `1.5` | 输出触顶 maxTokens 时按该倍数扩容重试；`1` 关闭 |
| `retryTemperatureStep` | number 0–2 | `0.3` | 每次重试的 temperature 增量（探索性重试）；`0` 关闭 |
| `skipIfAlreadyOptimized` | boolean | `false` | 输入已含四段标题时直接透传，不调用模型（仅 `sections` 模式生效） |
| `autoOptimize` | boolean | `false` | 是否启用自动优化钩子（前缀触发） |
| `autoOptimizePrefix` | string | `'/optimize '` | 自动优化的触发前缀（可改为 `/优化 ` 等） |
| `autoOptimizeAll` | boolean | `false` | 钩子优化**每条**用户文本消息（不止前缀触发） |
| `hookIncludeOriginal` | boolean | `false` | 钩子替换消息时保留原文（原文+优化结果双写） |
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
        # provider: 'deepseek-official'   # 可选：显式路由（成对）
        # model: 'deepseek-v4-flash'
```

非法配置（类型错误、越界、未知键、provider/model 只配其一）会在加载时响亮失败。

## 开发

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # 沙箱内安装
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest（mock llm，不依赖真实密钥）
pnpm run build        # tsc -p tsconfig.build.json → lib/
```

测试全部使用 mock 的 `llm` 流，绝不读取 `.credentials.yaml`。

## 设计要点

- 依赖面最小：`cordis` / `dsh-llm` / `dsh-tools` / `dsh-timeout` / `schemastery`。
- 模型路由来自 harness 默认模型（`agentDefaultModel.currentSelection()`），
  遵循「插件不管理 provider/model 配置」的约定；也可用配置显式覆盖。
- 元提示词含 `{{原始指令}}` 等占位符，运行时替换；含注入护栏（指令视为纯数据）、
  语言规则（`{{语言规则}}`）、禁代码围栏、精简要求与输出前自查；输出结构按
  `outputStyle` 在四段与无标题两套模板间切换。
- 所有注册（工具、systemPrompt 段落、自动优化钩子、命令）均为 effect 作用域，
  插件卸载自动清理。
- 命令命名：本插件注册 `/optimize` 与 `/auto-optimize`（短命令，遵循生态惯例）。
  若未来与其他插件冲突，改名需同步 `client.js` 调用、README 与钩子前缀默认值
  （`/optimize `），建议一次性原子变更。

## License

[MIT](LICENSE) — 自由使用、修改与分发（含商业用途），详见 `LICENSE` 文件。
