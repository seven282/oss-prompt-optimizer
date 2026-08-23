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
    var inject = ['remote', 'remote.commands']

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

    async function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

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
              ctx.remote.commands.execute(props.sessionId, '/optimize ' + draft)
                .then(function (response) {
                  var result = resultOf(response)
                  if (result && result.kind === 'success' && typeof result.text === 'string' && result.text.length > 0) {
                    setUndo({ original: draft, optimized: result.text })
                    props.inputActions.setDraft(result.text)
                    setAnnounce('提示词已优化，可点击撤销按钮恢复原文')
                    // 成本可见: read the last run's output tokens and show a
                    // transient hint. Best-effort; a failure is ignored.
                    ctx.remote.commands.execute(props.sessionId, '/optimize --stats')
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
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
