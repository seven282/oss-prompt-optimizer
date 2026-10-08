import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { OptimizeError, OptimizeErrorCode, OPTIMIZE_ERROR_TEXT } from './errors.js'
import { gatherConversationContext, type ContextMessage } from './context.js'
import { matchScene, renderSceneTemplate } from './meta.js'
import type { TaskSubtype } from './situation.js'
import { buildLocalTemplate, localTemplateGate } from './local.js'
import { formatEvalComparison, formatEvalRun, evalVerdictToken } from './eval.js'
import { formatStatus } from './status.js'
import type { PromptOptimizerService } from './optimizer.js'

/** Stable machine-readable token for the current role-document language mode. */
function metaLanguageToken(language: 'auto' | 'zh' | 'en'): string {
  if (language === 'auto') return 'META_LANGUAGE:AUTO'
  return language === 'en' ? 'META_LANGUAGE:EN' : 'META_LANGUAGE:ZH'
}

/**
 * Best-effort conversation context from the receiving agent's live session.
 * The exact session API is duck-typed (`agent.session.deriveMessages()`),
 * so a missing method or any error yields `undefined` — the optimization
 * then simply runs without context. Session messages include the current
 * command record; the last message is dropped so the command line itself is
 * not treated as user context.
 */
function sessionContext(
  agent: { session?: unknown } | undefined,
  service: PromptOptimizerService,
): string | undefined {
  if (agent === undefined || !service.isContextAware()) return undefined
  try {
    const session = agent.session as { deriveMessages?: () => unknown } | undefined
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return undefined
    const messages = (derive.call(session) ?? []) as ContextMessage[]
    if (messages.length === 0) return undefined
    const prior = messages.slice(0, -1)
    if (prior.length === 0) return undefined
    const bounds = service.contextConfig()
    return gatherConversationContext(prior, {
      maxMessages: bounds.maxMessages,
      maxTokens: bounds.maxTokens,
    })
  } catch {
    // Context is best-effort; never fail the command over it.
    return undefined
  }
}

/**
 * Register the `/optimize` and `/template` commands. The browser client drives
 * the input-box buttons through the already-generated `commands` Remote
 * namespace (`ctx.remote.commands.execute(sessionId, ...)`) — the one
 * client→host RPC path that ships with strict descriptors and is guaranteed to
 * be claimed by the host gateway (custom `@Remote` namespaces require SRC
 * discovery, which is unreliable in deployed compositions).
 *
 * The `/optimize` command supports sub-commands via flags:
 *   `/optimize <instruction>`           — optimize a raw instruction
 *   `/optimize --stats`                 — report run statistics
 *   `/optimize --status`                — live status (params/source/stats/prefs/events)
 *   `/optimize --language <mode>`       — switch role-document language
 *   `/optimize --auto <on|off|toggle>`  — switch auto-optimize mode
 *
 * Effect-scoped: the registrations are removed on plugin dispose.
 */
export function registerOptimizeCommand(ctx: Context, service: PromptOptimizerService): void {
  /** Shared optimize handler; `senseNeeds` enables the 造梦模式 appendix (/dream). */
  const optimizeHandler = async (invocation: {
    agent: unknown
    rawInput: string
    signal: AbortSignal
  }, senseNeeds: boolean): Promise<CommandResult> => {
    const text = invocation.rawInput.trim()
    if (text.length === 0) {
      return { kind: 'error', text: 'prompt-optimize: 请提供要优化的指令' }
    }
    try {
      const context = sessionContext(invocation.agent as { session?: unknown }, service)
      const result = await service.optimize(text, {
        signal: invocation.signal,
        senseNeeds,
        ...(context !== undefined && context.length > 0 ? { context } : {}),
      })
      if (result.optimized) return { kind: 'success', text: result.prompt }
      return { kind: 'error', text: result.error ?? 'prompt-optimize: 优化失败' }
    } catch (error) {
      if (error instanceof OptimizeError) {
        // 稳定码优先；UNKNOWN 码透传原始 message（含 harness 错误细节，如
        // provider 报错原文——C-2 修复后 terminal error finish 归为 UNKNOWN）。
        if (error.code === OptimizeErrorCode.UNKNOWN && error.message.length > 0) {
          return { kind: 'error', text: error.message }
        }
        return { kind: 'error', text: OPTIMIZE_ERROR_TEXT[error.code] }
      }
      return { kind: 'error', text: `prompt-optimize: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // Unified `/optimize` command with flag-based sub-commands.
  ctx.commands.register({
    name: 'optimize',
    description: 'Optimize a raw instruction (--stats / --status / --select / --feedback / --language / --auto / --insights / --set-*)',
    input: { hint: '<指令> | --stats | --status | --select | --feedback | --language auto|中文|英文 | --auto on|off|toggle | --insights | --set-profile balanced|fast' },
    handler: async (invocation): Promise<CommandResult> => {
      const raw = invocation.rawInput.trim()

      // --- Flag: --stats ---
      if (raw === '--stats' || raw.startsWith('--stats ')) {
        const stats = service.getStats()
        // 1.10.0: the trailing REAL*/USAGE* fields are provider-reported; the
        // leading TOKENS/INPUT pair stays the heuristic estimate, because a
        // caller that used the token before this version must keep working and
        // `USAGECALLS:0` is what tells the two apart.
        const last = stats.lastRunUsage
        const real = last === null
          ? 'REALIN:0|REALOUT:0|REALCALLS:0'
          : `REALIN:${last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens}|REALOUT:${last.outputTokens}|REALCALLS:${last.calls}`
        // 1.12.0: SELECT* reports the best-of-N outcome (`SELRUNS:0` when the
        // feature never ran), FEEDBACK* the host signal counts.
        const select = `SELRUNS:${stats.selectRuns}|SELGAINS:${stats.selectGains}|SELCAND:${stats.lastSelectCandidates}|SELCHOSEN:${stats.lastSelectChosen}|SELSCORE:${stats.lastSelectScore}|SELGATE:${stats.lastSelectGate}`
        const feedback = `FBSESSIONS:${stats.feedbackSessions}|FBPOS:${stats.feedbackPositive}|FBNEG:${stats.feedbackNegative}|FBBIAS:${stats.feedbackBiasApplied}`
        return {
          kind: 'success',
          text: `OPTIMIZE_STATS:TOKENS:${stats.lastOutputTokens}|INPUT:${stats.lastInputTokens}|CALLS:${stats.lastRunCalls}|LASTMSCALL:${stats.lastCallMs}|LOCAL:${stats.local}|REFINED:${stats.refined}|${real}|CACHER:${stats.cacheReadTokens}|CACHEW:${stats.cacheWriteTokens}|USAGECALLS:${stats.usageCalls}|${select}|${feedback}`,
        }
      }

      // --- Flag: --feedback (1.12.0 P1-B) ---
      // Reads the host's own per-message judgments. Counts and category slugs
      // only: the free-text note a human typed is never copied out of the host
      // store, so this output can be pasted or logged safely.
      if (raw === '--feedback' || raw.startsWith('--feedback ')) {
        const lang = service.getMetaPromptLanguage() === 'en' ? 'en' : 'zh'
        try {
          await service.scanFeedback()
        } catch {
          // Reading signals is best-effort; render whatever is already known.
        }
        return { kind: 'success', text: service.formatFeedbackSignals(lang) }
      }

      // --- Flag: --select (1.12.0 P1-A) ---
      // The best-of-N outcome of the last run, spelled out: which candidate was
      // adopted, why, and what each one scored. The reasoning behind a choice
      // has to be readable, or "we picked #2" is a claim without a reason.
      if (raw === '--select' || raw.startsWith('--select ')) {
        const lang = service.getMetaPromptLanguage() === 'en' ? 'en' : 'zh'
        const stats = service.getStats()
        if (stats.lastSelectCandidates <= 1) {
          return {
            kind: 'success',
            text: lang === 'zh'
              ? 'prompt-optimize: 未启用择优（selectCandidates=1）——单候选时为历史行为。设为 >1（如 3）后 /optimize 会生成多个候选并按判官分数择优。'
              : 'prompt-optimize: selection off (selectCandidates=1) — single-candidate behaviour is unchanged. Set it >1 (e.g. 3) to generate several candidates and keep the best.',
          }
        }
        const parts = [
          lang === 'zh'
            ? `prompt-optimize: 上次择优 ${stats.lastSelectChosen}/${stats.lastSelectCandidates}（分数 ${stats.lastSelectScore > 0 ? stats.lastSelectScore.toFixed(2) : 'n/a'}，结构门通过 ${stats.lastSelectGate}）`
            : `prompt-optimize: last selection ${stats.lastSelectChosen}/${stats.lastSelectCandidates} (score ${stats.lastSelectScore > 0 ? stats.lastSelectScore.toFixed(2) : 'n/a'}, ${stats.lastSelectGate} passed the gate)`,
          lang === 'zh'
            ? `  累计 ${stats.selectRuns} 次择优，${stats.selectGains} 次换用非首个候选`
            : `  ${stats.selectRuns} selection run(s), ${stats.selectGains} replaced the first draw`,
        ]
        const detail = service.selectSummary()
        if (detail !== undefined) parts.push(detail)
        return { kind: 'success', text: parts.join('\n') }
      }

      // --- Flag: --language ---
      if (raw.startsWith('--language')) {
        const arg = raw.replace(/^--language\s*/, '').trim()
        if (arg === '' || arg === 'status') {
          return { kind: 'success', text: metaLanguageToken(service.getMetaPromptLanguage()) }
        }
        if (arg === 'auto' || arg === '中文' || arg === '英文') {
          service.setMetaPromptLanguage(arg === 'auto' ? 'auto' : arg === '英文' ? 'en' : 'zh')
          return { kind: 'success', text: metaLanguageToken(service.getMetaPromptLanguage()) }
        }
        return { kind: 'error', text: 'prompt-optimize: 用法 /optimize --language auto | 中文 | 英文 | status' }
      }

      // --- Flag: --auto ---
      if (raw.startsWith('--auto')) {
        const arg = raw.replace(/^--auto\s*/, '').trim().toLowerCase()
        const current = service.isAutoOptimizeAll()
        let next: boolean
        switch (arg) {
          case 'on':
            next = true
            break
          case 'off':
            next = false
            break
          case 'toggle':
            next = !current
            break
          case 'status':
            return { kind: 'success', text: current ? 'AUTO_OPTIMIZE:ON' : 'AUTO_OPTIMIZE:OFF' }
          default:
            return { kind: 'error', text: 'prompt-optimize: 用法 /optimize --auto on | off | toggle | status' }
        }
        service.setAutoOptimizeAll(next)
        return { kind: 'success', text: next ? 'AUTO_OPTIMIZE:ON' : 'AUTO_OPTIMIZE:OFF' }
      }

      // --- Flag: --set-profile / --set-local / --set-temperature ---
      if (raw.startsWith('--set-profile')) {
        const arg = raw.replace(/^--set-profile\s*/, '').trim().toLowerCase()
        if (arg === 'clear') { service.clearUserOverride('profile'); return { kind: 'success', text: 'SET_PROFILE:CLEAR' } }
        if (arg === 'balanced' || arg === 'fast') { service.setUserOverride('profile', arg); return { kind: 'success', text: `SET_PROFILE:${arg.toUpperCase()}` } }
        return { kind: 'error', text: '用法: /optimize --set-profile balanced|fast|clear' }
      }
      if (raw.startsWith('--set-local')) {
        const arg = raw.replace(/^--set-local\s*/, '').trim().toLowerCase()
        if (arg === 'clear') { service.clearUserOverride('local'); return { kind: 'success', text: 'SET_LOCAL:CLEAR' } }
        if (['on','off','hybrid'].includes(arg)) { service.setUserOverride('local', arg); return { kind: 'success', text: `SET_LOCAL:${arg.toUpperCase()}` } }
        return { kind: 'error', text: '用法: /optimize --set-local on|off|hybrid|clear' }
      }
      if (raw.startsWith('--set-temperature')) {
        const arg = raw.replace(/^--set-temperature\s*/, '').trim()
        if (arg === 'clear') { service.clearUserOverride('temperature'); return { kind: 'success', text: 'SET_TEMPERATURE:CLEAR' } }
        const n = parseFloat(arg)
        if (Number.isFinite(n) && n >= 0 && n <= 2) { service.setUserOverride('temperature', arg); return { kind: 'success', text: `SET_TEMPERATURE:${n}` } }
        return { kind: 'error', text: '用法: /optimize --set-temperature 0.0-2.0|clear' }
      }

      // --- Flag: --insights ---
      if (raw === '--insights' || raw.startsWith('--insights ')) {
        const lang = service.getMetaPromptLanguage() === 'en' ? 'en' : 'zh'
        const insights = service.getInsights(lang)
        return { kind: 'success', text: insights }
      }

      // --- Flag: --status (P1, 1.7.9) 运行时状态 ---
      if (raw === '--status' || raw.startsWith('--status ')) {
        const lang = service.getMetaPromptLanguage() === 'en' ? 'en' : 'zh'
        const snapshot = service.getStatus(raw === '--status' ? '' : raw.slice('--status '.length))
        return { kind: 'success', text: `STATUS_OK\n${formatStatus(snapshot, lang)}` }
      }

      // --- Default: optimize instruction ---
      return optimizeHandler(invocation, false)
    },
  })

  // Evaluation harness (1.11.0): measure the optimizer's own output instead of
  // only asserting its shape. `/optimize-eval run` optimizes the case set,
  // scores it (deterministic gate + weighted judge rubric) and compares the
  // aggregate against the recorded baseline. Kept as its own command because a
  // run costs real model calls: it is an explicit act, never a side effect of
  // `/optimize`.
  ctx.commands.register({
    name: 'optimize-eval',
    description: 'Measure the optimizer against the golden set (run / baseline / show / list / rubric / cases)',
    input: { hint: 'run [label] [--all] [--mine] | baseline [label] | show | list | rubric | cases' },
    handler: async (invocation): Promise<CommandResult> => {
      const raw = invocation.rawInput.trim()
      const [head = '', ...rest] = raw.split(/\s+/)
      const lang = service.getMetaPromptLanguage() === 'en' ? 'en' : 'zh'

      // --- show: last run + baseline comparison ---
      if (head === 'show' || head === '') {
        const summary = service.getEvalSummary()
        if (summary.last === undefined) {
          return { kind: 'success', text: 'prompt-optimize: 还没有评测记录，先跑 /optimize-eval run' }
        }
        const parts = [formatEvalRun(summary.last, lang)]
        if (summary.comparison !== undefined) parts.push(formatEvalComparison(summary.comparison, lang))
        return { kind: 'success', text: parts.join('\n') }
      }

      // --- list: recent runs ---
      if (head === 'list') {
        const runs = service.getEvalRuns()
        if (runs.length === 0) return { kind: 'success', text: 'prompt-optimize: 还没有评测记录。' }
        const lines = runs.map((run) => {
          const when = new Date(run.ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
          const score = run.aggregate === undefined ? 'n/a' : run.aggregate.toFixed(3)
          return `  ${when}  ${score}  结构门 ${run.deterministicPass}/${run.cases}${run.label !== undefined ? `  ${run.label}` : ''}`
        })
        return { kind: 'success', text: `prompt-optimize: 最近 ${runs.length} 次评测\n${lines.join('\n')}` }
      }

      // --- rubric: the dimensions actually in effect ---
      if (head === 'rubric') {
        const lines = service.getEvalRubric().map((dimension) =>
          `  ${dimension.id}  权重 ${dimension.weight}  ${dimension.alwaysApplicable ? '' : '（按需启用）'}${lang === 'zh' ? dimension.descriptionZh : dimension.descriptionEn}`,
        )
        return { kind: 'success', text: `prompt-optimize: 评测维度\n${lines.join('\n')}` }
      }

      // --- cases: the case ids a run would use ---
      if (head === 'cases') {
        const all = rest.includes('--all')
        const cases = service.listEvalCases({ all })
        const lines = cases.map((item) => `  ${item.id}${item.core ? ' [core]' : ''}${item.injection ? ' [注入探针]' : ''}`)
        return { kind: 'success', text: `prompt-optimize: ${all ? '全部' : '默认（core）'}用例 ${cases.length} 条\n${lines.join('\n')}` }
      }

      // --- baseline: record a run as the comparison point ---
      if (head === 'baseline') {
        const label = rest.find((token) => !token.startsWith('--'))
        const recorded = service.setEvalBaseline(label)
        if (recorded === undefined) {
          return { kind: 'error', text: 'prompt-optimize: 没有可记录的评测运行，先跑 /optimize-eval run' }
        }
        const score = recorded.aggregate === undefined ? 'n/a' : recorded.aggregate.toFixed(3)
        return { kind: 'success', text: `EVAL_BASELINE:SET:${score}|CASES:${recorded.cases}` }
      }

      if (head !== 'run') {
        return { kind: 'error', text: '用法: /optimize-eval run [label] [--all] [--mine] | baseline [label] | show | list | rubric | cases' }
      }

      // --- run ---
      const all = rest.includes('--all')
      const mine = rest.includes('--mine')
      const label = rest.find((token) => !token.startsWith('--'))
      try {
        const { run, comparison } = await service.runEval({
          all,
          mine,
          signal: invocation.signal,
          ...(label !== undefined ? { label } : {}),
        })
        const text = [formatEvalRun(run, lang), formatEvalComparison(comparison, lang), evalVerdictToken(run, comparison)].join('\n')
        // A regression is reported as an error result so a caller (script, CI,
        // another plugin) can branch on it without parsing the prose.
        return comparison.verdict === 'regress'
          ? { kind: 'error', text }
          : { kind: 'success', text }
      } catch (error) {
        if (error instanceof OptimizeError) {
          return { kind: 'error', text: error.code === OptimizeErrorCode.UNKNOWN ? error.message : OPTIMIZE_ERROR_TEXT[error.code] }
        }
        return { kind: 'error', text: `prompt-optimize: 评测失败 ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // Quick scene template (1.5.1): `/template <场景>` returns a ready-to-fill
  // four-section template for a detected subcategory — no model call, zero
  // latency/cost. The client renders it as-is.
  // 1.5.6 方案 B: `/template <场景> <指令>`（如 `/template 周报 总结本周进展`）
  // 返回「预填版」——指令经 localTemplateGate 门控通过时用 buildLocalTemplate
  // 本地渲染成品四段（零 token）；门控拒绝时回退骨架并提示走 /optimize。
  ctx.commands.register({
    name: 'template',
    description: 'Return a ready-to-fill scene template (no model call)',
    handler: async (invocation): Promise<CommandResult> => {
      const arg = invocation.rawInput.trim()
      if (arg.length === 0) {
        return { kind: 'error', text: 'prompt-optimize: 用法 /template <场景>（如：周报、邮件、数据分析、部署…）' }
      }
      // 先尝试「场景 + 指令」拆分：首 token 必须独立命中场景（防止把整串当
      // 场景名的关键词子串误匹配），剩余部分作为预填指令。
      let subtype: TaskSubtype | undefined
      let instruction: string | undefined
      const parts = arg.split(/\s+/)
      if (parts.length >= 2) {
        const head = parts[0] ?? ''
        const rest = parts.slice(1).join(' ').trim()
        const headMatch = matchScene(head)
        if (headMatch !== undefined && rest.length > 0) {
          subtype = headMatch
          instruction = rest
        }
      }
      // 无指令拆分 → 整体匹配场景（`/template 周报` 或 `数据分析` 等）。
      if (subtype === undefined) {
        subtype = matchScene(arg)
      }
      if (subtype === undefined) {
        return { kind: 'error', text: `prompt-optimize: 未识别场景 "${arg}"；支持：周报/邮件/文案/翻译/创作/润色/简历/演讲/演示/数据分析/研究/评估/预测/bug修复/新功能/重构/审查/脚本/部署/安装/排查/运维` }
      }
      const en = service.getMetaPromptLanguage() === 'en'
      if (instruction !== undefined) {
        const gate = localTemplateGate(instruction, 'hybrid')
        if (gate.ok) {
          return { kind: 'success', text: buildLocalTemplate(instruction, subtype, en ? 'en' : 'zh') }
        }
        // 门控拒绝：回退骨架，附提示。
        return {
          kind: 'success',
          text: `${renderSceneTemplate(subtype, en)}\n\n（未识别可本地填充的信号——个性化需求请用 /optimize 走完整优化）`,
        }
      }
      return { kind: 'success', text: renderSceneTemplate(subtype, en) }
    },
  })
}
