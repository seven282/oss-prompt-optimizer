# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。格式约定：

- 版本倒序排列，顶部为最新；每个版本**只使用** `Added` / `Changed` / `Deprecated` / `Removed` /
  `Fixed` / `Security` 六类 `###` 标题，其余说明作子条目（不要新增 `Notes` / `Tooling` / `Tests` 这类标题）。
- 版本号遵循十进制进位：末尾 +1，满 10 向前进位（`1.3.9` + 1 = `1.4.0`），**不会出现尾位 ≥ 10**。
- 已发布的历史条目**不再改写**；本条约定适用于新条目。

## [1.13.1] - 2026-10-10

**修复一：更新/重装后客户端设置页与导航标签不跟随语言（冻结在英文）。**

用户报告（1.8.6，桌面版 DSH，界面语言中文）：每次更新或重装插件后，设置导航按钮显示
`Prompt Optimizer`、页内文案落 `View status` / `Reset all to defaults` / `Core options only…`；
重启不恢复，再次更新必现；而**手工改一次 `lib/client.js` 触发重新求值就立刻恢复中文**。

**修复二：设置面板「点保存提示成功、实际不落库」（issue #3）。**

用户在最新宿主上报告设置页改字段没反应。查明是**一条断掉的写入通路**，两个原因叠加：

1. 客户端读的是 `ctx.settingsScope`（0.1.x 的服务名），而 0.2.0 把它换成了
   `ctx.configForms` —— **两代服务名一刀两断、无任何版本同时具备**，所以表单**从来没找到过**；
   服务端 `SettingsForms.register` 在 0.2.0 也已被移除，旧桥连值都解析不出来（恒返回 `null`）。
2. 找到了表单也仍会假成功：`ConfigForm.set()` 解析为 **boolean**（`true` = 宿主已接受），
   旧代码只挂了 `.then()` 就打「已保存」，**从不读那个值** —— 被拒绝的写入与成功的写入看起来
   完全一样。

按用户口径**只适配最新宿主**（不保留旧服务名回退）。修复后：字段改动由 loader 的
`loader/volatile-update` **就地刷新、不重挂载**；写入被拒绝时提示「宿主拒绝了这次修改」；
拿不到表单 / 不可写时面板**降级为只读并写明原因**，不再渲染一堆看起来能用的输入框。

### Fixed（客户端 i18n）

- **客户端半边不再在 `apply()` 时捕获翻译器。** 原实现读一次 `ctx.get('locale')` 并
  `locale.bind(NS)` 缓存下来。调查结论是**捕获点**而非"翻译器被冻结"：`bind()` 返回的是
  **活闭包**（`(key, params) => this.translate(ns, key, params)`，`translate` 每次重读
  `snapshot.active`），所以语言切换本是跟得上的；捕获真正盖不住的是**当时还不存在的那个
  face** —— locale 插件的 `apply()` 是 `async`，`await` 完原生 bootstrap 才
  `ctx.provide('locale', …)`，本插件的 `apply()` 完全可能先跑完。此后整个会话里每个标签都
  解析到**原始 key**。现改为**每次调用现取**（与同文件 `remote.commands` 同一条规矩），
  并让字典注册也惰性化（首次取用时补注册）。
- **改用框架合成的 `t` seat。** 两处 `slots.register` 现在按契约声明 `locale: NS`
  （声明后渲染器才 `kit['t'] = localeSeat(face, entry.locale)`），组件优先用 `props.t`；
  该 seat 的**身份随 locale revision 变化**，正是 `React.memo` 失效通道的官方路径。
  原始查找保留为**回退**（宿主没装 locale face 时 seat 不存在）。
- **`locale: NS` 改为按需声明**：渲染器对"声明了命名空间却没人提供 face"的条目**直接抛错**，
  无条件声明会把"这台宿主没有 i18n"升级成"设置页整体挂掉"。无 face 宿主不再声明、只走回退。
- **页内文本补上重渲染通道**：回退路径下没有任何东西会让组件失效，页面会停在首次绘制的语言。
  组件订阅 locale 变化并自增一个计数器，两条路径都正确。
- **✨ 按钮的硬编码中文进字典**：`title` / `aria-label` 原先写死中文，英文界面下仍是中文。
  与之同批把按钮的全部文案（含 aria-live 播报、错误前缀、状态提示）纳入 zh/en 双表，
  并给 `announce.optimized.cost` 用上 `{tokens}` 模板参数。
- **重复注册不再中断 `apply()`**：更新会在旧 fiber 的 disposer 跑完之前重跑本文件，而运行时
  会拒绝重复的"命名空间+语言"对（`already has locale`）；此前该抛出会冒泡出去，把 ✨ 按钮与
  设置页一起带走（与 1.8.2 / 1.8.3 同一类故障）。现捕获并降级为一条 `console.warn`
  —— 运行时的 disposer 有身份保护（只删自己登记的那份），留着旧字典是安全的。

### Added

- **一次性 locale 自检**（激活约 2.5 s 后跑一次，健康时完全静默）：当本插件文案没有解析到
  当前语言时，打印 `active` / `revision` / 实际解析值 / 期望值，并指明**责任层**——
  「字典没进运行时（我们的）」还是「解析到了另一种语言（宿主侧）」。这样下一次同类报告自带定位。
  可一处删除（函数 + 一处调用点）。

### Fixed（设置面板 · issue #3）

- **写入通路换到 0.2.0 的服务名**：客户端改读 `ctx.get('configForms')`，并用
  `configForms.get('<host entry id>')` 取本插件 entry 的表单（entry id 与 settings 命名空间
  是同一个字符串 `prompt-optimizer`，`ConfigFormController` 就是按它构造的）。
  **不做旧名回退** —— 两个名字从不在同一版本共存，回退只会在两边都拿到空。
- **不再吞掉宿主的答复**：`set()` / `unset()` 的 boolean 结果现在真的被读。
  `false` ⇒ 提示「宿主拒绝了这次修改：<字段>」；只有 `true` 才显示「已保存」。
  这也顺带修掉 `clear` → **`unset`** 的改名（0.1.x 的 `clear` 在 0.2.0 上不存在）。
- **8 个核心字段标 `.volatile()`，并改为 per-use 读取**（`src/config.ts` 的
  `LIVE_CONFIG_KEYS`）。这是**设置面能否看见字段的唯一开关**：dsh-settings 的
  `volatileForm()` 在 schema 上找不到 volatile 节点就返回 `undefined`，
  `describe()` 随之返回空数组 ⇒ **该 entry 整条从设置面消失**，`configForms.get(ns)`
  永远停在 `loading`/`unavailable`。
- **`this.config` / `this.rawConfig` 一分为二**（`src/live-config.ts`，新增，无宿主依赖）：
  loader 传进来的对象里 volatile 字段是 **`{ get(), [Symbol.for('cosmokit.volatile.write')] }`
  引用**而不是普通值，构造期必须解成快照（`plainConfig`）；同一个对象又必须原样保留
  （`adoptLiveConfig`，**保持对象身份**），并订阅 `loader/volatile-update`
  （`followVolatileUpdates`）在 loader 就地提交后重读引用 —— 全程**不重挂载插件**。
- **缓存容量不再由 live 字段决定**：缓存原先按 `cacheEnabled ? cacheMaxEntries : 0` 建，
  于是「在面板上打开缓存」永远不会生效。现固定用 `cacheMaxEntries`，`cacheEnabled`
  在**每次读缓存时**判断。
- **面板会说清自己的状态**：新增 `status` / `writable` 维度。取不到表单、`status !== 'ready'`、
  或 `writable === false` ⇒ 所有输入与「恢复全部默认」置灰，并显示对应原因
  （宿主未提供可写配置服务 / 当前连接只能读 / 正在读取）。**旧页面在"没找到表单"时照样
  渲染可编辑输入框**，这正是 issue #3 能长期潜伏的原因。
- **`src/settings.ts` 的老桥删除**：不再 `settings.register(...)`，只剩一条
  `settings.configure({ auto: false }, ctx.fiber)` —— 告诉 dsh-settings 不要为同一命名空间
  再自动生成第二个编辑器（官方约定）。服务不存在时**静默保持 inactive、不 warn**
  （无设置服务的部署是正常部署）。
- **类型注解与 `.volatile()` 的输出类型对不上**（`src/config.ts`）：`export const Config: z<Config>`
  要求 schema 的输出是普通值 `Config`，可八个 `volatile()` 字段让 schemastery **如实**推导出
  `Volatile<T>` 引用 ⇒ `TS2322`。改为在对象字面量末尾 `as unknown as z<Config>`：运行时形状不变，
  公开类型仍保持普通值 `Config`（`@deepseek-ai/cosmokit` 不进公开面），注释写明这条断言描述的是
  `adoptLiveConfig()` 所在的那条边界。⚠️ 这是**纯类型改动** —— `lib/config.js` 的可执行代码
  逐字节不变（`as unknown as` 被擦除），只有跟随源码的 JSDoc 变了。

### Changed

- **依赖 `@deepseek-ai/schemastery` `^3.18.1` → `^3.18.4`**：`.volatile()` 是 3.18.4 才引入的
  （3.18.1 里 `undefined`）。
- **`vitest` `^3.2.0` → `^4.1.11`（devDependency）**：CI 的 `pnpm audit --audit-level=high`
  被**上游新公告**判死，与仓库代码无关。四条打在 `vitest` 的依赖子树上：
  - **critical** `tinypool` `GHSA-5gmw-xhrv-c9v3`（已修 `>=2.1.1`）与 `GHSA-85c8-ppgw-ccpr`
    （已修 `>=2.1.2`），路径 `.>vitest>tinypool`；
  - **high** `source-map-js` `GHSA-68fv-2mgg-jv7q`（已修 `>=1.2.2`）；
  - **moderate** `vitest` 自身 `GHSA-82fw-gwwq-j7x9`（已修 `>=4.1.11`）。
  `vitest@3.2.7` 声明的是 `tinypool: ^1.1.1`，而 1.x 线**停在 1.1.1、没有任何已修版本** ⇒
  3.x 上无论打补丁还是 override 都过不了门禁。`vitest@4.1.11` 的依赖表已移除 `tinypool` 与
  `vite-node`，四个条目一起消失；`source-map-js` 由重新解析从 `1.2.1` 抬到 `1.2.2`
  （`postcss@8.5.26` 声明的 `^1.2.1` 本就允许，锁文件只是停在 1.2.2 发布之前）。
  依赖树 **121 → 71 个包**；`vite` 保持 `7.3.6`（vitest 4 的 `^6 || ^7 || ^8` 接受该锁定值，
  不会被抬到 8.x）。迁移面为零：`vitest.config.ts` 只有 `include` + `environment: 'node'`，
  全仓只用到 `vi.fn` / `vi.spyOn`。
- **兼容性声明收窄到 `^0.2.0-rc.2`**：`engines.dsh` / `dsh.compatibility.dsh` 去掉
  `^0.1.6-alpha.2`，`dshReleases` 只留 `0.2.0-rc.2: compatible`。理由有二：① 0.2.0-rc.2 是
  设置面契约（`ctx.configForms` + volatile 表单）落地的第一版，本版起设置页是核心功能；
  ② CLI/web 与桌面运行时（`@deepseek-ai/dsh-desktop-runtime`）**现在同 tuple**，
  `scripts/preflight.mjs` P9 读的就是装好的 `app.asar`，`0.1.6-alpha.2` 已无任何发行面承接。

### Tests

- 用例数 821 → **854**（32 个文件）。1.13.1 共新增 33 条：locale 批次 12 条 + 设置面板批次 21 条。
- **locale 批次 12 条**，重点是**测试假宿主不再说谎**：旧 stub 是
  `bind: (ns) => (key) => \`${ns}:${key}\`` —— 一个**冻结捕获**，与真实的 `LocaleFace`（活闭包）
  恰好相反，也已经**恰好就是那个 bug 的形状**，所以任何回归都测不出来。新模型按已装包源码重建
  `LocaleRuntime`：`catalog` 恒含 zh(→en)/en、`register` 对重复对抛错、disposer 按**对象身份**
  删除、`bind` 每命名空间记忆一个**按调用时求值**的闭包、`translate` 走 fallback 链再走 `common`
  再回 key、支持 `{name}` 参数。三条反向控制：① 捕获式翻译器在**同一个 face、同一份字典**下永远
  返回 key，而按调用现取的路径返回中文；② 假 face 确实拒绝重复注册（否则"重复注册不中断"是空过）；
  ③ 自检在健康会话**不发声**、在字典缺失时点名到位。组件断言不再依赖源码文本（最小 `react` 替身
  + 遍历返回树取文本），因为本仓库没有 `react-dom`、也没有 DOM 环境。
- **设置面板批次 21 条**：
  - **客户端 9 条**（`tests/client-apply.test.ts`），宿主模型按 `ConfigFormController` /
    `ConfigFormSnapshot` 重建：**故意不提供 `clear()`**（0.2.0 改名成 `unset`，旧调用必须抛错
    而不是静默无事发生），`set()` 的结果**由 `accepted` 决定**而不是恒 `true`。
    覆盖：读宿主值而非 schema 默认值、boolean 以 boolean 而非字符串下发、
    **被拒绝时提示拒绝而不是「已保存」**、`unset` 逐字段恢复默认、订阅 snapshot 让宿主侧改动
    到达页面、entry 未知时降级为只读、`writable: false` 时说明只读、宿主没有 `configForms` 时
    仍然注册成功。另有一条**反向控制**：同一份假宿主下 `set()` 必须真的能返回 `true` 与 `false`，
    否则「拒绝」那条断言是空过。
  - **服务端 11 条**：`tests/live-config.test.ts`（新文件，8 条，用
    `Symbol.for('cosmokit.volatile.write')` 自造引用，含「报告的是当前值而非构造时的值」的反向
    控制）、`tests/settings.test.ts` 重写后 5 → 6 条、`tests/config.test.ts` 4 → 6 条
    （`LIVE_CONFIG_KEYS` 与 volatile 集合**双向相等** + 非 volatile 键数量反向控制）。
  - 剩下 1 条是下面的静态方向性断言（`client-inject-contract`）。
- ⚠️ **`ctx.effect(cb)` 的语义先测错了**：cordis 4.0.1 的 `fiber.effect()` 是
  **立刻调用 `cb`、把它的返回值登记为清理函数**（`_execute()` → `runner.execute.call(this)`，
  随后 `if (typeof effect === 'function') runner.collect(effect)`），不是"teardown 时才调用 `cb`"。
  假 `effect` 按错的语义写，「把策略绑到插件生命周期」这条就会**空过**；现已按源码对齐。
- **静态契约同步**：`tests/client-inject-contract.test.ts` 的探测名单与"可选服务不得进 `inject`"
  清单换成 `configForms`，并新增一条**方向性断言**（源码必须读 `ctx.get('configForms')`、
  且代码里不得再出现 `settingsScope`）—— 违规列表抓不到"**少读**"，而这正是 issue #3 的形状。
  `scripts/client-probe.mjs`（P7）对**构建产物**做同样的检查。
- `tests/manifest-contract.test.ts` 的"两条发行线"断言改为按 `SERVED_DSH_RELEASES` 常量核对，
  并加了"同一谓词必须能判否"的反向控制（当前两发行面同 tuple，所以列表只有一项）。

### Tooling（设置面真浏览器验收 · 门禁 P11）

- 新增 `scripts/e4-settings-browser.mjs`（`pnpm e4`）——**把设置面走完最后一层**：临时 `DSH_HOME`
  + 出厂 `web` 模板 → 装本地产物 → `dsh web` 起在随机端口 → **真 Chromium** 完成 token→cookie
  换证 → 断言客户端 bundle 真被取回（200，不是白屏）→ 打开设置面断言 `LIVE_CONFIG_KEYS`
  八个字段全部渲染 → 改一个字段并断言它**写进 `profiles/e2e/cordis.patch.yml`**、UI 回读一致。
  **13/13 通过**，含 2 条反向控制：假 token 不得进入应用；待写值不得已经在盘上。
- **为什么必须加**：issue #3 的每一个假宿主都能过 —— 假宿主不做换证、不取服务端下发的 bundle、
  也不挂设置插槽，而这正是那条链的三道关。真浏览器在真宿主源上同时成立，才叫验证过。
- 用 `playwright-core` 驱动**本机已装的 Chrome/Edge**（`--channel chrome|msedge`），**不下载浏览器**；
  它**不进 `dependencies`/`devDependencies`**（`--pw-root` 或 `PO_PLAYWRIGHT_CORE` 指向任意一份
  安装即可），因此不改发布面、不碰锁文件。
- **接进门禁但默认不跑**：`pnpm preflight --browser-e2e` 追加 **P11**（读子进程的 `--json` 证据判定）。
  默认关闭是因为它需要真浏览器和一次真实宿主启动，会让 `pnpm preflight` 与 CI 失去离线可重复性
  —— 与 `pnpm e3` 同一条理由。Windows 上同样**须在助手沙箱外**运行（`dsh web` 会探测 `reg.exe`）。
- 两个环境事实写进了脚本注释，都是踩出来的：新 profile 首启有**引导弹窗链**（预览版说明 →
  添加 API Key），**弹窗在时页面上任何点击都会超时**（看起来完全像选择器写错）；
  设置面**没有「保存」按钮**（`configForms` 改字段即落盘），所以「点保存」的诚实等价物是
  「改一个值 + 看磁盘 patch 变 + 读回一致」。

### Known gaps

- 设置页的**核心字段表（`PO_FIELDS`）仍是中文单语**：字段名、选项文案、"默认/当前" 模板都还是
  字面量。本次刻意不动（改动面大且与报告无关，历史上也一直是中文），英文界面下该区域仍为中文。
- **`0.1.6-alpha.2` 对照宿主上的设置页是只读的**（该宿主没有 `configForms`）。插件本身仍能加载、
  ✨ 按钮与命令照常工作，但本版**不再声明**对该版本的支持，也不再为它取证。

## [1.13.0] - 2026-10-09

**P1+P2：把「用了哪个模型」与一份 OpenTelemetry GenAI 形状的观测信号补进可见面。**

对标清单（大厂提示词优化机制调研给出的 8 项基准）里，第 6 项「声明目标模型」与第 7 项
「至少发一个 OTel-GenAI 形状信号」此前只做到了**一半**：路由早在 1.10.0 就解析并记进评测，
但**优化路径的事件与 `/optimize --stats` 里从不出现模型**；账本里的
`input / output / cacheRead / cacheWrite / reasoning` 与 `gen_ai.usage.*` **一一对应**，
却没有规范命名、事件也不带 usage。本次把这两件事补完——**不碰管线、不碰缓存键、不改
meta-prompt**，因此**不影响**任何评测分数与既有缓存命中率。

### Added

- **`route`：本次 run 实际调用的模型**（benchmark 清单第 6 项）。生命周期事件的成功/失败载荷
  新增 `route: { provider, model, reasoningEffort? }`，`/optimize --stats` 的机器可读 token
  尾部追加 `MODEL:` / `PROVIDER:` / `EFFORT:`，`/optimize --status` 增一行「目标模型」。
  路由在 `generateOnce`（唯一发出模型调用的地方）捕获，因此择优、精修、续传各路径报的都是
  **真正用到的那个模型**，而不是配置里写的那个。
- **`genAi`：同一件事的 OTel GenAI 形状**（第 7 项）。键为规范里的**属性名字面量**
  （`gen_ai.operation.name` / `gen_ai.provider.name` / `gen_ai.request.model` /
  `gen_ai.conversation.id` / 五个 `gen_ai.usage.*`），消费方可直接
  `span.setAttributes(payload.genAi)`，无需翻译表。

### Notes（两条诚实规则，由测试与反向控制守着）

- **无模型调用则整块不出现**：缓存命中、本地零 token 直出、跳过透传后 `route`/`genAi` **都不发**，
  且 `stats.lastRunRoute` 归 `null` —— 一个全零的 `genAi` 会描述一次从未发生的推理。
- **没测到的数字不报**：适配器未上报 usage 时，五个 `gen_ai.usage.*` 计数**一起缺席**，
  而不是报 0（与 `RunUsage.calls` 区分「上报 0」和「没上报」同一条规矩）。
- `gen_ai.response.model` **不发**：宿主只报告被请求的模型，不报告另一个"实际服务"的模型。
- **公开类型不引入宿主类型**：`ModelRoute.reasoningEffort` 是字符串而非宿主的
  `ReasoningEffortId`——`lib/types/*.d.ts` 里因此**不出现** `@deepseek-ai/dsh-llm`，
  消费方不必为了读一个字段去解析宿主包。
- 持久化的 `stats.lastRunRoute` 加载时经 `normalizeRoute` 修复（非对象、缺 provider、缺 model → `null`）：
  载入是 best-effort，宁可丢一个字段也不抛错。

### Docs

- `docs/configuration.md` 新增「常见问题（FAQ）」一节：把 `dsh web` 右侧栏「本轮改动」面板
  的 `/api/changes.summary` 404 记为**已知设计噪声**——摘要只活在跑过那一轮的那个进程内存里
  （宿主源码注释原文即 *"404 once the Host no longer serves it"*），插件既不调用该路由、
  也不产生 `workspace/changes` 事件，功能与自迭代学习都不受影响。
- README 中英双份：事件表补 `route`/`genAi` 的形状与两条诚实规则；功能清单新增
  「模型与 OTel 信号（1.13.0）」条目。

## [1.12.1] - 2026-09-23

**修复：`/optimize-eval run --all` 在默认配置下是空操作。**

配置注释与 `docs/configuration.md` 都写「`evalMaxCases` 是**未加 `--all` 时**的上限」，
但用例池无条件套用这个 cap。默认 `evalMaxCases: 8`、金标集 14 例，两者一交恰好就是那
8 条 core——于是 `--all` 与不加 `--all` **结果完全相同**，6 条非 core 用例（模糊指令、
已优化指令、英文脚本、PPT、排查、长多约束）在任何默认配置下**永远不可能被度量**。
文档承诺了一个不存在的行为，而"我要量全部"这个请求被静默打折。

### Fixed

- **`evalCasePool` 让 `--all` 真正表示"全部用例"**（`src/optimizer.ts`）：`all: true`
  时不再套用 `evalMaxCases` cap。cap 仍然约束**默认**运行的成本（这是它的本意），只是
  不再覆盖一个显式的全量请求；调用方显式传入的 `maxCases` 依旧优先于两者（`selectCases`
  的纯函数语义未改，`--all` 的语义在服务层收敛——那才是它唯一被赋予意义的地方）。
- `Config.evalMaxCases` 与 `docs/configuration.md` 的说明同步为该语义，并注明
  **1.12.1 起 `--all` 不受上限约束**（此前该承诺未实现）。
- 测试：新增「`--all` 跑满 14 例 / 默认仍被 cap 到 3 / 显式 `maxCases` 仍胜过 `--all`」
  三条断言（`tests/optimizer.test.ts`）。原有那条"想要全量必须同时设
  `evalMaxCases: 0`"的测试仍然通过——它测的是 `selectCases` 纯函数，而纯函数语义未变。

## [1.12.0] - 2026-09-23

**P1：把度量用起来——best-of-N 择优（判官给候选排序）＋ 接宿主真实反馈信号。**

1.11.0 让插件能给自己打分了，但分数只用来**看**：同一条指令跑两次，一次拿到好提示词、
一次拿到平庸的，管线照样把先出来的那个返回。采样是随机的，插件此前**没有任何机制
发现这件事**。本版把判官分数变成决策依据，并接通了此前一直在猜的那类信号——用户对
回答的点赞/点踩。

### Added

- **`src/select.ts`——候选排序层（纯函数，判官经回调注入）**：`selectCandidates > 1`
  时同一条指令生成多个候选并保留最好的一个。三条不可动摇的规则：
  ① **门控决定资格，分数只决定排序**——结构校验失败或注入金丝雀泄漏的候选**永远不能
  胜出**，无论判官多喜欢它（与评测同一份 `checkDeterministic`，不是复刻）；
  ② **必须赢过基线 `minGain`（默认 0.05）才换人**——平局/微弱领先一律保留候选 0，
  择优不可能让常见情况变差；③ 判官漏评维度 → 该候选**不计分**（不是部分均值），
  门控失败 → 无分（不是低分）。候选温度阶梯 `base + i·0.35`（上限 2），只有**胜者**
  进缓存（否则下一次候选数更少的运行会命中一个"没被选中过"的缓存）。
- **`src/feedback.ts`——宿主反馈计数层**：读 `messageFeedback.list`（宿主自带的服务，
  按会话读回人工点赞/点踩），折算成**温度偏置**：负面占比 ≥50% → +0.1（多探索），
  ≤20% → −0.1（收敛），样本 <3 不生效——反馈是对**过去回答**的判断，不是对某次优化
  的判决，所以只做偏置并**如实标注原因**。**隐私边界**：只记 rating / category 标签 /
  是否含备注，**备注原文永不复制**到内存、状态文件、事件或日志。
- **配置**：`selectCandidates`（默认 1＝关闭，历史行为不变）/ `selectMinGain` /
  `selectJudge` / `feedbackAdapt` / `feedbackScanLimit`。
- **命令**：`/optimize --select`（上次择优的候选数与胜者）、`/optimize --feedback`
  （计数与偏置，含"宿主未提供 messageFeedback"的明确说明）；`/optimize --stats` 追加
  `SEL*` / `FEEDBACK*` 字段（**追加在尾部**，客户端既有解析不受影响）；
  `/optimize --status` 增加择优与反馈两行（无数据时不渲染，不伪造 0）。
- **`OptimizeResult.selection`**：本次择优的候选分数、胜者下标与**原因**
  （`gain` 真赢 / `baseline` 保基线 / `only-eligible` 仅存活者），随事件一起发出，
  供订阅方渲染"为什么是它"。

### Fixed

- **`hasMetaContent` 的纯度门会随调用次数交替给出相反答案**：方法论词正则带了 `g`
  标志，`RegExp.test` 会推进 `lastIndex`，同一段文本第二次检测就变成"干净"。这条门在
  重试循环里被调用，因此偶发地放过元内容——净化门由此变成抽奖。已去掉 `g` 并补反向
  控制测试（连续 5 次必须同答案）。
- **`parseJudgeReport().rejected` 把两种东西混成一个数**：它同时表示"自创维度 id"和
  "被丢弃的段落数"。现在 `rejected` 是 id 列表、`rejectedCount` 是数量。
- **评测的判官开关会顺带关掉择优**：`evalJudge: false`（离线评测）此前也让择优退化成
  全候选等分。现在 `judgeRoute === undefined` 是"跑不跑判官"的唯一开关，评测看
  `evalJudge`、择优看 `selectJudge`，两者互不牵连。

### Changed

- **`evalOneCase` 与择优共用 `scoreCandidate`**：门控与判分的口径只存在一处，
  不可能出现"择优接受的"和"评测度量的"不一致。
- **preflight P10 扩展到择优与反馈的反向控制**（73 → **88 项**，仍跑在构建产物
  `lib/` 上）：门控失败者无论多高分都不能胜出、平局保基线、微弱领先不换人、
  未判分不按 0 计；反馈备注**原文**在归一化项/台账/渲染文本里都必须**不出现**，
  重复读取是替换而非累加。
- `/optimize --stats` 的 token 变长（尾部追加），`lib/` 已重建。

## [1.11.0] - 2026-09-22

**度量闭环第二步：`/optimize-eval`——让插件能度量自己，而不是只断言形态。**

在此之前，插件的"质量"判断全是结构门：四段齐、每段够厚、目标锚点保留。这些门
可以**全部通过**，而输出依然是空泛、注水或悄悄虚构了事实的提示词；每次改模板、
改启发式、换档位，能不能让输出更好，只能靠争论。

### Added

- **`src/judge.ts`——加权评分判官（纯函数层）**：内置 5 个必评维度
  （`specificity` .25 / `output-contract` .25 / `context` .2 / `fidelity` .2 /
  `economy` .1）+ 按需启用的 `safety` .15；判分 1–5、加权归一化到 0–1。
  判官提示词要求**先写理由再给分**，解析器**严格执行**这一顺序：理由缺失/为空、
  分数写在理由之前、分数非整数（`parseInt` 会把 `3.5` 悄悄截成 3——已改为要求整数
  字面量）、越界、自创维度、重复维度一律**作废**；缺项记为 missing，绝不用默认分
  填充（不完整即不采信该例分数）。rubric 覆盖 id 写错在**加载时**抛错。
- **`src/eval.ts`——评测数据集与指标层（纯函数）**：内置金标集 **14 例**（8 例 core：
  周报/脚本/修 bug/数据分析/部署/邮件/评估 + 注入探针，另含模糊指令、已优化指令、
  英文、PPT、排查、长多约束）；确定性层复用**与优化管线同一份** `validateOutput`
  （从 `optimizer.ts` 上移到 `validate.ts`，避免"我们接受的"和"我们度量的"漂移）
  + 逐例 `mustInclude` / `mustNotInclude`（注入金丝雀）；确定性门失败直接记 **0 分**
  ——坏掉的提示词不是"0.8 分质量"，不能被判官的高分平均掉。基线对比中
  **回归优先于未达阈值**（先看方向）。会话历史挖掘（`sessionQuery` 全文检索）
  为 best-effort：服务缺失/报错/形状不符一律降级为空，绝不因此让评测失败。
- **服务层 `runEval()`**：跑管线 → 打分 → 与基线比较 → 持久化；记录本轮真实用量
  （1.10.0 台账的增量）；缓存**读路径**被绕过（`enrich: true`），否则第二次评测
  度量的是自己的缓存。新增 `getEvalRuns` / `getEvalBaseline` / `setEvalBaseline` /
  `getEvalSummary` / `listEvalCases` / `getEvalRubric`。
- **命令 `/optimize-eval`**：`run [标签] [--all] [--mine]` / `baseline [标签]` /
  `show` / `list` / `rubric` / `cases`；末行输出机器可读 token
  （`EVAL|SCORE:…|BASE:…|DELTA:…|VERDICT:…|CASES:…|GATE:…|LEAK:…`），**判回归时返回
  错误结果**，便于脚本/CI 分支。
- **配置**：`evalThreshold` / `evalRegressionTolerance` / `evalMaxCases` / `evalJudge` /
  `evalJudgeProvider` / `evalJudgeModel` / `evalMineSessions` / `evalMineLimit` /
  `evalSet` / `evalRubric`；`/optimize --status` 增加评测行（最近成绩、基线、判定、
  历史次数）。
- **preflight 新增 P10（`pnpm eval:grader`）**：在**构建产物 `lib/`** 上校验
  ①金标集完整性（id 唯一、覆盖声明的任务类型、注入探针必须有金丝雀、core 子集
  小于全集、用例引用的维度必须存在）②**评分器区分度**（每个内置参考对必须按
  正确顺序判：good 通过、bad 不通过）③判官解析反向控制（无理由、先分后由、
  越界、非整数、自创维度、不完整）④判定数学反向控制（容差内不算回归、首轮不判
  pass、回归优先）⑤挖掘过滤反向控制。P4 只跑 `src/`，P10 同时是"金标集与判官
  真的进了发布包"的打包检查。
- **测试 +82（29 文件 / 751 用例）**：`tests/judge.test.ts`（26）、
  `tests/eval.test.ts`（42）、`tests/optimizer.test.ts` 新增 14 条 `runEval`
  集成用例（含隐私裁剪、注入泄漏记 0、判官不完整、基线回归、历史上限、
  配置用例覆盖、挖掘不入库、状态展示、abort）。

### Changed

- `validateOutput` 从 `optimizer.ts` 私有函数上移到 `validate.ts` 并导出——评测
  与管线共用同一份输出契约。
- `generateOnce` 新增可选 `userText` 参数（判官需要自己的 user turn；路由、超时、
  用量捕获、finish 错误翻译全部复用，判官与优化器不会在"怎么跟宿主说话"上分叉）。
- `OptimizeStats` 之外的持久化结构新增 `evalRuns` / `evalBaseline`：**不升
  `PERSIST_VERSION`**（附加字段 + `parseState` 独立校验，旧文件按空处理），
  否则为了存评测历史要丢掉用户的 episode 与统计。

## [1.10.0] - 2026-09-22

**度量闭环第一步：把「启发式估算」换成 provider 上报的真实用量台账。**

此前插件的所有 token 数字（`lastInputTokens` / `lastOutputTokens`）都是本地启发式
估算，与实测值混在一起无法区分；而宿主 `dsh-llm` 的 `StreamChunk` 一直带着
`{ type: 'usage', usage: TokenUsage }`（含 `cacheReadTokens` / `cacheWriteTokens`），
插件从未读取过。

### Added

- **真实用量台账**（`OptimizeStats` 新增 6 个累计字段 + `lastRunUsage`）：
  `usageCalls` / `inputTokens` / `outputTokens` / `cacheReadTokens` /
  `cacheWriteTokens` / `reasoningTokens`，并新增导出类型 `RunUsage`。
  `generateOnce` 在流中捕获 `usage` 块、在 `finally` 中记账——**超时/取消/中断的
  调用同样计入**（那正是最该看到的成本）。
- **`/optimize --stats` 机器 token 扩展**：追加
  `REALIN / REALOUT / REALCALLS / CACHER / CACHEW / USAGECALLS`；原有前缀字段
  一字未动（`USAGECALLS:0` 即"未上报"），客户端 `OPTIMIZE_STATS:TOKENS:(\d+)`
  解析不受影响。
- **`/optimize --status` 真实用量行**：累计 input（缓存读/写/未缓存拆分）、output、
  **缓存命中率**、上报调用数、推理 token（有才显示）、上次优化用量；provider 未上报时
  明确打印"适配器未上报 usage——上面两个 token 数是启发式估算"。
- 单测 +10（27 文件 / 669 用例）：用量入账、无上报不污染台账、跨调用累计与
  单次运行分离、缓存命中报"0 次调用"、畸形 usage（负数/NaN）不污染台账、
  状态渲染四种分支（含**反向控制**：有调用但未上报不得显示为"0 次模型调用"）。

### Fixed

- **`docs/configuration.md` 的 `localTemplate` 文档与实现不符**：文档写
  `'auto' | 'on' | 'off' | 'hybrid'`、默认 `'auto'`，但 1.8.0 已移除 `'auto'`
  且默认是 `'off'`——照文档配置会**直接导致配置加载失败**
  （`$.localTemplate expected "on" | "off" | "hybrid" but got "auto"`）。
  文档与 `src/config.ts` 的过期注释同步为实际值（含 `'auto'` 已移除的告警）。
- **区分「0 次模型调用」与「有调用但未上报」**：`lastRunUsage.calls` 与
  `lastRunCalls` 是两个不同问题，状态行同时读取两者，避免把"适配器不支持
  上报"错误呈现为"这次优化零成本"。

## [1.9.0] - 2026-09-22

- **桌面端适配（与 web 双端兼容）**：桌面 App 自带独立运行时
  `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`（与 CLI/web 的 dsh 不同发布线）。
  兼容契约按 semver 预发布规则**逐 tuple 枚举**两条线：
  - `engines.dsh` / `dsh.compatibility.dsh`：`^0.1.6-alpha.2 || ^0.2.0-rc.2`
  - `dsh.compatibility.dshReleases`：新增 `"0.2.0-rc.2": "compatible"`（保留
    `0.1.6-alpha.2`，web 端不受影响）
  - `tests/manifest-contract.test.ts` 新增双线锁定断言（两条 tuple 必须都被枚举
    且都有 verdict）——CI 即可拦住"只覆盖一端"的回归
- **新增 `scripts/check-desktop-compat.mjs`（`pnpm desktop:compat`）**：直接读桌面
  `resources/app.asar` 的 `dsh/package.json`，校验（a）运行时版本被兼容范围覆盖且
  在 `dshReleases` 中有精确 verdict；（b）`dsh.client.inject` 每个包在桌面运行时中
  存在；含**覆盖规则自检反向控制**；无桌面安装时报 SKIP，可移植
- **preflight 新增 P9（桌面兼容门）**：接入上述脚本，P1–P9 全部门禁；CI/无桌面机器
  自动 SKIP，装有桌面 App 的开发机获得真机校验
- 实测结论：桌面端宿主契约与插件已对齐——`commands.execute(agent, line,
  submittedAttachments, signal)` 四参（插件客户端早已 4 参调用）、
  `CommandDefinition/CommandInvocation` 字段兼容、`llm.stream`/`StreamChunk` 未变、
  `conversation.input.left` 插槽存在、cordis 4.0.4 满足 peer `^4.0.1`

## [1.8.6] - 2026-09-20

**修复每次优化都刷屏的假警告 `Unknown placeholders found: {{原始指令}}`。**

### Fixed

- **占位符自检不再误报调用方填充的数据槽**：`renderBlocks()` 用 `PLACEHOLDER_MAP`
  当"已知占位符"白名单，但 `{{原始指令}}`（以及迭代路径的 `{{上次结果}}` /
  `{{迭代指令}}`）是**渲染之后**才由调用方填入的，两段式替换的下游槽位不在那张表里
  ⇒ 自检**每次调用都必然**把 `{{原始指令}}` 判为未知并 `console.warn` 一次；
  迭代路径一次报两个。启动 `dsh web` 时那行噪音就是这么来的。

  ⚠️ **它一直是假警告，功能从未受影响** —— 渲染结果里不含任何占位符（已实测）。
  但一条无条件触发的警告比没有警告更糟：它会把唯一一次真报错淹掉。

  修法是把这些下游槽位显式声明为 `CALLER_FILLED_PLACEHOLDERS`，自检改为比对
  「既不在块表、也不在调用方清单」的剩余项。判据更准确，且仍然**能**报出真正漏填的槽位。

### Added

- **`tests/meta.test.ts` 新增 `placeholder self-check` 4 例**：optimize 路径、iterate 路径、
  中英文 × 三种 `outputStyle` 全静默；外加一条**反向控制** —— 塞一个拼错的占位符进模板，
  断言警告**必须**出现且只提那一个（证明前三条"静默"不是空过）。
  实测反向控制有效：临时清空清单后该组测试立刻失败。

### Verified

- 全量测试 **27 文件 / 658 用例** 通过（原 654 + 新增 4）。
- 在 `0.1.6-alpha.2` 宿主上启动 `dsh web` 复测：控制台不再出现该警告，功能正常。

## [1.8.5] - 2026-09-19

**按 DSH STORE 上架契约补齐固定 Commit 的运行时产物与兼容性声明。**

DSH STORE 的复检在 **1.8.4（固定 Commit `d954cac`）** 上给出两条结论：

- 更新暂缓：`runtime artifact is missing from the fixed Git Commit: lib/index.js;
  ./lib/types/index.d.ts; ./lib/client.js`；
- 兼容性暂时下架：`Add an exact compatible dshReleases record at a new fixed Commit;
  range-only or unknown compatibility is not installable evidence.`

第一条的根因是 **`lib/` 被 `.gitignore` 排除**：manifest 的 `main` / `types` / `exports`
全部指向 `lib/`，而固定 Commit 里只有 `src/`。npm 路完全正常（`prepublishOnly` 现构建 +
`files` 强含 `lib`），所以 `npm publish` 与真机安装都没暴露问题；但 STORE 明确
**不执行第三方 install / prepare / build**，只读源码 —— 一个不带 `lib/` 的 Commit 就是
不可安装的包。第二条是 manifest **完全没有 `dsh.compatibility`**，Catalog 无法把任何
已验证的安装映射成兼容记录。

### Fixed

- **`lib/` 纳入版本控制**（`.gitignore` 移除该规则）：它**就是发布产物**，必须与 `src/`
  在同一笔提交里保持同步 —— 这也正是同一生态参照实现的既有惯例。同时天然解决了
  「从 GitHub 源安装时 pnpm ≥10 拒绝 `prepare`」的问题。
- **`prepare` → `prepublishOnly`**：构建只在发布时发生，git 源安装不再要求消费方的
  包管理器执行我们的构建脚本（`pnpm` 11+ 默认拦截 `prepare`，需人工加 `allowBuilds`）。
- **新增 `dsh.compatibility` 与 `engines`**：`engines.node: >=22`；`engines.dsh` 与
  `dsh.compatibility.dsh` 同值，逐 tuple 枚举 `^0.1.5-rc.1 || ^0.1.6-alpha.1`；
  `dshReleases` 给出精确版本记录（只列必须声明的最新三个，历史版本交由「旧 dsh 配旧插件」
  自然分流）。⚠️ 范围**不能**写成 `>=0.1.5-rc.1 <0.2.0`：按 semver 的预发布规则，
  带预发布号的版本只有在比较集中存在**同一 `[major.minor.patch]` 且带预发布**的项时才满足
  范围，因此该写法**匹配不到 `0.1.6-alpha.2`**。

### Added

- **门禁 P8「提交产物新鲜度」**（`scripts/preflight.mjs`）：manifest 发布的每个路径都必须
  在磁盘上、**被 git 跟踪**、且与新建构建**无未提交漂移**；并先证明两条探测本身能判别
  （已跟踪文件能查出来、被忽略路径能认出）—— 不能失败的门禁等于没有门禁。worktree
  非 git 检出时记为 SKIP 并说明原因。
- **`tests/manifest-contract.test.ts`**（16 例）：在源码层面锁住上述契约 —— 运行文件存在性、
  `files` 覆盖、不得被 `.gitignore` 命中、`prepublishOnly` 形态、Node/DSH 范围一致、
  `dshReleases` 键为精确版本且能被范围覆盖（含「错误范围必须判否」的反向控制）、
  patch 仅插入自有 entry id、插件名不占用 `@deepseek-ai/*` 命名空间。
- **`scripts/e3-acceptance.mjs`**：一次性 Profile 的**安装 → 启动 → 卸载**验收脚本。
  在临时 `DSH_HOME` 中初始化出厂 `web` 模板、安装指定产物、合成配置、启动 `dsh web`
  并校验 HTTP 200 与插件客户端模块、卸载、清理，输出 JSON 证据；含三条反向控制
  （未装插件的 profile 不得含 entry id、伪造 token 必须被拒、不存在的版本必须安装失败）。
  两个环境事实被写进脚本注释：`dsh plugin add <路径>` 会**按空白重新切分参数**
  （含空格路径会被 pnpm 当成 `owner/repo` GitHub 简写），故产物先落到无空格目录；
  新建 profile 是**空的**，必须先 `--from-default-profile web` 才有 web 应用可启动。
- **`npm run e3`**：上架/发版前的本地验收入口。

### Changed

- **兼容性声明收窄到最新一版**：`engines.dsh` / `dsh.compatibility.dsh` 由
  `^0.1.5-rc.1 || ^0.1.6-alpha.1` 改为 **`^0.1.6-alpha.2`**，`dshReleases` 只留
  **`0.1.6-alpha.2: compatible`** 一条。理由：Catalog 要的是「在某个确定版本上真的装过、
  起来过」的证据，逐版本声明才有意义；旧版本由「旧 dsh 配旧插件」自然分流，在此重复声明
  只会引入没人读、也不会去复验的记录。按 semver 预发布规则，`^0.1.6-alpha.2` 覆盖
  `0.1.6-alpha.2` / `0.1.6-alpha.3` / `0.1.6-beta.1` / `0.1.6` / `0.1.7`，
  **不覆盖** `0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.6-alpha.1`。
- **删除 `docs/兼容性策略.md`**：兼容性的权威说明改为本文件 + `AGENTS.md` 的规则条目，
  规则 R1 / R2 / R2b 的正文不再单独维护（内容未搬迁，避免两处漂移）。
  `client/client.js` 与相关脚本、测试里指向该文档的引用一并去掉。

### Verified

- **E3 验收在 `0.1.6-alpha.2` 宿主上全绿**（`1.8.5` 产物，沙箱外执行）：
  E3.1–E3.9 九步全 PASS，反向控制 `RC1` / `RC2` / `RC3` 全部通过 ——
  其中 **E3.7 真的启动了 `dsh web`、拿到 HTTP 200 并取到插件自身的客户端模块**，
  证明客户端半边确实挂载（不只是宿主起来了）。证据 JSON：
  `plugin: oss-prompt-optimizer@1.8.5`、`dshHost: 0.1.6-alpha.2`、`entryId: prompt-optimizer`。
- **`scripts/e3-acceptance.mjs` 删掉了内建的一次性删除补偿逻辑**：此前把它当成
  「宿主批量删除防护」的迹象，用三组对照实验证伪了 —— 真正装上防护的是一层
  **`--require` 注入的 shim**，而它的旁路判据正是 `os.tmpdir()`，偏偏 E3 的临时 home
  就在那之下，所以防护对它从来不生效（1062 条目树在临时目录内外都干净删完）。
  现在只做一次删除、然后**按实际残留判据**结论，不再猜原因。

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
