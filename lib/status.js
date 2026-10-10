/**
 * Runtime status formatting (P1, 1.7.9).
 *
 * Aggregates the optimizer's live state into one human-readable status block:
 * effective parameters (with the resolution source), run statistics, usage
 * preference summary, and the most recent optimization events. Served via
 * `/optimize --status` (and the ✨-adjacent status button in client.js).
 *
 * Pure formatting over the service's snapshot — no harness dependency.
 *
 * @module status
 */
/** Maximum buffered events (FIFO). */
export const STATUS_EVENT_MAX = 20;
/** Map a resolution source token to a human label. */
function sourceLabel(source, lang) {
    if (lang === 'zh') {
        switch (source) {
            case 'user:profile':
            case 'user:local':
            case 'user:temp': return '用户覆盖（命令，会话级）';
            case 'session:profile':
            case 'session:local':
            case 'session:temp': return '会话学习（Layer 1）';
            case 'config': return '基础配置（设置/entry-config）';
            case 'smart:code':
            case 'smart:writing':
            case 'smart:analysis':
            case 'smart:ops':
            case 'smart:other': return '智能默认值（Layer 2）';
            default: return source;
        }
    }
    switch (source) {
        case 'user:profile':
        case 'user:local':
        case 'user:temp': return 'user override (command, session)';
        case 'session:profile':
        case 'session:local':
        case 'session:temp': return 'session learning (Layer 1)';
        case 'config': return 'base config (settings/entry-config)';
        case 'smart:code':
        case 'smart:writing':
        case 'smart:analysis':
        case 'smart:ops':
        case 'smart:other': return 'smart default (Layer 2)';
        default: return source;
    }
}
/** Format a millisecond duration compactly. */
function fmtMs(ms, lang) {
    if (ms >= 60000) {
        const s = (ms / 60000).toFixed(1);
        return lang === 'zh' ? `${s} 分钟` : `${s} min`;
    }
    return `${Math.round(ms)} ms`;
}
/**
 * Billed input tokens of one ledger: uncached input plus both cache sides
 * (the harness contract counts them disjointly, see `TokenUsage`).
 */
function billedInput(stats) {
    return stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
}
/** Cache-read share of the billed input (0 when nothing was billed). */
function cacheReadRate(stats) {
    const billed = billedInput(stats);
    return billed > 0 ? stats.cacheReadTokens / billed : 0;
}
/**
 * Best-of-N selection lines (1.12.0 P1-A). Present only once a selection run
 * happened (`lastSelectCandidates > 1`) or the feature is configured on — a
 * host that never enabled it sees the status block it always had.
 */
function selectionLines(stats, lang) {
    const configured = stats.lastSelectCandidates > 1;
    if (!configured)
        return [];
    const rate = stats.selectRuns > 0 ? Math.round((stats.selectGains / stats.selectRuns) * 100) : 0;
    const score = stats.lastSelectScore > 0 ? stats.lastSelectScore.toFixed(2) : 'n/a';
    return [
        lang === 'zh'
            ? `  择优: 上次 ${stats.lastSelectChosen}/${stats.lastSelectCandidates} 候选（${score}，结构门 ${stats.lastSelectGate}）｜ 累计 ${stats.selectRuns} 次择优，其中 ${stats.selectGains} 次换用非首个候选（${rate}%）`
            : `  Selection: last ${stats.lastSelectChosen}/${stats.lastSelectCandidates} candidates (${score}, gate ${stats.lastSelectGate}) ｜ ${stats.selectRuns} run(s), ${stats.selectGains} replaced the first draw (${rate}%)`,
    ];
}
/**
 * Host feedback lines (1.12.0 P1-B). Counts only; when nothing was ever read
 * there is no line — an empty feature must not look like a measured zero.
 */
function feedbackLines(stats, lang) {
    if (stats.feedbackSessions === 0 && stats.feedbackPositive === 0 && stats.feedbackNegative === 0)
        return [];
    const total = stats.feedbackPositive + stats.feedbackNegative;
    const rate = total > 0 ? Math.round((stats.feedbackNegative / total) * 100) : 0;
    const bias = stats.feedbackBiasApplied === 0
        ? (lang === 'zh' ? '无偏置' : 'no bias')
        : `${stats.feedbackBiasApplied > 0 ? '+' : ''}${stats.feedbackBiasApplied}`;
    return [
        lang === 'zh'
            ? `  宿主反馈: 👍 ${stats.feedbackPositive} / 👎 ${stats.feedbackNegative}（${stats.feedbackSessions} 个会话${total > 0 ? `，负面 ${rate}%` : ''}）｜ 温度偏置 ${bias}`
            : `  Host feedback: 👍 ${stats.feedbackPositive} / 👎 ${stats.feedbackNegative} (${stats.feedbackSessions} session(s)${total > 0 ? `, ${rate}% negative` : ''}) ｜ temperature bias ${bias}`,
    ];
}
/**
 * The evaluation-harness line (1.11.0): the latest aggregate, its baseline and
 * the verdict. Absent summary → no line at all, so a host that never measured
 * sees the status block it always had.
 */
function evalLines(summary, lang) {
    if (summary === undefined)
        return [];
    const score = summary.aggregate === undefined ? 'n/a' : summary.aggregate.toFixed(2);
    const base = summary.baseline === undefined ? 'n/a' : summary.baseline.toFixed(2);
    const verdictLabel = lang === 'zh'
        ? { pass: '通过', regress: '回归', 'below-threshold': '未达阈值', 'no-baseline': '无基线', 'no-score': '无判分' }
        : { pass: 'pass', regress: 'REGRESS', 'below-threshold': 'below threshold', 'no-baseline': 'no baseline', 'no-score': 'nothing scored' };
    const verdict = summary.verdict === undefined ? 'n/a' : (verdictLabel[summary.verdict] ?? summary.verdict);
    const when = new Date(summary.at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false });
    return [
        lang === 'zh'
            ? `  评测: 最近 ${score}（基线 ${base}，${verdict}）｜ 历史 ${summary.runs} 次 ｜ ${when}`
            : `  Eval: latest ${score} (baseline ${base}, ${verdict}) ｜ ${summary.runs} run(s) ｜ ${when}`,
    ];
}
/**
 * The provider-reported usage ledger (1.10.0), rendered as one or two lines.
 *
 * The point of these lines is to make the difference between a MEASUREMENT and
 * an ESTIMATE visible: before this the stats block only ever showed heuristic
 * token guesses, indistinguishable from real numbers. `usageCalls === 0` says
 * so out loud instead of printing a plausible-looking zero.
 */
function usageLines(stats, lang) {
    const last = stats.lastRunUsage;
    if (stats.usageCalls === 0) {
        return [
            lang === 'zh'
                ? '  真实用量: 适配器未上报 usage——上面两个 token 数是启发式估算'
                : '  Real usage: adapter reported no usage — the two token counts above are heuristic estimates',
        ];
    }
    const billed = billedInput(stats);
    const out = [];
    if (lang === 'zh') {
        out.push(`  真实用量: 累计 input ${billed}（缓存读 ${stats.cacheReadTokens} / 写 ${stats.cacheWriteTokens} / 未缓存 ${stats.inputTokens}）｜ output ${stats.outputTokens}`);
        out.push(`  缓存命中 ${Math.round(cacheReadRate(stats) * 100)}% ｜ ${stats.usageCalls} 次调用上报${stats.reasoningTokens > 0 ? ` ｜ 推理 ${stats.reasoningTokens} tok` : ''}`);
        if (last !== null)
            out.push(`  ${lastRunLine(last, stats.lastRunCalls, lang)}`);
    }
    else {
        out.push(`  Real usage: cumulative input ${billed} (cache read ${stats.cacheReadTokens} / write ${stats.cacheWriteTokens} / uncached ${stats.inputTokens}) ｜ output ${stats.outputTokens}`);
        out.push(`  Cache hit ${Math.round(cacheReadRate(stats) * 100)}% ｜ reported by ${stats.usageCalls} calls${stats.reasoningTokens > 0 ? ` ｜ reasoning ${stats.reasoningTokens} tok` : ''}`);
        if (last !== null)
            out.push(`  ${lastRunLine(last, stats.lastRunCalls, lang)}`);
    }
    return out;
}
/**
 * The model the last run actually called (1.13.0, benchmark checklist item 6).
 *
 * No line at all when that run called no model — a local zero-token render or
 * a cache hit has no model to declare, and reusing the previous one would
 * attribute it to a run that never touched the model. The route shown is the
 * RESOLVED one: an explicit `provider`/`model` pair from the config, or what
 * the host's `agentDefaultModel` reported.
 */
function modelLines(stats, lang) {
    const route = stats.lastRunRoute;
    if (route === null)
        return [];
    const effort = route.reasoningEffort === undefined
        ? ''
        : (lang === 'zh' ? ` ｜ 推理档 ${route.reasoningEffort}` : ` ｜ effort ${route.reasoningEffort}`);
    return [
        lang === 'zh'
            ? `  目标模型: ${route.provider}/${route.model}${effort}`
            : `  Target model: ${route.provider}/${route.model}${effort}`,
    ];
}
/**
 * One line for the last run. `lastRunUsage.calls` and `lastRunCalls` answer
 * different questions — the former counts calls that REPORTED usage, the
 * latter counts calls that were MADE — so a zero in the first field alone
 * cannot be read as "this run cost nothing": an adapter without usage support
 * produces the same zero after three real calls.
 */
function lastRunLine(last, modelCalls, lang) {
    if (last.calls === 0 && modelCalls === 0) {
        return lang === 'zh' ? '上次优化: 0 次模型调用（缓存命中或本地直出）' : 'Last run: 0 model calls (cache hit or local render)';
    }
    if (last.calls === 0) {
        return lang === 'zh'
            ? `上次优化: ${modelCalls} 次模型调用均未上报 usage`
            : `Last run: ${modelCalls} model calls, none reported usage`;
    }
    const billed = last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens;
    return lang === 'zh'
        ? `上次优化: input ${billed} ｜ output ${last.outputTokens}（${last.calls}/${modelCalls} 次调用上报）`
        : `Last run: input ${billed} ｜ output ${last.outputTokens} (${last.calls}/${modelCalls} calls reported)`;
}
/** Format the full status block. */
export function formatStatus(snapshot, lang = 'zh') {
    const lines = [];
    const { effective, stats, prefs, recentEvents } = snapshot;
    if (lang === 'zh') {
        lines.push('📋 prompt-optimizer 运行状态');
        lines.push('');
        lines.push('⚙️ 当前生效参数：');
        lines.push(`  Profile: ${effective.profile} ｜ 本地模板: ${effective.localTemplate} ｜ 温度: ${effective.temperature}`);
        lines.push(`  来源: ${sourceLabel(effective.source, lang)}`);
        lines.push(`  自迭代: ${snapshot.autoAdapt ? '开（≥' + snapshot.minAdaptEpisodes + ' 次生效）' : '关'} ｜ 设置面板: ${snapshot.settingsPanel ? '可用' : '不可用（走 cordis.patch.yml）'}`);
        lines.push('');
        lines.push('📊 运行统计：');
        lines.push(`  总次数 ${stats.runs}（成功 ${stats.success} / 失败 ${stats.failed} / 缓存 ${stats.cached}）`);
        lines.push(`  本地直出 ${stats.local}（精修 ${stats.refined}）｜ 平均耗时 ${fmtMs(stats.avgCallMs, lang)}（最长 ${fmtMs(stats.maxDurationMs, lang)}）`);
        lines.push(`  平均调用 ${stats.callCount > 0 ? (stats.callCount / Math.max(1, stats.runs)).toFixed(1) : 0} 次/次优化 ｜ 上次输出 ${stats.lastOutputTokens} tok`);
        lines.push(...usageLines(stats, lang));
        lines.push(...modelLines(stats, lang));
        lines.push(...selectionLines(stats, lang));
        lines.push(...feedbackLines(stats, lang));
        lines.push(...evalLines(snapshot.evalSummary, lang));
        lines.push('');
        lines.push('🧠 偏好模型（最近 ' + prefs.total + ' 次）：');
        if (prefs.total > 0) {
            if (prefs.dominantTaskType !== undefined)
                lines.push(`  最常用: ${prefs.dominantTaskType}`);
            lines.push(`  本地模板使用率 ${Math.round(prefs.localUsageRate * 100)}% / 接受率 ${Math.round(prefs.localAcceptanceRate * 100)}%`);
            lines.push(`  平均质量 ${prefs.avgQuality.toFixed(2)}（${prefs.feedbackCount} 次反馈）｜ 编辑率 ${Math.round(prefs.editRate * 100)}%`);
        }
        else {
            lines.push('  暂无记录，使用 /optimize 后生成。');
        }
        lines.push('');
        lines.push('🕘 最近事件（' + recentEvents.length + '）：');
        if (recentEvents.length === 0) {
            lines.push('  暂无。');
        }
        else {
            for (const ev of recentEvents.slice(-6).reverse()) {
                const time = new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false });
                const tag = ev.ok ? '✅' : '❌';
                const detail = ev.ok
                    ? `${ev.outputTokens !== undefined ? ev.outputTokens + ' tok' : ''}${ev.local ? ' 本地' : ''}`
                    : (ev.errorCode ?? 'error');
                lines.push(`  ${time} ${tag} ${ev.method} ${detail}${ev.durationMs !== undefined ? ' · ' + fmtMs(ev.durationMs, lang) : ''}`);
            }
        }
        lines.push('');
        lines.push('（设置项请在 Harness 设置 → 插件设置调整；命令覆盖为会话级）');
    }
    else {
        lines.push('📋 prompt-optimizer status');
        lines.push('');
        lines.push('⚙️ Effective params:');
        lines.push(`  Profile: ${effective.profile} ｜ Local template: ${effective.localTemplate} ｜ Temp: ${effective.temperature}`);
        lines.push(`  Source: ${sourceLabel(effective.source, lang)}`);
        lines.push(`  Auto-adapt: ${snapshot.autoAdapt ? 'on (≥' + snapshot.minAdaptEpisodes + ' runs)' : 'off'} ｜ Settings panel: ${snapshot.settingsPanel ? 'available' : 'unavailable (cordis.patch.yml)'}`);
        lines.push('');
        lines.push('📊 Stats:');
        lines.push(`  Runs ${stats.runs} (ok ${stats.success} / fail ${stats.failed} / cached ${stats.cached})`);
        lines.push(`  Local ${stats.local} (refined ${stats.refined}) ｜ avg ${fmtMs(stats.avgCallMs, lang)} (max ${fmtMs(stats.maxDurationMs, lang)})`);
        lines.push(`  Avg calls ${stats.callCount > 0 ? (stats.callCount / Math.max(1, stats.runs)).toFixed(1) : 0}/run ｜ last out ${stats.lastOutputTokens} tok`);
        lines.push(...usageLines(stats, lang));
        lines.push(...modelLines(stats, lang));
        lines.push(...selectionLines(stats, lang));
        lines.push(...feedbackLines(stats, lang));
        lines.push(...evalLines(snapshot.evalSummary, lang));
        lines.push('');
        lines.push('🧠 Preference model (last ' + prefs.total + ' runs):');
        if (prefs.total > 0) {
            if (prefs.dominantTaskType !== undefined)
                lines.push(`  Dominant: ${prefs.dominantTaskType}`);
            lines.push(`  Local usage ${Math.round(prefs.localUsageRate * 100)}% / acceptance ${Math.round(prefs.localAcceptanceRate * 100)}%`);
            lines.push(`  Avg quality ${prefs.avgQuality.toFixed(2)} (${prefs.feedbackCount} feedback) ｜ edit ${Math.round(prefs.editRate * 100)}%`);
        }
        else {
            lines.push('  No records yet — run /optimize to build them.');
        }
        lines.push('');
        lines.push('🕘 Recent events (' + recentEvents.length + '):');
        if (recentEvents.length === 0) {
            lines.push('  none.');
        }
        else {
            for (const ev of recentEvents.slice(-6).reverse()) {
                const time = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false });
                const tag = ev.ok ? '✅' : '❌';
                const detail = ev.ok
                    ? `${ev.outputTokens !== undefined ? ev.outputTokens + ' tok' : ''}${ev.local ? ' local' : ''}`
                    : (ev.errorCode ?? 'error');
                lines.push(`  ${time} ${tag} ${ev.method} ${detail}${ev.durationMs !== undefined ? ' · ' + fmtMs(ev.durationMs, lang) : ''}`);
            }
        }
        lines.push('');
        lines.push('(Adjust options in Harness Settings → plugin settings; command overrides are session-scoped)');
    }
    return lines.join('\n');
}
