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
      var url = target.src || target.href;
      record('Failed to load', (target.tagName || '?') + ' ' + url);
      /* A module script reports the failure against the entry file even when
         the thing that actually failed is something it imports, several levels
         down. Without devtools that name is a dead end, so walk the imports and
         fetch each one to find the file that really did not arrive. */
      if (target.type === 'module') probe(url);
      return;
    }
    record('Script error', (e.message || 'unknown')
      + (e.filename ? '\n  at ' + e.filename + ':' + e.lineno + ':' + e.colno : ''));
  }, true);

  /* Fetches a module and everything it imports, and records whichever ones do
     not come back. A refused fetch and a 404 look the same to the page, but not
     here: the message tells a blocked file apart from a missing one. */
  function probe(entry) {
    if (!window.fetch || !window.Promise) return;
    var seen = {};
    var pending = 0;
    var failures = 0;

    function short(url) {
      return url.indexOf(location.origin) === 0 ? url.slice(location.origin.length) : url;
    }

    function visit(url, depth) {
      if (seen[url] || depth > 8) return;
      seen[url] = true;
      pending++;
      fetch(url, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) {
          failures++;
          record('Missing', 'HTTP ' + res.status + '  ' + short(url));
          return null;
        }
        var type = res.headers.get('content-type') || '(none)';
        if (type.indexOf('javascript') < 0) {
          failures++;
          record('Wrong type', type + '  ' + short(url));
        }
        return res.text();
      }).then(function (text) {
        if (!text) return;
        var pattern = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;
        var match;
        while ((match = pattern.exec(text))) {
          if (match[1].charAt(0) === '.') visit(new URL(match[1], url).href, depth + 1);
        }
      })['catch'](function (err) {
        failures++;
        record('Blocked or unreachable', short(url) + '\n  ' + ((err && err.message) || err)
          + (navigator.onLine === false ? '\n  The device is offline.' : ''));
      })['finally'](function () {
        pending--;
        if (pending === 0 && failures === 0) {
          record('Every file loads on its own', 'so one of them failed to parse, or the '
            + 'connection dropped part way. Reload and it will usually start.');
        }
      });
    }

    visit(entry, 0);
  }

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
      + 'UA: ' + navigator.userAgent + '\n'
      + 'Online: ' + (navigator.onLine === false ? 'no' : 'yes') + '\n\n'
      + (problems.length ? problems.join('\n\n') : 'No error was reported - the UI simply never rendered.')
      + '\n\nReload first - most of these are a dropped connection. If it keeps '
      + 'happening, screenshot this and send it over.\n\n';

    /* A dropped request is the common case and a reload fixes it, so the way
       out is on screen rather than something to know. */
    var again = document.createElement('button');
    again.textContent = 'Reload';
    again.setAttribute('style', [
      'font:600 15px/1 system-ui,sans-serif', 'padding:12px 22px',
      'background:#ffcc00', 'color:#1c1c1e', 'border:0', 'border-radius:10px',
    ].join(';'));
    again.onclick = function () { location.reload(); };
    box.appendChild(again);
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
