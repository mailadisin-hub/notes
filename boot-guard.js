/**
 * Startup diagnostics for a sideloaded build.
 *
 * There are no devtools on the phone. If a module fails to parse, a file fails
 * to load, or the first render throws, the app is a black rectangle and there
 * is nothing to report back. This runs before app.js as a classic script - so
 * it is already listening when the module graph loads - captures anything that
 * goes wrong, and paints it on screen in plain text.
 *
 * It deliberately uses no imports, no modern syntax that could itself fail to
 * parse on an old WebView, and inline styles rather than styles.css, because
 * any of those could be the thing that is broken.
 */
(function () {
  var problems = [];
  var shown = false;

  function record(kind, detail) {
    problems.push(kind + ': ' + detail);
    if (shown) render();
  }

  window.addEventListener('error', function (e) {
    var target = e.target;
    if (target && target !== window && (target.src || target.href)) {
      record('Failed to load', (target.tagName || '?') + ' ' + (target.src || target.href));
      return;
    }
    record('Script error', (e.message || 'unknown')
      + (e.filename ? '\n  at ' + e.filename + ':' + e.lineno + ':' + e.colno : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    record('Unhandled rejection', (reason && (reason.stack || reason.message)) || String(reason));
  });

  function render() {
    shown = true;
    var box = document.getElementById('boot-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'boot-error';
      box.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:9999',
        'background:#1c1c1e', 'color:#fff',
        'font:13px/1.5 monospace',
        'padding:calc(env(safe-area-inset-top,0px) + 20px) 18px 20px',
        'overflow:auto', '-webkit-user-select:text', 'user-select:text',
        'white-space:pre-wrap', 'word-break:break-word',
      ].join(';'));
      document.body.appendChild(box);
    }
    box.textContent = 'Notes could not start\n\n'
      + 'URL: ' + location.href + '\n'
      + 'UA: ' + navigator.userAgent + '\n\n'
      + (problems.length ? problems.join('\n\n') : 'No error was reported - the UI simply never rendered.')
      + '\n\nScreenshot this and send it over.';
  }

  /* If the stack has no screen in it after a few seconds, the app never
     booted, whether or not anything threw. */
  window.addEventListener('load', function () {
    setTimeout(function () {
      var stack = document.getElementById('stack');
      if (stack && stack.children.length > 0) return;
      render();
    }, 4000);
  });
}());
