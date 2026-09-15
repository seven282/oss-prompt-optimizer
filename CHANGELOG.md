# Changelog

## [1.8.4] - 2026-09-16

**修复 1.8.3 在真机上客户端半边仍不加载：`cannot get property "remote.commands" without inject`。**

1.8.3 修好了 `ctx.locale`，却在同一段代码里留下了**同一类问题的另一种形态**：
`client/client.js` 第 252 行把 `remote.commands` 当成 `remote` 服务的一个属性来读。

`remote.commands` **不是** `remote` 的属性，而是一个**独立的服务名**：`dsh-api-gateway`
为每个 remote 命名空间单独注册 `remote.<namespace>`（`remoteServiceKey(ns) === 'remote.' + ns`，
每个命名空间各自挂一个 cordis `Service`）。而 `ctx.get('remote')` 拿到的值是 `Service`，
当 `remote.commands` 这个带点服务名**已被注册**时，服务代理会把「读 `.commands`」**改写成
「读 `ctx['remote.commands']`」**（cordis `createTraceable` 的 `tracker.associate` 分支）——
于是又回到 inject 门禁，照样抛 `cannot get property "remote.commands" without inject`。
`ctx.get('remote.commands')` 才是唯一安全的读法。

同一段代码还有**第二处缺陷**：1.8.1 是**点击时**才解析命令通道（惰性），1.8.3 改成
`apply()` 里解析一次并缓存。命名空间由「谁先加载谁挂载」决定，`apply()` 时可能还没装上 ——
即便名字写对了，按钮也会**永久失效**。故改为**每次调用时解析**。

### Fixed

- `client/client.js`：删除两处点读（`ctx.get('remote').commands` 与兜底分支
  `ctx.remote.commands`），改为在 `executeCommand()` 内部**按调用时**取
  `ctx.get('remote.commands')`，取不到则 reject 明确错误。注释写明机制与"为什么必须惰性"。

### Added

- **静态门禁扩展为规则 R2b**（`tests/client-inject-contract.test.ts`，8 → 13 例）：除原有
  `ctx.<name>` 外，另覆盖**点号路径**（`ctx.remote.commands`、`ctx['remote.commands']`）、
  **内联点读**（`ctx.get('remote').commands`、`ctx.get('remote')['commands']`）与
  **服务别名点读**（`var r = ctx.get('remote')` … `r.commands`）。命名空间根集合
  `NAMESPACE_ROOTS` 保持显式且窄（当前仅 `remote`），并新增"不得误报"的控制用例
  （`slots.inject()` / `locale.bind()` / `ctx.get('remote.commands')` 必须放行）——
  会把普通方法读也判红的门禁迟早会被关掉。
- **动态门禁改为忠实建模**（`tests/client-apply.test.ts`，6 → 10 例）：1.8.3 之所以蒙混过关，
  是因为假宿主用**普通对象** `{ commands: … }` 提供 `remote`，那样 `.commands` 永远不会抛。
  现在用 `new Service(ctx, name)` 提供 `remote` 与 `remote.commands`，与真机一致，
  并新增控制用例断言 `ctx.get('remote').commands` 在这个宿主上**必须抛**（证明模型有对抗性）。
  另增「命名空间尚未挂载时 apply() 仍成功」与「`ctx.get('remote.commands').execute()` 真能往返」
  两例。
- **`scripts/client-probe.mjs`** 同步以上全部规则与忠实宿主；并新增**推导步骤**：从本机已安装的
  dsh 重新推导命名空间根（`super(ctx, <builder>())` / `super(ctx, 'a.b')` 两种形态），
  与 `NAMESPACE_ROOTS` 不一致即 FAIL —— 上游新增第二个带点服务名时不会静默漏检。
  无 dsh 安装时输出 `[SKIP]` 而非 PASS（CI 即如此）。控制数 3 → 7。
- `preflight` P7 会在详情里回显 `[SKIP]` 行：看起来像通过的跳过项正是门禁腐烂的方式。

### Notes

- **两次事故是同一个根因的两种形态**：cordis 里「服务的属性读」可能被改写回服务名读。
  1.8.2 漏的是「未注入服务直读」，1.8.3 漏的是「带点服务名的父级属性读」。
  现在两者都有静态 + 动态 + 产物三道门禁，且都用"把 bug 放回去"验证过会咬：
  - 静态侧报精确行号：`client.js:252/253/254/255/258 reads the nested service "remote.commands" as a property of its parent`
  - 动态侧：`cannot get property "remote.commands" without inject` —— 与真机控制台字符串完全一致
- **边界已实测**：扫遍 dsh 全部 358 个客户端产物文件，带点服务名共 18 个**全部以 `remote.` 开头**；
  `super(ctx, '<字面量>')` 的 86 个名字**无一带点**；唯一用表达式拼带点名的就是
  `remoteServiceKey()` ⇒ 只有 `remote` 需要禁止点读，`slots` / `locale` / `sessions` /
  `settingsScope` 都是普通服务，点读安全。
- **不覆盖已发布的 1.8.3**：npm 不允许重发同一版本号，修复以 1.8.4 发布。
- 测试 629 → **639**（26 个文件）。

## [1.8.3] - 2026-09-16

**修复 1.8.2 在真机上客户端半边完全不加载：`cannot get property "locale" without inject`。**

1.8.2 把客户端 `inject` 收敛为 `['remote']`、把可选服务改为防御式读取，但
`client/client.js` 第 226 行**漏改**，仍是直接属性访问 `ctx.locale`。
cordis 的 context 是一个 Proxy，`ctx.<name>` 从 fiber 的 inject 集合解析，名字不在其中时
**直接抛错**（`cannot get property "<name>" without inject`），而 `apply()` 没有捕获它 ——
于是一个未注入的服务读，就让整个客户端半边注册失败：**✨ 按钮与设置页双双消失**，
控制台留下一行 `failed to apply loader entry fa1f2970 (oss-prompt-optimizer)`。
`ctx.get('<name>')` 则明确不要求 inject，返回服务或 `undefined`、永不抛错。

### Fixed

- `client/client.js` 第 226 行 `var locale = ctx.locale` → **`var locale = ctx.get('locale')`**。
  改后与 1.8.1 的 locale 行为逐字节等价（拿到的仍是同一个服务对象）：语言字典照常注册、
  设置页标题恢复本地化。注释同步改写，把"为什么不能直接读"写进代码旁边。

### Added

- **静态门禁 `tests/client-inject-contract.test.ts`（8 例）** —— 扫描 `client/client.js`，
  `ctx.<name>` 直读必须落在 `exports.inject` 内或是 cordis 内核成员；内核集合**实测得出**
  （在一个什么都不提供的真实 `Context` 上探测哪些名字可解析），不硬编码会过期的名单。
  含反向控制：合成一段 `ctx.locale` 必须被判违规、`ctx.get('locale')` 必须被放行、
  注释里的 `ctx.<name>` 不得被计入。
- **动态门禁 `tests/client-apply.test.ts`（6 例）** —— 用**真实 cordis Context** 只提供
  `slots` + `remote`（即真机最小宿主面），加载手写的 ModuleLoader bundle 并真正调用
  `apply()`，断言不抛错且两个 slot 都注册；另测 locale 存在时字典被注册、`slots` 缺失时
  静默降级。末例是反向控制：同一 context 上直读 `ctx.locale` 必须仍抛 `without inject`，
  否则上面的断言就是空转。
- **`scripts/client-probe.mjs`** —— 对**产物** `lib/client.js` 做同规则静态扫描 + 真实
  `apply()` 运行，输出 `[PASS]` 行；三个反向控制保证"永远 PASS"不可能发生。
- **`preflight` P7「client inject contract」** —— 跑上述探针。`--skip-tests` 时也生效，
  所以 CI 的那一步同样覆盖。
- **`docs/兼容性策略.md` 规则 R2** —— "客户端半边只能直读已 inject 的服务，可选服务一律走
  `ctx.get()`"，附兼容矩阵新增行与残余风险说明。

### Notes

- **1.8.2 的 changelog 有一处与事实不符**：那里写着"`ctx.locale` 判空（缺失时退回恒等 `t`）"，
  但判空从未生效 —— 访问本身就先抛错了。本次修复后才真正成立。
- **为什么 615 例全绿 + P1–P6 全 PASS 也没抓住**：测试与 preflight 只跑 `lib/index.js`
  （宿主半边）；`client/client.js` 是手写的非 TS 文件，**从未被任何自动化步骤执行过**。
  P2 只校验 `dsh.client.inject` 里的包 id 能解析，不校验代码是否只碰已注入的服务。
  这正是新增 P7 补的那一层。
- **门禁已用真实回退验证过会咬**（把第 226 行改回 `ctx.locale`）：
  - 静态侧：`client.js:239 reads ctx.locale, which is neither injected nor a cordis core member — use ctx.get('locale') or add it to \`inject\``
  - 动态侧：`cannot get property "locale" without inject` —— 与真机控制台字符串完全一致
- **不覆盖已发布的 1.8.2**：npm 不允许重发同一版本号，修复以 1.8.3 发布。
- 测试 615 → **629**（26 个文件）。

## [1.8.2] - 2026-09-15

**兼容性重构：本插件不再可能成为 `dsh web` 启动失败的起因。**

1.8.1 的 `deepFreeze` 事故根因是：产物里存在 **7 处对宿主域包的静态 `import`**，
而 Node ESM 下静态导入解析失败**无法被捕获** → 整个服务起不来。本次把这 7 处全部消解，
并把"不能再发生"变成脚本与测试自动断言。详见 `docs/兼容性策略.md`。

### Added

- **`src/compat/` 兼容层**：
  - `freeze.ts` —— 自建 `deepFreeze` / `isFrozen`（环形安全、跳过 `AbortSignal`、返回同引用），
    彻底断开对宿主该 helper 的依赖（即 1.8.1 事故点）
  - `timing.ts` —— 自建 `MAX_TIMER_DELAY_MS` / `deadline()` / `timeoutOf()` / `TimeoutReason`，
    `dsh-timeout` 依赖**整体归零**；`TimeoutReason` 按**结构**判别（非 `instanceof`），兼容多份类副本
  - `loader.ts` —— 同步 `createRequire` 懒加载 + 缓存，**永不抛错**（失败返回 `null`），
    使插件 `apply()` 保持同步，服务/工具注册时序与 1.8.1 完全一致
  - `capability.ts` —— 运行时**能力探测**（不判版本号）+ 降级说明 + 启动报告
  - `scope.ts` —— `ctx.inject` 防御式包装
- **按功能门禁**：`inject` 从 `['llm','tools','systemPrompt','commands']` 收敛为 `['llm']`，
  其余经 `ctx.inject()` 作用域化注册。任一服务改名只关掉对应功能，插件整体与宿主照常工作。
- **降级可见**：构造时必定打印一行 compat report —— `host compat ok (...)` 或
  `host compat DEGRADED (...)` + 逐项说明"哪个功能停了、还有什么还能用"。降级是静默减功能，
  必须让它可被发现。
- 新错误码 **`UNSUPPORTED_ENV`**：`BlockAssembler` 缺失时 `/optimize` 明确报错，
  不伪造消息、不静默失败。
- **`scripts/preflight.mjs`**（`pnpm preflight`）—— 六道门禁：P1 依赖面审计 /
  P2 `dsh.client.inject` 真实解析 / P3 产物字节一致性 / P4 typecheck→test→build /
  P5 兼容性报告 / P6 启动独立性。P2 从宿主**实际加载插件的目录**发起解析，
  走 Node 真实的查找顺序（profile 层 → 共享 anchor 层 → CLI 内嵌）并报告解析来源层级；
  列举固定目录的旧做法会与 Node 的 realpath 行为背离，能在宿主实际解析到别处时仍报 PASS。
  可用 `--dsh-home <path>` 指定目标 profile。
- **`scripts/startup-probe.mjs`** —— 启动独立性动态证明：在同进程内同时封死 ESM `resolve`
  与 CJS `Module._load` 两条路径上的所有 `@deepseek-ai/dsh*`，再导入 `lib/index.js`，
  断言入口仍能实例化、能力全部降级、降级被报告。内含**反向控制**（先证明封印真的生效），
  杜绝"封印失效 → 断言空转 → 永远 PASS"。
- **5 个新测试**（共 53 例）：`compat-freeze` / `compat-timing` / `compat-loader` /
  `compat-capability` / `policy-static-imports`（源码级规则 R1 的第二道锁）。
- **`docs/兼容性策略.md`** —— 三条不变量、规则 R1、兼容矩阵、降级行为表、升级验证步骤、残余风险。
- `.gitattributes`（`* text=auto eol=lf`），从机制上根治 CRLF 复发。

### Changed

- `package.json`：`peerDependencies` 只保留 `@deepseek-ai/cordis` + `react`；
  移除 8 个从未被 import 的 peer（`dsh-agent`、`dsh-api-remotes`、`dsh-client-connection`、
  `dsh-client-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-slots`、
  `dsh-system-prompt`、`dsh-typert-protocol`）——它们只造成"未满足 peer"告警。
  `dsh.client.inject` 收敛为实测存在的 3 项。
- 客户端 `inject` 收敛为 `['remote']`；`ctx.locale` 判空（缺失时退回恒等 `t`）；
  命令通道防御式取值；新增 composer 契约自适应候选链（`useInput` hook →
  `props.input.draft` → `props.hooks.input.draft`），**全部失败则不注册按钮**并打印
  自诊断日志（`Object.keys(props)`），让下次事故自曝而非靠人肉挖。
- `preflight` 调用 pnpm 时带 `--config.verify-deps-before-run=false`：裸 `pnpm run`
  会先重新校验依赖图，在 link farm 陈旧时**静默重装**依赖 —— 只读门禁不该改动 `node_modules`。
- 测试 562 → **615**（24 个文件）。

### Notes

- **不要用内联 `import { type X } from 'pkg'`**：`verbatimModuleSyntax` 下它会被保留成
  `import {} from 'pkg'`，**仍是运行时导入**。只能用顶层 `import type { X } from 'pkg'`。
  改造中曾误写此形式，由 P1 拦下，现有专门用例守护。
- peer 范围**不能**作为兼容性保障：semver 的 prerelease 排除规则使 `^0.1.0-rc.6`
  等范围在 `0.1.5-rc.2` 上全部返回 `false`（连 `*` 都不例外）。兼容性改由运行时能力探测保证。
- 残余风险：`@deepseek-ai/cordis`（框架本体）与 `schemastery`（自有 `dependencies`）仍为静态
  import，前者为固有成本，后者解析自我保证。

## [1.8.1] - 2026-08-26

### Added

- **状态/自迭代数据持久化**：运行统计、episode 日志（隐私裁剪，不含指令原文）、最近 20 条事件持久化到 `~/.dsh/oss-prompt-optimizer/state.json`（跨 profile 共享用户级学习；`$DSH_HOME` 与 `stateFile` 可覆盖）。`/optimize --status` 与自迭代（`minAdaptEpisodes=10` 阈值）跨重启生效——修复重启清零导致自迭代永远无法触发的问题。
- 新配置 `persistState`（默认 `true`；`false` 恢复 1.8.1 之前的内存行为）与 `stateFile`。
- `src/persistence.ts`：纯函数序列化/裁剪 + 原子写（tmp→rename）+ 防抖 500ms + 卸载同步 flush。

### Notes

- 结果缓存（`cacheEnabled`）与情境感知会话 registry 仍为内存（有意设计，重启即清空）。
- 打破 1.7.2「episode 日志重启即清空是有意设计」约定（用户决策）：自迭代学习改为跨重启累计。

## [1.8.0] - 2026-08-25

### Removed
- **localTemplate `'auto'` 移除**（用户决策）：本地模板默认改为 **`off`**（默认全走 LLM
  优化，行为更可预期）；合法值 `on | off | hybrid`——`on` 本地直出、`hybrid`
  未对齐 seed 优化（原 auto 的 seed 优化语义由 hybrid 未对齐分支承担）
- 设置页「本地模板」选项同步（off 默认 + on/hybrid）；`/optimize --set-local`
  与 tool schema 同步；README 说明更新

### Changed
- 目标对齐重试（GOAL_MISALIGNED + goalDiagnosis）随 auto 移除由 LLM 管线承担
  （seed 专属用例随 auto 删除：seed goal alignment 2 例 + purity seed 1 例）
- 测试 551 → 548（移除 3 个 auto seed 用例）

## [1.7.9] - 2026-08-25

### Added
- **运行时状态（P1）**：`/optimize --status` 输出完整状态块——当前生效参数
  （Profile/本地模板/温度 + 解析来源：用户覆盖/会话学习/基础配置/智能默认值）、
  运行统计（成功/失败/缓存/本地直出/耗时）、偏好模型摘要、最近 20 条优化事件
  （时间/✅❌/错误码/耗时）
- **客户端 ℹ️ 状态按钮**：✨ 旁新增状态入口，点击展开状态面板（toggle），
  经 `/optimize --status` 获取（机器 token `STATUS_OK` 前缀）；样式随主题 token
- 新增 `src/status.ts`（`formatStatus`/`StatusSnapshot`/`STATUS_EVENT_MAX`）、
  `tests/status.test.ts`（6 例）；服务端 `getStatus()` + 最近事件 FIFO 缓冲
- README 命令列表同步 `--status`

### Notes
- 状态面板只读展示；设置调整仍在设置面板（P0）/命令（会话级）
- 测试 545 → 551。

## [1.7.8] - 2026-08-25

### Added
- **设置面板（P0，dsh-settings 接入）**：插件将全部 45+ 配置项注册为
  `prompt-optimizer` settings 命名空间——Harness 设置面板（设置 → 插件设置）
  自动渲染表单，可查看默认值/当前值并调整，改动即时生效且持久化
- 解析层级：schema 默认值 → base（现有 `cordis.patch.yml` 配置快照）→
  用户文档（面板/命令写入）；每次 `optimize` 前自动采纳用户层
- 新增 `src/settings.ts`（`createSettingsBridge`，可选接入）：宿主无
  dsh-settings 时自动跳过（返回 null），配置仍走 entry-config，行为零变化；
  新测试 `tests/settings.test.ts`（5 例：无 settings/注册失败/注册+同步/更新）
- README 中英同步「设置面板」说明

### Notes
- 运行时命令（`/optimizer-language`、`--set-*`）仍为会话级内存覆盖（Layer 3），
  设置面板改动作用于配置层（Layer 2/基础层）——两者互不覆盖
- 测试 545 全绿（540 + 5）。

## [1.7.7] - 2026-08-25

### Changed
- **analysis 类「结论先行」回声去重（方案 A）**：任务类型提示删
  「Format 记得结论先行」半句（与前半句重复）、角色参考删「结论先行」
  前缀（保留「结论以数据支撑」）、local.ts analysis 模板同步——实测
  「华为手机抖音小店经营全案」类 analysis 指令的 system 中「结论先行」
  由 2-3 处（系统回声叠加）降至 1 处（场景参考自然使用），用户原指令的
  「结论先行」不再被系统注入重复放大；Format 输出规格与内置示例保留
- 测试 540 全绿。

## [1.7.6] - 2026-08-25

### Fixed
- **✨ 取消误报失败（第二种结算形态）**：dsh 对取消以 `{ ok:false,
  error:{message:'This operation was aborted'} }` **resolve**（RPC 信封失败）——
  1.7.5 只覆盖了 `result.kind:'error'` resolve，`ok:false` 信封落入
  unexpected 分支误报「优化失败」；现 `.then` 最前统一处理 `ok:false`：
  aborted 时提示「已取消优化」，否则展示宿主 error.message
- 取消三种结算形态现已全部覆盖：`ok:false` 信封（本次）+ `kind:'error'`
  resolve（1.7.5）+ reject（原 catch）
- 测试 540 全绿（build 同步 lib/client.js）。

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
