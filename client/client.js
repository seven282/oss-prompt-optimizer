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
    // `settingsScope` (dsh-client-ui-settings) drives the Settings-sidebar page;
    // `locale` localizes the sidebar label per the user's language.
    var inject = ['remote', 'remote.commands', 'settingsScope', 'locale', 'sessions']
    var SETTINGS_NS = 'prompt-optimizer'
    var NS = 'prompt-optimizer-client'
    var zh = {
      'section.nav': '提示词优化',
      'section.sub': 'oss-prompt-optimizer · 配置与运行状态',
      'action.status': '查看运行状态',
      'action.reset': '恢复全部默认',
      'saved': '已保存：',
      'reset.all.done': '已恢复全部默认',
      'hint': '本页仅列核心常用项；完整配置（缓存 / 情境感知 / 模板 / 自迭代等）→ 设置 → 插件 → oss-prompt-optimizer，默认值已调优、多数无需修改。',
    }
    var en = {
      'section.nav': 'Prompt Optimizer',
      'section.sub': 'oss-prompt-optimizer · config & status',
      'action.status': 'View status',
      'action.reset': 'Reset all to defaults',
      'saved': 'Saved: ',
      'reset.all.done': 'All defaults restored',
      'hint': 'Core options only; the full config (cache / situation awareness / templates / self-iteration) lives under Settings → Plugins → oss-prompt-optimizer. Defaults are tuned — most need no changes.',
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
        '.po-field-input{width:100%;box-sizing:border-box;padding:5px 8px;font-size:13px;border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.18));border-radius:6px;background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-text-primary, inherit)}.po-field-input:focus{outline:2px solid var(--dsw-alias-brand-primary, currentColor);outline-offset:0;border-color:transparent}',
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
      { key: 'localTemplate', label: '本地模板（零 token）', type: 'select', group: '运行', defaultValue: 'auto',
        options: [['auto', '自动'], ['on', '开启'], ['off', '关闭'], ['hybrid', '混合']] },
      { key: 'autoOptimize', label: '自动优化（前缀触发）', type: 'boolean', group: '自动', defaultValue: true },
      { key: 'autoAdapt', label: '自迭代学习（越用越好用）', type: 'boolean', group: '自动', defaultValue: true },
    ]


    async function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      // Localize the settings-sidebar label per user language.
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      })
      var t = ctx.locale.bind(NS)

      // ✨ Optimize button (composer tool row, left).
      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'prompt-optimizer', order: 10, label: '优化提示词' },
          function OptimizeButton(props) {
            ensureStyles()
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
            // Owner prop: point-in-time InputState snapshot (the skeleton
            // re-renders on input changes, so the button stays current).
            var draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''
            // The error flash never blocks a retry: clicking again retries
            // immediately (and clears the flash).
            var canOptimize = draft.trim().length > 0 && !busy
            var canUndo = !busy && undo !== null && draft === undo.optimized

            function flashError(message) {
              setError(message)
              setAnnounce('优化失败：' + message)
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
                setAnnounce('已取消优化')
                return
              }
              if (canUndo) {
                props.inputActions.setDraft(undo.original)
                setUndo(null)
                setAnnounce('已恢复优化前的原文')
                return
              }
              if (!canOptimize) return
              if (error !== null) setError(null)
              setBusy(true)
              var controller = typeof AbortController === 'function' ? new AbortController() : null
              cancelRef.current = controller
              var signal = controller ? controller.signal : undefined
              ctx.remote.commands.execute(props.sessionId, '/optimize ' + draft, [], signal)
                .then(function (response) {
                  // 取消结算（dsh 协议）：宿主以 { ok:false, error:{message:'This
                  // operation was aborted'} } resolve——须在 ok:false 信封层先识别
                  // 取消，否则落入 unexpected 分支误报「优化失败」（1.7.6）。
                  if (response === undefined || response.ok === false) {
                    if (controller && controller.signal.aborted) {
                      setAnnounce('已取消优化')
                      return
                    }
                    var errMsg = response && response.error && typeof response.error.message === 'string'
                      ? response.error.message
                      : '优化失败，请重试'
                    flashError(errMsg)
                    return
                  }
                  var result = resultOf(response)
                  if (result && result.kind === 'success' && typeof result.text === 'string' && result.text.length > 0) {
                    setUndo({ original: draft, optimized: result.text })
                    props.inputActions.setDraft(result.text)
                    setAnnounce('提示词已优化，可点击撤销按钮恢复原文')
                    // 成本可见: read the last run's output tokens and show a
                    // transient hint. Best-effort; a failure is ignored.
                    ctx.remote.commands.execute(props.sessionId, '/optimize --stats', [])
                      .then(function (statsResponse) {
                        var statsResult = resultOf(statsResponse)
                        var match = statsResult && typeof statsResult.text === 'string'
                          ? /OPTIMIZE_STATS:TOKENS:(\d+)/.exec(statsResult.text)
                          : null
                        if (match) {
                          setCost(match[1])
                          setAnnounce('提示词已优化（消耗约 ' + match[1] + ' tokens），可点击撤销按钮恢复原文')
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
                      setAnnounce('已取消优化')
                      return
                    }
                    flashError(result.text)
                  } else {
                    console.error('prompt-optimizer: unexpected command result', response)
                    flashError('优化失败，请重试')
                  }
                })
                .catch(function (error) {
                  // A user-initiated abort is not an error.
                  if (controller && controller.signal.aborted) {
                    setAnnounce('已取消优化')
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
            var title = '优化提示词 (prompt-optimizer)'
            var aria = '优化提示词'
            var className = 'po-optimize-btn'
            if (busy) {
              icon = SpinnerIcon
              title = '正在优化…（点击取消）'
              aria = '取消优化'
            } else if (canUndo) {
              icon = UndoIcon
              title = '恢复优化前的提示词'
              aria = '恢复优化前的提示词'
              className += ' is-undo'
            } else if (error !== null) {
              className += ' has-error'
              title = '优化失败：' + error
              aria = '优化失败'
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
      // The section shell renders the nav entry from `id`/`order`/`label`;
      // the SVG mark lives inside the page header (settings.section owns no
      // nav-icon seat by contract).
        // Settings-sidebar page: SVG-marked header + core fields + live status.
        function PromptOptimizerSection(props) {
          ensureStyles()
          var settingsScope = ctx.get('settingsScope')
          var scopeRef = React.useRef(null)
          var snapState = React.useState(null)
          var snap = snapState[0]
          var setSnap = snapState[1]
          var savedState = React.useState('')
          var savedMsg = savedState[0]
          var setSavedMsg = savedState[1]
          React.useEffect(function () {
            if (!settingsScope || typeof settingsScope.bind !== 'function') return undefined
            var scope
            try {
              scope = settingsScope.bind({ namespace: SETTINGS_NS })
            } catch (err) {
              console.error('prompt-optimizer: settings scope bind failed', err)
              return undefined
            }
            scopeRef.current = scope
            setSnap(scope.getSnapshot())
            return scope.subscribe(function () { setSnap(scope.getSnapshot()) })
          }, [])

      function setField(key, value) {
        var scope = scopeRef.current
        if (!scope) return
        scope.set(key, value)
          .then(function () {
            setSavedMsg(t('saved') + key)
            if (typeof setTimeout === 'function') setTimeout(function () { setSavedMsg('') }, 2500)
          })
          .catch(function (err) {
            setSavedMsg('保存失败：' + (err instanceof Error ? err.message : String(err)))
          })
      }

      // 恢复某字段为默认：清空用户层，字段回退 composition/默认层。
      function clearField(key) {
        var scope = scopeRef.current
        if (!scope || typeof scope.clear !== 'function') return
        return scope.clear(key)
          .catch(function (err) {
            setSavedMsg('恢复失败：' + (err instanceof Error ? err.message : String(err)))
          })
      }

      // 恢复全部核心字段为默认（底部统一按钮）。
      function clearAllFields() {
        var scope = scopeRef.current
        if (!scope || typeof scope.clear !== 'function') return
        var jobs = []
        for (var i = 0; i < PO_FIELDS.length; i++) jobs.push(clearField(PO_FIELDS[i].key))
        Promise.all(jobs).then(function () {
          setSavedMsg(t('reset.all.done'))
          if (typeof setTimeout === 'function') setTimeout(function () { setSavedMsg('') }, 2500)
        })
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
              setStatusText('设置页无法确定当前会话——请在对话中运行 /optimize --status 查看状态。')
              return
            }
            ctx.remote.commands.execute(sessionId, '/optimize --status', [])
              .then(function (response) {
                var result = resultOf(response)
                if (result && result.kind === 'success' && typeof result.text === 'string') {
                  setStatusText(result.text.replace(/^STATUS_OK\n?/, ''))
                }
              })
              .catch(function (err) {
                setStatusText('无法获取状态：' + (err instanceof Error ? err.message : String(err)))
              })
          }

          var resolved = snap && snap.value && typeof snap.value === 'object' ? snap.value : {}
          var writable = snap ? snap.writable !== false : false

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
                  { className: 'po-field-input', 'data-po-key': field.key, value: field.type === 'boolean' ? (current ? 'true' : 'false') : String(current ?? ''), onChange: onFieldChange },
                  field.type === 'boolean'
                    ? [React.createElement('option', { key: 't', value: 'true' }, '开启'), React.createElement('option', { key: 'f', value: 'false' }, '关闭')]
                    : field.options.map(function (opt) {
                        return React.createElement('option', { key: opt[0], value: opt[0] }, opt[1])
                      }),
                )
              } else {
                input = React.createElement('input', {
                  className: 'po-field-input', type: 'number', step: field.step, min: field.min, max: field.max,
                  'data-po-key': field.key,
                  defaultValue: current !== undefined ? String(current) : '',
                  onBlur: onFieldChange,
                })
              }
              children.push(
                React.createElement('div', { className: 'po-field', key: field.key },
                  React.createElement('div', { className: 'po-field-label' },
                    React.createElement('span', null, field.label),
                    React.createElement('span', { className: 'po-field-default' },
                      '默认 ' + String(field.defaultValue ?? '—') + ' · 当前 ' + String(current ?? '—'),
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
          React.createElement('button', { className: 'po-reset', type: 'button', onClick: clearAllFields }, t('action.reset')),
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
          { name: 'settings.section', id: 'prompt-optimizer', order: 90, label: function () { return t('section.nav') }, locale: NS },
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
