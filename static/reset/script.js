/* ════════════════════════════════════════════════
   FORK — Reset password screen logic

   Reads ?token=X from the URL, exchanges it via
   POST /api/auth/password-reset/confirm, then redirects
   to /login?reset=1 on success so the login page can
   show a confirmation toast.

   Token-missing / 410 paths swap the tile to its
   "invalid" mode (form hidden, ссылка-устарела card shown).
═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  const tile           = document.getElementById('resetTile');
  const form           = document.getElementById('resetForm');
  const passwordInput  = document.getElementById('resetPassword');
  const confirmInput   = document.getElementById('resetPasswordConfirm');
  const submitBtn      = document.getElementById('resetSubmit');
  const submitLabel    = submitBtn ? submitBtn.querySelector('.auth-submit-label') : null;
  const errorEl        = document.getElementById('resetError');

  /* Read the token. The /api/auth/email/verify endpoint that issued
     this URL guarantees the token is at least 30 chars; reject
     anything obviously short before calling the server. */
  let token = '';
  try {
    const params = new URLSearchParams(window.location.search);
    token = (params.get('token') || '').trim();
  } catch (_) { /* file:// or sandboxed; token stays empty */ }

  if (!token || token.length < 20) {
    showInvalid();
    return;
  }

  // ── Submit gating: button stays dim until both fields valid + match.
  function checkReady() {
    if (!form) return;
    const pw = passwordInput.value;
    const cf = confirmInput.value;
    const ok = pw.length >= 4 && pw === cf;
    form.classList.toggle('ready', ok);
  }
  if (passwordInput) passwordInput.addEventListener('input', checkReady);
  if (confirmInput)  confirmInput.addEventListener('input',  checkReady);

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }
  function clearError() {
    if (!errorEl) return;
    errorEl.classList.remove('visible');
    setTimeout(() => {
      if (!errorEl.classList.contains('visible')) errorEl.textContent = '';
    }, 220);
  }

  /* Swap to the "ссылка устарела" card. Used on no-token and on
     server 410 (expired/used/invalid). The card has its own CTA back
     to /login so the user is never stuck. */
  function showInvalid() {
    if (tile) tile.classList.add('invalid');
  }

  // ── Server error mapping. The endpoint returns:
  //    410 → "Ссылка устарела или недействительна" (treat as invalid)
  //    422 → password validation error (Russian, pass through)
  //    other 4xx → fall through to generic
  const ERROR_MAP = {
    'Ссылка устарела или недействительна': 'Ссылка устарела или недействительна',
    'Password must be at least 4 characters': 'Пароль должен быть минимум 4 символа',
    'Password is too long (max 128 characters)': 'Пароль слишком длинный',
  };
  function localizeError(detail) {
    if (typeof detail === 'string' && ERROR_MAP[detail]) return ERROR_MAP[detail];
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0];
      return (first && (first.msg || first.message)) || 'Проверьте данные и попробуйте снова';
    }
    return 'Не удалось сменить пароль. Попробуйте снова.';
  }

  // ── Submit handler.
  let busy = false;
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      clearError();

      const pw = passwordInput.value;
      const cf = confirmInput.value;
      if (pw.length < 4) { showError('Минимум 4 символа'); return; }
      if (pw !== cf)     { showError('Пароли не совпадают'); return; }

      busy = true;
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');

      try {
        const res = await fetch('/api/auth/password-reset/confirm', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: token, new_password: pw }),
          credentials: 'same-origin',
        });

        if (res.status === 410) {
          // Token was rejected — expired, used, or never existed.
          // Swap to the invalid card; the user can request a fresh
          // reset from there.
          showInvalid();
          return;
        }
        if (!res.ok) {
          let body = {};
          try { body = await res.json(); } catch { /* non-JSON */ }
          showError(localizeError(body.detail));
          busy = false;
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
          return;
        }

        // Success — server invalidated all sessions for this user, so
        // a fresh login is required. Redirect with a query param
        // /login picks up to show the success toast.
        window.location.replace('/login?reset=1');
      } catch (_) {
        showError('Сетевая ошибка. Проверьте подключение.');
        busy = false;
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
      }
    });
  }

  // Initial readiness pass (handles browser autofill).
  checkReady();

  // Focus the new-password field unless on a touch device — on
  // mobile, keyboard popping up before the user has read the title
  // is jarring.
  if (!('ontouchstart' in window) && passwordInput) {
    setTimeout(() => passwordInput.focus(), 120);
  }
})();
