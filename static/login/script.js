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
  const submitBtn     = document.getElementById('authSubmit');
  const submitLabel   = document.getElementById('authSubmitLabel');
  const errorEl       = document.getElementById('authError');
  const titleEl       = document.getElementById('authTitle');
  const subtitleEl    = document.getElementById('authSubtitle');
  const tabs          = document.querySelectorAll('.auth-tab');
  const toggleHint    = document.getElementById('authToggleHint');

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
      subtitleEl.textContent = 'Введите имя и пароль, чтобы открыть свой аккаунт';
      submitLabel.textContent = 'Войти';
      passwordInput.autocomplete = 'current-password';
      toggleHint.innerHTML = 'Первый раз? <a href="#" data-mode="register">Создать аккаунт</a>';
    } else {
      titleEl.textContent    = 'Создать аккаунт';
      subtitleEl.textContent = 'Только буквы и цифры в имени, пароль минимум 4 символа';
      submitLabel.textContent = 'Создать';
      passwordInput.autocomplete = 'new-password';
      toggleHint.innerHTML = 'Уже есть аккаунт? <a href="#" data-mode="login">Войти</a>';
    }
    clearError();
  }

  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  toggleHint.addEventListener('click', e => {
    if (e.target.tagName === 'A' && e.target.dataset.mode) {
      e.preventDefault();
      setMode(e.target.dataset.mode);
    }
  });

  // ── Initial mode (also sets the data-attr for tab indicator) ────
  tile.dataset.mode = 'login';

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

    setBusy(true);
    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
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
})();
