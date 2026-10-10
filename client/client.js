// prompt-optimizer browser client half — hand-written in the harness ModuleLoader
// format (no bundler needed). Declared via package.json `dsh.client` and exported
// as `./client`; the harness serves this file and registers the plugin.
//
// UI:
// - ✨ optimize button (composer tool row, left): optimizes the current draft,
//   offers a one-click ↺ restore, shows spinner/error states.
// - aria-live announcements for success/failure/undo (screen readers).
//
// The role-document language is resolved automatically from the instruction
// (`metaPromptLanguage: 'auto'`, the default) — no language button is shipped.
//
// UI/UX: 28px hit area with a 16px stroke icon; theme-token colors; hover and
// active feedback; :focus-visible ring; disabled state; aria-label + tooltip.
window.__ModuleLoader__.load({
  id: 'oss-prompt-optimizer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var name = 'prompt-optimizer-client'
    // The `commands` Remote namespace is generated and mounted at boot (strict
    // descriptor), so it is injectable — unlike a custom @Remote namespace,
    // which this deployment cannot claim on the host. Buttons drive the host's
    // `/optimize` and `/auto-optimize` commands through `remote.commands.execute`.
    //
    // 1.8.2: the inject list is the MINIMUM the client half cannot work without.
    // `configForms`, `sessions` and `locale` are all read defensively through
    // `ctx.get()`, so listing them here only turned "settings page missing" into
    // "the whole client half never loads". Gating everything on them is what made
    // a single renamed service take the ✨ button offline.
    //
    // RULE (R2): every `ctx.<name>` read in this file must appear in `inject`,
    // because reading a service that is not injected THROWS at access time.
    // Optional services therefore have to go through `ctx.get('<name>')` and be
    // null-checked — `inject` is a hard gate, `ctx.get()` is not.
    // `tests/client-inject-contract.test.ts` scans for direct reads, and
    // `scripts/client-probe.mjs` re-checks the built artifact.
    var inject = ['remote']
    // The Host plugin entry id AND the settings namespace are the same string
    // (`cordis.patch.yml` `insert.id`), which is what `configForms.get()` keys on.
    var SETTINGS_NS = 'prompt-optimizer'
    var NS = 'prompt-optimizer-client'
    // Every string a user can see lives here, in both languages. The ✨ button
    // used to build its title/aria text from hardcoded Chinese literals, which
    // is the other half of "the UI does not follow the language": a dictionary
    // that is complete except for the one control the user interacts with is
    // still a control stuck in one language (1.13.1).
    var zh = {
      'section.nav': '提示词优化',
      'section.sub': 'oss-prompt-optimizer · 配置与运行状态',
      'action.status': '查看运行状态',
      'action.reset': '恢复全部默认',
      'saved': '已保存：',
      'reset.all.done': '已恢复全部默认',
      'opt.on': '开启',
      'opt.off': '关闭',
      'field.meta': '默认 {default} · 当前 {current}',
      'btn.label': '优化提示词',
      'btn.title': '优化提示词 (prompt-optimizer)',
      'btn.busy': '正在优化…（点击取消）',
      'btn.cancel': '取消优化',
      'btn.undo': '恢复优化前的提示词',
      'btn.failed': '优化失败',
      'announce.cancelled': '已取消优化',
      'announce.restored': '已恢复优化前的原文',
      'announce.optimized': '提示词已优化，可点击撤销按钮恢复原文',
      'announce.optimized.cost': '提示词已优化（消耗约 {tokens} tokens），可点击撤销按钮恢复原文',
      'error.prefix': '优化失败：',
      'error.retry': '优化失败，请重试',
      'save.failed': '保存失败：',
      'save.rejected': '宿主拒绝了这次修改：',
      'restore.failed': '恢复失败：',
      'panel.loading': '正在读取宿主配置…',
      'panel.unavailable': '宿主未提供可写的配置服务（本页面可能不是本机地址）。请在 cordis.patch.yml 中修改本插件配置。',
      'panel.readonly': '当前连接只能读取配置，改动不会写入宿主。',
      'status.unknown.session': '设置页无法确定当前会话——请在对话中运行 /optimize --status 查看状态。',
      'status.fetch.failed': '无法获取状态：',
      'hint': '本页仅列 8 项核心开关（可即时生效、无需重启）；其余配置（温度 / 预算 / 模板 / 评测等，大多已调优）写在 cordis.patch.yml 中。',
    }
    var en = {
      'section.nav': 'Prompt Optimizer',
      'section.sub': 'oss-prompt-optimizer · config & status',
      'action.status': 'View status',
      'action.reset': 'Reset all to defaults',
      'saved': 'Saved: ',
      'reset.all.done': 'All defaults restored',
      'opt.on': 'On',
      'opt.off': 'Off',
      'field.meta': 'Default {default} · current {current}',
      'btn.label': 'Optimize prompt',
      'btn.title': 'Optimize prompt (prompt-optimizer)',
      'btn.busy': 'Optimizing… (click to cancel)',
      'btn.cancel': 'Cancel optimization',
      'btn.undo': 'Restore the prompt from before optimization',
      'btn.failed': 'Optimization failed',
      'announce.cancelled': 'Optimization cancelled',
      'announce.restored': 'Original draft restored',
      'announce.optimized': 'Prompt optimized — click undo to restore the original draft',
      'announce.optimized.cost': 'Prompt optimized (~{tokens} tokens) — click undo to restore the original draft',
      'error.prefix': 'Optimization failed: ',
      'error.retry': 'Optimization failed — please retry',
      'save.failed': 'Save failed: ',
      'save.rejected': 'The host refused the change: ',
      'restore.failed': 'Restore failed: ',
      'panel.loading': 'Reading host configuration…',
      'panel.unavailable': 'This host exposes no writable configuration service (this page may not be a local address). Edit this plugin in cordis.patch.yml instead.',
      'panel.readonly': 'This connection can only read configuration; changes will not reach the host.',
      'status.unknown.session': 'The settings page cannot determine the current session — run /optimize --status in a conversation to see the status.',
      'status.fetch.failed': 'Unable to fetch status: ',
      'hint': 'This page lists the 8 core switches only (each applies immediately, no restart); the remaining options (temperature / budgets / templates / evaluation — mostly pre-tuned) live in cordis.patch.yml.',
    }

    /** Shallow-merge `extra` into `base` (this file ships unbuilt — no object spread). */
    function merged(base, extra) {
      for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) base[key] = extra[key]
      return base
    }

    // One idempotent stylesheet for the buttons (injected once; global classes
    // are unique to this plugin so they never collide with product styles).
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('po-optimize-btn-styles')) return
      var style = document.createElement('style')
      style.id = 'po-optimize-btn-styles'
      style.textContent = [
        '.po-optimize-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary, inherit);cursor:pointer;transition:background-color .15s ease,color .15s ease,opacity .15s ease,transform .1s ease}',
        '.po-optimize-btn:hover:not(:disabled),.po-optimize-btn:focus-visible{background:var(--dsw-alias-bg-layer-1, rgba(0,0,0,.06));color:var(--dsw-alias-brand-primary, inherit)}',
        '.po-optimize-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, currentColor);outline-offset:1px}',
        '.po-optimize-btn:active:not(:disabled){transform:scale(.94)}',
        '.po-optimize-btn:disabled{opacity:.4;cursor:not-allowed}',
        '.po-optimize-btn.is-undo{color:var(--dsw-alias-brand-primary, inherit)}',
        '.po-optimize-btn.has-error{color:var(--dsw-alias-state-error-primary, #d93026)}',
        '.po-cost{display:inline-flex;align-items:center;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary, inherit);margin-left:6px;white-space:nowrap;transition:opacity .15s ease}',
        '.po-status-btn{margin-left:2px;font-size:14px;line-height:1}.po-status-btn.is-active{color:var(--dsw-alias-brand-primary, inherit);background:var(--dsw-alias-bg-layer-1, rgba(0,0,0,.06))}',
        '.po-status-pre{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-text-primary, inherit);max-height:40vh;overflow:auto}',
        '.po-section{padding:4px 2px}.po-section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}.po-section-title{font-size:15px;font-weight:600;color:var(--dsw-alias-text-primary, inherit)}.po-section-sub{font-size:12px;color:var(--dsw-alias-label-secondary, inherit);margin-top:2px}',
        '.po-field{margin-bottom:12px}.po-field-label{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:var(--dsw-alias-text-primary, inherit);margin-bottom:4px}.po-field-default{font-size:11px;color:var(--dsw-alias-label-secondary, inherit)}',
        '.po-field-input{width:100%;box-sizing:border-box;padding:5px 8px;font-size:13px;border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.18));border-radius:6px;background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-text-primary, inherit)}.po-field-input:focus{outline:2px solid var(--dsw-alias-brand-primary, currentColor);outline-offset:0;border-color:transparent}.po-field-input:disabled{opacity:.55;cursor:not-allowed}',
        '.po-save{margin-top:4px;padding:6px 16px;font-size:13px;border:none;border-radius:6px;background:var(--dsw-alias-brand-primary, #0052d9);color:#fff;cursor:pointer}.po-save:hover{opacity:.9}',
        '.po-status-panel{position:static;max-width:none;background:var(--dsw-alias-bg-layer-2, #fff);border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.12));border-radius:8px;padding:10px 12px;margin-top:12px}',
        '.po-status-pre{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-text-primary, inherit);max-height:40vh;overflow:auto}',
        '.po-reset{margin-top:4px;padding:2px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.18));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary, inherit);cursor:pointer}.po-reset:hover{color:var(--dsw-alias-brand-primary, inherit);border-color:currentColor}',
        '.po-group{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary, inherit);margin:16px 0 8px;text-transform:uppercase;letter-spacing:.04em}',
        '.po-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary, inherit)}.po-link{color:var(--dsw-alias-brand-primary, inherit);cursor:pointer;text-decoration:underline}',
        '.po-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px}',
      ].join('')
      document.head.appendChild(style)
    }

    // Sparkles glyph (Lucide-style, stroke draws in currentColor).
    function SparklesIcon() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }),
        React.createElement('path', { d: 'M20 3v4' }),
        React.createElement('path', { d: 'M22 5h-4' }),
        React.createElement('path', { d: 'M4 17v2' }),
        React.createElement('path', { d: 'M5 18H3' }),
      )
    }

    // Rotating arc spinner (SMIL animation — no CSS keyframes needed).
    function SpinnerIcon() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
        React.createElement('circle', { cx: 12, cy: 12, r: 8, stroke: 'var(--dsw-alias-brand-primary, currentColor)', strokeWidth: 2.5, opacity: 0.25 }),
        React.createElement(
          'path',
          { d: 'M20 12a8 8 0 0 0-8-8', stroke: 'var(--dsw-alias-brand-primary, currentColor)', strokeWidth: 2.5, strokeLinecap: 'round' },
          React.createElement('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 12 12', to: '360 12 12', dur: '0.8s', repeatCount: 'indefinite' }),
        ),
      )
    }

    // Undo / rotate-ccw glyph: restores the pre-optimization draft.
    function UndoIcon() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
        React.createElement('path', { d: 'M3 3v5h5' }),
      )
    }

    // Unwrap the gateway envelope { ok, value } to the CommandExecution result.
    function resultOf(response) {
      var execution = response && response.ok ? response.value : undefined
      return execution && execution.result
    }

    // Editable core fields shown on the Settings-sidebar page (a curated subset;
    // the full 45+ fields live on the plugin card auto-rendered by the settings
    // Plugins section from the registered namespace schema). 核心 = 需要用户
    // 决策的开关类；温度/输出 token/预算等默认已调优，不进本页。
    var PO_FIELDS = [
      { key: 'outputStyle', label: '输出形态', type: 'select', group: '输出', defaultValue: 'plain',
        options: [['plain', '纯文本（最省 token）'], ['role-task-goal', '三要素标签'], ['sections', '四段结构']] },
      { key: 'situationProfileLevel', label: '情境感知画像', type: 'select', group: '情境感知', defaultValue: 'full',
        options: [['full', '完整（角色/任务/目标）'], ['minimal', '精简'], ['off', '关闭']] },
      { key: 'contextAware', label: '上下文感知（自动采集对话背景）', type: 'boolean', group: '情境感知', defaultValue: true },
      { key: 'cacheEnabled', label: '结果缓存（相同请求零调用）', type: 'boolean', group: '缓存', defaultValue: true },
      { key: 'optimizationProfile', label: '优化档位', type: 'select', group: '运行', defaultValue: 'balanced',
        options: [['balanced', '均衡'], ['fast', '快速（省时，跳过部分校验）']] },
      { key: 'localTemplate', label: '本地模板（零 token）', type: 'select', group: '运行', defaultValue: 'off',
        options: [['off', '关闭（默认，LLM 优化）'], ['on', '开启'], ['hybrid', '混合']] },
      { key: 'autoOptimize', label: '自动优化（前缀触发）', type: 'boolean', group: '自动', defaultValue: true },
      { key: 'autoAdapt', label: '自迭代学习（越用越好用）', type: 'boolean', group: '自动', defaultValue: true },
    ]


    // ---------------------------------------------------------------------
    // Composer contract adaptation (1.8.2)
    //
    // The slot props shape is a harness-internal contract and it MOVED between
    // releases: 0.1.0-rc.6 passed the input snapshot as `props.input.draft`,
    // 0.1.5-rc.2 replaced it with a `props.useInput(selector)` hook and strips
    // the raw snapshot. Reading only one shape meant the button silently stayed
    // disabled forever with no error anywhere. Each accessor below tries every
    // known shape in turn and type-guards the result.
    // ---------------------------------------------------------------------

    /** Read the current draft text from any known slot-props shape. */
    function resolveDraft(props) {
      if (!props) return ''
      var useInput = props.useInput
      if (typeof useInput === 'function') {
        var viaHook = useInput(function (state) {
          return state && typeof state.draft === 'string' ? state.draft : ''
        })
        if (typeof viaHook === 'string') return viaHook
      }
      var snapshot = props.input
      if (snapshot && typeof snapshot.draft === 'string') return snapshot.draft
      var legacy = props.hooks && props.hooks.input
      if (legacy && typeof legacy.draft === 'string') return legacy.draft
      return ''
    }

    /** Write access to the composer draft, from any known slot-props shape. */
    function resolveInputActions(props) {
      if (!props) return null
      var direct = props.inputActions
      if (direct && typeof direct.setDraft === 'function') return direct
      var hooked = props.hooks && props.hooks.inputActions
      if (hooked && typeof hooked.setDraft === 'function') return hooked
      return null
    }

    /** Whether props carry any known draft-reading contract. Pure. */
    function hasInputContract(props) {
      if (!props) return false
      if (typeof props.useInput === 'function') return true
      if (props.input && typeof props.input.draft === 'string') return true
      var legacy = props.hooks && props.hooks.input
      return !!(legacy && typeof legacy.draft === 'string')
    }

    /**
     * Whether the harness exposes the composer contract this plugin needs.
     * Pure — the hook-backed draft must already have been resolved by the
     * caller, so no React hook is invoked from a predicate.
     *
     * When false, the button renders nothing at all (a missing button beats one
     * that can never be clicked) and the prop names are logged once, so the next
     * contract change diagnoses itself instead of silently disabling the UI.
     */
    function composerSupported(props, draft, inputActions) {
      return typeof draft === 'string' && inputActions !== null && hasInputContract(props)
    }

    /** Log the unsupported-props diagnosis once per session. */
    var unsupportedLogged = false
    function warnUnsupportedComposer(props) {
      if (unsupportedLogged) return
      unsupportedLogged = true
      console.warn(
        '[prompt-optimizer] unsupported composer contract — the optimize button is not rendered. props keys:',
        props ? Object.keys(props) : props,
      )
    }

    async function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      // `locale` is deliberately NOT in `inject`, so it must be read through
      // `ctx.get()` — never as `ctx.locale`. Direct property access on a
      // service outside `inject` throws `cannot get property "locale" without
      // inject`, and an uncaught throw here aborts this entire `apply()`. 1.8.2
      // shipped exactly that: the inject list was cut down, this line was left
      // behind, and every real machine lost BOTH the ✨ button and the settings
      // page. `ctx.get()` returns the service when the host provides one and
      // `undefined` when it does not, and never throws.
      var locale = ctx.get('locale')
      // Whether the host installed a locale face decides whether the slot
      // registrations may DECLARE a namespace (`locale: NS`). Declaring one is
      // what makes the renderer synthesize the `t` seat for our components
      // (`kit['t'] = localeSeat(face, entry.locale)`, re-derived per locale
      // revision — see the section component below) — but the renderer THROWS
      // when an entry declares a namespace and no face is installed, and that
      // throw takes the section down with it. So the declaration is gated on the
      // face being here, and a host without one keeps working through the
      // per-call lookup below.
      var localeFace = locale && typeof locale.bind === 'function' ? locale : null
      var localeOption = localeFace === null ? {} : { locale: NS }

      // Registration is lazy for the same reason the lookup is: this plugin's
      // `apply()` can run before the locale plugin's, which is `async` and awaits
      // its native bootstrap before `ctx.provide('locale', …)`. Attempting once
      // here and once at the first lookup covers both orders, and
      // `dictsRegistered` keeps it to exactly one registration.
      var dictsRegistered = false
      function ensureDictionary() {
        if (dictsRegistered) return
        var live = ctx.get('locale')
        if (!live || typeof live.register !== 'function') return
        dictsRegistered = true
        ctx.effect(function () {
          try {
            return live.register(NS, { zh: zh, en: en })
          } catch (error) {
            // A plugin update re-runs this file while the previous fiber's
            // registrations may still be standing, and the runtime refuses a
            // duplicate namespace+locale pair ("already has locale"). The
            // disposer is identity-guarded — it removes only the entries it
            // registered — so the dictionaries already in place stay valid and
            // carrying on is the safe resolution. An uncaught throw here would
            // abort `apply()` and take the ✨ button and the settings page with
            // it, which is strictly worse than keeping an old-but-equal copy of
            // the same strings.
            console.warn('[prompt-optimizer] dictionary registration skipped:', error && error.message)
            return undefined
          }
        })
      }
      ensureDictionary()

      // No translator is captured, deliberately. `locale.bind(NS)` returns a
      // LIVE closure — it reads the active language at call time, so a frozen
      // `t` was never the failure mode it looked like — but a binding taken now
      // can only ever see the face that exists now: one provided after this
      // `apply()` ran is invisible to it, and then every label resolves to the
      // raw key for the whole session. Resolving per call costs one store lookup
      // per rendered string and cannot go stale — the same rule `executeCommand`
      // follows for `remote.commands`.
      function translate(key, params) {
        ensureDictionary()
        var live = ctx.get('locale')
        if (!live || typeof live.bind !== 'function') return key
        var bound = live.bind(NS)
        return params === undefined ? bound(key) : bound(key, params)
      }

      // One-shot self-check, ~2.5 s after activation so a host preference that
      // merely lands late is not mistaken for a fault. Silent whenever our copy
      // resolves in the active language — every healthy session — and otherwise
      // names which layer is wrong, instead of leaving "the settings are in
      // English" to be re-derived from scratch each time it is reported.
      // Removable in one edit: this function plus its single call site.
      var lastLocaleWarning
      function diagnoseLocale() {
        var live = ctx.get('locale')
        if (!live || typeof live.bind !== 'function' || typeof live.getSnapshot !== 'function') return
        var snapshot
        try { snapshot = live.getSnapshot() } catch (error) { return }
        if (!snapshot || typeof snapshot !== 'object') return
        var active = typeof snapshot.active === 'string' ? snapshot.active : ''
        var expected = active === 'zh' ? zh['section.nav'] : en['section.nav']
        var got = live.bind(NS)('section.nav')
        if (got === expected) return
        var who = got === 'section.nav'
          ? 'our dictionary never reached the runtime'
          : 'the runtime resolved another language (host-side)'
        var message = '[prompt-optimizer] locale self-check: the settings copy is not in the active language'
          + ' — active=' + active
          + ' revision=' + String(snapshot.revision)
          + ' resolve("section.nav")=' + JSON.stringify(got)
          + ' expected=' + JSON.stringify(expected)
          + ' ⇒ ' + who
        if (message === lastLocaleWarning) return
        lastLocaleWarning = message
        console.warn(message)
      }
      if (typeof setTimeout === 'function') setTimeout(diagnoseLocale, 2500)

      // `remote.commands` is a NESTED service name, not a property of the
      // `remote` service: dsh-api-gateway registers every remote namespace
      // separately as `remote.<namespace>` (`remoteServiceKey`, and each
      // namespace is mounted as its own cordis `Service`). Because the value of
      // `ctx.get('remote')` is a Service, cordis rewrites a read of `.commands`
      // on it into a read of `ctx['remote.commands']` — straight back through
      // the inject gate — so `ctx.get('remote').commands` throws
      // `cannot get property "remote.commands" without inject`, and
      // `ctx.remote.commands` throws the same. `ctx.get()` with the full dotted
      // name is the only safe read, and it must stay out of `inject`: a nested
      // name in the gate would turn "this namespace is not mounted yet" into
      // "the whole client half never loads".
      //
      // Resolved per call rather than once here: a namespace is mounted by
      // whichever contribution carries it, which may happen after this
      // `apply()` already ran. Caching the lookup would pin the button to a
      // channel that was still missing at registration time.
      function executeCommand(sessionId, command, args, signal) {
        var channel = ctx.get('remote.commands')
        if (!channel || typeof channel.execute !== 'function') {
          return Promise.reject(new Error('remote.commands is unavailable'))
        }
        return channel.execute(sessionId, command, args, signal)
      }

      // ✨ Optimize button (composer tool row, left).
      slots.inject('conversation.input.left', function () {
        return slots.register(
          merged({
            name: 'conversation.input.left',
            id: 'prompt-optimizer',
            order: 10,
            // A thunk, not a literal: the label is re-read whenever the slot
            // ledger is projected, so it follows the active language without
            // re-registering (`SlotLabel = string | (() => string)`).
            label: function () { return translate('btn.label') },
          }, localeOption),
          function OptimizeButton(props) {
            ensureStyles()
            // The framework-synthesized `t` seat, present because this entry
            // declares `locale: NS` (see `localeOption`). Preferred over our own
            // lookup because the seat carries the locale revision in its
            // identity; the per-call lookup is the fallback for hosts that
            // installed no locale face, where the seat does not exist.
            var t = props && typeof props.t === 'function' ? props.t : translate
            var busyState = React.useState(false)
            var busy = busyState[0]
            var setBusy = busyState[1]
            // After a successful optimization, remember { original, optimized }
            // so the button can offer a one-click restore. Cleared on undo or
            // when the user edits the draft (canUndo requires draft unchanged).
            var undoState = React.useState(null)
            var undo = undoState[0]
            var setUndo = undoState[1]
            // Transient error feedback: the real failure text surfaces on the
            // button (red icon + tooltip) for a few seconds, then clears.
            var errorState = React.useState(null)
            var error = errorState[0]
            var setError = errorState[1]
            // AbortController for the in-flight /optimize call (click-to-cancel).
            var cancelRef = React.useRef(null)
            // Transient "consumed ≈N tokens" hint after a fresh optimization
            // (roadmap 要优化的功能 #5: 成本可见).
            var costState = React.useState(null)
            var cost = costState[0]
            var setCost = costState[1]
            // aria-live announcement (screen readers / assistive tech).
            var announceState = React.useState('')
            var announce = announceState[0]
            var setAnnounce = announceState[1]
            // Composer contract resolution (1.8.2) — see the helpers above.
            // Deliberately after every hook call so hook order stays
            // unconditional: an unsupported contract renders nothing at all
            // rather than a button that can never be clicked.
            var draft = resolveDraft(props)
            var inputActions = resolveInputActions(props)
            if (!composerSupported(props, draft, inputActions)) {
              warnUnsupportedComposer(props)
              return null
            }
            // The error flash never blocks a retry: clicking again retries
            // immediately (and clears the flash).
            var canOptimize = draft.trim().length > 0 && !busy
            var canUndo = !busy && undo !== null && draft === undo.optimized

            function flashError(message) {
              setError(message)
              setAnnounce(t('error.prefix') + message)
              if (typeof setTimeout === 'function') {
                setTimeout(function () { setError(null) }, 4000)
              }
            }

            function onClick() {
              // Clicking while optimizing cancels the in-flight call
              // (roadmap 要优化的功能 #4: 取消反馈).
              if (busy) {
                if (cancelRef.current) {
                  cancelRef.current.abort()
                  cancelRef.current = null
                }
                setBusy(false)
                setAnnounce(t('announce.cancelled'))
                return
              }
              if (canUndo) {
                inputActions.setDraft(undo.original)
                setUndo(null)
                setAnnounce(t('announce.restored'))
                return
              }
              if (!canOptimize) return
              if (error !== null) setError(null)
              setBusy(true)
              var controller = typeof AbortController === 'function' ? new AbortController() : null
              cancelRef.current = controller
              var signal = controller ? controller.signal : undefined
              executeCommand(props.sessionId, '/optimize ' + draft, [], signal)
                .then(function (response) {
                  // 取消结算（dsh 协议）：宿主以 { ok:false, error:{message:'This
                  // operation was aborted'} } resolve——须在 ok:false 信封层先识别
                  // 取消，否则落入 unexpected 分支误报「优化失败」（1.7.6）。
                  if (response === undefined || response.ok === false) {
                    if (controller && controller.signal.aborted) {
                      setAnnounce(t('announce.cancelled'))
                      return
                    }
                    var errMsg = response && response.error && typeof response.error.message === 'string'
                      ? response.error.message
                      : t('error.retry')
                    flashError(errMsg)
                    return
                  }
                  var result = resultOf(response)
                  if (result && result.kind === 'success' && typeof result.text === 'string' && result.text.length > 0) {
                    setUndo({ original: draft, optimized: result.text })
                    inputActions.setDraft(result.text)
                    setAnnounce(t('announce.optimized'))
                    // 成本可见: read the last run's output tokens and show a
                    // transient hint. Best-effort; a failure is ignored.
                    executeCommand(props.sessionId, '/optimize --stats', [])
                      .then(function (statsResponse) {
                        var statsResult = resultOf(statsResponse)
                        var match = statsResult && typeof statsResult.text === 'string'
                          ? /OPTIMIZE_STATS:TOKENS:(\d+)/.exec(statsResult.text)
                          : null
                        if (match) {
                          setCost(match[1])
                          setAnnounce(t('announce.optimized.cost', { tokens: match[1] }))
                          if (typeof setTimeout === 'function') {
                            setTimeout(function () { setCost(null) }, 4000)
                          }
                        }
                      })
                      .catch(function () { /* stats are best-effort */ })
                  } else if (result && result.kind === 'error' && typeof result.text === 'string') {
                    // dsh 协议：被中止的 handler 以 kind:'error' 结算（resolve 而非
                    // reject）——用户点取消时若宿主返回 error，须识别为取消而非失败。
                    if (controller && controller.signal.aborted) {
                      setAnnounce(t('announce.cancelled'))
                      return
                    }
                    flashError(result.text)
                  } else {
                    console.error('prompt-optimizer: unexpected command result', response)
                    flashError(t('error.retry'))
                  }
                })
                .catch(function (error) {
                  // A user-initiated abort is not an error.
                  if (controller && controller.signal.aborted) {
                    setAnnounce(t('announce.cancelled'))
                    return
                  }
                  console.error('prompt-optimizer: command call failed', error)
                  flashError(error instanceof Error ? error.message : String(error))
                })
                .finally(function () {
                  setBusy(false)
                  cancelRef.current = null
                })
            }

            var icon = SparklesIcon
            var title = t('btn.title')
            var aria = t('btn.label')
            var className = 'po-optimize-btn'
            if (busy) {
              icon = SpinnerIcon
              title = t('btn.busy')
              aria = t('btn.cancel')
            } else if (canUndo) {
              icon = UndoIcon
              title = t('btn.undo')
              aria = t('btn.undo')
              className += ' is-undo'
            } else if (error !== null) {
              className += ' has-error'
              title = t('error.prefix') + error
              aria = t('btn.failed')
            }

            return React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: className,
                  onClick: onClick,
                  // Clickable while busy so the same button can cancel.
                  disabled: !canOptimize && !canUndo && !busy,
                  title: title,
                  'aria-label': aria,
                },
                React.createElement(icon),
              ),
              // Transient cost hint (成本可见) after a fresh optimization.
              cost !== null
                ? React.createElement('span', { className: 'po-cost', 'aria-hidden': true }, '≈' + cost + ' tokens')
                : null,
              // Visually hidden live region: announces status changes to
              // assistive technology (WCAG 4.1.3).
              React.createElement(
                'span',
                { role: 'status', 'aria-live': 'polite', className: 'po-visually-hidden' },
                announce,
              ),
            )
          },
        )
      })

        // Settings-sidebar page（设置 → 侧边栏「Prompt 优化器」）— 1.8.0.
        // SVG-marked header + core fields + live status. The section shell renders
        // the nav entry from `id`/`order`/`label`; the mark lives inside the page
        // header (settings.section owns no nav-icon seat by contract).
        function PromptOptimizerSection(props) {
          ensureStyles()
          // Framework-synthesized `t` seat (see the button above). The renderer
          // re-derives it per locale revision (`localeSeat(face, entry.locale)`),
          // so preferring it is what puts this page on the documented path; the
          // per-call lookup covers hosts that installed no locale face.
          var t = props && typeof props.t === 'function' ? props.t : translate
          // 0.2.0 replaced the 0.1.x `ctx.settingsScope` service with
          // `ctx.configForms`; the two names never coexisted in any release, so
          // there is no dual path to keep. The form is keyed by this plugin's
          // HOST ENTRY ID, whose settings namespace is the same string
          // (`configForms.get()` builds `new ConfigFormController(owner,
          // { namespace: entryId }, …)`).
          var configForms = ctx.get('configForms')
          var formRef = React.useRef(null)
          var snapState = React.useState(null)
          var snap = snapState[0]
          var setSnap = snapState[1]
          var savedState = React.useState('')
          var savedMsg = savedState[0]
          var setSavedMsg = savedState[1]
          React.useEffect(function () {
            if (!configForms || typeof configForms.get !== 'function') return undefined
            var form
            try {
              form = configForms.get(SETTINGS_NS)
            } catch (err) {
              console.error('prompt-optimizer: config form lookup failed', err)
              return undefined
            }
            if (!form || typeof form.getSnapshot !== 'function') return undefined
            formRef.current = form
            setSnap(form.getSnapshot())
            if (typeof form.subscribe !== 'function') return undefined
            return form.subscribe(function () { setSnap(form.getSnapshot()) })
          }, [])
          // Re-render on a language change. The renderer already re-renders every
          // outlet when the locale revision bumps, which keeps the `t` seat
          // above fresh — but that only covers the seat path. On the fallback
          // path (`translate`) nothing else would ever invalidate this render,
          // so the page would keep whatever language it was first painted in
          // until some unrelated state happened to change. One subscription
          // makes both paths correct. The counter's value is never read;
          // bumping it is the whole point.
          var localeRevisionState = React.useState(0)
          var setLocaleRevision = localeRevisionState[1]
          React.useEffect(function () {
            var live = ctx.get('locale')
            if (!live || typeof live.subscribe !== 'function') return undefined
            return live.subscribe(function () { setLocaleRevision(function (n) { return n + 1 }) })
          }, [])

      /** Show a transient status line under the buttons. */
      function flashSaved(message) {
        setSavedMsg(message)
        if (typeof setTimeout === 'function') setTimeout(function () { setSavedMsg('') }, 2500)
      }

      // 写一个字段。`ConfigForm.set()` 解析为 **boolean**（true = 宿主已接受），
      // 不是「resolve 就算成功」：旧页面只看 .then 就打「已保存」，正是这个假成功
      // 让一个根本没落库的设置页看起来正常（issue #3）。
      function setField(key, value) {
        var form = formRef.current
        if (!form) return
        form.set(key, value)
          .then(function (accepted) {
            if (accepted === false) flashSaved(t('save.rejected') + key)
            else flashSaved(t('saved') + key)
          })
          .catch(function (err) {
            setSavedMsg(t('save.failed') + (err instanceof Error ? err.message : String(err)))
          })
      }

      // 恢复某字段为默认：清空用户层，字段回退到 composition/默认层。
      // 0.2.0 把 0.1.x 的 `clear` 改名为 `unset`，同样返回 boolean。
      function clearField(key) {
        var form = formRef.current
        if (!form || typeof form.unset !== 'function') return Promise.resolve()
        return form.unset(key)
          .then(function (accepted) {
            if (accepted === false) flashSaved(t('save.rejected') + key)
          })
          .catch(function (err) {
            setSavedMsg(t('restore.failed') + (err instanceof Error ? err.message : String(err)))
          })
      }

      // 恢复全部核心字段为默认（底部统一按钮）。
      function clearAllFields() {
        if (!formRef.current) return
        var jobs = []
        for (var i = 0; i < PO_FIELDS.length; i++) jobs.push(clearField(PO_FIELDS[i].key))
        Promise.all(jobs).then(function () { flashSaved(t('reset.all.done')) })
      }

          // 状态查看：settings.section 无 sessionId props——从 sessions 服务取
          // 当前（首个）会话 id 执行 `/optimize --status`；取不到时提示走命令。
          var statusState = React.useState(null)
          var statusText = statusState[0]
          var setStatusText = statusState[1]
          function getSessionId() {
            var sessions = ctx.get('sessions')
            if (!sessions) return undefined
            try {
              var list = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
              if (list && list.byId) {
                var ids = Object.keys(list.byId)
                return ids.length > 0 ? ids[0] : undefined
              }
            } catch (err) { /* best-effort */ }
            return undefined
          }
          function fetchStatus() {
            var sessionId = getSessionId()
            if (sessionId === undefined) {
              setStatusText(t('status.unknown.session'))
              return
            }
            executeCommand(sessionId, '/optimize --status', [])
              .then(function (response) {
                var result = resultOf(response)
                if (result && result.kind === 'success' && typeof result.text === 'string') {
                  setStatusText(result.text.replace(/^STATUS_OK\n?/, ''))
                }
              })
              .catch(function (err) {
                setStatusText(t('status.fetch.failed') + (err instanceof Error ? err.message : String(err)))
              })
          }

          // `status` is what makes a dead panel visible instead of silent:
          // 'loading' until the Host's `settings.describe` reached this client,
          // 'ready' while a section stands, 'unavailable' when the namespace is
          // not served to this client (or the connection keeps preferences
          // process-local — a non-loopback page). The old page rendered inputs
          // for every state and called them "current", which is how "saved but
          // never written" stayed invisible.
          var status = snap && typeof snap.status === 'string' ? snap.status : 'loading'
          var resolved = snap && snap.value && typeof snap.value === 'object' ? snap.value : {}
          var writable = snap ? snap.writable !== false : false
          var canEdit = formRef.current !== null && status === 'ready' && writable

          var groups = []
          for (var i = 0; i < PO_FIELDS.length; i++) {
            var f = PO_FIELDS[i]
            if (groups.length === 0 || groups[groups.length - 1].name !== f.group) {
              groups.push({ name: f.group, fields: [] })
            }
            groups[groups.length - 1].fields.push(f)
          }

          var children = []
          children.push(
            React.createElement('div', { className: 'po-section-head', key: 'head' },
              React.createElement(SparklesIcon),
              React.createElement('div', null,
                React.createElement('div', { className: 'po-section-title' }, t('section.nav')),
                React.createElement('div', { className: 'po-section-sub' }, t('section.sub')),
              ),
            ),
          )

          // Degradation notice: say what is wrong, not merely that something is.
          if (!canEdit) {
            children.push(
              React.createElement('div', { className: 'po-hint', key: 'availability', style: { marginBottom: 10 } },
                t(formRef.current === null || status === 'unavailable' ? 'panel.unavailable' : status === 'ready' ? 'panel.readonly' : 'panel.loading'),
              ),
            )
          }

          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g]
            for (var j = 0; j < grp.fields.length; j++) {
              var field = grp.fields[j]
              var current = resolved[field.key]
              var input
              // 通用变更处理：data-po-key 定位字段（避免 var 闭包陷阱与 bind 预绑丢事件对象）。
              function onFieldChange(ev) {
                if (!ev || !ev.target) return
                var key = ev.target.getAttribute('data-po-key')
                if (!key) return
                var value = ev.target.value
                var def = null
                for (var k = 0; k < PO_FIELDS.length; k++) {
                  if (PO_FIELDS[k].key === key) { def = PO_FIELDS[k]; break }
                }
                if (def !== null && def.type === 'boolean') value = ev.target.value === 'true'
                else if (def !== null && def.type === 'number') {
                  var n = Number(ev.target.value)
                  if (!Number.isFinite(n)) return
                  value = n
                }
                setField(key, value)
              }
              if (field.type === 'select' || field.type === 'boolean') {
                input = React.createElement(
                  'select',
                  { className: 'po-field-input', 'data-po-key': field.key, disabled: !canEdit, value: field.type === 'boolean' ? (current ? 'true' : 'false') : String(current ?? ''), onChange: onFieldChange },
                  field.type === 'boolean'
                    ? [React.createElement('option', { key: 't', value: 'true' }, t('opt.on')), React.createElement('option', { key: 'f', value: 'false' }, t('opt.off'))]
                    : field.options.map(function (opt) {
                        return React.createElement('option', { key: opt[0], value: opt[0] }, opt[1])
                      }),
                )
              } else {
                input = React.createElement('input', {
                  className: 'po-field-input', type: 'number', step: field.step, min: field.min, max: field.max,
                  'data-po-key': field.key, disabled: !canEdit,
                  defaultValue: current !== undefined ? String(current) : '',
                  onBlur: onFieldChange,
                })
              }
              children.push(
                React.createElement('div', { className: 'po-field', key: field.key },
                  React.createElement('div', { className: 'po-field-label' },
                    React.createElement('span', null, field.label),
                    React.createElement('span', { className: 'po-field-default' },
                      t('field.meta', { default: String(field.defaultValue ?? '—'), current: String(current ?? '—') }),
                    ),
                  ),
                  input,
                ),
              )
            }
          }

          children.push(
            React.createElement('div', { key: 'save-row', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
              React.createElement('button', { className: 'po-save', onClick: function () {
                if (statusText !== null) { setStatusText(null); return }
                fetchStatus()
              } }, t('action.status')),
              React.createElement('button', { className: 'po-reset', type: 'button', disabled: !canEdit, onClick: clearAllFields }, t('action.reset')),
              savedMsg !== '' ? React.createElement('span', { className: 'po-hint', key: 'saved' }, savedMsg) : null,
            ),
          )

          if (statusText !== null) {
            children.push(
              React.createElement(
                'div', { className: 'po-status-panel', key: 'status', style: { position: 'static', marginTop: 12, maxWidth: 'none' } },
                React.createElement('pre', { className: 'po-status-pre' }, statusText),
              ),
            )
          }

          children.push(
            React.createElement('div', { className: 'po-hint', key: 'hint', style: { marginTop: 14 } },
              t('hint'),
            ),
          )

          return React.createElement('div', { className: 'po-section' }, children)
        }

      slots.inject('settings.section', function () {
        return slots.register(
          // `locale: NS` (via `localeOption`) is what makes the renderer hand the
          // component its `t` seat, and the label a thunk that is re-read per
          // ledger projection, so the nav row follows the active language
          // without re-registration. It is declared only when a locale face is
          // actually installed: the renderer throws for an entry that declares a
          // namespace nobody provides.
          merged({
            name: 'settings.section',
            id: 'prompt-optimizer',
            order: 90,
            label: function () { return translate('section.nav') },
          }, localeOption),
          PromptOptimizerSection,
        )
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
