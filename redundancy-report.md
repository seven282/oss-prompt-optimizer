# 冗余代码分析报告 · prompt-optimizer

> 范围：`src/**/*.ts`（17 个文件）+ `client/client.js`
> 方法：逐文件通读 + 跨文件调用关系核对（grep 确认每个导出/函数的实际引用点）
> 结论：无真正"死函数"（所有 `validate.ts` 导出、`situation.ts`/`meta.ts` 导出均被内部消费）。问题集中在**重复逻辑块**、**重复类型**与**冗余守卫/不一致**，共 9 项。

---

## 一、冗余项清单（含文件路径、函数名、冗余原因）

| # | 严重度 | 文件 / 位置 | 函数 / 符号 | 冗余原因 |
|---|--------|------------|------------|----------|
| 1 | 🔴 P1 | `src/context.ts:27` `contextMessageText` 与 `src/hook.ts:8` `messageText` | 两个函数 | **逻辑完全重复**：都做"过滤 `type==='text'` 的文本块 → 拼接"。`messageText` 处理的 `UserMessage.content` 是块数组，`contextMessageText` 已能处理"块数组 \| 字符串"两种入参，hook 可直接复用，无需另写一份。 |
| 2 | 🔴 P1 | `src/validate.ts:137` `truncateByTokens` 与 `src/context.ts:77-86` `gatherConversationContext` 内联循环 | 两个函数 | **二分截断逻辑重复**：都是"在 token 预算内二分找最长前缀 + 追加 `[…已截断]` 标记"。仅标记文案略有差异。应抽成共享 `truncateToTokenBudget(text, maxTokens, estimate, marker)`。 |
| 3 | 🔴 P1 | `src/optimizer.ts:609-613`（runPipeline）与 `src/optimizer.ts:728-732`（refineOnce） | 输出校验分支 | **校验分支重复**，且两处行为不一致：`runPipeline` 的 plain 分支用 `hasPlainOutput`（含"禁止标题"检查），`refineOnce` 的 plain 分支只用 `hasSubstantialContent`（**不含**标题检查）——自精炼可能放过带 `##` 标题的结果。应抽成 `validateOutput(text, outputStyle, minSectionChars)` 并统一两处语义。 |
| 4 | 🟠 P2 | `src/meta.ts:56-71` `detectTaskType` 与 `src/situation.ts:192-205` `detectTaskSubtype` | 两个函数 | **关键词打分循环重复**：同一套"遍历关键词表 → `lower.includes` 累加 → 严格大于才更新最佳"的循环写了两遍。可抽 `bestScoreByKeywords(keywordMap, lower)`。 |
| 5 | 🟠 P2 | `src/config.ts:5` `PromptExample` 与 `src/meta.ts:139` `PromptExampleText` | 两个接口 | **同构类型重复**：两者都是 `{ input: string; output: string }`。`meta.ts` 的 builder 与 `config.examples` 用两套名字，徒增认知负担。统一为一个（建议保留 `PromptExample`）。 |
| 6 | 🟠 P2 | `src/meta.ts:193` `metaBlocks` 内 `subtype` 守卫 | `subtypeBlock` 条件 | **冗余守卫**：`subtype !== undefined && taskType !== undefined && taskType !== 'other'`。`detectTaskSubtype` 在 `type==='other'` 时 `return undefined`，故 `subtype !== undefined` 已隐含后两者；且 `taskType` 经 `taskType ?? resolvedProfile.task.type` 永远非空。可简化为 `subtype !== undefined`。 |
| 7 | 🟡 P3 | `src/events.ts:42` `PROMPT_OPTIMIZER_EVENTS` | 常量 | **弱死代码 / 不一致**：常量已 `export` 但包内从未引用；`optimizer.ts:351`、`370-371` 的 `emit` 直接写字符串字面量 `'prompt-optimizer/optimize:start'` 等，绕过了该常量。应改用 `PROMPT_OPTIMIZER_EVENTS.start`，避免事件名漂移。 |
| 8 | 🟡 P3 | `src/optimizer.ts:642-653` runPipeline 失败分支 | `missingSections` / `hasSectionHeadings` 调用 | **重复计算**：同一 `full` 字符串在 else 分支被 `hasAllSections(full)`（642）与 `hasSectionHeadings(full)`（644、653 调两次）反复扫描。可用 `diagnoseSections(full, minSectionChars)` 一次性拿 `missing`/`thin`，同时消除重复 `hasSectionHeadings` 调用。 |
| 9 | 🟡 P3 | `src/optimizer.ts:392` `estimateInputTokens` | 私有方法（命名） | **命名误导**：方法名含 "Input"，但 `outputTokens: this.estimateInputTokens(result)`（637、735）实际是对"优化**输出**"文本估 token。建议改名 `estimateTextTokens`，或内部直接复用 `estimateTokens`/meter，减少"输入/输出"一词多义。 |

---

## 二、已确认"非冗余"（避免误删）

- `validate.ts` 全部导出（`hasAllSections` / `hasOptimizedSections` / `hasValidSections` / `hasPlainOutput` / `hasSectionHeadings` / `plainHeadingsMessage` / `diagnoseSections` / `thinOutputMessage` / `thinSectionsMessage` / `INCOMPLETE_SECTIONS_MESSAGE` / `REQUIRED_SECTIONS` / `sectionBody` / `truncateInput` / `truncateByTokens` / `estimateTokens` / `assertInput`）**均有实际引用**，非死代码。
- `situation.ts` 的 `goalAnchorsOf` / `driftLine` / `isCJK` / `cacheProfile` 等私有 helper 均被调用。
- `client/client.js` 的 `resultOf` 与三个图标函数（Sparkles / Spinner / Undo）均被使用，无冗余。
- 中英文常量对（`ZH_GOAL` / `EN_GOAL`、`ZH_ROLE_MARKERS` / `EN_ROLE_MARKERS` 等）是**有意 i18n 设计**，不算冗余。

---

## 三、精简建议（按优先级）

### 立即可做（低风险，纯重构）
1. **合并文本抽取**：删除 `hook.ts` 的 `messageText`，改在 hook 内 `import { contextMessageText } from './context.js'`（其入参兼容块数组）。删 ~5 行重复。
2. **合并 token 截断**：在 `validate.ts` 新增 `truncateToTokenBudget(text, maxTokens, estimate, marker)`，让 `gatherConversationContext` 复用；`truncateByTokens` 可改为其 `marker` 取默认值的特例。删 ~12 行重复 + 统一标记文案。
3. **提取 `validateOutput(text, outputStyle, minSectionChars)`**：在 `optimizer.ts` 内新增私有纯函数，runPipeline 与 refineOnce 共用——**同时修复** refineOnce 在 plain 模式下漏检标题的不一致。
4. **统一 `PromptExample` 类型**：`meta.ts` 改用 `import type { PromptExample }`，删除 `PromptExampleText`；对应 `examples` 参数类型收敛。

### 建议做（中等收益）
5. **提取 `bestScoreByKeywords`**：`detectTaskType` 与 `detectTaskSubtype` 共用，新增关键词分类时只改表不改循环。
6. **简化 `subtype` 守卫**为 `subtype !== undefined`（meta.ts:193）。
7. **用 `PROMPT_OPTIMIZER_EVENTS` 常量替换** optimizer.ts 三处字面量。

### 可选（一致性 / 可读性）
8. runPipeline 失败分支改用 `diagnoseSections` 一次诊断，去掉重复的 `hasSectionHeadings` 调用。
9. `estimateInputTokens` 重命名为 `estimateTextTokens`，调用点语义更清晰。

> 说明：以上不涉及功能删除，均为"合并重复 / 消除不一致"的纯重构；每项改动都有受控的纯函数单测覆盖（tests/ 下 validate / diagnose / situation / meta / optimizer 等），重构后跑 `pnpm test` 即可回归。

---

## 四、执行状态（2026-08-19 已落地 P1/P2/P3）

全部 9 项已执行完毕：`pnpm run typecheck` 通过、`pnpm test` 347 全绿、`pnpm run build` 通过。

| # | 落地情况 |
|---|----------|
| 1 | ✅ `hook.ts` 删除重复抽取逻辑，`messageText` 改为 1 行委托 `contextMessageText`（保留导出壳——`index.ts` 公共 re-export，避免破坏公开 API） |
| 2 | ✅ `validate.ts` 新增 `truncateToTokenBudget(text, maxTokens, estimate, marker)`；`truncateByTokens` 变为其默认 marker 的特例；`context.ts` 内联二分截断删除、直接复用 |
| 3 | ✅ `optimizer.ts` 新增模块级 `validateOutput(text, outputStyle, minSectionChars)`，`runPipeline` 与 `refineOnce` 共用；**顺带修复** refineOnce 在 plain 模式下漏检 `##` 标题的不一致 |
| 4 | ✅ `meta.ts` 新增 `bestScoreByKeywords`（严格大于保持先到者胜，迭代顺序即平局优先级），`detectTaskType` 与 `detectTaskSubtype` 共用 |
| 5 | ✅ 删除 `PromptExampleText`，`meta.ts` 改用 `import type { PromptExample } from './config.js'`，builder/metaBlocks 参数收敛 |
| 6 | ✅ `metaBlocks` 的 `subtypeBlock` 守卫简化为 `subtype !== undefined`（subtype 来自 `detectTaskSubtype`，`'other'` 时必为 undefined，后两个条件冗余） |
| 7 | ✅ `emitStart`/`emitCompleted` 改用 `PROMPT_OPTIMIZER_EVENTS.start/.success/.failure`，消除事件名字面量漂移 |
| 8 | ✅ runPipeline 失败分支用 `diagnoseSections` 一次判定缺失段落，`hasSectionHeadings` 只扫一次（原 644/653 两处） |
| 9 | ✅ `estimateInputTokens` 改名 `estimateTextTokens`（7 处调用点同步），方法注释同步 |

**刻意保留（不删）**：`validate.ts` 的 `hasSubstantialContent` 与 `hook.ts` 的 `messageText` 均为 `index.ts` 公共导出，作为公共 API 保留；`optimizer.ts` 已不再导入 `hasSubstantialContent`。
