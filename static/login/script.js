/* ════════════════════════════════════════════════
   FORK — Login screen logic
   - Toggles between login + register modes (UI + form action)
   - Submits to /api/auth/{login,register}
   - On success: navigate to /admin if username==='0', else /
   - Error messages mapped to Russian
═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  const tile          = document.getElementById('authTile');
  const form          = document.getElementById('authForm');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const consentInput  = document.getElementById('consent');
  const consentLabel  = consentInput && consentInput.closest('.auth-consent');
  const submitBtn     = document.getElementById('authSubmit');
  const submitLabel   = document.getElementById('authSubmitLabel');
  const errorEl       = document.getElementById('authError');
  const titleEl       = document.getElementById('authTitle');
  const tabs          = document.querySelectorAll('.auth-tab');

  let mode = 'login';   // 'login' | 'register'
  let busy = false;

  // ── Pre-flight: if the user already has a valid session, skip the
  // login screen entirely. Otherwise an authed user navigating to /login
  // (e.g. by accident or browser back) sees a useless form. The server
  // also does this redirect in the route, but the client check shaves
  // a request when the cookie's already valid.
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(res => res.ok ? res.json() : null)
    .then(user => {
      if (user) {
        window.location.replace(user.username === '0' ? '/admin' : '/');
      }
    })
    .catch(() => { /* ignore — proceed with login form */ });

  // ── Mode handling ─────────────────────────────
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    tile.dataset.mode = next;
    tabs.forEach(t => {
      t.setAttribute('aria-selected', t.dataset.mode === next ? 'true' : 'false');
    });
    if (next === 'login') {
      titleEl.textContent    = 'Войти';
      submitLabel.textContent = 'Войти';
      passwordInput.autocomplete = 'current-password';
    } else if (next === 'register') {
      titleEl.textContent    = 'Создать аккаунт';
      submitLabel.textContent = 'Создать';
      passwordInput.autocomplete = 'new-password';
    } else if (next === 'forgot') {
      titleEl.textContent    = 'Восстановление';
      // Reset the forgot block's success/error state when entering
      // forgot mode so a re-entry shows a clean form.
      const fSuccess = document.getElementById('forgotSuccess');
      const fError   = document.getElementById('forgotError');
      const fInput   = document.getElementById('forgotEmail');
      if (fSuccess) fSuccess.classList.remove('visible');
      if (fError)   fError.classList.remove('visible');
      if (fInput)   fInput.value = '';
    }
    // Reset consent on every mode swap. 152-ФЗ requires affirmative
    // consent each time, so leaving the box checked from a previous
    // browser session would defeat the purpose.
    if (consentInput) consentInput.checked = false;
    if (consentLabel) consentLabel.classList.remove('nudge');
    clearError();
    checkReady();
  }

  // ── Submit button readiness gating ─────────────────────────────
  // The submit button starts dim + desaturated. JS toggles
  // `.auth-form.ready` when every visible field passes its rules,
  // and the CSS smoothly lights up the gradient. Recomputed on
  // every keystroke + checkbox change + mode switch.
  function isReady() {
    const u = usernameInput.value.trim();
    if (!/^[A-Za-z0-9]+$/.test(u)) return false;     // username valid
    if (passwordInput.value.length < 4) return false; // password valid
    // Consent only required in register mode
    if (mode === 'register' && consentInput && !consentInput.checked) return false;
    return true;
  }
  function checkReady() {
    form.classList.toggle('ready', isReady());
  }
  usernameInput.addEventListener('input', checkReady);
  passwordInput.addEventListener('input', checkReady);
  if (consentInput) consentInput.addEventListener('change', checkReady);

  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

  // ── Phase 3.6: forgot-password mode ──────────────────────────────
  const forgotLink   = document.getElementById('authForgotLink');
  const backToLogin  = document.getElementById('authBackToLogin');
  const forgotForm   = document.getElementById('forgotForm');
  const forgotInput  = document.getElementById('forgotEmail');
  const forgotSubmit = document.getElementById('forgotSubmit');
  const forgotError  = document.getElementById('forgotError');
  const forgotSuccess = document.getElementById('forgotSuccess');

  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      setMode('forgot');
    });
  }
  if (backToLogin) {
    backToLogin.addEventListener('click', (e) => {
      e.preventDefault();
      setMode('login');
    });
  }

  // Forgot-form submit handler. Always shows the same success message
  // regardless of whether the email exists — anti-enumeration. The
  // server enforces the same property (always 200), so this is just
  // the matching UX.
  if (forgotForm) {
    let forgotBusy = false;
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (forgotBusy) return;
      if (forgotError) forgotError.classList.remove('visible');
      if (forgotSuccess) forgotSuccess.classList.remove('visible');

      const email = (forgotInput && forgotInput.value || '').trim();
      if (!email || email.length < 3 || !email.includes('@')) {
        if (forgotError) {
          forgotError.textContent = 'Введите email';
          forgotError.classList.add('visible');
        }
        return;
      }

      forgotBusy = true;
      if (forgotSubmit) {
        forgotSubmit.disabled = true;
        forgotSubmit.classList.add('loading');
      }

      try {
        const res = await fetch('/api/auth/password-reset/request', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email }),
          credentials: 'same-origin',
        });
        // Server always returns 200 (anti-enumeration). 4xx here means
        // genuine validation error — surface it; 5xx means server hiccup.
        if (res.ok) {
          if (forgotSuccess) forgotSuccess.classList.add('visible');
        } else if (res.status === 429) {
          if (forgotError) {
            forgotError.textContent = 'Слишком частые попытки. Попробуйте позже.';
            forgotError.classList.add('visible');
          }
        } else {
          if (forgotError) {
            forgotError.textContent = 'Не получилось отправить. Попробуйте позже.';
            forgotError.classList.add('visible');
          }
        }
      } catch {
        if (forgotError) {
          forgotError.textContent = 'Сетевая ошибка. Проверьте подключение.';
          forgotError.classList.add('visible');
        }
      } finally {
        forgotBusy = false;
        if (forgotSubmit) {
          forgotSubmit.disabled = false;
          forgotSubmit.classList.remove('loading');
        }
      }
    });
  }

  // ── Initial mode (also sets the data-attr for tab indicator) ────
  tile.dataset.mode = 'login';

  // ── Phase 3.7: ?reset=1 success toast ────────────────────────────
  // Triggered when the user lands here after a successful password
  // reset on /reset. Show a brief toast, then strip the param so a
  // refresh doesn't re-trigger.
  try {
    const _params = new URLSearchParams(window.location.search);
    if (_params.has('reset')) {
      const toast = document.getElementById('authToast');
      if (toast) {
        toast.textContent = 'Пароль изменён. Войдите с новым паролем.';
        toast.classList.add('visible');
        // Auto-fade after 5s — gentle reminder, not perma-banner.
        setTimeout(() => toast.classList.remove('visible'), 5000);
      }
      // Strip the param from the visible URL.
      const cleanUrl = window.location.pathname + window.location.hash;
      try { window.history.replaceState({}, '', cleanUrl); } catch (_) { /* sandbox */ }
    }
  } catch (_) { /* URL parse glitch — non-fatal */ }

  // ── Error helpers ─────────────────────────────
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    setTimeout(() => { if (!errorEl.classList.contains('visible')) errorEl.textContent = ''; }, 220);
  }

  // Server returns English error messages from FastAPI's HTTPException
  // detail. Map the known set to friendly Russian. Unknown messages fall
  // through to a generic localized string instead of bleeding raw English
  // through to the user.
  const ERROR_MAP = {
    'Invalid username or password': 'Неверное имя или пароль',
    'Username is already taken':    'Это имя уже занято',
    'This username is reserved':    'Это имя зарезервировано',
    'This account is disabled':     'Аккаунт отключён',
    'Authentication required':      'Требуется вход',
    'Username must be a string':                                                    'Неверное имя',
    'Username must be 1-32 letters or digits (no symbols, no spaces)':              'Имя: 1–32 символа, только буквы и цифры',
    'Password must be a string':                                                    'Неверный пароль',
    'Password must be at least 4 characters':                                       'Пароль должен быть минимум 4 символа',
    'Password is too long (max 128 characters)':                                    'Пароль слишком длинный (максимум 128)',
    // 152-ФЗ consent server message is already Russian; map kept for
    // self-documentation so this file lists every known error key.
    'Согласие на обработку персональных данных обязательно':
      'Согласие на обработку персональных данных обязательно',
  };

  function localizeError(detail) {
    if (typeof detail === 'string' && ERROR_MAP[detail]) return ERROR_MAP[detail];
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length) {
      // Pydantic 422 — pull the first message
      const first = detail[0];
      const msg = first && (first.msg || first.message);
      return msg || 'Проверьте данные и попробуйте снова';
    }
    return 'Что-то пошло не так. Попробуйте снова.';
  }

  // ── Submit ────────────────────────────────────
  function setBusy(b) {
    busy = b;
    submitBtn.disabled = b;
    submitBtn.classList.toggle('loading', b);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    // Client-side guard so we don't burn a server roundtrip on
    // obviously-malformed input. Server is the source of truth for
    // detailed validation; this is just a fast-fail.
    if (!username) { showError('Введите имя пользователя'); return; }
    if (password.length < 4) { showError('Пароль должен быть минимум 4 символа'); return; }
    if (!/^[A-Za-z0-9]+$/.test(username)) {
      showError('Имя: только буквы и цифры');
      return;
    }

    // Register-only consent gate. 152-ФЗ refuses pre-checked or
    // implied-by-action consent — the user must tick the box. The
    // shake animation makes the unticked state visible without a
    // separate error line dominating the form.
    if (mode === 'register' && consentInput && !consentInput.checked) {
      if (consentLabel) {
        consentLabel.classList.remove('nudge');
        // Force reflow so re-adding the class restarts the keyframes.
        void consentLabel.offsetWidth;
        consentLabel.classList.add('nudge');
      }
      showError('Подтвердите согласие на обработку персональных данных');
      return;
    }

    setBusy(true);
    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

    // Register POST carries `consent: true`; login POST does not.
    // Sending an unrelated field on login would hit Pydantic's
    // extra="ignore" default but it's cleaner to omit it.
    const body = (mode === 'register')
      ? { username, password, consent: true }
      : { username, password };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });

      if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON */ }
        showError(localizeError(body.detail));
        setBusy(false);
        return;
      }

      const data = await res.json();
      // Username `0` is the super-admin shortcut → land directly on
      // the dashboard. Everyone else (including `admin`) goes to the
      // main scanner app; `admin` can still navigate to /admin from
      // there if they want, since it has role='admin'.
      const target = (data.user && data.user.username === '0') ? '/admin' : '/';
      // Outro animation — auth-tile scales up + fades + blurs out
      // while the bg glow flares. Gives the login → app handoff a
      // deliberate beat instead of a hard nav flash. ~520ms.
      const reduced = window.matchMedia &&
                      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const glowEl = document.querySelector('.auth-bg-glow');
      tile.classList.add('leaving');
      if (glowEl) glowEl.classList.add('flare');
      const wait = reduced ? 0 : 540;
      setTimeout(() => window.location.replace(target), wait);
    } catch (err) {
      showError('Сетевая ошибка. Проверьте подключение.');
      setBusy(false);
    }
  });

  // Pressing Enter in either input submits the form (default behavior,
  // explicit here in case future tweaks add custom Enter handlers).
  [usernameInput, passwordInput].forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') form.requestSubmit();
    });
  });

  // ── Focus the username field on load — single most common action.
  // Skip on touch devices to avoid pulling up the keyboard before the
  // user has even seen the page.
  if (!('ontouchstart' in window)) {
    setTimeout(() => usernameInput.focus(), 120);
  }

  // ── Legal modal — privacy/terms in-app sheet ─────────────────
  // Iframe-free implementation: fetch the canonical /privacy or /terms
  // HTML, parse it with DOMParser, extract the .legal-doc article, and
  // inject it directly into #legalModalContent. Bypasses every iframe
  // quirk (Brave Shields blocking, lazy-load not re-evaluating after
  // off-screen transforms, etc.) while keeping a single source of
  // truth — the same HTML the standalone /privacy page renders.
  const legalModal   = document.getElementById('legalModal');
  const legalContent = document.getElementById('legalModalContent');

  /* Cache fetched articles in memory — typical user opens both
     privacy and terms once or twice; refetching every open burns
     bandwidth for no reason. Cleared on page reload. */
  const _legalCache = {};

  /* Promise for the operator/version info — fetched once, reused
     for every modal open. The fetch is cheap (~80 byte JSON) but
     paralleling each open's filling logic is unnecessary. */
  let _legalInfoPromise = null;
  function getLegalInfo() {
    if (!_legalInfoPromise) {
      _legalInfoPromise = fetch('/api/legal/info', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
    }
    return _legalInfoPromise;
  }

  /* Replace the .legal-fill spans inside the injected article with
     real values from /api/legal/info. Same shape the standalone
     /privacy page's inline script handles. */
  function fillLegalPlaceholders(root, info) {
    if (!info) return;
    root.querySelectorAll('.legal-fill').forEach(el => {
      const key = el.dataset.legal;
      if (key && info[key]) el.textContent = info[key];
    });
  }

  /* Internal links inside the injected article — e.g. the privacy
     page references /terms and vice versa. Re-route those clicks
     to swap the modal content instead of navigating away. */
  function rewireInternalLinks(root) {
    root.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href === '/privacy') {
        a.dataset.legal = 'privacy';
        a.removeAttribute('target');
      } else if (href === '/terms') {
        a.dataset.legal = 'terms';
        a.removeAttribute('target');
      }
      // External links keep their target/rel as-is.
    });
  }

  function renderLegalError(path) {
    if (!legalContent) return;
    legalContent.classList.add('error');
    legalContent.innerHTML =
      '<div class="legal-error">Не удалось загрузить документ.<br>' +
      '<a href="' + path + '" target="_blank" rel="noopener">Открыть в новой вкладке →</a>' +
      '</div>';
  }

  async function openLegal(kind) {
    if (!legalModal || !legalContent) return false;
    const path = kind === 'terms' ? '/terms' : '/privacy';

    /* Reset state every open. */
    legalContent.classList.remove('error');
    legalContent.innerHTML = '';

    legalModal.setAttribute('aria-hidden', 'false');
    /* requestAnimationFrame ensures .visible lands AFTER the initial
       paint with the sheet translated off-screen — the slide-up
       animates instead of snapping into place. */
    requestAnimationFrame(() => legalModal.classList.add('visible'));
    document.documentElement.classList.add('legal-locked');

    try {
      let html = _legalCache[kind];
      if (!html) {
        const res = await fetch(path, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        html = await res.text();
        _legalCache[kind] = html;
      }

      /* DOMParser parses the full HTML doc; we extract just .legal-doc
         to avoid pulling in <html>/<head>/<body> wrappers that would
         clash with the parent page. cloneNode keeps the cached html
         string intact for next reopen. */
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const article = doc.querySelector('.legal-doc');
      if (!article) throw new Error('Article not found in response');

      const clone = article.cloneNode(true);
      rewireInternalLinks(clone);

      /* Fill placeholders before insertion so there's no flash of "…"
         in the rendered content. */
      const info = await getLegalInfo();
      fillLegalPlaceholders(clone, info);

      legalContent.innerHTML = '';
      legalContent.appendChild(clone);
      /* Reset scroll to top — content from a previous open might have
         been scrolled. */
      legalContent.scrollTop = 0;
    } catch (err) {
      renderLegalError(path);
    }
    return true;
  }

  function closeLegal() {
    if (!legalModal) return;
    legalModal.classList.remove('visible');
    document.documentElement.classList.remove('legal-locked');
    /* Wait for the slide-down animation before clearing content —
       clearing mid-slide would visibly blank the sheet. */
    setTimeout(() => {
      legalModal.setAttribute('aria-hidden', 'true');
      if (legalContent) {
        legalContent.innerHTML = '';
        legalContent.classList.remove('error');
      }
    }, 400);
  }

  /* Delegate clicks on every [data-legal] anchor on the page — both
     the consent-checkbox label links and the footer row. One handler
     handles all entry points, current and future. */
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[data-legal]');
    if (a) {
      const kind = a.dataset.legal;
      if (kind === 'privacy' || kind === 'terms') {
        if (openLegal(kind)) e.preventDefault();
      }
      return;
    }
    /* Backdrop + close button — both have data-modal-close. */
    if (e.target.closest && e.target.closest('[data-modal-close]')) {
      closeLegal();
    }
  });

  /* ESC closes the modal — keyboard-friendliness and a familiar
     dismiss gesture on desktop. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && legalModal && legalModal.classList.contains('visible')) {
      closeLegal();
    }
  });

  // Initial readiness check (in case the browser autofilled the form).
  checkReady();
})();
