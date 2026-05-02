/* ════════════════════════════════════════════════
   FORK — API + image compression + error overlay
   - Client-side image resize before upload (saves bandwidth + Claude tokens)
   - POST /api/analyze
   - Error overlay (operates on #errorOverlay DOM directly)
   Globals: Spring (from spring.js).
════════════════════════════════════════════════ */

const ERROR_MAP = {
  'No food was detected': {
    title: 'Еда не обнаружена',
    detail: 'Не удалось распознать еду на этом фото. Попробуйте сделать более чёткий, хорошо освещённый снимок.',
    warn: true,
  },
  'API key not configured': {
    title: 'Сервис недоступен',
    detail: 'Сервис анализа временно недоступен. Попробуйте позже.',
    warn: false,
  },
  'rate limit': {
    title: 'Слишком много запросов',
    detail: 'Вы сканируете слишком быстро. Подождите немного и попробуйте снова.',
    warn: true,
  },
};

function showError(msg) {
  const overlay = document.getElementById('errorOverlay');
  const titleEl = document.getElementById('errorTitle');
  const detailEl = document.getElementById('errorDetail');
  const iconEl = document.getElementById('errorIcon');

  const key = Object.keys(ERROR_MAP).find(k => msg.toLowerCase().includes(k.toLowerCase()));
  const info = key ? ERROR_MAP[key] : { title: 'Что-то пошло не так', detail: msg, warn: false };

  titleEl.textContent = info.title;
  detailEl.textContent = info.detail;
  iconEl.classList.toggle('warn', !!info.warn);
  overlay.classList.add('show');

  Spring.springTo(overlay.querySelector('.error-card'), {
    from: { y: 20, opacity: 0, scale: 0.95 },
    to:   { y: 0, opacity: 1, scale: 1 },
    preset: 'snappy',
  });
}

function hideError() {
  document.getElementById('errorOverlay').classList.remove('show');
}

// ── Image compression ─────────────────────────
function compressImage(file, maxPx = 1280) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else        { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(resolve, 'image/jpeg', 0.88);
    };
    img.src = url;
  });
}

// ── API call ──────────────────────────────────
async function analyzeFood(blob, portionHint, opts) {
  const fd = new FormData();
  fd.append('image', blob, 'food.jpg');
  if (portionHint) fd.append('portion_hint', portionHint);

  // signal lets callers pass an AbortController.signal to cancel the
  // request mid-flight (used by the hold-to-cancel UI on the analysis
  // tile). On abort, fetch rejects with AbortError which the caller
  // distinguishes from genuine failure.
  const signal = opts && opts.signal;
  const res = await fetch('/api/analyze', { method: 'POST', body: fd, signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'object' ? err.detail.message : (err.detail || 'Analysis failed');
    throw new Error(msg);
  }
  return res.json();
}

// ── Streaming analyze (Phase 1) ────────────────────────────
// Consumes /api/analyze/stream, an SSE endpoint that emits stage-by-stage
// progress events during the 30-60s pipeline. We use fetch + ReadableStream
// because EventSource doesn't support POST with multipart body.
//
// Wire format: events separated by \n\n; each event has lines like
//   event: <name>
//   data:  <JSON>
//
// `onEvent(name, data)` is invoked per parsed event (synchronously). The
// caller is responsible for capturing the `done` event payload as the
// final result if needed. abortSignal aborts the underlying fetch and
// the reader cleanly.
async function analyzeImageStream(blob, portionHint, onEvent, abortSignal) {
  const fd = new FormData();
  fd.append('image', blob, 'food.jpg');
  if (portionHint) fd.append('portion_hint', portionHint);

  const res = await fetch('/api/analyze/stream', {
    method: 'POST',
    body: fd,
    signal: abortSignal,
    credentials: 'same-origin',
  });

  if (!res.ok) {
    let detail = `Server returned ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.detail) {
        detail = typeof j.detail === 'string'
          ? j.detail
          : (j.detail.message || JSON.stringify(j.detail));
      }
    } catch { /* response wasn't JSON; keep generic message */ }
    throw new Error(detail);
  }

  if (!res.body) {
    // Older Safari without ReadableStream support — fall back loudly.
    throw new Error('Streaming not supported by this browser');
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE event boundary is a blank line (\n\n). Process every
      // complete block currently in the buffer; partial trailing data
      // stays in the buffer for the next read.
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim()) continue;
        const parsed = _parseSSEBlock(block);
        if (!parsed) continue;
        // Handler errors propagate intentionally: an `error` event from
        // the server is delivered by handleAnalyzeEvent throwing, and the
        // outer caller's catch needs to see it so the analyzing overlay
        // closes and the error UI surfaces. Swallowing it here would
        // strand the user on the analyzing screen.
        onEvent(parsed.event, parsed.data);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// Parse one SSE block (`event:` line + `data:` line(s)) into {event, data}.
// Spec allows multi-line data fields joined by \n; we honor that. Lines
// starting with ":" are SSE comments and ignored.
function _parseSSEBlock(block) {
  let event = 'message';
  let dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join('\n');
  try { return { event, data: JSON.parse(dataStr) }; }
  catch (err) {
    console.warn('[SSE] bad JSON in event', event, ':', dataStr.slice(0, 200));
    return null;
  }
}

// Re-validation of user edits — POST to /api/validate-edits as multipart
// with the original (compressed) image blob + a JSON-encoded item list.
// Server returns a verdict matching the ValidationVerdict schema.
async function validateEdits(imageBlob, items) {
  const fd = new FormData();
  fd.append('image', imageBlob, 'food.jpg');
  fd.append('items', JSON.stringify(items));
  const res = await fetch('/api/validate-edits', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let msg;
    if (typeof err.detail === 'string')  msg = err.detail;
    else if (Array.isArray(err.detail))  msg = err.detail[0]?.msg || 'Не удалось проверить';
    else                                 msg = 'Сервис проверки временно недоступен';
    throw new Error(msg);
  }
  return res.json();
}

// Day-quality verdict — POST a date's consumed items + water + target
// calories to the server agent. Returns {color, summary, tip}. The client
// caches the response per date in localStorage; the cache is invalidated
// whenever the day's content changes.
async function fetchDayQuality(payload) {
  const res = await fetch('/api/day-quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let msg;
    if (typeof err.detail === 'string')   msg = err.detail;
    else if (Array.isArray(err.detail))   msg = err.detail[0]?.msg || 'Не удалось оценить день';
    else                                  msg = 'Сервис оценки временно недоступен';
    throw new Error(msg);
  }
  return res.json();
}

// Phase 3A — write-side server sync for entries. The frontend keeps
// a localStorage cache for fast renders, but every user-triggered change
// (consumed toggle, ingredient edit, delete) is mirrored to the server
// fire-and-forget so it survives a browser-data clear / multi-device.
//
// Failure handling: silent. The local update is the immediate UX; if
// the server PATCH/DELETE fails we just log and move on. The next
// `syncEntriesFromServer` on app boot reconciles to the server's truth.
// The user never sees an "edit failed to save" toast — that would imply
// the local change wasn't applied, which it was.
async function patchServerEntry(entryId, patch) {
  if (entryId == null) return false;
  try {
    const res = await fetch(`/api/entries/${entryId}`, {
      method:      'PATCH',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(patch),
      credentials: 'same-origin',
    });
    return res.ok;
  } catch (err) {
    console.warn('[patchServerEntry]', entryId, err);
    return false;
  }
}

async function deleteServerEntry(entryId) {
  if (entryId == null) return false;
  try {
    const res = await fetch(`/api/entries/${entryId}`, {
      method:      'DELETE',
      credentials: 'same-origin',
    });
    return res.ok;
  } catch (err) {
    console.warn('[deleteServerEntry]', entryId, err);
    return false;
  }
}

// Phase 3B — settings + water log server sync. Same fire-and-forget
// pattern as entries: local writes are immediate, server PUTs follow
// silently. Pull-on-init reconciles to the server's state.

async function pullServerSettings() {
  try {
    const res = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch (err) {
    console.warn('[pullServerSettings]', err);
    return null;
  }
}

async function pushServerSettings(settings) {
  try {
    const res = await fetch('/api/settings', {
      method:      'PUT',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(settings || {}),
      credentials: 'same-origin',
    });
    return res.ok;
  } catch (err) {
    console.warn('[pushServerSettings]', err);
    return false;
  }
}

async function pullServerWaterLog() {
  try {
    const res = await fetch('/api/water', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn('[pullServerWaterLog]', err);
    return null;
  }
}

// Phase 4 — profile + avatar + logout helpers. Unlike entries / settings
// these are NOT fire-and-forget; the caller awaits and inspects the
// response so the account sheet can show errors inline (e.g. avatar
// rejected for being too large) and refresh the UI with the canonical
// user record returned by the server.

async function fetchCurrentUser() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[fetchCurrentUser]', err);
    return null;
  }
}

async function updateProfile(patch) {
  const res = await fetch('/api/auth/profile', {
    method:      'PUT',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify(patch || {}),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'string'
      ? err.detail
      : (Array.isArray(err.detail) && err.detail[0]?.msg) || 'Не удалось сохранить профиль';
    throw new Error(msg);
  }
  return res.json();
}

async function uploadAvatar(blob) {
  const fd = new FormData();
  fd.append('image', blob, 'avatar.jpg');
  const res = await fetch('/api/auth/avatar', {
    method:      'POST',
    body:        fd,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'string' ? err.detail : 'Не удалось загрузить фото';
    throw new Error(msg);
  }
  return res.json();
}

async function deleteAvatar() {
  const res = await fetch('/api/auth/avatar/delete', {
    method:      'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Не удалось удалить фото');
  return res.json();
}

async function logoutUser() {
  try {
    await fetch('/api/auth/logout', {
      method:      'POST',
      credentials: 'same-origin',
    });
  } catch (err) {
    console.warn('[logoutUser]', err);
  }
}

async function changePassword(currentPassword, newPassword) {
  const res = await fetch('/api/auth/change-password', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({
      current_password: currentPassword,
      new_password:     newPassword,
    }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'string'
      ? err.detail
      : (Array.isArray(err.detail) && err.detail[0]?.msg) || 'Не удалось сменить пароль';
    throw new Error(msg);
  }
  return res.json();
}

async function deleteAccount(password, reason) {
  const body = { password };
  // Optional feedback string — server logs it (no separate endpoint
  // for now; the delete handler picks it up). Empty/whitespace skipped.
  const trimmed = (reason || '').trim();
  if (trimmed) body.reason = trimmed.slice(0, 500);
  const res = await fetch('/api/auth/delete-account', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'string'
      ? err.detail
      : 'Не удалось удалить аккаунт';
    throw new Error(msg);
  }
  return res.json();
}

async function pushServerWaterLog(log) {
  try {
    const res = await fetch('/api/water', {
      method:      'PUT',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(Array.isArray(log) ? log : []),
      credentials: 'same-origin',
    });
    return res.ok;
  } catch (err) {
    console.warn('[pushServerWaterLog]', err);
    return false;
  }
}

// Manual ingredient lookup — used by the "+ Ингредиент" sheet.
// 404 from the server (no DB hit anywhere) surfaces as a localized
// detail string; 422 (validation) surfaces the first field message.
async function lookupIngredient(name, grams, usdaSearchTerm) {
  const body = { name, grams };
  if (usdaSearchTerm) body.usda_search_term = usdaSearchTerm;
  const res = await fetch('/api/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let msg;
    if (typeof err.detail === 'string')      msg = err.detail;
    else if (Array.isArray(err.detail))      msg = err.detail[0]?.msg || 'Неверный ввод';
    else                                     msg = 'Не удалось найти ингредиент';
    throw new Error(msg);
  }
  return res.json();
}
