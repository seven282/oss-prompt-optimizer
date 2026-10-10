# 兼容性与失败模式

> English: [docs/compatibility.en.md](compatibility.en.md)
>
> 本文件是兼容性设计的**唯一权威**。README 只保留摘要，源代码里的注释只保留一行引用。
> 相关：`README.md`（面向用户）、`AGENTS.md`（面向改造者）、`CHANGELOG.md`（版本历史）。

## 一、硬约束

本插件与 dsh 运行在**同一个 Node 进程**里，因此：

> **插件的任何内部缺陷都不得阻止 `dsh web` 启动。**

dsh 的域包（`dsh-llm`、`dsh-tools`、`dsh-timeout`…）仍在 `0.1.x-rc` 阶段，导出会被搬迁或改名。
若插件在顶层静态 `import` 这些包，一旦解析失败，**ESM 的失败无法被捕获**，整个服务起不来。

这一条推导出下面三条规则。三条都是"真机全废"级事故的产物，各自发生过一次。

## 二、规则 R1 —— 依赖分层

`src/**` 只允许静态 import 两类包：

1. **框架本体 `@deepseek-ai/cordis`**（唯一保留的静态宿主依赖）；
2. **本包 `dependencies` 里自己安装的包**（如 `@deepseek-ai/schemastery`）。

**其余宿主包一律禁止静态 import**，必须经 `src/compat/loader.ts` 用 `createRequire`
**同步懒加载**：`try/catch` + 缓存，**失败只返回 `null`，永不抛错**。

保持同步（而非改成 async）是为了让 `apply()` 仍是同步的，注册时序不变。

### `verbatimModuleSyntax` 陷阱

`tsconfig.json` 开了 `verbatimModuleSyntax`，于是：

```ts
import type { X } from '@deepseek-ai/dsh-llm'   // ✅ 完全擦除，零运行时
import { type X } from '@deepseek-ai/dsh-llm'   // ❌ 编译成 `import {} from '…'` —— 仍是运行时导入
```

内联 `type` 修饰符**不会**擦成空语句，而是留下**空具名绑定导入**，照样在模块实例化阶段解析宿主包。
⇒ **宿主导入只允许顶层 `import type`。** 由 `tests/policy-static-imports.test.ts` 的 `erased` 用例守着。

## 三、规则 R2 —— 客户端注入契约

`client/client.js` 的 `exports.inject` **只放真正不可缺的服务**（当前只有 `remote`）；
**其余一律 `ctx.get('<name>')` 并判空**。

原因：cordis 的 context 是 Proxy，读一个不在 `inject` 里的服务会**抛错**
（`cannot get property "X" without inject`），而 `apply()` 不捕获它 ⇒
**整个客户端半边不注册**：✨ 按钮与设置页一起消失，控制台留下
`failed to apply loader entry …`。

`ctx.get(name)` 走 `ReflectService.get`，注释原文是 *"without the inject requirement"* ⇒
返回服务或 `undefined`、**永不抛错**。`ctx.effect` 等是 cordis 核心方法，安全。

## 四、规则 R2b —— 带点服务名不是父级属性

宿主的 `dsh-api-gateway` 用 `remoteServiceKey(ns)` = `'remote.' + ns`，
以 `super(ctx, 'remote.commands')` 的形式为**每个 remote 命名空间**注册独立服务；
而命名空间集合**运行时才定**（contribution 挂载时安装），白名单不可能穷举。

cordis 的 `createTraceable`：服务值带 `[symbols.tracker]` 时，读 `服务.属性` 会被**改写**成
`Reflect.get(ctx, '<服务名>.<属性>')` ⇒ **重新进 inject 门禁**。所以

```js
ctx.get('remote').commands     // ❌ 抛 cannot get property "remote.commands" without inject
ctx.remote.commands            // ❌ 同上
ctx.get('remote.commands')     // ✅ 整体按完整名取
```

两条推论：

1. 嵌套服务一律按**完整名**取；
2. **在调用时取**——命名空间可能在本插件 `apply()` 之后才挂载。

边界（已实测）：扫遍 dsh 全部包，带点服务名共 18 个，**全部是 `remote.` 前缀**；
`super(ctx, '<literal>')` 的 86 个字面名**无一带点** ⇒ `slots.*` / `locale.*` /
`settingsScope.*` / `sessions.*` 等目前安全，只有 `remote` 需要禁点读。

### 门禁的两个已知盲区

| 盲区 | 说明 |
|---|---|
| 静态正则只取单段 | `ctx.remote.commands` 只判到 `remote`（在 inject 内）就放过了；局部变量 `ctx.get('remote')` 之后的 `remote.commands` 更是完全看不见 |
| 假宿主不忠实 | 若用 **plain object** 提供服务，`getTraceable` 因缺 `[symbols.tracker]` **原样返回**，嵌套读取不触发代理 ⇒ 断言空过 |

**忠实建模 = `Service` 子类 + 把嵌套名也注册成服务 + 一条「naive 写法在此宿主上必须抛」的反向控制。**

## 五、宿主契约变化时会发生什么

| 宿主变化 | 后果 |
|---|---|
| 某工具函数被移出包 / 改名 | **该功能降级 + 一行 WARN**；宿主与其余功能正常 |
| 某服务改名（如 `systemPrompt`） | 仅对应功能消失（按功能门禁，不再整插件失效） |
| 客户端可选服务缺失 / 改名（`locale`…） | 走 `ctx.get()`，只少对应文案；✨ 按钮与设置页照常注册 |
| `BlockAssembler` 缺失 | `/optimize` 返回错误码 `UNSUPPORTED_ENV` 并给出明确文案，**不伪造消息、不静默失败** |
| 客户端 slot props 契约改名 | 候选链自适配；全部失败则**不注册按钮**并打印自诊断日志 |
| 设置面服务换代（0.1.x `settingsScope` → 0.2.0 `configForms`） | 设置页只读 `ctx.get('configForms')`；取不到或不可写时**降级为只读并写明原因**，写入被宿主拒绝时提示「宿主拒绝了这次修改」，不再出现「已保存」假成功 |
| 域包整体升级（`0.1.5-rc` → `0.2.x`） | 运行时能力探测决定可用面；不可用即降级 |

降级不是静默的：插件构造时**必定打印一行 compat report**（健康 `info`，降级 `warn`）：

```
prompt-optimizer: host compat ok (defineTool=ok createUserMessage=ok BlockAssembler=ok)
prompt-optimizer: host compat DEGRADED (defineTool=MISSING …) — defineTool: the `prompt_optimize` tool is not registered; the /optimize command and the input-box button still work | …
```

## 六、升级 dsh 后怎么验证

```sh
pnpm preflight       # P1–P12（P11 默认跳过，需 --browser-e2e）
pnpm preflight --browser-e2e   # 追加 P11（真浏览器，须在沙箱外跑）
pnpm e3 --dsh-bin <目标版本的 dsh/lib/bin.js>   # 一次性 Profile：安装 → 启动 → 卸载
pnpm e4 --json e4.json                          # 设置面真浏览器：换证 → 8 字段 → 写盘
dsh web              # 真机：正常启动 + 日志出现一行 compat report
```

| 步骤 | 证明什么 |
|---|---|
| P1 | 依赖面：`lib/**/*.js` 的顶层裸包 import 只含白名单（cordis + 自有 dependencies） |
| P2 | `dsh.client.inject` 存在性：模拟真实解析并报告来源层级（plugin profile / shared anchor / dsh CLI bundle） |
| P3 | `client/client.js` 与 `lib/client.js` 字节一致 |
| P4 | typecheck → test → build |
| P5 | 兼容性报告（仅提示，不阻断） |
| P6 | **启动独立性**：子进程内同时封死 ESM 与 CJS 两条解析路径上的全部 `@deepseek-ai/dsh*` 后导入入口——"宿主升级只会减功能、不会让服务起不来"的动态证明。含反向控制（先证明封印真生效，防"封印失效→断言空转→永远 PASS"） |
| P7 | **客户端服务读取契约**：静态扫描 + 在**忠实最小宿主**上真正执行 `lib/client.js` 的 `apply()`（本项目里唯一会跑浏览器半边的自动化步骤）。扫两类违规：直读未注入的服务（R2）、把带点服务名当父级属性读（R2b） |
| P8 | 提交产物新鲜度：manifest 声明的路径必须存在、被 git 跟踪、且**对 HEAD 无 diff** ⇒ 干净索引 ≠ 已提交 |
| P9 | 桌面 / 网页双兼容 |
| P10 | 评测判官标定（内置参考对 + "无法造分的判官必须被拒"的反向控制） |
| P11 | 真浏览器设置面（`--browser-e2e`，默认关闭） |

`pnpm e3` / `pnpm e4` / `pnpm preflight --browser-e2e` **都不进 CI**：它们需要真实宿主启动或真浏览器，
跑进 CI 会破坏离线可重复性。三者都支持 `--json <path>` 输出机器可读证据。

## 七、事故档案

记录在这里是为了让源代码注释不必再复述它们。

| 版本 | 症状 | 根因 | 现在的守卫 |
|---|---|---|---|
| **1.8.1** | `dsh web` 完全起不来 | 顶层静态 import 宿主包，取其 `deepFreeze` 时解析失败；ESM 失败不可捕获 | 规则 R1；P1 + P6 |
| **1.8.2** | ✨ 按钮与设置页**一起消失**（客户端半边全废） | 客户端直读一个不在 `inject` 里的可选服务，Proxy 抛错且 `apply()` 不捕获 | 规则 R2；`tests/client-inject-contract.test.ts` + `tests/client-apply.test.ts` + P7 |
| **1.8.3** | 同上，**上一版门禁没盖住** | `ctx.get('remote').commands` 被 cordis 改写成读 `remote.commands`，再次撞 inject 门禁 | 规则 R2b；P7 的忠实假宿主 + 反向控制 |
| **1.8.4** | 插件市场上「更新暂缓」，而 `npm publish` 一切正常 | `lib/` 当时被 gitignore，而 `main`/`types`/`exports` 全指向它 ⇒ 只带 `src/` 的提交是不可安装的包（DSH STORE 只读固定 Commit、不跑构建） | `lib/` 入库 + P8（发布路径必须存在、被跟踪、对 HEAD 无 diff） |
| **issue #3** | 设置面板"保存成功"但什么都没存 | 客户端读 0.1.x 的 `settingsScope`（0.2.0 已换成 `configForms`），且 `set()` 的 boolean 返回值被吞；schema 上无 volatile 字段 ⇒ 该 entry 在设置面整条不出现 | `src/live-config.ts` + C 端 `form.set()` 判返回值 + P11 |

## 八、门禁自检原则

**每个"应当为空"的违规列表断言，都要配一条"证明能非空"的控制断言。**

否则断言会退化成永远 PASS：封印失效、假宿主不忠实、正则写错，都不会有人知道。
现有的反向控制：P6（封印真生效）、P7（naive 写法在忠实宿主上必须抛）、
P10（无法造分的判官必须被拒）、P11（假 token 必须 401；待写值不得已经在盘上）。
