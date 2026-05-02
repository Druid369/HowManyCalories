/* ════════════════════════════════════════════════
   FORK — Storage + small utils
   - localStorage scan history (load / save / clear)
   - String escaping, date formatting, haptic helper
   - Fires "hmc:history-changed" CustomEvent after writes so the UI
     can re-render without storage.js needing to know about render funcs.
   Globals: depends on none. Used by app.js + api.js.
════════════════════════════════════════════════ */

var STORAGE_KEY        = 'hmc_v1';
var WATER_KEY          = 'hmc_water_v1';     // [{ts, ml}]
var QUALITY_KEY        = 'hmc_quality_v1';   // { 'YYYY-MM-DD': {color, summary, tip, hash} }
var SETTINGS_KEY       = 'hmc_settings_v1';
// DEPRECATED — kept as fallback constants for any read site that hasn't been
// migrated yet, AND as the source of truth for DEFAULT_SETTINGS below. New
// code should call getSetting('daily_kcal') / getSetting('daily_water_ml')
// so live target updates from the settings sheet propagate without each
// caller having to listen for a refresh event.
var DAILY_GOAL         = 2000;
var WATER_DAILY_TARGET = 2000;               // ml
var HISTORY_LIMIT      = 60;

// ── Settings (per-user daily targets) ─────────────────────
// Stored under SETTINGS_KEY. Forward-compatible: any new field added to
// DEFAULT_SETTINGS picks up its default value for legacy users automatically
// because loadSettings() spreads defaults under the stored object. Macro
// percentages are persisted now so Phase 7 (macro-balance UI) and Phase 8
// (day-quality agent receiving user targets) can read them without a
// separate migration.
var DEFAULT_SETTINGS = {
  daily_kcal:          DAILY_GOAL,
  daily_water_ml:      WATER_DAILY_TARGET,
  target_protein_pct:  30,
  target_fat_pct:      30,
  target_carbs_pct:    40,
  theme:               'warm',  // see VALID_THEMES below; folded into settings so server sync covers it for free
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    return Object.assign({}, DEFAULT_SETTINGS, raw);
  } catch { return Object.assign({}, DEFAULT_SETTINGS); }
}

function getSetting(key) {
  const s = loadSettings();
  return s[key] !== undefined ? s[key] : DEFAULT_SETTINGS[key];
}

// Apply a partial update to settings. Touches updated_at so we can later
// detect a non-default profile (e.g. for analytics / day-quality agent
// "user has tuned targets" signal). Fires hmc:settings-changed so any
// surface that displays a target re-renders without an explicit refresh.
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return false;
  const cur  = loadSettings();
  const next = Object.assign({}, cur, patch, { updated_at: Date.now() });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('hmc:settings-changed'));
    // Phase 3B: mirror the full settings blob to the server so it
    // survives browser-data clears / multi-device. Fire-and-forget;
    // the local change is the immediate UX.
    if (typeof pushServerSettings === 'function') pushServerSettings(next);
    return true;
  } catch (err) {
    console.error('[setSettings] localStorage write failed:', err);
    return false;
  }
}

function resetSettings() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    window.dispatchEvent(new CustomEvent('hmc:settings-changed'));
    // Phase 3B: clear server-side too. Pushing {} results in
    // "no settings stored" semantics (GET returns {}; defaults apply).
    if (typeof pushServerSettings === 'function') pushServerSettings({});
    return true;
  } catch (err) {
    console.error('[resetSettings] localStorage remove failed:', err);
    return false;
  }
}

// Phase 3B: pull the user's settings from the server on app boot. If
// the server has settings stored, replace localStorage with them so
// the in-app reads (which all go through loadSettings/getSetting)
// reflect the canonical value. If the server has nothing yet, do
// nothing — local defaults stand and the next setSettings() call
// will push them up.
async function syncSettingsFromServer() {
  if (typeof pullServerSettings !== 'function') return false;
  try {
    const remote = await pullServerSettings();
    if (!remote) return false;
    if (Object.keys(remote).length === 0) return false;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(remote));
    window.dispatchEvent(new CustomEvent('hmc:settings-changed'));
    return true;
  } catch (err) {
    console.warn('[syncSettingsFromServer]', err);
    return false;
  }
}

// ── Theme ────────────────────────────────────
// Color-palette selection lives inside the same settings blob as
// daily targets — that way pushServerSettings/pullServerSettings
// covers it for free (multi-device sync, fresh-login restore). The
// VALID_THEMES allowlist filters out stale stored values (e.g. a
// retired experimental name) so they fall back to the default
// rather than producing an unstyled app.
var DEFAULT_THEME = 'warm';
var VALID_THEMES  = ['warm', 'light', 'dark', 'verdant'];

function getTheme() {
  const t = getSetting('theme');
  return VALID_THEMES.indexOf(t) !== -1 ? t : DEFAULT_THEME;
}

function setTheme(name) {
  if (VALID_THEMES.indexOf(name) === -1) return false;

  // Persist via setSettings — that single call handles localStorage,
  // server mirror (PUT /api/settings), and the hmc:settings-changed
  // event dispatch.
  setSettings({ theme: name });

  // Instant DOM swap. We previously wrapped this in
  // document.startViewTransition() for a 350ms cross-fade, but the
  // API works by snapshotting the OLD and NEW DOMs as bitmaps and
  // overlaying them — with backdrop-filter on 14 surfaces, the
  // midpoint of the cross-fade reads as a "ghost" of the previous
  // theme bleeding through. A single-frame attribute swap avoids the
  // overlap entirely and the eye perceives no in-between state.
  document.documentElement.setAttribute('data-theme', name);

  window.dispatchEvent(new CustomEvent('hmc:theme-changed', { detail: { theme: name } }));
  return true;
}

// Reads the stored theme and applies it to <html>. Called once at boot
// after CSS has loaded so a non-default choice doesn't flash the warm
// palette before swapping. The HTML <html data-theme="warm"> default
// means "warm" users see no flash regardless of when this runs.
// Idempotent: skips the DOM write when the attribute is already correct,
// so the hmc:settings-changed reconciliation listener won't churn.
function applyStoredTheme() {
  const want = getTheme();
  if (document.documentElement.getAttribute('data-theme') !== want) {
    document.documentElement.setAttribute('data-theme', want);
  }
}

// "Consumed" semantics: an entry's `consumed` flag tells us whether the user
// actually ate the scanned dish. Default for new saves is true (the common
// case — you scan because you ate). Legacy entries without the field are
// treated as consumed so existing data isn't silently zeroed.
function isEntryConsumed(e) { return e && e.consumed !== false; }

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

// Phase 2: pull the user's canonical history from the server and write
// it into the localStorage cache. Called once on app boot when the
// local cache is empty (e.g. fresh login or a browser-data clear). The
// returned entry shape matches what saveEntry stores locally — same
// keys, same types — so existing renderers don't need to know whether
// an entry came from the server or a fresh scan.
//
// `imageDataUrl` for server entries is a real URL (`/api/scans/{id}/image`),
// not a base64 data: URL, but the browser's <img src> handles both
// transparently. Sending the cookie via `credentials: 'same-origin'` is
// what lets the auth-gated image endpoint actually serve the file.
//
// Returns the number of entries pulled (0 on any failure path).
async function syncEntriesFromServer() {
  try {
    const res = await fetch('/api/entries?limit=500', { credentials: 'same-origin' });
    if (!res.ok) return 0;
    const entries = await res.json();
    if (!Array.isArray(entries)) return 0;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new CustomEvent('hmc:history-changed'));
    return entries.length;
  } catch (err) {
    console.warn('[syncEntriesFromServer] failed:', err);
    return 0;
  }
}

// Returns { ok: bool, trimmed: int }
//   ok       — false iff the entry could not be saved at all
//   trimmed  — count of older entries dropped to make room (≥0)
// Callers can show the user a nudge when trimmed > 0 (some history was
// dropped) and a hard error when ok === false (THIS save was lost).
function saveEntry(entry) {
  const before = loadEntries();
  const list = [entry, ...before];
  if (list.length > HISTORY_LIMIT) list.pop();

  // Try to write; if localStorage is full (QuotaExceededError on iOS Safari
  // and elsewhere), drop the oldest entries 5 at a time until it fits.
  // Without this, a single failed setItem silently aborts the whole save.
  let attempts = 0;
  let trimmed = 0;
  while (attempts < 12) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('hmc:history-changed'));
      return { ok: true, trimmed };
    } catch (err) {
      if (list.length <= 1) {
        console.error('[saveEntry] localStorage full and entry is too big to fit:', err);
        return { ok: false, trimmed };
      }
      list.splice(-5);  // drop 5 oldest
      trimmed += 5;
      attempts++;
    }
  }
  console.error('[saveEntry] gave up after 12 trim attempts');
  return { ok: false, trimmed };
}

function clearEntries() {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('hmc:history-changed'));
}

// Patch an existing entry by id (used when the user edits ingredients
// post-analysis and wants to update the saved scan rather than duplicate it).
// Loose string-comparison on id since entry ids are sometimes stored as
// numbers (Date.now() at save time) and sometimes as strings (DOM dataset
// values are always strings) — strict equality silently no-ops the update.
function updateEntry(id, patch) {
  const list = loadEntries();
  const sid = String(id);
  const idx = list.findIndex(e => String(e.id) === sid);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent('hmc:history-changed'));
  return true;
}

// Remove a single entry by id. Used for the per-dish delete button in
// history. Loose string-comparison on id since entry ids are sometimes
// stored as numbers and sometimes as strings depending on origin.
function deleteEntryById(id) {
  const list = loadEntries();
  const sid = String(id);
  const filtered = list.filter(e => String(e.id) !== sid);
  if (filtered.length === list.length) return false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  window.dispatchEvent(new CustomEvent('hmc:history-changed'));
  return true;
}

// Toggle / set the consumed flag on an entry. Day totals filter on this.
function setEntryConsumed(id, consumed) {
  const ok = updateEntry(id, { consumed: !!consumed });
  return ok;
}

// ── Water log ────────────────────────────────
// Append-only list of {ts, ml} entries. Quick-add chips push, undo pops the
// most recent entry that's within the same calendar day. Daily total is
// computed by filtering on date.
function loadWaterLog() {
  try { return JSON.parse(localStorage.getItem(WATER_KEY)) || []; }
  catch { return []; }
}
function saveWaterLog(log) {
  localStorage.setItem(WATER_KEY, JSON.stringify(log));
  window.dispatchEvent(new CustomEvent('hmc:water-changed'));
  // Phase 3B: mirror the whole log to the server so add/undo/cutoff
  // changes survive a browser-data clear. Whole-blob PUT keeps the
  // sync model trivial — no per-entry id tracking needed since the
  // server doesn't allocate ids; the client owns the array shape.
  if (typeof pushServerWaterLog === 'function') pushServerWaterLog(log);
}

// Phase 3B: pull water log from the server on app boot. Replaces local
// cache when the server has data (canonical source). Returns true if a
// replace happened; false otherwise (server empty / fetch failed —
// local cache stands).
async function syncWaterLogFromServer() {
  if (typeof pullServerWaterLog !== 'function') return false;
  try {
    const remote = await pullServerWaterLog();
    if (!Array.isArray(remote) || remote.length === 0) return false;
    localStorage.setItem(WATER_KEY, JSON.stringify(remote));
    window.dispatchEvent(new CustomEvent('hmc:water-changed'));
    return true;
  } catch (err) {
    console.warn('[syncWaterLogFromServer]', err);
    return false;
  }
}
function addWater(ml) {
  if (!ml || ml <= 0) return;
  const log = loadWaterLog();
  log.push({ ts: Date.now(), ml: Math.round(ml) });
  // Keep at most 30 days of water entries to avoid unbounded growth.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  saveWaterLog(log.filter(e => e.ts > cutoff));
}
function undoLastWater() {
  const log = loadWaterLog();
  if (!log.length) return false;
  // Only allow undoing entries from today (don't let user accidentally rewind history)
  const today = new Date();
  const last = log[log.length - 1];
  const lastDay = new Date(last.ts);
  if (lastDay.getFullYear() !== today.getFullYear() ||
      lastDay.getMonth()    !== today.getMonth()    ||
      lastDay.getDate()     !== today.getDate()) return false;
  log.pop();
  saveWaterLog(log);
  return true;
}
function getWaterTotalForDay(day) {
  const log = loadWaterLog();
  return log
    .filter(e => {
      const d = new Date(e.ts);
      return d.getFullYear() === day.getFullYear() &&
             d.getMonth()    === day.getMonth() &&
             d.getDate()     === day.getDate();
    })
    .reduce((sum, e) => sum + e.ml, 0);
}

// ── Day-quality cache ─────────────────────────
// Quality scores are computed by an LLM on the server but cached locally
// keyed by date. The hash captures the content shape so we know when to
// invalidate (entries added/removed/edited).
function getCachedQuality(dateKey) {
  try {
    const map = JSON.parse(localStorage.getItem(QUALITY_KEY)) || {};
    return map[dateKey] || null;
  } catch { return null; }
}
function setCachedQuality(dateKey, quality) {
  try {
    const map = JSON.parse(localStorage.getItem(QUALITY_KEY)) || {};
    map[dateKey] = quality;
    // Cap the cache at ~90 days to avoid runaway growth.
    const keys = Object.keys(map).sort().reverse();
    if (keys.length > 90) {
      keys.slice(90).forEach(k => delete map[k]);
    }
    localStorage.setItem(QUALITY_KEY, JSON.stringify(map));
  } catch {}
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(d) {
  const now = new Date();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (sameDay(d, now))  return 'Сегодня';
  if (sameDay(d, yest)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { month: 'long', day: 'numeric' });
}

function formatDate(ts) { return new Date(ts).toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

function haptic(pattern = 8) { navigator.vibrate && navigator.vibrate(pattern); }
