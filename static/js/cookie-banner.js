/* ════════════════════════════════════════════════════════════════════
   FORK — Cookie banner mount

   Self-contained module. Drop-in on any public page that wants the
   first-visit notice. Skips itself on subsequent visits via a
   localStorage flag. No exports, no globals, no dependencies.

   Why the banner exists: 152-ФЗ doesn't require explicit consent for
   strictly-technical session cookies, but a visible disclosure is the
   conservative default and matches what Russian regulators expect to
   see on a public site collecting any user data.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var STORAGE_KEY = 'fork_cookie_consent_v1';

  /* localStorage can throw in restricted contexts (private mode, some
     embedded browsers, sandboxed iframes). Wrap every access. If we
     can't read the flag, we treat that as "not yet seen" and show the
     banner; if we can't write it, the user sees the banner once per
     load — non-fatal, just slightly noisier. */
  function safeRead() {
    try { return localStorage.getItem(STORAGE_KEY); }
    catch (_) { return null; }
  }
  function safeWrite(value) {
    try { localStorage.setItem(STORAGE_KEY, value); }
    catch (_) { /* ignore */ }
  }

  if (safeRead()) return;

  function buildBanner() {
    var bar = document.createElement('div');
    bar.className   = 'cookie-banner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Уведомление о cookies');

    var text = document.createElement('span');
    text.className = 'cookie-banner-text';
    /* Innerhtml used so the privacy link inside the disclosure renders
       as a clickable anchor. The string is a static literal — no user
       input flows through it, so there's no XSS surface. */
    text.innerHTML =
      'Этот сайт использует только технические cookies для авторизации. ' +
      'Подробнее — в <a href="/privacy" target="_blank" rel="noopener">Политике</a>.';

    var ok = document.createElement('button');
    ok.type      = 'button';
    ok.className = 'cookie-banner-ok';
    ok.textContent = 'Понятно';

    var close = document.createElement('button');
    close.type      = 'button';
    close.className = 'cookie-banner-close';
    close.setAttribute('aria-label', 'Закрыть');
    close.textContent = '×';

    bar.appendChild(text);
    bar.appendChild(ok);
    bar.appendChild(close);

    function dismiss() {
      bar.classList.remove('shown');
      bar.classList.add('dismissing');
      safeWrite(JSON.stringify({ v: 1, ts: Date.now() }));
      /* Match the .dismissing transition duration so the node is gone
         AFTER the slide-out finishes. Hard-removed, not just hidden,
         to avoid lingering DOM weight. */
      setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }, 280);
    }

    ok.addEventListener('click',    dismiss);
    close.addEventListener('click', dismiss);

    return bar;
  }

  function mount() {
    /* Re-check the flag at mount time. Two banner scripts could race
       on a page that includes the file twice by accident; whoever
       writes the flag first wins, the other no-ops. */
    if (safeRead()) return;
    var bar = buildBanner();
    document.body.appendChild(bar);
    /* requestAnimationFrame ensures the .shown class lands AFTER the
       initial paint with .cookie-banner's offscreen translate, so the
       slide-up actually animates instead of jumping into place. */
    requestAnimationFrame(function () { bar.classList.add('shown'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
