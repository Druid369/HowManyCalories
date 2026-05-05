/* ════════════════════════════════════════════════
   FORK — App orchestrator
   Depends on (load order):
     1. spring.js   — Spring global
     2. storage.js  — STORAGE_KEY, loadEntries, saveEntry, clearEntries,
                      esc, dayLabel, sameDay, formatDate, formatTime, haptic
     3. api.js      — analyzeFood, compressImage, showError, hideError
     4. app.js      — this file
════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────
let selectedFile   = null;
let selectedPortion = '';
let currentBlobUrl = null;
let currentResult  = null;
let isSaved        = false;
let currentEntryId = null;   // history-entry id of the result on screen, if any

// The compressed blob sent to /api/analyze — kept around so the validation
// agent ("Исправить…") can re-send the same image without forcing the user
// to re-upload. Lives only while the page is loaded; null when viewing a
// saved entry from history (we only have the thumbnail then).
let lastAnalyzedBlob = null;

// Snapshot of estimated_grams as Stage 3 produced them, indexed positionally.
// Used by the validator request to send `original_grams` so the model knows
// what the user changed from. Reset on every new scan.
let originalGramsByIdx = [];

// Where the currently-displayed result came from. The back arrow uses this
// to send the user back to the right place: 'fresh' → upload screen,
// 'history' → history view (where they tapped the entry).
let lastViewSource = 'fresh';

// ── DOM refs ──────────────────────────────────
const $ = id => document.getElementById(id);

const scanZone     = $('scanZone');
const cameraInput  = $('cameraInput');
const galleryInput = $('galleryInput');
const btnCamera    = $('btnCamera');
const btnGallery   = $('btnGallery');
// btnBack + btnScanAgain removed in Phase B — the report overlay's two
// corner X close buttons (btnReportCloseTop, btnReportCloseBottom) plus
// backdrop tap replace them. The "open" event is the overlay being shown,
// the "close" event is closeReportOverlay() which returns the user to
// whichever view they were on (scanner or history).
const btnSave      = $('btnSave');
// btnClear removed in the history-tab redesign — per-entry × buttons cover
// the destructive case at the right granularity.

// Analyzing overlay (Phase 1) — streaming-progress popup driven by
// SSE events from /api/analyze/stream.
const analyzingOverlay           = $('analyzingOverlay');
const analyzingOverlayCard       = $('analyzingOverlayCard');
const analyzingOverlayPhoto      = $('analyzingOverlayPhoto');
const analyzingOverlayBboxLayer  = $('analyzingOverlayBboxLayer');
const analyzingOverlayStageLabel = $('analyzingOverlayStageLabel');
const analyzingOverlayPct        = $('analyzingOverlayPct');
const analyzingOverlayEta        = $('analyzingOverlayEta');
const analyzingOverlayItemsList  = $('analyzingOverlayItemsList');
const analyzingOverlayItemsCount = $('analyzingOverlayItemsCount');
const analyzingOverlayLog        = $('analyzingOverlayLog');
const analyzingOverlayCancel     = $('analyzingOverlayCancel');

const resultThumb   = $('resultThumb');
const calNumber     = $('calNumber');
const confidenceTag = $('confidenceTag');
const macroBars     = $('macroBars');
const itemsList     = $('itemsList');
const itemCount     = $('itemCount');
const analysisCard   = $('analysisCard');
const insightBody    = $('insightBody');   // <ul> of bulleted sentences
const notesBody      = $('notesBody');     // collapsed-by-default block
const btnNotesToggle = $('btnNotesToggle');
const errorOverlay  = $('errorOverlay');
const errorTitle    = $('errorTitle');
const errorDetail   = $('errorDetail');
const errorIcon     = $('errorIcon');
const btnErrorRetry = $('btnErrorRetry');
const recentSection = $('recentSection');
const recentList    = $('recentList');
const historyContent = $('historyContent');

const navScanner   = $('navScanner');
const navHistory   = $('navHistory');

// Add-ingredient sheet
const btnOpenAddSheet  = $('btnOpenAddSheet');
const addSheet         = $('addSheet');
const addSheetBackdrop = $('addSheetBackdrop');
const addNameInput     = $('addName');
const addGramsInput    = $('addGrams');
const addSheetError    = $('addSheetError');
const btnAddSubmit     = $('btnAddSubmit');
const btnAddCancel     = $('btnAddCancel');

// Validation agent
const btnValidateEdits = $('btnValidateEdits');
const verdictCard      = $('verdictCard');
const verdictTitle     = $('verdictTitle');
const verdictOverall   = $('verdictOverall');
const verdictItems     = $('verdictItems');
const btnVerdictClose  = $('btnVerdictClose');

const views   = { scanner: $('view-scanner'),  history: $('view-history') };
// Phase B reduced the screen system to a single screen (upload). The
// "results" screen became the report overlay (#reportOverlay), which
// is no longer part of this map — overlays live alongside sheets at
// the .app level rather than within the screen-stack inside views.
const screens = { upload: $('screen-upload') };
const appShell = $('appShell');

// Toggle the app shell's context class so the FORK app-header can collapse
// when the report overlay is open. The hero card inside the overlay
// identifies the page; the global header would just be chrome. Phase B
// renamed this from .context-results to .context-report and drives the
// class from openReportOverlay/closeReportOverlay directly. This helper
// is now a no-op kept for caller compatibility — the class is managed
// where the overlay state changes.
function updateAppContext() {
  // Intentionally empty: header dimming is now handled by
  // openReportOverlay() / closeReportOverlay() adding/removing
  // .context-report on the appShell. Keeping the function defined so
  // existing call sites (showScreen, viewSavedResult) don't break.
}

// ── Navigation (spring-driven) ────────────────
let currentView = 'scanner';
// Pending cleanup timer for the previous switch's outgoing view. We
// don't use a "viewSwitching" boolean lock because if anything ever
// prevents the cleanup from running (heavy paint, throttled timer,
// layout thrash), the lock would stay stuck forever and every
// subsequent tab tap would return early. Instead each new switchView
// call cancels any pending cleanup and starts fresh — taps are always
// responsive.
let _viewCleanupTimer = null;
let _viewCleanupOutEl = null;

function switchView(name) {
  if (name === currentView) return;

  // If a prior switch is still cleaning up, run that cleanup now so the
  // outgoing element from this NEW switch starts from a known state.
  if (_viewCleanupTimer) {
    clearTimeout(_viewCleanupTimer);
    _viewCleanupTimer = null;
    if (_viewCleanupOutEl) {
      _viewCleanupOutEl.classList.add('no-transition');
      _viewCleanupOutEl.style.transform = '';
      void _viewCleanupOutEl.offsetWidth;
      _viewCleanupOutEl.classList.remove('no-transition');
      _viewCleanupOutEl = null;
    }
  }

  // direction: 1 = scanner→history (incoming comes from RIGHT, outgoing goes LEFT)
  //           -1 = history→scanner (incoming comes from LEFT, outgoing goes RIGHT)
  const direction = name === 'history' ? 1 : -1;
  const outEl = views[currentView];
  const inEl  = views[name];
  currentView = name;

  navScanner.classList.toggle('active', name === 'scanner');
  navHistory.classList.toggle('active', name === 'history');
  positionNavInk();
  updateAppContext();

  // 1. Snap inEl to its starting off-screen position WITHOUT animating that
  //    snap (no-transition class blocks the CSS transition for one frame).
  inEl.classList.add('no-transition');
  inEl.style.transform = `translateX(${100 * direction}%)`;
  inEl.classList.add('active');
  // Force a synchronous layout so the snapped transform commits before we
  // remove no-transition. Without this, the browser may batch the two
  // transform writes and animate from translateX(0)/100% to 0 — wrong direction.
  void inEl.offsetWidth;

  // 2. Remove no-transition + clear inline transform → CSS rule .view.active
  //    takes over (translateX 0). The CSS transition smoothly slides it in.
  inEl.classList.remove('no-transition');
  inEl.style.transform = '';

  // 3. Outgoing slides off the opposite side. The CSS transition handles it
  //    on the GPU; JS thread is free for whatever else needs to happen
  //    (e.g. renderHistory below).
  outEl.style.transform = `translateX(${-100 * direction}%)`;
  outEl.classList.remove('active');

  // 4. Defer history render until after the slide has STARTED. Doing it
  //    synchronously here would block the first ~30-80ms of the slide
  //    (large innerHTML insertion + image decoding). Two rAF cycles puts
  //    the work safely past the first compositor frame.
  if (name === 'history') {
    requestAnimationFrame(() => requestAnimationFrame(renderHistory));
  }

  // 5. Clean up after the transition completes. Reset outEl's inline
  //    transform back to CSS-default with no-transition so the off-screen
  //    snap doesn't animate. Cancellable so the next switchView can
  //    short-circuit if the user taps again before this fires.
  _viewCleanupOutEl = outEl;
  _viewCleanupTimer = setTimeout(() => {
    outEl.classList.add('no-transition');
    outEl.style.transform = '';
    void outEl.offsetWidth;
    outEl.classList.remove('no-transition');
    _viewCleanupTimer = null;
    _viewCleanupOutEl = null;
  }, 380);
}

let currentScreen = 'upload';

function showScreen(name) {
  if (name === currentScreen && screens[name].classList.contains('active')) return;
  const outEl = screens[currentScreen];
  const inEl  = screens[name];
  const prev = currentScreen;
  currentScreen = name;
  updateAppContext();

  // Cancel any running springs on both screens
  Spring.cancelElement(outEl);
  Spring.cancelElement(inEl);

  // Determine direction: upload(0) → results(1).
  // (analyzing is no longer a separate screen — see screens map above.)
  const order = { upload: 0, results: 1 };
  const forward = order[name] > order[prev];

  // Clean slate
  outEl.style.transform = '';
  outEl.style.opacity = '1';
  inEl.classList.add('active');
  inEl.style.opacity = '0';
  inEl.style.transform = `translateY(${forward ? 30 : -30}px)`;

  // Fade/slide out current screen.
  // Both springs use the same preset and run in lockstep so the cross-fade
  // window is brief (~300ms total) and the old screen never lingers on top
  // of the new one. The previous version mixed 'smooth' (1s settle time)
  // for outEl with 'snappy' (~300ms) for inEl, so the user saw the old
  // screen ghosting over the new one for ~700ms after the incoming
  // animation completed — that read as the "double close" glitch.
  Spring.springTo(outEl, {
    from: { y: 0, opacity: 1 },
    to:   { y: forward ? -24 : 24, opacity: 0 },
    preset: 'snappy',
  }).then(() => {
    outEl.classList.remove('active');
    outEl.style.transform = '';
    outEl.style.opacity = '';
  });

  // Slide in new screen, no delay — let it cross-fade with the outgoing one.
  Spring.springTo(inEl, {
    from: { y: forward ? 30 : -30, opacity: 0 },
    to:   { y: 0, opacity: 1 },
    preset: 'snappy',
  }).then(() => {
    inEl.style.transform = '';
    inEl.style.opacity = '';
  });
}

// pointerup fires before click on touch devices and isn't subject to
// iOS Safari's click-event quirks (300ms tap delay, focus-then-click
// pattern, suppression after a transform-during-touch hit-box shift).
// Wire BOTH for redundancy: whichever fires first calls switchView,
// the second is a silent no-op via switchView's name === currentView
// early-return. Without this fallback, the first scanner-tap after
// reload→history would be dropped by Safari.
navScanner.addEventListener('pointerup', () => switchView('scanner'));
navHistory.addEventListener('pointerup', () => switchView('history'));
navScanner.addEventListener('click',     () => switchView('scanner'));
navHistory.addEventListener('click',     () => switchView('history'));

// ── Bottom-nav ink slide ──────────────────────
// A 2px gold bar at the top edge of the nav slides between active
// items on tab switch. Position is measured from the active button's
// bounding box relative to the nav, applied as inline width + a
// transform translateX. CSS handles the slide animation.
const navInk = $('navInk');
function positionNavInk() {
  if (!navInk) return;
  const active = document.querySelector('.bottom-nav .nav-item.active');
  if (!active) return;
  const navBox = active.parentElement.getBoundingClientRect();
  const btnBox = active.getBoundingClientRect();
  // Inset the ink by 22% on each side so it sits under the icon+label
  // cluster, not the full button width — feels more deliberate.
  const inset  = btnBox.width * 0.22;
  const width  = btnBox.width - inset * 2;
  const left   = (btnBox.left - navBox.left) + inset;
  navInk.style.width = width + 'px';
  navInk.style.transform = `translateX(${left}px)`;
  // Reveal on first measurement — kept invisible until we know where
  // to put it, so users don't see a snap from 0,0 to the active spot.
  if (!navInk.classList.contains('ready')) {
    requestAnimationFrame(() => navInk.classList.add('ready'));
  }
}
window.addEventListener('resize', positionNavInk);
window.addEventListener('orientationchange', positionNavInk);

// ── File triggers (guarded against rapid taps) ─
let fileTriggerBusy = false;
function triggerFileInput(input) {
  if (fileTriggerBusy) return;
  fileTriggerBusy = true;
  input.click();
  setTimeout(() => { fileTriggerBusy = false; }, 400);
}

btnCamera.addEventListener('click',  () => { haptic(); triggerFileInput(cameraInput); });
btnGallery.addEventListener('click', () => { haptic(); triggerFileInput(galleryInput); });
// The scan zone splits into two intent zones now:
//   - .scan-camera-zone (top): tap anywhere → camera (cameraInput has
//     capture="environment", so iOS opens the camera directly)
//   - .scan-gallery-zone (bottom strip, button#btnGallery): handled by
//     the existing btnGallery click below
// Empty-area taps in the top zone fall through to cameraInput. Taps on
// the shutter button bubble up but the busy-guard in triggerFileInput
// prevents a duplicate fire.
const scanCameraZone = $('scanCameraZone');
if (scanCameraZone) {
  scanCameraZone.addEventListener('click', e => {
    if (e.target.closest('button')) return;  // shutter handles its own click
    haptic();
    triggerFileInput(cameraInput);
  });
}

cameraInput.addEventListener('change',  () => { if (cameraInput.files[0])  handleFile(cameraInput.files[0]);  cameraInput.value = ''; });
galleryInput.addEventListener('change', () => { if (galleryInput.files[0]) handleFile(galleryInput.files[0]); galleryInput.value = ''; });

// ── Drag & Drop ───────────────────────────────
scanZone.addEventListener('dragover', e => { e.preventDefault(); scanZone.classList.add('dragover'); });
scanZone.addEventListener('dragleave', e => { if (!scanZone.contains(e.relatedTarget)) scanZone.classList.remove('dragover'); });
scanZone.addEventListener('drop', e => {
  e.preventDefault();
  scanZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) handleFile(f);
});

// AbortController for the in-flight analyze request. Set in handleFile,
// triggered by the hold-to-cancel button. Null when no scan is running.
let _analyzeAbortController = null;

// ══════════════════════════════════════════════
// ANALYZING OVERLAY (Phase 1) — driven by SSE events from
// /api/analyze/stream. Each event mutates the visible UI:
//   started        → ETA + start client-side ETA timer
//   progress       → fill stage segments + global %
//   log            → append line to event log (latest 3 visible)
//   item_found     → insert item card + decorative bbox bracket
//   item_enriched  → add source badge to item card
//   item_revised   → flash item card (digit-flip lands in Phase 1.4)
//   stage_done     → mark stage as filled, advance label
//   done           → settle UI; outer caller transitions to report
//   error          → throw; outer caller closes overlay + showError
// ══════════════════════════════════════════════

const STAGE_LABELS  = { 1: 'Распознаю', 2: 'Уточняю', 3: 'Суммирую' };
// Stage progress windows. Tuned so each stage feels substantial:
//   Stage 1 (vision)         0   → 40%  ← longest perceived; Sonnet ~15-22s
//   Stage 2 (DB enrichment) 40   → 70%  ← medium; ~1-3s real
//   Stage 3 (Opus + diff)   70   → 100% ← long; carries Opus tail
// Must match server-side milestones in claude_vision.py.
const STAGE_RANGES  = { 1: [0.00, 0.40], 2: [0.40, 0.70], 3: [0.70, 1.00] };
const SOURCE_LABELS = {
  usda:           'USDA',
  russian_db:     'RUS',
  openfoodfacts:  'OFF',
  off:            'OFF',
  ai_estimate:    'AI',
  ai:             'AI',
};

// Progress driver — smoothly advances `current` toward
// max(server_target, synthetic_target). The synthetic target rises
// continuously over the expected duration so the bar never sits stuck
// during the long Sonnet/Opus waits. Server progress events bump the
// server_target up; the driver handles the smoothing in a single RAF
// loop. The synthetic is CLAMPED to the current stage's end milestone
// (× 0.92 for headroom) so it never overshoots — real milestones
// always snap the bar up, never down.
const _progressDriver = {
  current:          0,
  serverTarget:     0,
  // Active stage 1..3 — the synthetic ceiling depends on this.
  stage:            1,
  expectedTotalMs:  35000,
  startMs:          0,
  rafId:            null,
};
// End-of-stage milestones: indexed by stage number (1..3). Stage N's
// synthetic target plateaus at STAGE_END[N] * 0.92 so a real milestone
// event always has room to snap the bar visibly higher.
const _STAGE_END = [0, 0.40, 0.70, 0.95];

function _startProgressDriver(etaSeconds) {
  _progressDriver.current         = 0;
  _progressDriver.serverTarget    = 0;
  _progressDriver.stage           = 1;
  _progressDriver.expectedTotalMs = Math.max(8000, (etaSeconds || 35) * 1000);
  _progressDriver.startMs         = performance.now();
  if (_progressDriver.rafId) cancelAnimationFrame(_progressDriver.rafId);
  _progressDriver.rafId = requestAnimationFrame(_tickProgressDriver);
}

function _stopProgressDriver() {
  if (_progressDriver.rafId) {
    cancelAnimationFrame(_progressDriver.rafId);
    _progressDriver.rafId = null;
  }
}

function _bumpProgressTarget(value) {
  // Monotonic: server progress only ever moves forward.
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  if (v > _progressDriver.serverTarget) _progressDriver.serverTarget = v;
}

function _setActiveStage(stage) {
  // Stage only advances forward — late/out-of-order events don't pull
  // the synthetic ceiling backwards.
  const s = Number(stage);
  if (Number.isFinite(s) && s > _progressDriver.stage) {
    _progressDriver.stage = Math.min(3, s);
  }
}

function _tickProgressDriver(now) {
  const elapsed = now - _progressDriver.startMs;
  const total   = _progressDriver.expectedTotalMs;
  const stageEnd = _STAGE_END[_progressDriver.stage] || 0.40;
  // Synthetic target: ease-out curve scaled to this stage's milestone
  // ceiling × 0.92. Using `total * 1.05` gives the curve a bit of slack
  // (it never quite asymptotes by the time the real ETA elapses).
  const t = Math.min(1, elapsed / (total * 1.05));
  const synthetic = (1 - Math.pow(1 - t, 1.4)) * stageEnd * 0.92;
  const target = Math.max(synthetic, _progressDriver.serverTarget);
  // Lerp toward target at a rate that produces visually smooth motion
  // at 60fps (~75ms time-constant). Higher rate when far from target
  // so big snaps still feel reasonably immediate.
  const delta = target - _progressDriver.current;
  const rate  = Math.abs(delta) > 0.05 ? 0.12 : 0.08;
  _progressDriver.current += delta * rate;
  if (_progressDriver.current > 0.999) _progressDriver.current = 0.999;
  _renderProgressUI(_progressDriver.current);
  _progressDriver.rafId = requestAnimationFrame(_tickProgressDriver);
}

function _renderProgressUI(value) {
  Object.entries(STAGE_RANGES).forEach(([s, [lo, hi]]) => {
    const seg = document.querySelector(`.analyzing-overlay-stage-seg[data-stage="${s}"]`);
    if (!seg) return;
    const fill = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    seg.style.setProperty('--fill', String(fill));
  });
  if (analyzingOverlayPct) {
    analyzingOverlayPct.textContent = `${Math.round(value * 100)}%`;
  }
}

// Event queue — paces SSE events so they don't all flush instantly when
// the server returns a burst (e.g. all item_found at once after Sonnet).
// Each event type has its own delay; non-listed events process with no
// delay (progress, stage_done) so they stay tight to the timeline.
//
// State is tracked via a SYNCHRONOUS boolean (`_eventQueueRunning`),
// NOT via the drain Promise itself. An earlier version stored the
// Promise in a module-level slot:
//   _eventQueuePromise = _drainEventQueue();
// which raced with the drain's finally block when all queued events
// had delay=0: the drain ran to completion synchronously, finally set
// the slot to null, then the outer assignment overwrote it back to a
// resolved Promise — making subsequent queueOverlayEvent calls believe
// a drain was active when none was. Symptom: events from the 2nd/3rd
// scan sat in the queue forever; user saw 0% throughout.
const _eventQueue = [];
let   _eventQueueRunning = false;
const _eventQueueIdleResolvers = [];
const EVENT_DELAY_MS = {
  item_found:    700,  // each card gets ~3/4s on screen alone
  item_enriched: 250,  // source badges light up in sequence
  item_revised:  800,  // emphasize the "AI changed its mind" beat
  log:            80,  // tiny pause for log readability
};

function queueOverlayEvent(eventName, data) {
  _eventQueue.push({ eventName, data });
  if (!_eventQueueRunning) {
    _eventQueueRunning = true;
    _drainEventQueue();  // fire-and-forget; flag tracks completion
  }
}

async function _drainEventQueue() {
  try {
    while (_eventQueue.length > 0) {
      const { eventName, data } = _eventQueue.shift();
      // handleAnalyzeEvent throws on `error`; let it propagate up to
      // the outer await in handleFile so the overlay closes properly.
      handleAnalyzeEvent(eventName, data);
      const delay = EVENT_DELAY_MS[eventName] || 0;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    _eventQueueRunning = false;
    // Resolve every waiter at this idle point. New events queued after
    // this will start a fresh drain via queueOverlayEvent.
    const resolvers = _eventQueueIdleResolvers.splice(0);
    resolvers.forEach(r => r());
  }
}

function waitForEventQueue() {
  if (!_eventQueueRunning && _eventQueue.length === 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => _eventQueueIdleResolvers.push(resolve));
}

function clearEventQueue() {
  _eventQueue.length = 0;
  // Don't toggle _eventQueueRunning here — if a drain is currently
  // awaiting a setTimeout, it'll exit naturally on its next while-check.
  // We DO release any waiters since "queue is now empty" is true for
  // their purposes.
  const resolvers = _eventQueueIdleResolvers.splice(0);
  resolvers.forEach(r => r());
}

const _analyzingState = {
  etaStartedAt:   0,
  etaSeconds:     0,
  etaTimer:       null,
  itemsById:      new Map(),  // SSE id → item card DOM node
};

function resetAnalyzingOverlay() {
  if (!analyzingOverlay) return;
  if (analyzingOverlayItemsList)  analyzingOverlayItemsList.innerHTML  = '';
  if (analyzingOverlayLog)        analyzingOverlayLog.innerHTML        = '';
  if (analyzingOverlayBboxLayer)  analyzingOverlayBboxLayer.innerHTML  = '';
  if (analyzingOverlayItemsCount) analyzingOverlayItemsCount.textContent = '0';
  if (analyzingOverlayPct)        analyzingOverlayPct.textContent      = '0%';
  if (analyzingOverlayEta)        analyzingOverlayEta.textContent      = '';
  if (analyzingOverlayStageLabel) analyzingOverlayStageLabel.textContent = STAGE_LABELS[1];
  document.querySelectorAll('.analyzing-overlay-stage-seg').forEach(seg => {
    seg.style.setProperty('--fill', '0');
  });
  _analyzingState.itemsById.clear();
  if (_analyzingState.etaTimer) {
    clearInterval(_analyzingState.etaTimer);
    _analyzingState.etaTimer = null;
  }
  // Stop any prior progress driver and drop unprocessed events from a
  // previous run (in case the user re-scans before the prior overlay
  // fully closed).
  _stopProgressDriver();
  clearEventQueue();
}

function setAnalyzingOverlayPhoto(url) {
  if (analyzingOverlayPhoto) analyzingOverlayPhoto.src = url;
}

function openAnalyzingOverlay() {
  if (!analyzingOverlay) return;
  analyzingOverlay.classList.add('open');
  analyzingOverlay.setAttribute('aria-hidden', 'false');
  // Phase 3 stacking discipline: strip glass from home-view surfaces
  // behind full-screen overlays so simultaneous glass surfaces stay
  // ≤ 3 (overlay + header + nav). See LIQUID GLASS section in app.css.
  if (appShell) appShell.classList.add('overlay-active');
}

function closeAnalyzingOverlay() {
  if (!analyzingOverlay) return;
  analyzingOverlay.classList.remove('open');
  analyzingOverlay.setAttribute('aria-hidden', 'true');
  if (appShell) appShell.classList.remove('overlay-active');
  // Clear any in-flight cancel-iris state so the next open starts clean.
  if (analyzingOverlayCard) {
    analyzingOverlayCard.classList.remove('cancel-pressed', 'cancel-released');
  }
  if (_analyzingState.etaTimer) {
    clearInterval(_analyzingState.etaTimer);
    _analyzingState.etaTimer = null;
  }
  _stopProgressDriver();
  clearEventQueue();
}

// ── Hold-to-cancel for the new analyzing overlay ─────────────
// Pointer-down on the cancel chip starts a 1-second timer + an iris-
// close cover that collapses inward. Releasing before the timer fires
// reverses the cover and the analysis continues. Hitting 1 second
// aborts the in-flight fetch via _analyzeAbortController; the catch
// path in handleFile detects AbortError and closes the overlay.
let _overlayCancelHoldTimer = null;

function _clearOverlayCancelHold() {
  if (_overlayCancelHoldTimer) {
    clearTimeout(_overlayCancelHoldTimer);
    _overlayCancelHoldTimer = null;
  }
}

function setupAnalyzingOverlayCancel() {
  if (!analyzingOverlayCancel || !analyzingOverlayCard) return;

  const startHold = (e) => {
    if (!_analyzeAbortController) return;  // no analysis running
    if (e && e.preventDefault) e.preventDefault();
    analyzingOverlayCard.classList.remove('cancel-released');
    // Force reflow so the press transition restarts cleanly even if a
    // prior release just played.
    // eslint-disable-next-line no-unused-expressions
    analyzingOverlayCard.offsetWidth;
    analyzingOverlayCard.classList.add('cancel-pressed');
    haptic(8);
    _clearOverlayCancelHold();
    _overlayCancelHoldTimer = setTimeout(() => {
      // 1-second hold completed → commit cancellation. The fetch
      // catch path handles the rest (clearing classes, closing overlay).
      if (_analyzeAbortController) {
        try { _analyzeAbortController.abort(); } catch (_) {}
      }
      haptic([20, 50, 10]);
      _overlayCancelHoldTimer = null;
    }, 1000);
  };

  const endHold = () => {
    if (_overlayCancelHoldTimer) {
      // Released before commit — reverse the iris.
      _clearOverlayCancelHold();
      analyzingOverlayCard.classList.remove('cancel-pressed');
      analyzingOverlayCard.classList.add('cancel-released');
      // Drop the released class once the reverse transition finishes
      // so subsequent presses get a fresh starting state.
      setTimeout(() => {
        if (analyzingOverlayCard) {
          analyzingOverlayCard.classList.remove('cancel-released');
        }
      }, 400);
    }
  };

  analyzingOverlayCancel.addEventListener('pointerdown',  startHold);
  analyzingOverlayCancel.addEventListener('pointerup',    endHold);
  analyzingOverlayCancel.addEventListener('pointercancel', endHold);
  analyzingOverlayCancel.addEventListener('pointerleave',  endHold);
}

function handleAnalyzeEvent(eventName, data) {
  switch (eventName) {
    case 'started': {
      _analyzingState.etaStartedAt = Date.now();
      _analyzingState.etaSeconds   = data.eta_seconds || 35;
      if (analyzingOverlayEta) {
        analyzingOverlayEta.textContent = `осталось ~${_analyzingState.etaSeconds} сек`;
      }
      // Kick off the progress driver — it'll tick continuously,
      // synthesising target progress until server progress events
      // bump the bar higher.
      _startProgressDriver(_analyzingState.etaSeconds);
      // Tick down ETA every second so users see time advance even
      // between server events. Floors at 1 second remaining.
      if (_analyzingState.etaTimer) clearInterval(_analyzingState.etaTimer);
      _analyzingState.etaTimer = setInterval(() => {
        const elapsed   = (Date.now() - _analyzingState.etaStartedAt) / 1000;
        const remaining = Math.max(1, Math.round(_analyzingState.etaSeconds - elapsed));
        if (analyzingOverlayEta) {
          analyzingOverlayEta.textContent = `осталось ~${remaining} сек`;
        }
      }, 1000);
      break;
    }

    case 'progress': {
      // The driver does the actual rendering; we just bump its target
      // and advance the stage so the synthetic ceiling lifts. Stage
      // label updates here (separate from the visual %).
      const stage = data.stage;
      const p     = Math.max(0, Math.min(1, Number(data.progress) || 0));
      _setActiveStage(stage);
      _bumpProgressTarget(p);
      if (analyzingOverlayStageLabel && STAGE_LABELS[stage]) {
        analyzingOverlayStageLabel.textContent = STAGE_LABELS[stage];
      }
      break;
    }

    case 'log':
      _appendOverlayLogLine(data && data.text);
      break;

    case 'item_found':
      _addOverlayItemCard(data);
      _addOverlayBboxBracket(data);
      // Item events bundle their soft-voice log line ("Вижу X") so
      // the card and the line appear together at the queue's cadence.
      // Falling back to the 'log' branch would race ahead of the card.
      if (data && data.log) _appendOverlayLogLine(data.log);
      break;

    case 'item_enriched':
      _enrichOverlayItemCard(data);
      break;

    case 'item_revised':
      _reviseOverlayItemCard(data);
      break;

    case 'stage_done': {
      const stage = data.stage;
      // Snap the driver target up to this stage's end-of-window so the
      // bar is guaranteed to reach the milestone even if a progress
      // event was missed on the wire. Also bump the active stage so
      // the synthetic ceiling lifts for the next stage.
      const stageEnd = (STAGE_RANGES[stage] || [0, 0])[1];
      if (stageEnd) _bumpProgressTarget(stageEnd);
      _setActiveStage(stage + 1);
      if (analyzingOverlayStageLabel && STAGE_LABELS[stage + 1]) {
        analyzingOverlayStageLabel.textContent = STAGE_LABELS[stage + 1];
      }
      break;
    }

    case 'done':
      // The full result payload is captured by the closure in
      // handleFile; here we just settle the UI. The stagger-flash
      // below pulses every item card in sequence as the "I've
      // confirmed all of these" finalization beat — fires whether
      // or not Opus revised the item, so all cards light up.
      _bumpProgressTarget(1.0);
      if (analyzingOverlayEta) analyzingOverlayEta.textContent = 'Готово';
      if (_analyzingState.etaTimer) {
        clearInterval(_analyzingState.etaTimer);
        _analyzingState.etaTimer = null;
      }
      if (analyzingOverlayItemsList) {
        const cards = analyzingOverlayItemsList.querySelectorAll('.analyzing-overlay-item');
        cards.forEach((card, i) => {
          // 130ms stagger feels punchy without dragging the
          // finalization beat too long even on 6+ item dishes.
          setTimeout(() => {
            card.classList.add('finalized');
            // Remove after the keyframe completes so a subsequent
            // re-render of this same DOM (rare but possible) gets a
            // fresh animation.
            setTimeout(() => card.classList.remove('finalized'), 750);
          }, i * 130);
        });
      }
      break;

    case 'error':
      // Re-throw so the outer try/catch in handleFile can route it
      // through showError. data.recoverable is forwarded for future
      // retry-flow UI; the legacy error overlay just shows a message.
      throw new Error((data && data.message) || 'Pipeline error');

    default:
      // Unknown event — silently ignore. Forward-compat with future
      // backend additions (e.g. a new analyze stage event); we don't
      // need to log on the client because the server already logs all
      // events it emits.
      break;
  }
}

function _appendOverlayLogLine(text) {
  if (!analyzingOverlayLog || !text) return;
  const el = document.createElement('div');
  el.className = 'analyzing-overlay-log-line latest';
  el.textContent = text;
  // Demote previous "latest" lines so only the newest gets emphasis.
  analyzingOverlayLog.querySelectorAll('.latest').forEach(n => n.classList.remove('latest'));
  analyzingOverlayLog.appendChild(el);
  // Trim DOM aggressively — 4 entries is plenty (3 visible + 1 fading).
  // With justify-content: flex-end the newest is anchored at the bottom
  // so older lines naturally rise into the top fade and out of view.
  while (analyzingOverlayLog.children.length > 4) {
    analyzingOverlayLog.removeChild(analyzingOverlayLog.firstChild);
  }
}

function _addOverlayItemCard(data) {
  if (!analyzingOverlayItemsList || !data) return;
  // Wrap the card in a grid-row container so the list height grows
  // smoothly as each card is added (see .analyzing-overlay-item-wrap
  // CSS comment). The card itself runs a slide-from-right entrance
  // INSIDE the growing wrapper.
  const wrap = document.createElement('div');
  wrap.className = 'analyzing-overlay-item-wrap';
  const card = document.createElement('div');
  card.className = 'analyzing-overlay-item';
  card.dataset.itemId = data.id || '';
  const grams = Math.round(Number(data.grams) || 0);
  card.innerHTML =
    `<span class="analyzing-overlay-item-name">${esc(data.name || '')}</span>` +
    `<span class="analyzing-overlay-item-grams">~${grams}г</span>`;
  wrap.appendChild(card);
  analyzingOverlayItemsList.appendChild(wrap);
  // Two-RAF deferral so the browser commits the wrapper's initial
  // 0fr state before we transition to 1fr. Without this, some engines
  // collapse the transition to an instant change.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      wrap.classList.add('entered');
      // Once the row has had time to grow into existence, smooth-scroll
      // it into view. scrollIntoView is a no-op when the card is
      // already visible (e.g. cards 1-3 typically fit), so this only
      // produces a slow scroll once the list overflows — exactly the
      // cadence the user wanted ("slow scroll begins on 3rd-5th item").
      setTimeout(() => {
        try {
          wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } catch { /* old Safari without smooth-scrolling */ }
      }, 220);
    });
  });
  if (data.id) _analyzingState.itemsById.set(data.id, card);
  if (analyzingOverlayItemsCount) {
    analyzingOverlayItemsCount.textContent = String(analyzingOverlayItemsList.children.length);
  }
}

function _addOverlayBboxBracket(data) {
  if (!analyzingOverlayBboxLayer || !data || !data.bbox) return;
  const x = Number(data.bbox.x);
  const y = Number(data.bbox.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const wrap = document.createElement('div');
  wrap.className = 'analyzing-overlay-bbox-bracket';
  wrap.style.left = `${Math.max(0, Math.min(100, x))}%`;
  wrap.style.top  = `${Math.max(0, Math.min(100, y))}%`;
  wrap.innerHTML =
    '<span class="bracket-corner tl"></span>' +
    '<span class="bracket-corner tr"></span>' +
    '<span class="bracket-corner bl"></span>' +
    '<span class="bracket-corner br"></span>';
  analyzingOverlayBboxLayer.appendChild(wrap);
}

function _enrichOverlayItemCard(data) {
  if (!data) return;
  const card = _analyzingState.itemsById.get(data.id);
  if (!card) return;
  if (!card.querySelector('.analyzing-overlay-item-source')) {
    const badge = document.createElement('span');
    badge.className = 'analyzing-overlay-item-source';
    const key = String(data.source || '').toLowerCase();
    badge.textContent = SOURCE_LABELS[key] || (data.source || '').toUpperCase();
    card.appendChild(badge);
  }
  if (typeof data.kcal === 'number') card.dataset.kcal = String(data.kcal);
}

function _reviseOverlayItemCard(data) {
  if (!data) return;
  const card = _analyzingState.itemsById.get(data.id);
  if (!card) return;
  // Phase 1.2 visual: brief gold flash on the card border. Phase 1.4
  // upgrades this to a proper digit-flip on the kcal badge.
  card.classList.add('revised-flash');
  setTimeout(() => card.classList.remove('revised-flash'), 700);
  if (data.field === 'kcal' && typeof data.to === 'number') {
    card.dataset.kcal = String(data.to);
  }
}

// ── Handle file selection ─────────────────────
async function handleFile(file) {
  hideError();
  selectedFile = file;
  currentEntryId = null;   // new scan — detach from any previously viewed entry
  lastAnalyzedBlob = null; // reset until we successfully compress + analyze
  originalGramsByIdx = [];
  lastViewSource = 'fresh';
  closeVerdict();
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(file);

  // Open the streaming-progress analyzing overlay: reset its state,
  // attach the photo, and animate the card in.
  resetAnalyzingOverlay();
  setAnalyzingOverlayPhoto(currentBlobUrl);
  openAnalyzingOverlay();

  // Fresh AbortController for this scan; the cancel button aborts via it.
  _analyzeAbortController = new AbortController();

  // The 'done' SSE event carries the full result payload; we capture it
  // in this closure rather than relying on the stream return value.
  let finalResult = null;

  try {
    const blob = await compressImage(file);
    lastAnalyzedBlob = blob;

    await analyzeImageStream(blob, selectedPortion, (eventName, data) => {
      // Capture the final payload synchronously — we may need it after
      // the queue has drained (event order: done arrives last).
      if (eventName === 'done') finalResult = data;
      // Push through the paced queue. Most events apply immediately;
      // item_found / item_enriched / item_revised get deliberate gaps
      // so the user sees them happen one by one even when the server
      // bursts them.
      queueOverlayEvent(eventName, data);
    }, _analyzeAbortController.signal);

    // Server has finished sending. Now wait for the queue to drain so
    // pending item reveals + log lines actually appear before we
    // dismiss the overlay. Without this, items mid-queue would vanish.
    await waitForEventQueue();

    if (!finalResult) throw new Error('Анализ завершился без результата');
    currentResult = finalResult;
    originalGramsByIdx = (finalResult.items || []).map(it => it.estimated_grams);
    isSaved = false;

    // Success beat — the hand-off to the report card is now a
    // horizontal page-turn: analyzing card slides out to the LEFT
    // while the report card slides in from the RIGHT, both on the
    // same axis at the same time. JS sequence:
    //   1. Hold "Готово" 700ms so the user registers completion
    //   2. Add .swipe-out-left to analyzing card (translateX -110%)
    //   3. Set .from-right on report-overlay BEFORE .open so its
    //      initial state is offscreen-right
    //   4. Add .open to report-overlay → slides in from right
    //   5. After 460ms (animation done), closeAnalyzingOverlay() and
    //      remove .from-right so future opens use the default
    //      scale-in (history view, re-render)
    haptic([15, 50, 20]);
    await new Promise(r => setTimeout(r, 700));

    const reportOverlay = $('reportOverlay');
    if (analyzingOverlayCard && reportOverlay) {
      // Pre-stage: start analyzing slide-out + render report content
      // (still hidden). renderResults populates DOM but the
      // .from-right class on the overlay holds it offscreen-right
      // until .open is added below.
      reportOverlay.classList.add('from-right');
      analyzingOverlayCard.classList.add('swipe-out-left');
      renderResults(finalResult);  // populates content + adds .open

      // After the slide animation completes, clean up.
      setTimeout(() => {
        if (analyzingOverlayCard) {
          analyzingOverlayCard.classList.remove('swipe-out-left');
        }
        closeAnalyzingOverlay();
        if (reportOverlay) reportOverlay.classList.remove('from-right');
      }, 460);
    } else {
      // Fallback if either DOM ref missing — just do the legacy
      // sequential close + open.
      closeAnalyzingOverlay();
      await new Promise(r => setTimeout(r, 280));
      renderResults(finalResult);
    }
    // Save eagerly with consumed=false. Phase B/C will replace this with
    // the swipe-to-choose gesture on the report overlay (right=eat,
    // left=skip). Until then, every scan lands as not-consumed by
    // default — the user can promote it later via the recents/history
    // bite icon.
    autoSave(false);
  } catch (err) {
    // Phase 3 — 6th-scan gate: server returns 403 with structured
    // detail {code: "REGISTRATION_REQUIRED"} when a guest hits the
    // lifetime free-scan cap. Open the upgrade sheet instead of a
    // generic error toast — the user converts inline and their 5
    // existing scans carry through to the new account.
    if (err && err.code === 'REGISTRATION_REQUIRED') {
      closeAnalyzingOverlay();
      showScreen('upload');
      if (typeof openUpgradeSheet === 'function') openUpgradeSheet();
      _analyzeAbortController = null;
      return;
    }
    // User-cancelled: smooth return to idle, no error overlay. Distinguish
    // AbortError from real failure (the fetch was aborted via the cancel
    // button's hold-to-commit handler).
    const wasCancelled = err && (err.name === 'AbortError' ||
                                 (err.message && err.message.toLowerCase().includes('abort')));
    closeAnalyzingOverlay();
    if (wasCancelled) {
      // Back to idle silently. Phase D will optionally write a
      // "cancelled" entry to history for the admin dashboard.
      haptic([8, 30, 5]);
    } else {
      showScreen('upload');
      showError(err.message || 'Ошибка анализа. Попробуйте ещё раз.');
    }
  } finally {
    _analyzeAbortController = null;
  }
}

// ── Render results ────────────────────────────
function renderResults(data, thumbUrl, opts) {
  const skipEntrance = !!(opts && opts.skipEntrance);
  const { items, total, confidence, notes } = data;

  // Thumbnail
  resultThumb.src = thumbUrl || currentBlobUrl;

  // Calorie hero — digit cascade lands right-to-left on first reveal.
  // When re-rendering from history (skipEntrance), drop the cascade
  // and just assign the final string — it should read as committed,
  // not animate from empty.
  if (skipEntrance) {
    calNumber.textContent = total.calories.toLocaleString();
  } else {
    cascadeNumber(calNumber, total.calories);
  }

  // Confidence tag — only render when 'low'. High/medium are the common
  // case and don't need a chrome element competing with the calorie hero.
  if (confidence === 'low') {
    confidenceTag.className = 'confidence-tag conf-low';
    confidenceTag.textContent = 'низкая точность';
    confidenceTag.hidden = false;
  } else {
    confidenceTag.hidden = true;
    confidenceTag.textContent = '';
  }
  // Source-aggregator pill removed in Phase 8b — per-item dots already
  // convey provenance. Leaving the legacy element invisible if it exists.
  const sourceTag = document.getElementById('sourceTag');
  if (sourceTag) sourceTag.style.display = 'none';

  // Macro rings (caloric distribution)
  macroBars.innerHTML = macroRingsHTML(total);

  // Items
  updateItemCount();
  itemsList.innerHTML = items.map((item, i) => itemCardHTML(item, i)).join('');

  // Analysis card — combined insight (primary) + collapsible notes (secondary)
  const insight = data.health_insight;
  renderAnalysisCard(insight, notes);

  // Save button state
  if (isSaved) {
    btnSave.disabled = true;
    btnSave.textContent = 'Сохранено \u2713';
  } else {
    btnSave.disabled = false;
    btnSave.textContent = 'Сохранить';
  }
  closeVerdict();
  updateValidateBtn();

  if (!skipEntrance) openReportOverlay();

  // When re-rendering from history we want the full layout visible
  // immediately — the view-slide is the only motion. Snap the rings
  // to their final stroke offsets and bail before the spring block.
  if (skipEntrance) {
    const summaryCard = document.querySelector('.summary-card');
    if (summaryCard) summaryCard.classList.add('entered');
    document.querySelectorAll('.ring-fill').forEach(el => {
      const pct = Math.min(parseFloat(el.dataset.pct) || 0, 100);
      el.style.strokeDashoffset = (RING_C * (1 - pct / 100)).toFixed(2);
      _setRingTipRotation(el.parentElement.querySelector('.ring-tip-rotor'), pct);
    });
    return;
  }

  // Spring-driven results reveal
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // The .summary-card no longer animates separately — its parent
    // .report-content already does the slide-up + scale entrance, and
    // running ANOTHER transform on a child with overflow:hidden +
    // border-radius caused the top corners to flicker between sharp
    // and rounded each frame (Safari + Chrome both). Just add the
    // .entered class immediately so the Ken Burns scale-in on
    // .hero-image still kicks off.
    const summaryCard = document.querySelector('.summary-card');
    if (summaryCard) {
      summaryCard.style.opacity = '';
      summaryCard.style.transform = '';
      summaryCard.classList.add('entered');
    }

    // Macro rings animate stroke-dashoffset with spring (0 → target
    // offset). The comet-head tip co-rotates with the stroke so it
    // always sits at the leading edge.
    document.querySelectorAll('.ring-fill').forEach((el, i) => {
      const pct = Math.min(parseFloat(el.dataset.pct) || 0, 100);
      const rotor = el.parentElement.querySelector('.ring-tip-rotor');
      el.style.strokeDashoffset = RING_C; // start empty
      _setRingTipRotation(rotor, 0);      // tip at start
      Spring.animate(null, {
        preset: 'snappy',
        delay: 12 + i * 5,
        onUpdate(progress) {
          const filled = pct * progress;
          el.style.strokeDashoffset = (RING_C * (1 - filled / 100)).toFixed(2);
          _setRingTipRotation(rotor, filled);
        },
      });
    });

    // Item cards stagger in
    const cards = document.querySelectorAll('.item-card');
    cards.forEach((card, i) => {
      const fromX = i % 2 === 0 ? -20 : 20;
      card.style.opacity = '0';
      card.style.transform = `translateX(${fromX}px)`;
      Spring.springTo(card, {
        from: { x: fromX, opacity: 0 },
        to:   { x: 0, opacity: 1 },
        preset: 'snappy',
        delay: 14 + i * 4,
      });
    });

    // Confidence tag pop-in — only when the tag is actually shown (low conf)
    if (confidenceTag && !confidenceTag.hidden) {
      confidenceTag.style.transform = 'scale(0)';
      Spring.springTo(confidenceTag, {
        from: { scale: 0 },
        to:   { scale: 1 },
        preset: 'bouncy',
        delay: 10,
      });
    }

    // Analysis card entrance (single card now — was two before Phase 8)
    if (analysisCard && analysisCard.style.display !== 'none') {
      analysisCard.style.opacity = '0';
      analysisCard.style.transform = 'translateY(12px)';
      Spring.springTo(analysisCard, {
        from: { y: 12, opacity: 0 },
        to:   { y: 0, opacity: 1 },
        preset: 'snappy',
        delay: 18,
      });
    }
  }));
}

// ── Analysis card text formatting ─────────────
// Two helpers turn the raw AI prose into a more scannable layout:
//   - splitSentences   → array of trimmed sentences (Russian-aware split)
//   - highlightMetrics → wraps "(~800 ккал)" / "(~16-18 г)" mentions in
//                        ochre <span class="metric-chip"> for visual density
// Both run on already-escaped HTML to avoid XSS via AI-generated text.

function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function highlightMetrics(escapedText) {
  // Match parenthesised metrics: (~800 ккал), (~16-18 г), (~1.5 кДж), etc.
  // The leading ~ is optional; ranges may use - or –.
  return escapedText.replace(
    /\(~?\d+(?:[.,]\d+)?(?:[\-–]\d+(?:[.,]\d+)?)?\s*(?:ккал|г|кДж|мг|kcal|kJ)\)/g,
    match => `<span class="metric-chip">${match.slice(1, -1)}</span>`
  );
}

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space + capital letter
  // (Latin or Cyrillic). Avoids regex lookbehind because Safari < 16.4
  // (March 2023) treats it as a SyntaxError at parse time, which would
  // kill the entire script on older devices. Instead we replace the
  // boundary with a sentinel character and split on that.
  const marked = text.replace(/([.!?]+)\s+([A-ZА-ЯЁ])/g, '$1$2');
  const parts = marked.split('').map(s => s.trim()).filter(s => s.length > 0);
  return parts.length ? parts : [text.trim()];
}

function renderAnalysisCard(insight, notes) {
  // Hide the whole card if there's nothing to show.
  if (!insight && !notes) {
    analysisCard.style.display = 'none';
    return;
  }
  analysisCard.style.display = 'block';

  // Insight: bulleted list of sentences with metric chips.
  if (insight) {
    const sentences = splitSentences(insight);
    insightBody.innerHTML = sentences
      .map(s => `<li>${highlightMetrics(escapeHTML(s))}</li>`)
      .join('');
  } else if (notes) {
    // Edge case: only notes, no insight. Promote notes into the body
    // so the card isn't empty above the toggle.
    insightBody.innerHTML = `<li>${highlightMetrics(escapeHTML(notes))}</li>`;
    notes = null;  // consumed; don't show again below
  } else {
    insightBody.innerHTML = '';
  }

  // Notes: rendered into the collapsible block, toggle button shown only
  // when there's something to expand. Reset expanded state on every render.
  notesBody.classList.remove('expanded');
  btnNotesToggle.classList.remove('expanded');
  if (notes) {
    notesBody.innerHTML = highlightMetrics(escapeHTML(notes));
    btnNotesToggle.hidden = false;
  } else {
    notesBody.innerHTML = '';
    btnNotesToggle.hidden = true;
  }
}

function setupAnalysisCard() {
  if (!btnNotesToggle) return;
  btnNotesToggle.addEventListener('click', () => {
    const expanded = !notesBody.classList.contains('expanded');
    notesBody.classList.toggle('expanded', expanded);
    btnNotesToggle.classList.toggle('expanded', expanded);
    haptic(4);
  });
}


// ── Water tile ────────────────────────────────
// The tile is rendered + updated locally; storage layer fires
// 'hmc:water-changed' on adds/undo so the UI re-renders. Quality cache
// for today is invalidated alongside since water affects the day score.
const waterTile         = $('waterTile');
const waterCurrent      = $('waterCurrent');
const waterTarget       = $('waterTarget');
const waterProgressFill = $('waterProgressFill');
const waterProgressBar  = $('waterProgressBar');
const btnWaterUndo      = $('btnWaterUndo');

// (Day-progress strip refs removed in Phase A.5 — the slim day-hero at
// the top of the scanner tab supersedes it as the daily-calorie display.)

function renderWaterTile() {
  if (!waterTile) return;
  // Read the target live from settings so an in-session change in the
  // settings sheet propagates immediately without a separate refresh.
  const target = getSetting('daily_water_ml');
  const ml = getWaterTotalForDay(new Date());
  const pct = Math.min((ml / target) * 100, 100);
  const over = ml > target;
  tickerTo(waterCurrent, ml);
  waterCurrent.classList.toggle('over', over);
  waterTarget.textContent = `/ ${target.toLocaleString()}`;
  // Use rAF so the bar animates from current → new value via the CSS transition
  requestAnimationFrame(() => { waterProgressFill.style.width = pct + '%'; });
  // Glug — the droplet icon's internal fill rises to match progress.
  // Inverted geometry: y=24 is empty (rect entirely below the 24x24
  // viewBox), y=0 is full. The CSS transition adds the spring-rise
  // overshoot so taps feel like a physical pour, not a teleport.
  const waterIconFill = $('waterIconFill');
  if (waterIconFill) {
    const fraction = Math.min(ml / target, 1);
    const y = (1 - fraction) * 24;
    waterIconFill.setAttribute('y', y.toFixed(2));
  }
  // Keep ARIA values in sync so screen readers announce the current state.
  if (waterProgressBar) {
    waterProgressBar.setAttribute('aria-valuemax', String(target));
    waterProgressBar.setAttribute('aria-valuenow', String(ml));
    waterProgressBar.setAttribute(
      'aria-valuetext',
      `${ml.toLocaleString()} мл из ${target.toLocaleString()}`
    );
  }
  // Disable undo when nothing logged today
  if (btnWaterUndo) btnWaterUndo.disabled = ml === 0;
}

function setupWaterTile() {
  if (!waterTile) return;
  waterTile.querySelectorAll('.water-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const ml = parseInt(btn.dataset.add, 10);
      if (!isFinite(ml) || ml <= 0) return;
      addWater(ml);
      haptic([8, 20, 5]);
      // Invalidate today's quality cache since water counts in the score
      invalidateQualityForToday();
    });
  });
  if (btnWaterUndo) {
    btnWaterUndo.addEventListener('click', () => {
      const ok = undoLastWater();
      if (ok) { haptic(8); invalidateQualityForToday(); }
    });
  }
  window.addEventListener('hmc:water-changed', renderWaterTile);
}

// (Phase A.5 removed renderDayProgressTile + setupDayProgressTile — their
// role is now filled by the slim day-hero at the top of the scanner tab.)

function invalidateQualityForToday() {
  try {
    const map = JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}');
    const d = new Date();
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    delete map[k];
    localStorage.setItem(QUALITY_KEY, JSON.stringify(map));
  } catch {}
}


// ── Macro rings ───────────────────────────────
// Three circular gauges showing each macronutrient's share of total
// calories. Stroke-dashoffset is the fill driver: 0 = full ring,
// RING_C = empty. JS sets initial offsets after mount + on every recalc;
// CSS transition handles the smooth animation between values.

const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;          // ≈ 125.66

function ringPctFromTotal(total) {
  const totalCal = (total.protein_g * 4) + (total.carbs_g * 4) + (total.fat_g * 9) || 1;
  return [
    { pct: total.protein_g * 4 / totalCal * 100, val: total.protein_g, label: 'Белки',    color: 'var(--protein)' },
    { pct: total.carbs_g   * 4 / totalCal * 100, val: total.carbs_g,   label: 'Углеводы', color: 'var(--carbs)'   },
    { pct: total.fat_g     * 9 / totalCal * 100, val: total.fat_g,     label: 'Жиры',     color: 'var(--fat)'     },
  ];
}

function macroRingsHTML(total) {
  return `<div class="macro-rings">${
    ringPctFromTotal(total).map(r => `
      <div class="macro-ring-col" style="--ring-color: ${r.color}">
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 50 50">
            <circle class="ring-bg"   cx="25" cy="25" r="${RING_R}" />
            <circle class="ring-fill" cx="25" cy="25" r="${RING_R}"
                    stroke-dasharray="${RING_C.toFixed(2)}"
                    stroke-dashoffset="${RING_C.toFixed(2)}"
                    data-pct="${r.pct.toFixed(2)}" />
            <g class="ring-tip-rotor" style="transform: rotate(0deg)">
              <circle class="ring-tip" cx="${25 + RING_R}" cy="25" r="3.2" />
            </g>
          </svg>
          <div class="ring-value">${r.val}г</div>
        </div>
        <div class="ring-label">${r.label}</div>
      </div>
    `).join('')
  }</div>`;
}

// Rotate a single ring's comet-head tip to land at the END of its
// progress arc. Stroke draws clockwise from 3 o'clock in the SVG's
// own coords (the parent rotate(-90deg) on .ring-svg is what makes
// it visually start at 12 o'clock). pct → degrees: 0% = no rotation
// (tip at start), 100% = 360° (tip back at start). Used by both the
// initial Spring animation and patchRings on edits.
function _setRingTipRotation(rotorEl, pct) {
  if (!rotorEl) return;
  const deg = (Math.min(pct, 100) / 100) * 360;
  rotorEl.style.transform = `rotate(${deg.toFixed(2)}deg)`;
}

function patchRings(total) {
  const rings = ringPctFromTotal(total);
  const fills  = macroBars.querySelectorAll('.ring-fill');
  const tips   = macroBars.querySelectorAll('.ring-tip-rotor');
  const values = macroBars.querySelectorAll('.ring-value');
  fills.forEach((el, i) => {
    const pct = Math.min(rings[i].pct, 100);
    el.dataset.pct = pct.toFixed(2);
    el.style.strokeDashoffset = (RING_C * (1 - pct / 100)).toFixed(2);
    _setRingTipRotation(tips[i], pct);
  });
  values.forEach((el, i) => { el.textContent = rings[i].val + 'г'; });
}


// ── Item card template + edit flow ───────────
// Items with `per_100g` are editable: tapping the pencil swaps the grams
// display for an inline number input, and committing rescales calories +
// macros locally (no server round-trip — the per-100g values were captured
// at analysis time). Items without per_100g (older saved entries from before
// the Phase 0 wire change) get no pencil.

const PENCIL_SVG = '<svg class="icon-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Zm0 0L19.5 7.125"/></svg>';
const CHECK_SVG  = '<svg class="icon-check"  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';
const TRASH_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

// Source → 6px colored dot. Replaces the per-item "USDA" / "ИИ" pills that
// repeated 4× down a typical results list. The colored dot conveys the same
// provenance signal at ~10% of the visual weight; the full label appears in
// the expanded state (tap card to reveal).
const SOURCE_DOT = {
  verified:      { color: 'var(--green-br)', label: 'Подтверждено'  },
  russian_db:    { color: 'var(--protein)',  label: 'База РФ'       },
  usda:          { color: 'var(--carbs)',    label: 'USDA'          },
  openfoodfacts: { color: 'var(--carbs)',    label: 'OpenFoodFacts' },
  ai_branded:    { color: 'var(--teal)',     label: 'Бренд'         },
  ai_estimate:   { color: 'var(--t3)',       label: 'Оценка ИИ'     },
};

function sourceDotHTML(source) {
  const meta = SOURCE_DOT[source] || { color: 'var(--t3)', label: '' };
  const title = meta.label ? ` title="${meta.label}"` : '';
  return `<span class="item-source-dot" style="--source-color: ${meta.color}"${title}></span>`;
}

function sourceLabelText(source) {
  return (SOURCE_DOT[source] && SOURCE_DOT[source].label) || '';
}

function itemCardHTML(item, i) {
  const editable = item.per_100g != null;
  const editBtn = editable
    ? `<button class="item-delete-btn" data-action="delete" aria-label="Удалить ингредиент">${TRASH_SVG}</button>
       <button class="item-edit-btn"   data-action="edit"   aria-label="Изменить вес">${PENCIL_SVG}${CHECK_SVG}</button>`
    : '';
  const sourceLabel = sourceLabelText(item.data_source);
  return `
    <div class="item-card" data-idx="${i}" style="animation-delay:${i * 55}ms">
      <div class="item-info">
        <div class="item-name-row">
          ${sourceDotHTML(item.data_source)}
          <span class="item-name">${esc(item.name)}</span>
        </div>
        ${item.estimated_grams ? `<div class="item-grams" data-role="grams"><span class="grams-value">${item.estimated_grams}</span>г</div>` : ''}
        <div class="item-macros">
          <span class="mp">Б <span data-macro="p">${item.protein_g}</span>г</span>
          <span class="mc">У <span data-macro="c">${item.carbs_g}</span>г</span>
          <span class="mf">Ж <span data-macro="f">${item.fat_g}</span>г</span>
        </div>
        ${sourceLabel ? `<div class="item-source-label">${sourceLabel}</div>` : ''}
      </div>
      <div class="item-right">
        <div class="item-cal" data-role="cal">${item.calories}</div>
        <div class="item-unit">ккал</div>
        <span class="item-expand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="9" height="9">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </div>
      ${editBtn}
    </div>
  `;
}

function setupItemEditing() {
  itemsList.addEventListener('click', e => {
    // Action buttons (edit/delete) take precedence — they handle their own logic.
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      e.stopPropagation();
      const card = btn.closest('.item-card');
      if (!card || card.dataset.removing === '1') return;
      const idx = parseInt(card.dataset.idx, 10);
      const action = btn.dataset.action;
      if (action === 'edit') {
        if (card.classList.contains('editing')) commitItemEdit(idx, card);
        else                                    enterItemEdit(idx, card);
      } else if (action === 'delete') {
        removeItem(idx, card);
      }
      return;
    }
    // Anywhere else on the card body → toggle expanded state, which reveals
    // the macro chips + source label. Skip while editing or removing so the
    // input keystrokes don't accidentally collapse the card.
    if (e.target.closest('input')) return;
    const card = e.target.closest('.item-card');
    if (!card || card.classList.contains('editing') || card.dataset.removing === '1') return;
    card.classList.toggle('expanded');
    haptic(4);
  });
}

function enterItemEdit(idx, card) {
  const item = currentResult && currentResult.items && currentResult.items[idx];
  if (!item || !item.per_100g) return;
  const gramsEl = card.querySelector('[data-role="grams"]');
  if (!gramsEl) return;

  card.classList.add('editing');
  const grams = Math.round(item.estimated_grams || 100);
  gramsEl.innerHTML = `<span class="grams-input-wrap">
    <input class="grams-input" type="number" min="1" max="9999" inputmode="numeric" value="${grams}">
    <span class="grams-unit">г</span>
  </span>`;
  const input = gramsEl.querySelector('.grams-input');
  input.focus();
  input.select();
  haptic(6);

  let resolved = false;
  const onCommit = () => {
    if (resolved) return;
    resolved = true;
    commitItemEdit(idx, card);
  };
  const onCancel = () => {
    if (resolved) return;
    resolved = true;
    cancelItemEdit(idx, card);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')      { e.preventDefault(); onCommit(); }
    else if (e.key === 'Escape'){ e.preventDefault(); onCancel(); }
  });
  // Defer blur-commit so a click on the checkmark commits via its handler first
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!resolved && card.classList.contains('editing')) onCommit();
    }, 80);
  });
}

function commitItemEdit(idx, card) {
  const input = card.querySelector('.grams-input');
  if (!input) return;
  const newGrams = parseInt(input.value, 10);
  const item = currentResult.items[idx];
  if (!isFinite(newGrams) || newGrams <= 0 || newGrams > 9999) {
    cancelItemEdit(idx, card);
    return;
  }
  if (Math.round(item.estimated_grams) === newGrams) {
    cancelItemEdit(idx, card);
    return;
  }
  rescaleItem(idx, newGrams);
  patchItemCardDOM(idx, card);
  recalcAndPatchTotals();
  card.classList.remove('editing');
  // Auto-commit the edit. Save button is gone (the overlay now uses
  // top/bottom close bars), so the user gets no separate save tap.
  // markDirty still fires updateValidateBtn so "Исправить…" can show
  // for fresh-mode entries that have a usable lastAnalyzedBlob.
  if (currentEntryId) {
    updateSavedEntry();
  } else {
    markDirty();
  }
  haptic(10);
}

function cancelItemEdit(idx, card) {
  patchItemCardDOM(idx, card);
  card.classList.remove('editing');
}

function reindexCards() {
  const cards = itemsList.querySelectorAll('.item-card');
  cards.forEach((card, i) => { card.dataset.idx = i; });
}

function removeItem(idx, card) {
  if (!currentResult || card.dataset.removing === '1') return;
  card.dataset.removing = '1';
  card.style.pointerEvents = 'none';
  haptic([15, 30, 8]);
  Spring.springTo(card, {
    from: { x: 0, opacity: 1 },
    to:   { x: -40, opacity: 0 },
    preset: 'snappy',
  }).then(() => {
    card.remove();
    currentResult.items.splice(idx, 1);
    reindexCards();
    updateItemCount();
    recalcAndPatchTotals();
    markDirty();
  });
}

function round1(n) { return Math.round(n * 10) / 10; }

function rescaleItem(idx, newGrams) {
  const item = currentResult.items[idx];
  const p = item.per_100g;
  if (!p) return;
  const f = newGrams / 100;
  item.estimated_grams = newGrams;
  item.calories  = Math.round(p.calories  * f);
  item.protein_g = round1(p.protein_g * f);
  item.fat_g     = round1(p.fat_g     * f);
  item.carbs_g   = round1(p.carbs_g   * f);
  item.sugar_g   = round1((p.sugar_g || 0) * f);
  item.fiber_g   = round1((p.fiber_g || 0) * f);
}

function patchItemCardDOM(idx, card) {
  const item = currentResult.items[idx];
  const grams = card.querySelector('[data-role="grams"]');
  if (grams) grams.innerHTML = `<span class="grams-value">${item.estimated_grams}</span>г`;
  const cal = card.querySelector('[data-role="cal"]');
  if (cal) cal.textContent = item.calories;
  const p = card.querySelector('[data-macro="p"]');
  const c = card.querySelector('[data-macro="c"]');
  const f = card.querySelector('[data-macro="f"]');
  if (p) p.textContent = item.protein_g;
  if (c) c.textContent = item.carbs_g;
  if (f) f.textContent = item.fat_g;
}

function recalcAndPatchTotals() {
  const items = currentResult.items;
  const total = {
    calories:  items.reduce((s, it) => s + (it.calories || 0), 0),
    protein_g: round1(items.reduce((s, it) => s + (it.protein_g || 0), 0)),
    fat_g:     round1(items.reduce((s, it) => s + (it.fat_g     || 0), 0)),
    carbs_g:   round1(items.reduce((s, it) => s + (it.carbs_g   || 0), 0)),
    sugar_g:   round1(items.reduce((s, it) => s + (it.sugar_g   || 0), 0)),
    fiber_g:   round1(items.reduce((s, it) => s + (it.fiber_g   || 0), 0)),
  };
  currentResult.total = total;

  // Calorie display
  calNumber.textContent = total.calories.toLocaleString();

  // Macro rings: patch stroke offsets + center values.
  patchRings(total);
}

function markDirty() {
  isSaved = false;
  if (btnSave) {
    btnSave.disabled = false;
    btnSave.textContent = 'Обновить';
  }
  updateValidateBtn();
}

// Show "Исправить…" whenever the original full-res image bytes are
// in memory (fresh-scan path only — history thumbnails are too small
// for the vision model). The previous !isSaved gate became too
// restrictive once edits started auto-committing.
function updateValidateBtn() {
  if (!btnValidateEdits) return;
  const eligible = lastAnalyzedBlob != null && currentResult && currentResult.items.length > 0;
  btnValidateEdits.hidden = !eligible;
}

function updateSavedEntry() {
  if (!currentResult || !currentEntryId) return false;
  const itemNames = currentResult.items.map(i => i.name).join(', ');
  const ok = updateEntry(currentEntryId, {
    result:        currentResult,
    itemNames,
    totalCalories: currentResult.total.calories,
  });
  if (ok) {
    isSaved = true;
    btnSave.textContent = 'Сохранено ✓';
    btnSave.disabled = true;
    updateValidateBtn();
    // Phase 3A: mirror to the server. Fire-and-forget; on failure the
    // local edit stands and the next page-load sync resolves.
    patchServerEntry(currentEntryId, {
      result:        currentResult,
      totalCalories: currentResult.total.calories,
      itemCount:     currentResult.items.length,
      itemNames,
    });
  }
  return ok;
}

// ── Add-ingredient bottom sheet ────────────────
// Opens a slide-up sheet with name + grams inputs. Submission calls
// /api/lookup which reuses the same russian_db → USDA → OFF chain as
// Stage 2 of the analyze pipeline, so a manually-added "хлеб 80г"
// behaves identically to one the photo identified.

function updateItemCount() {
  // Bare count — the section header reads "Обнаружено [N]". Earlier
  // versions had "Обнаруженные продукты 4 продукта" which double-stamped
  // the noun.
  const items = currentResult ? currentResult.items : [];
  itemCount.textContent = String(items.length);
}

function appendItemCard(item, index) {
  itemsList.insertAdjacentHTML('beforeend', itemCardHTML(item, index));
  const card = itemsList.lastElementChild;
  card.style.opacity = '0';
  card.style.transform = 'translateY(12px)';
  Spring.springTo(card, {
    from: { y: 12, opacity: 0 },
    to:   { y: 0, opacity: 1 },
    preset: 'snappy',
  });
}

function setAddSheetError(msg) {
  addSheetError.textContent = msg || '';
}

function openAddSheet() {
  if (!currentResult) return;
  addSheet.classList.add('open');
  addSheet.setAttribute('aria-hidden', 'false');
  addNameInput.value = '';
  addGramsInput.value = '';
  setAddSheetError('');
  btnAddSubmit.disabled = false;
  btnAddSubmit.textContent = 'Добавить';
  // Focus after the slide-in finishes so iOS doesn't fight the keyboard
  setTimeout(() => addNameInput.focus(), 220);
}

function closeAddSheet() {
  addSheet.classList.remove('open');
  addSheet.setAttribute('aria-hidden', 'true');
  // Drop focus so the on-screen keyboard hides on mobile
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
}

async function submitAddIngredient() {
  const name = addNameInput.value.trim();
  const grams = parseInt(addGramsInput.value, 10);
  if (!name) {
    setAddSheetError('Укажите название ингредиента');
    addNameInput.focus();
    return;
  }
  if (!isFinite(grams) || grams <= 0 || grams > 9999) {
    setAddSheetError('Граммы: от 1 до 9999');
    addGramsInput.focus();
    return;
  }
  setAddSheetError('');
  btnAddSubmit.disabled = true;
  btnAddSubmit.textContent = 'Ищу…';

  try {
    const item = await lookupIngredient(name, grams);
    currentResult.items.push(item);
    appendItemCard(item, currentResult.items.length - 1);
    updateItemCount();
    recalcAndPatchTotals();
    markDirty();
    haptic([10, 30, 10]);
    closeAddSheet();
  } catch (err) {
    setAddSheetError(err.message || 'Что-то пошло не так');
    haptic(20);
    btnAddSubmit.disabled = false;
    btnAddSubmit.textContent = 'Добавить';
  }
}

// ── Validation agent ("Исправить…") ─────────────
// User clicks the pill → we POST the original (compressed) photo blob
// + the current items list to /api/validate-edits. Sonnet looks at the
// photo and either confirms the edits or flags items it thinks are off
// by 2× or more, with per-item suggested grams. Failures collapse to a
// silent 'looks_right' on the server, so the UX never blocks.

function closeVerdict() {
  if (!verdictCard) return;
  verdictCard.hidden = true;
  verdictCard.classList.remove('looks-right', 'concerns');
  verdictItems.innerHTML = '';
  verdictOverall.textContent = '';
  verdictOverall.hidden = true;
}

function renderVerdictCard(verdict) {
  verdictCard.hidden = false;
  verdictCard.classList.remove('looks-right', 'concerns');

  if (verdict.verdict === 'looks_right') {
    verdictCard.classList.add('looks-right');
    verdictTitle.textContent = 'Шеф-повар: всё в порядке';
    verdictOverall.textContent = verdict.overall_note
      || 'Заявленные граммы выглядят адекватно для этого блюда.';
    verdictOverall.hidden = false;
    verdictItems.innerHTML = '';
    return;
  }

  // "concerns" — render flagged items
  verdictCard.classList.add('concerns');
  verdictTitle.textContent = 'Шеф-повар нашёл расхождения';
  if (verdict.overall_note) {
    verdictOverall.textContent = verdict.overall_note;
    verdictOverall.hidden = false;
  } else {
    verdictOverall.textContent = '';
    verdictOverall.hidden = true;
  }

  const flagged = (verdict.items || []).filter(v => !v.ok && v.suggested_grams);
  verdictItems.innerHTML = flagged.map(v => {
    const item = currentResult.items[v.index];
    if (!item) return '';
    const current = Math.round(item.estimated_grams);
    const suggested = Math.round(v.suggested_grams);
    return `
      <div class="verdict-item" data-idx="${v.index}">
        <div class="verdict-item-name">${esc(item.name)}</div>
        ${v.reason ? `<div class="verdict-item-reason">${esc(v.reason)}</div>` : ''}
        <div class="verdict-item-numbers">
          <span class="verdict-current">${current}г</span>
          <span class="verdict-arrow">→</span>
          <span class="verdict-suggested">${suggested}г</span>
        </div>
        <div class="verdict-item-actions">
          <button class="verdict-apply"   data-action="apply"   data-suggested="${suggested}">Применить</button>
          <button class="verdict-dismiss" data-action="dismiss">Оставить</button>
        </div>
      </div>
    `;
  }).join('');
}

function applyVerdictItem(idx, suggestedGrams) {
  const item = currentResult && currentResult.items[idx];
  if (!item || !item.per_100g) return;
  rescaleItem(idx, suggestedGrams);
  // Patch the matching item card on the results screen
  const card = itemsList.querySelector(`.item-card[data-idx="${idx}"]`);
  if (card) patchItemCardDOM(idx, card);
  recalcAndPatchTotals();
  markDirty();
  haptic([10, 25, 10]);
}

function removeVerdictRow(rowEl) {
  if (!rowEl) return;
  Spring.springTo(rowEl, {
    from: { y: 0, opacity: 1 },
    to:   { y: -8, opacity: 0 },
    preset: 'snappy',
  }).then(() => {
    rowEl.remove();
    if (!verdictItems.children.length) {
      // No more flagged items left to act on — close the card
      closeVerdict();
    }
  });
}

async function runValidation() {
  if (!lastAnalyzedBlob || !currentResult || !currentResult.items.length) return;
  if (btnValidateEdits.classList.contains('checking')) return;

  btnValidateEdits.classList.add('checking');
  btnValidateEdits.disabled = true;

  const items = currentResult.items.map((it, i) => {
    const orig = originalGramsByIdx[i];
    const payload = {
      name: it.name,
      estimated_grams: it.estimated_grams,
    };
    if (orig != null && orig !== it.estimated_grams) {
      payload.original_grams = orig;
    }
    return payload;
  });

  try {
    const verdict = await validateEdits(lastAnalyzedBlob, items);
    renderVerdictCard(verdict);
    haptic(verdict.verdict === 'concerns' ? [15, 30, 8] : 8);
    // Spring entrance for the card
    verdictCard.style.opacity = '0';
    verdictCard.style.transform = 'translateY(-8px)';
    Spring.springTo(verdictCard, {
      from: { y: -8, opacity: 0 },
      to:   { y: 0, opacity: 1 },
      preset: 'snappy',
    });
  } catch (err) {
    showError(err.message || 'Не удалось проверить правки. Попробуйте позже.');
  } finally {
    btnValidateEdits.classList.remove('checking');
    btnValidateEdits.disabled = false;
  }
}

function setupValidation() {
  if (!btnValidateEdits) return;
  btnValidateEdits.addEventListener('click', () => { haptic(); runValidation(); });
  btnVerdictClose.addEventListener('click', closeVerdict);
  verdictItems.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.verdict-item');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (btn.dataset.action === 'apply') {
      const suggested = parseInt(btn.dataset.suggested, 10);
      if (isFinite(suggested) && suggested > 0) applyVerdictItem(idx, suggested);
    }
    removeVerdictRow(row);
  });
}

function setupAddSheet() {
  if (!btnOpenAddSheet) return;
  btnOpenAddSheet.addEventListener('click', () => { haptic(); openAddSheet(); });
  btnAddCancel.addEventListener('click', closeAddSheet);
  addSheetBackdrop.addEventListener('click', closeAddSheet);
  btnAddSubmit.addEventListener('click', submitAddIngredient);

  addNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); addGramsInput.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeAddSheet(); }
  });
  addGramsInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); submitAddIngredient(); }
    if (e.key === 'Escape') { e.preventDefault(); closeAddSheet(); }
  });
}

// Number ticker — animates an element's text content from its CURRENT
// numeric value to a TARGET, using a snappy spring. Used for counters
// that change in response to user actions (water log +250, new scan
// committed) so the value rolls up rather than teleporting. Skips the
// animation when the change is zero, or when the user has asked the
// OS to reduce motion. Parses the current value out of textContent so
// the function is idempotent — caller doesn't need to track state.
function tickerTo(el, target) {
  if (!el) return;
  const t = Math.round(Number(target) || 0);
  const cur = Math.round(Number(String(el.textContent).replace(/[^\d.-]/g, '')) || 0);
  if (cur === t) return;
  const reduced = window.matchMedia &&
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    el.textContent = t.toLocaleString();
    return;
  }
  // Pass the element to Spring.animate so a second tickerTo call on
  // the same element cancels the prior animation (Spring.animate
  // tracks active animations per-element via WeakMap-keyed handles).
  // Without this, rapid back-to-back render calls produce flicker as
  // two springs simultaneously stomp on textContent.
  Spring.animate(el, {
    preset: 'snappy',
    onUpdate(progress) {
      const v = Math.round(cur + (t - cur) * progress);
      el.textContent = v.toLocaleString();
    },
  });
}

// Calorie-hero cascade: each digit lands right-to-left with a 50ms
// stagger and a bouncy entry. Used on report-card open. The element's
// existing text content is replaced with per-character spans, each
// carrying its own animation-delay; the keyframe lives in app.css.
// Falls back to a plain assignment if any character can't be wrapped
// (e.g. element is missing).
function cascadeNumber(el, target) {
  if (!el) return;
  const str = (Number(target) || 0).toLocaleString();
  const len = str.length;
  el.innerHTML = '';
  for (let i = 0; i < len; i++) {
    const span = document.createElement('span');
    span.className = 'cal-digit';
    span.textContent = str[i];
    // Rightmost char (index len-1) gets delay 0 and lands first;
    // delay grows as we move left so the wave reads right-to-left.
    span.style.animationDelay = ((len - 1 - i) * 50) + 'ms';
    el.appendChild(span);
  }
}

// ── Auto-save to history ─────────────────────
// New entries default to consumed=false — user explicitly opts into "ate
// it" via the post-scan choice popup or by tapping the bite icon on the
// recent tile. Legacy entries with no `consumed` field still resolve to
// true via isEntryConsumed (e.consumed !== false), so existing data is
// not silently zeroed.
function autoSave(consumed) {
  if (!currentResult || isSaved) return;
  thumbDataUrl(currentBlobUrl, dataUrl => {
    // Phase 2: /api/analyze creates the canonical entry server-side and
    // returns its id in the response body. Use that as our entry id so
    // future PATCH/DELETE calls (consumed toggle, edits, delete) hit
    // the right row. Date.now() fallback covers the rare case where the
    // server entry-create failed (logged on the server side); the local
    // entry still works as a cache, it just can't sync until the next
    // /api/entries pull on app boot.
    const entryId = currentResult.entry_id || Date.now();
    const entry = {
      id:            entryId,
      timestamp:     Date.now(),
      imageDataUrl:  dataUrl,
      result:        currentResult,
      itemNames:     currentResult.items.map(i => i.name).join(', '),
      totalCalories: currentResult.total.calories,
      consumed:      consumed === true,
    };
    const saveResult = saveEntry(entry);
    if (!saveResult.ok) {
      // localStorage full and even after trimming the new entry won't fit —
      // surface to the user (it WAS lost) instead of silently swallowing.
      // The server-side entry (created by /api/analyze) still exists, so
      // a fresh app load reconciles it back; the message just sets
      // expectations for the current session.
      showError('Память браузера переполнена. Анализ сохранён на сервере, но локальная история не обновилась.');
      return;
    }
    if (saveResult.trimmed > 0) {
      // Older entries were dropped to fit the new one. Console-only —
      // visible only in devtools — because the user's CURRENT save did
      // succeed; "old history is gone" is not worth a modal interruption.
      console.warn(`[autoSave] localStorage full — dropped ${saveResult.trimmed} oldest entries to fit`);
    }
    currentEntryId = entry.id;
    isSaved = true;
    btnSave.textContent = 'Сохранено ✓';
    btnSave.disabled = true;
    updateValidateBtn();
  });
}

btnSave.addEventListener('click', () => {
  if (!currentResult || isSaved) return;
  // If we have an existing entry id (autoSave already ran or user is viewing
  // a saved entry), update in place. Otherwise create a new one.
  if (currentEntryId && updateSavedEntry()) return;
  autoSave();
});

// Saved-entry thumbnail. Sized to render crisp in the 200px hero band but
// small enough that ~60 entries stay under ~3MB.
//
// Critical: must always invoke cb, even on error/timeout, otherwise
// autoSave's callback chain is silently severed and the entry never lands
// in localStorage. Three guards:
//   1. img.onerror      → log + cb('') so save proceeds without thumb
//   2. canvas exception → catch + cb('')
//   3. 3-second timeout → cb('') if neither onload nor onerror has fired
function thumbDataUrl(blobUrl, cb) {
  let done = false;
  const finish = (dataUrl) => {
    if (done) return;
    done = true;
    cb(dataUrl);
  };

  const img = new Image();
  img.onload = () => {
    try {
      const SZ = 480;
      let w = img.width, h = img.height;
      if (w >= h) { h = Math.round(h * SZ / w); w = SZ; }
      else        { w = Math.round(w * SZ / h); h = SZ; }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      finish(c.toDataURL('image/jpeg', 0.78));
    } catch (err) {
      console.warn('[thumbDataUrl] canvas/toDataURL failed:', err);
      finish('');
    }
  };
  img.onerror = (err) => {
    console.warn('[thumbDataUrl] image load failed:', err);
    finish('');
  };
  setTimeout(() => {
    if (!done) {
      console.warn('[thumbDataUrl] timed out after 3s — saving without thumbnail');
      finish('');
    }
  }, 3000);

  img.src = blobUrl;
}

// ── Render recent scans (upload screen) ───────
// Relative time formatter for recent cards. Falls back to a calendar date
// for anything older than a week so the meta line stays compact.
function relativeTime(ts) {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60)            return 'только что';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)            return `${diffMin} мин`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)              return `${diffH} ч`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1)             return 'вчера';
  if (diffD < 7)               return `${diffD} дн`;
  return formatDate(ts);
}

// Caloric-share split for the tri-color macro fingerprint at the bottom
// of each recent card. Keeps the same calorie weighting we use for the
// dish-view rings: P=4 kcal/g, C=4 kcal/g, F=9 kcal/g.
function macroPercents(total) {
  const t = total || {};
  const p = (t.protein_g || 0) * 4;
  const c = (t.carbs_g   || 0) * 4;
  const f = (t.fat_g     || 0) * 9;
  const sum = p + c + f;
  if (sum <= 0) return { p: 0, c: 0, f: 0 };
  return {
    p: (p / sum) * 100,
    c: (c / sum) * 100,
    f: (f / sum) * 100,
  };
}

// Consumed toggle icon — two states, two icons. The previous fork-only
// design read as decoration ("there's a fork here, why?") rather than
// an action. The plus / check pair is universally legible as "add" /
// "added" — the same vocabulary as add-to-cart, add-to-list, etc.
//   Default (not consumed): outline + sign in circle  → "tap to add to today"
//   Consumed:               filled checkmark in circle → "added today"
const CONSUMED_SVG_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><line x1="12" y1="6" x2="12" y2="18"/><line x1="6" y1="12" x2="18" y2="12"/></svg>';
const CONSUMED_SVG_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>';

function consumedToggleHTML(entry) {
  const consumed = isEntryConsumed(entry);
  const cls = consumed ? 'entry-consumed-btn consumed' : 'entry-consumed-btn';
  const label = consumed
    ? 'Сегодня съедено — отменить'
    : 'Добавить в сегодня';
  const svg = consumed ? CONSUMED_SVG_DONE : CONSUMED_SVG_ADD;
  return `<button class="${cls}" data-action="toggle-consumed" aria-label="${label}" aria-pressed="${consumed}">${svg}</button>`;
}

function renderRecent() {
  // Scanner-tab recents show consumed dishes only; the History tab is
  // the place to see everything (eaten + skipped). This is a deliberate
  // UX split — the scanner is the user's daily dashboard, history is the
  // archive. Skipped scans are still in localStorage and visible there.
  // Recent strip on the scanner tab is a TODAY-ONLY ledger — once
  // midnight rolls over, yesterday's consumed scans drop out of this
  // strip but stay in the history tab forever. Keeps the dashboard
  // scoped to "what did I eat today" rather than slowly accreting a
  // multi-day blob users have to scroll past.
  const today = new Date();
  const list = loadEntries()
    .filter(isEntryConsumed)
    .filter(e => sameDay(new Date(e.timestamp), today))
    .slice(0, 3);
  if (!list.length) { recentSection.classList.remove('show'); return; }
  recentSection.classList.add('show');
  recentList.innerHTML = list.map(e => {
    const total = (e.result && e.result.total) || {};
    const m = macroPercents(total);
    // onerror swap: when /api/scans/.../image returns 404 (image file gone
    // — common on Railway's ephemeral filesystem after a redeploy), replace
    // the broken-image icon with the empty placeholder div so the entry
    // looks intentional rather than broken.
    const thumb = e.imageDataUrl
      ? `<img class="recent-thumb" src="${e.imageDataUrl}" alt="" loading="lazy" decoding="async"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'recent-thumb'}))">`
      : `<div class="recent-thumb"></div>`;
    const dimCls = isEntryConsumed(e) ? '' : ' is-skipped';
    return `
      <div class="recent-item${dimCls}" role="button" tabindex="0" data-entry-id="${e.id}">
        ${thumb}
        <div class="recent-info">
          <div class="recent-name">${esc(e.itemNames || 'Блюдо')}</div>
          <div class="recent-meta">${relativeTime(e.timestamp)}</div>
        </div>
        <div class="recent-cal-block">
          <div class="recent-cal">${e.totalCalories}</div>
          <div class="recent-cal-unit">ккал</div>
        </div>
        ${consumedToggleHTML(e)}
        <div class="recent-macro-bar" aria-hidden="true">
          <span class="recent-macro-seg p" style="width: 0%" data-target="${m.p.toFixed(1)}"></span>
          <span class="recent-macro-seg c" style="width: 0%" data-target="${m.c.toFixed(1)}"></span>
          <span class="recent-macro-seg f" style="width: 0%" data-target="${m.f.toFixed(1)}"></span>
        </div>
      </div>
    `;
  }).join('');

  // Tap card body → opens the dish in the scanner result view; user came
  // from the upload screen so back returns there. Tap consumed toggle
  // (button child) → flips consumed state without opening the dish.
  recentList.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('button[data-action="toggle-consumed"]')) {
        e.stopPropagation();
        handleConsumedToggle(el.dataset.entryId);
        return;
      }
      const entry = loadEntries().find(x => String(x.id) === el.dataset.entryId);
      if (entry) {
        // Recent-card opens originate on the scanner — back returns here, not history
        lastViewSource = 'fresh';
        viewSavedResult(entry);
      }
    });
    el.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) {
        e.preventDefault();
        const entry = loadEntries().find(x => String(x.id) === el.dataset.entryId);
        if (entry) { lastViewSource = 'fresh'; viewSavedResult(entry); }
      }
    });
  });

  // Animate the macro bars in after entrance.
  requestAnimationFrame(() => {
    springAnimateList('.recent-item');
    requestAnimationFrame(() => {
      recentList.querySelectorAll('.recent-macro-seg').forEach(seg => {
        seg.style.width = (parseFloat(seg.dataset.target) || 0) + '%';
      });
    });
  });
}

// Toggle the consumed flag on an entry. setEntryConsumed fires
// hmc:history-changed which re-runs renderHistory + renderRecent;
// historyHash now includes the consumed flag, so the render cache
// invalidates automatically. We still purge the day-quality cache
// here since the LLM verdict depends on what was actually eaten.
function handleConsumedToggle(entryId) {
  const list = loadEntries();
  const entry = list.find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const next = !isEntryConsumed(entry);
  setEntryConsumed(entryId, next);
  // Phase 3A: mirror the toggle to the server so it survives a
  // browser-data clear. Fire-and-forget — local change is the
  // immediate UX.
  patchServerEntry(entryId, { consumed: next });
  try {
    const map = JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}');
    const day = new Date(entry.timestamp);
    const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
    delete map[key];
    localStorage.setItem(QUALITY_KEY, JSON.stringify(map));
  } catch {}
  haptic(8);
}

// ── Day hero (top of scanner tab) ───────────
// Slim daily-consumption dashboard above the scan-zone. Kcal headline +
// progress + macro inline strip (Phase A.5). The previous macro-rings
// strip is gone; macros are now a single line of color-coded values
// pulled from .day-hero-macros [data-macro] spans.

const dayHero          = $('dayHero');
const dayHeroCurrent   = $('dayHeroCurrent');
const dayHeroGoal      = $('dayHeroGoal');
const dayHeroProgress  = $('dayHeroProgressFill');
const dayHeroKicker    = $('dayHeroKicker');
const dayHeroMacros    = $('dayHeroMacros');

function pluralizeScans(n) {
  // Russian plural rules: 1 → "скан", 2-4 → "скана", 5+ / 11-14 → "сканов"
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} сканов`;
  if (mod10 === 1)                  return `${n} скан`;
  if (mod10 >= 2 && mod10 <= 4)     return `${n} скана`;
  return `${n} сканов`;
}

// Sum nutrient totals across a list of saved entries. Skips any entry
// the user has marked as not-consumed — the day "consumed" view is the
// authoritative one for the calorie tracker.
function computeDayTotals(entries) {
  return entries.reduce((tot, e) => {
    if (!isEntryConsumed(e)) return tot;
    const t = (e && e.result && e.result.total) || {};
    tot.calories  += t.calories  || 0;
    tot.protein_g += t.protein_g || 0;
    tot.fat_g     += t.fat_g     || 0;
    tot.carbs_g   += t.carbs_g   || 0;
    return tot;
  }, { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
}

function entriesForDay(list, day) {
  return list.filter(e => sameDay(new Date(e.timestamp), day));
}

// Count of entries the user actually ate on a given day. Used for the
// "5 СКАНОВ" kicker on the day hero — saying "5 scans" when 2 were
// rejected feels off, so we only count consumed.
function consumedCount(entries) {
  return entries.filter(isEntryConsumed).length;
}

function renderDayHero() {
  if (!dayHero) return;
  const today  = new Date();
  const todays = entriesForDay(loadEntries(), today);
  // Hide the dashboard when no consumed entries today, so the scanner
  // tab on a fresh day stays clean (no jarring "0 / 2000" placeholder).
  // Matches the empty-state policy of the recents list and the previous
  // day-progress-tile.
  if (!consumedCount(todays)) { dayHero.style.display = 'none'; return; }

  const totals   = computeDayTotals(todays);
  const todayCal = totals.calories;
  const goal     = getSetting('daily_kcal');
  const pct      = Math.min((todayCal / goal) * 100, 100);
  const over     = todayCal > goal;

  dayHero.style.display = 'block';

  // Headline kcal + goal + scan-count kicker.
  // Kicker counts only consumed entries (skipped scans don't count).
  tickerTo(dayHeroCurrent, todayCal);
  dayHeroCurrent.classList.toggle('over', over);
  dayHeroGoal.textContent = `из ${goal.toLocaleString()}`;
  const eatenCount = consumedCount(todays);
  dayHeroKicker.textContent = eatenCount > 0 ? pluralizeScans(eatenCount).toUpperCase() : '';

  // Progress bar — also fire the afterglow sweep when the bar grows
  // (user just added a scan / edited macros up). The pct is stored on
  // dataset so we can compare run-to-run; growth triggers a one-shot
  // CSS animation on .afterglow that auto-clears via animationend.
  // Skipped on first render (no prior pct) — otherwise users see the
  // afterglow on every reload as the bar grows from 0 to its real
  // value, which reads as gratuitous motion.
  dayHeroProgress.classList.toggle('over', over);
  const hasPrior = dayHeroProgress.dataset.pct !== undefined;
  const prevPct = parseFloat(dayHeroProgress.dataset.pct || '0');
  requestAnimationFrame(() => { dayHeroProgress.style.width = pct + '%'; });
  if (hasPrior && pct > prevPct + 0.5) {
    // Restart the animation by toggling the class off-then-on across a frame.
    dayHeroProgress.classList.remove('afterglow');
    requestAnimationFrame(() => {
      dayHeroProgress.classList.add('afterglow');
    });
  }
  dayHeroProgress.dataset.pct = String(pct);

  // Macro inline strip — three color-coded chips (P/C/F). Replaces the
  // previous ring-trio with a single text line so the dashboard fits
  // above the scan-zone without crowding the scanner tab. Values are
  // rounded to ints since the strip is meant for at-a-glance reading,
  // not nutrition-label precision.
  if (dayHeroMacros) {
    const protein = Math.round(totals.protein_g || 0);
    const carbs   = Math.round(totals.carbs_g || 0);
    const fat     = Math.round(totals.fat_g || 0);
    const setMacro = (key, val) => {
      const el = dayHeroMacros.querySelector(`[data-macro="${key}"]`);
      if (el) el.textContent = String(val);
    };
    setMacro('p', protein);
    setMacro('c', carbs);
    setMacro('f', fat);
  }
}

// ── View saved result ─────────────────────────
// Three animations would normally fight when opening from history:
//   1. switchView slides history-view out, scanner-view in
//   2. showScreen slides whatever screen was last (usually 'upload')
//      out and 'results' in
//   3. The summary-card entrance fades + translates the hero
// Phase B simplified this dramatically: the report overlay is positioned
// over whichever view the user is on, so we don't need to switch views
// or juggle screen states. Just render the saved entry's result into
// the overlay and open it.
function viewSavedResult(entry) {
  if (!entry.result) return;
  currentResult = entry.result;
  currentEntryId = entry.id;
  lastAnalyzedBlob = null;   // saved entries only have a thumbnail; can't validate
  originalGramsByIdx = (entry.result.items || []).map(it => it.estimated_grams);
  closeVerdict();
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = entry.imageDataUrl || '';
  isSaved = true;

  // Render content with skipEntrance so renderResults doesn't auto-open
  // the overlay; we open it explicitly below in 'review' mode (X buttons
  // visible, swipe disabled — the entry's consumed flag is already set).
  renderResults(entry.result, entry.imageDataUrl, { skipEntrance: true });
  openReportOverlay('review');
}

// ── Render history view ───────────────────────
// Cache the last-rendered history signature so repeat calls (e.g. every
// time the user switches to history when nothing changed) don't redo the
// expensive innerHTML insertion + thumbnail decoding.
let lastHistoryRenderHash = null;

function historyHash(list) {
  // Cheap structural hash — id + total + consumed + name. Includes the
  // consumed flag so toggling it invalidates the cache automatically;
  // without it, the cache stays warm on consumed-flips and the day-total
  // pill in the date header silently goes stale.
  return list.map(e =>
    e.id + ':' + e.totalCalories + ':' + (e.consumed === false ? 0 : 1) + ':' + (e.itemNames || '')
  ).join('|');
}

// ── Week sparkline hero ──────────────────────────────────
// Renders the top of the History tab: 7 mini-bars (one per day, last
// 7 days incl. today), height = % of daily kcal goal, today's bar
// highlighted. Right column shows the running average and a streak
// count if the user has been hitting goal for 2+ days in a row.
// Replaces the previous "Всего · 142" mono caption — same vertical
// budget, dramatically more informative.
function renderHistoryHero(list) {
  const goal = getSetting('daily_kcal') || 2000;
  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dayEntries = entriesForDay(list, d);
    const totals = computeDayTotals(dayEntries);
    days.push({ date: d, totals, isToday: i === 0 });
  }

  // Average across days that had any consumed kcal (skips empty days
  // so a vacation week with one logged day doesn't drop the average
  // to 1/7 of that day's kcal).
  const consumedDays = days.filter(d => d.totals.calories > 0);
  const avg = consumedDays.length
    ? Math.round(consumedDays.reduce((a, d) => a + d.totals.calories, 0) / consumedDays.length)
    : 0;

  // Streak: consecutive days from today going backward where kcal is
  // within ±20% of goal. Counts today only if it's already past goal,
  // so a half-eaten in-progress day doesn't kill an otherwise good run.
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    const inRange = d.totals.calories >= goal * 0.8 && d.totals.calories <= goal * 1.2;
    if (d.isToday && d.totals.calories < goal * 0.8) break; // today is mid-day, don't penalize
    if (inRange) streak++;
    else if (!d.isToday) break;
  }

  const dayLetter = (d) => {
    // Russian single-letter weekday — пн/вт/ср/чт/пт/сб/вс. Two-letter
    // is more readable than one at this scale.
    const dows = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    return dows[d.getDay()];
  };

  const bars = days.map(d => {
    const heightPct = Math.max(2, Math.min(100, d.totals.calories / goal * 100));
    return `
      <div class="hist-hero-bar${d.isToday ? ' today' : ''}${d.totals.calories === 0 ? ' empty' : ''}" title="${dayLetter(d.date)}: ${d.totals.calories} ккал">
        <div class="hist-hero-bar-track">
          <div class="hist-hero-bar-fill" style="height:${heightPct}%"></div>
        </div>
        <span class="hist-hero-bar-label">${dayLetter(d.date)}</span>
      </div>`;
  }).join('');

  const streakHTML = streak >= 2
    ? `<span class="hist-hero-streak">${streak} ${streak === 1 ? 'день' : (streak < 5 ? 'дня' : 'дней')} в цели</span>`
    : '';

  return `
    <div class="hist-hero">
      <div class="hist-hero-top">
        <span class="hist-hero-label">Эта неделя</span>
        ${streakHTML}
      </div>
      <div class="hist-hero-row">
        <div class="hist-hero-bars">${bars}</div>
        <div class="hist-hero-stats">
          <div class="hist-hero-avg-num">${avg || '—'}</div>
          <div class="hist-hero-avg-label">средн / день</div>
        </div>
      </div>
    </div>
  `;
}

// ── Day-group summary card + entries ─────────────────────
// Each day group now leads with a card: relative day name + absolute
// date, total kcal vs goal with a progress bar, and a 3-macro pill
// strip. Replaces a tiny mono uppercase label that gave the user no
// at-a-glance info.
function renderHistoryGroup(label, entries, totals) {
  const goal = getSetting('daily_kcal') || 2000;
  const dateStr = formatDate(entries[0].timestamp);
  const pct = Math.min(100, totals.calories / goal * 100);
  const consumedCount = entries.filter(isEntryConsumed).length;

  const summary = totals.calories > 0
    ? `
      <div class="hist-day-totals">
        <span class="hist-day-kcal">${totals.calories}</span>
        <span class="hist-day-goal">/ ${goal} ккал</span>
      </div>
      <div class="hist-day-bar"><div class="hist-day-bar-fill" style="width:${pct}%"></div></div>
      <div class="hist-day-macros">
        <span class="hist-day-macro hist-day-macro-p"><i></i>Б ${Math.round(totals.protein_g)}г</span>
        <span class="hist-day-macro hist-day-macro-c"><i></i>У ${Math.round(totals.carbs_g)}г</span>
        <span class="hist-day-macro hist-day-macro-f"><i></i>Ж ${Math.round(totals.fat_g)}г</span>
      </div>`
    : `<div class="hist-day-empty">${consumedCount === 0 && entries.length > 0 ? 'Только сканы — ничего не съедено' : 'Нет приёмов'}</div>`;

  const entriesHTML = entries.map((e, i) => renderHistoryEntry(e, i)).join('');

  return `
    <div class="history-group">
      <div class="hist-day-card">
        <div class="hist-day-head">
          <span class="hist-day-name">${esc(label)}</span>
          <span class="hist-day-date">${esc(dateStr)}</span>
        </div>
        ${summary}
      </div>
      <div class="history-entries">
        ${entriesHTML}
      </div>
    </div>
  `;
}

// ── Single entry tile ────────────────────────────────────
// Bigger thumb (was 52, now 70), neumorphic raised tile, macro
// mini-strip below the meal name (3 colored pills with gram counts),
// and a "Не съел" badge instead of just-dim styling for skipped scans.
function renderHistoryEntry(e, i) {
  const consumed = isEntryConsumed(e);
  const dimCls = consumed ? '' : ' is-skipped';
  const total = (e && e.result && e.result.total) || {};
  const macroStrip = (total.protein_g != null || total.carbs_g != null || total.fat_g != null)
    ? `
      <div class="history-macros">
        <span class="hist-entry-macro hist-entry-macro-p"><i></i>${Math.round(total.protein_g || 0)}</span>
        <span class="hist-entry-macro hist-entry-macro-c"><i></i>${Math.round(total.carbs_g || 0)}</span>
        <span class="hist-entry-macro hist-entry-macro-f"><i></i>${Math.round(total.fat_g || 0)}</span>
      </div>`
    : '';
  const skippedBadge = !consumed
    ? '<span class="history-badge-skipped">Не съел</span>'
    : '';
  return `
    <div class="history-entry${dimCls}" data-entry-id="${e.id}" style="animation-delay:${i * 40}ms">
      ${e.imageDataUrl
        ? `<img class="history-thumb" src="${e.imageDataUrl}" alt="" loading="lazy" decoding="async"
              onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'history-thumb'}))">`
        : `<div class="history-thumb"></div>`}
      <div class="history-info">
        <div class="history-name">${esc(e.itemNames || 'Блюдо')}</div>
        <div class="history-meta">
          <span class="history-time">${formatTime(e.timestamp)}</span>
          ${skippedBadge}
        </div>
        ${macroStrip}
      </div>
      <div class="history-cal">${e.totalCalories}</div>
      ${consumedToggleHTML(e)}
      <button class="history-delete-btn" data-action="delete-entry" aria-label="Удалить запись">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" width="13" height="13">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="6" y1="18" x2="18" y2="6"/>
        </svg>
      </button>
    </div>
  `;
}

function renderHistory() {
  const list = loadEntries();
  const hash = historyHash(list);

  // Day hero refreshes cheaply (totals + ring offsets); always called in
  // case the only change was a midnight rollover or a same-day scan.
  renderDayHero();

  if (hash === lastHistoryRenderHash) return;
  lastHistoryRenderHash = hash;

  if (!list.length) {
    historyContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="24" height="24">
            <path d="M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"/>
          </svg>
        </div>
        <p class="empty-title">Пока нет сканирований</p>
        <p class="empty-sub">Сфотографируйте блюдо, чтобы начать отслеживать калории и макронутриенты</p>
      </div>`;
    return;
  }

  // Group by date label, preserving the chronological order from the list
  // (entries are already in newest-first order via unshift in saveEntry).
  const groups = {};
  list.forEach(e => {
    const label = dayLabel(new Date(e.timestamp));
    (groups[label] = groups[label] || []).push(e);
  });

  const heroHTML = renderHistoryHero(list);
  const groupsHTML = Object.entries(groups).map(([label, entries]) => {
    const totals = computeDayTotals(entries);
    return renderHistoryGroup(label, entries, totals);
  }).join('');

  historyContent.innerHTML = heroHTML + groupsHTML;

  // Tap entry to view; tap delete (× with arm/confirm) to remove; tap
  // consumed toggle to flip eaten state. Buttons stop propagation so they
  // don't bubble to the row's view-handler.
  historyContent.querySelectorAll('.history-entry').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-action="delete-entry"]')) return;
      if (e.target.closest('[data-action="toggle-consumed"]')) {
        e.stopPropagation();
        handleConsumedToggle(el.dataset.entryId);
        return;
      }
      const entry = loadEntries().find(e2 => String(e2.id) === el.dataset.entryId);
      if (entry) {
        // History-row opens originate on the history view — back-arrow
        // returns there, not to the scanner upload screen.
        lastViewSource = 'history';
        viewSavedResult(entry);
      }
    });
    const delBtn = el.querySelector('[data-action="delete-entry"]');
    if (delBtn) {
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        handleEntryDeleteTap(delBtn, el);
      });
    }
  });

  // Entrance animation handled purely in CSS now: .history-entry has a
  // 240ms keyframe and each card carries an inline animation-delay
  // (i * 40ms) that staggers the wave. The previous per-card JS spring
  // saturated the main thread for ~4-6s after refresh, blocking tap
  // events on the cards during the entrance. CSS keyframes run on the
  // compositor and don't block input.
}

// ── Per-entry delete (two-tap arm + confirm pattern) ────
// Tap × once → button arms (red bg, pulse, haptic). The user has 3s to
// either tap × again to confirm (entry slides out + removed from
// localStorage) or tap anywhere else to disarm. No native confirm()
// dialog — it'd break the visual language and feel jarring.
let armedDeleteBtn = null;
let armedDeleteTimeout = null;
let armedDeleteOutsideHandler = null;

function disarmEntryDelete() {
  if (!armedDeleteBtn) return;
  armedDeleteBtn.classList.remove('arming');
  armedDeleteBtn = null;
  if (armedDeleteTimeout) { clearTimeout(armedDeleteTimeout); armedDeleteTimeout = null; }
  if (armedDeleteOutsideHandler) {
    document.removeEventListener('pointerdown', armedDeleteOutsideHandler, true);
    armedDeleteOutsideHandler = null;
  }
}

function handleEntryDeleteTap(btn, entryEl) {
  // Confirm path — second tap on the same armed button
  if (btn === armedDeleteBtn && btn.classList.contains('arming')) {
    disarmEntryDelete();
    commitEntryDelete(btn, entryEl);
    return;
  }
  // Disarm any other armed button first (only one armed at a time)
  if (armedDeleteBtn) disarmEntryDelete();
  // Arm this button
  btn.classList.add('arming');
  armedDeleteBtn = btn;
  haptic([10, 20, 5]);
  armedDeleteTimeout = setTimeout(disarmEntryDelete, 3000);
  // Capture-phase listener so a tap anywhere else cancels arming
  armedDeleteOutsideHandler = (e) => {
    if (!btn.contains(e.target)) disarmEntryDelete();
  };
  // Defer registration so this tap doesn't immediately disarm itself
  setTimeout(() => {
    if (armedDeleteOutsideHandler) {
      document.addEventListener('pointerdown', armedDeleteOutsideHandler, true);
    }
  }, 0);
}

function commitEntryDelete(btn, entryEl) {
  const id = entryEl.dataset.entryId;
  // Disable the row so further interaction during the slide-out is blocked
  entryEl.style.pointerEvents = 'none';
  haptic([15, 30, 8]);
  Spring.springTo(entryEl, {
    from: { x: 0, opacity: 1 },
    to:   { x: -48, opacity: 0 },
    preset: 'snappy',
  }).then(() => {
    // The hmc:history-changed event fired by deleteEntryById will trigger
    // a renderHistory() that rebuilds the list; we invalidate the cache so
    // the rebuild actually happens (the data hash changed).
    lastHistoryRenderHash = null;
    deleteEntryById(id);
    // Phase 3A: mirror to server. If it fails the entry will reappear on
    // next sync — acceptable in v1; rare and recoverable (delete again).
    deleteServerEntry(id);
  });
}

// "Очистить" / clear-all was removed in the history-tab redesign. The
// per-entry × button is the right granularity for "delete a thing"; an
// app-wide nuke button is rare and dangerous. clearEntries() in storage.js
// is still available if a future settings screen wants to expose it.

// React to history changes (saveEntry, clearEntries fire this event)
window.addEventListener('hmc:history-changed', () => {
  // day-hero lives on the scanner tab now (Phase A.5), so re-render it
  // unconditionally — adding/editing/toggling entries from any view
  // should refresh the dashboard.
  renderDayHero();
  renderRecent();
  if (currentView === 'history') renderHistory();
});

// Settings-change cascade: when the user updates a daily target (calorie
// or water goal) via the settings sheet, every surface that displays a
// goal needs to re-render. Centralized here rather than per-component so
// the contract is visible in one place — adding a new goal-displaying
// surface in the future just needs an entry in this list.
window.addEventListener('hmc:settings-changed', () => {
  renderDayHero();      // dashboard at top of scanner tab — always re-render
  renderWaterTile();
  if (currentView === 'history') renderHistory();
  // Calendar grid heuristic colors are computed against daily_kcal — if the
  // sheet is open we need to re-tile so the visible cells match.
  if (calendarSheet && calendarSheet.classList.contains('open')) {
    renderCalendarMonth();
  }
});

// ── Button wiring ─────────────────────────────
// Phase B removed btnBack and btnScanAgain — the report overlay's own
// X close buttons (top-right + bottom-right) and backdrop tap are the
// only ways to exit the overlay. Closing returns the user to whichever
// view they were on (scanner or history); no view-switching needed
// because the overlay was just floating on top.
btnErrorRetry.addEventListener('click', () => { hideError(); showScreen('upload'); });

// ── Micro-interactions (spring-driven) ────────

// Bouncy tap effect for all interactive buttons
function addSpringTap(el) {
  let currentScale = 1;
  let pressed = false;

  el.addEventListener('pointerdown', () => {
    pressed = true;
    currentScale = 0.94;
    haptic(6);
    Spring.springTo(el, {
      from: { scale: 1 },
      to:   { scale: 0.94 },
      config: { damping: 200, stiffness: 300, mass: 1 },
    });
  });

  const release = () => {
    if (!pressed) return;
    pressed = false;
    Spring.springTo(el, {
      from: { scale: currentScale },
      to:   { scale: 1 },
      preset: 'bouncy',
    }).then(() => { currentScale = 1; });
  };

  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

// Orbs (btnCamera, btnGallery) excluded — CSS float animation owns their
// transform. btnBack + btnScanAgain were removed in Phase B (report overlay
// has its own close buttons). Spring tap remains on the few remaining
// global action buttons.
[btnSave, btnErrorRetry].forEach(el => {
  if (el) addSpringTap(el);
});

// Spring-animate history entries when rendered
function springAnimateList(selector) {
  const items = document.querySelectorAll(selector);
  items.forEach((item, i) => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
    Spring.springTo(item, {
      from: { y: 8, opacity: 0 },
      to:   { y: 0, opacity: 1 },
      preset: 'snappy',
      delay: i * 3,
    });
  });
}


// ── Shutter entrance animation ────────────────
// The cinematic camera button is the single focal point of the upload
// screen. On first paint it springs in from scale(0) with a slight
// overshoot so the entrance has weight.
function initShutterEntrance() {
  const shutter = document.querySelector('.scan-shutter');
  if (!shutter) return;
  shutter.style.opacity = '0';
  shutter.style.transform = 'scale(0)';
  Spring.springTo(shutter, {
    from: { scale: 0, opacity: 0 },
    to:   { scale: 1, opacity: 1 },
    preset: 'bouncy',
    delay: 6,
  }).then(() => {
    // Clear inline transform so :hover/:active CSS rules can take over
    shutter.style.transform = '';
    shutter.style.opacity = '';
  });
}

// (Init block was here — moved to the END of the file so all `const`
// declarations below execute before any setup function reads them. The
// calendar refs in particular were at the bottom of the file and caused
// a Temporal Dead Zone error when setupCalendar() tried to reference
// them, which silently broke every subsequent setup* call and froze the
// whole upload screen.)


// ── Calendar sheet ────────────────────────────
// Month-grid modal accessed from the FORK app-header. Each day cell
// is tinted by the AI-judged quality of that day. Quality scores come
// from /api/day-quality (backend agent), cached locally per date so we
// don't re-spend tokens on unchanged days.

const calendarSheet      = $('calendarSheet');
const calendarBackdrop   = $('calendarBackdrop');
const calendarGrid       = $('calendarGrid');
const calendarTitle      = $('calendarTitle');
const calendarDayDetail  = $('calendarDayDetail');
const calendarDayName    = $('calendarDayName');
const calendarDayStats   = $('calendarDayStats');
const calendarDayTip     = $('calendarDayTip');
const btnOpenCalendar    = $('btnOpenCalendar');
const btnCalPrev         = $('btnCalPrev');
const btnCalNext         = $('btnCalNext');

// ── Report overlay refs ─────────────────────────────────────
// Hovering tile that replaces the old screen-results full-screen panel.
// Opened from the analyze success path AND from viewSavedResult (re-view
// of saved entries from recents/history). Closed via the two corner X
// buttons (review mode), backdrop tap, or — fresh mode only — a swipe
// gesture or a tap on the engraved arrow buttons at the bottom of the
// tile. Both swipe and tap route through commitSwipe() so the visual
// confirmation (fly-off + close + commit) is identical regardless of
// input modality.
const reportOverlay         = $('reportOverlay');
const reportOverlayBackdrop = $('reportOverlayBackdrop');
const reportContent         = $('reportContent');
const reportScroll          = $('reportScroll');
const btnReportCloseTop     = $('btnReportCloseTop');     // legacy hidden — see HTML
const btnReportCloseBottom  = $('btnReportCloseBottom');  // legacy hidden — see HTML
const btnReportCloseBarTop    = $('btnReportCloseBarTop');
const btnReportCloseBarBottom = $('btnReportCloseBarBottom');

// ── Settings sheet refs (daily-targets editor) ────────────
// Slide-up modal that edits hmc_settings_v1. setSettings() fires
// hmc:settings-changed on commit; the centralized listener at the bottom
// of this file handles the cascade to renderDayHero/renderWaterTile/
// renderHistory (when on history view) / renderCalendarMonth.
const settingsSheet      = $('settingsSheet');
const settingsBackdrop   = $('settingsSheetBackdrop');
const btnOpenSettings    = $('btnOpenSettings');
const btnSettingsCancel  = $('btnSettingsCancel');
const btnSettingsSubmit  = $('btnSettingsSubmit');
// btnSettingsReset removed in the corrections pass — the Сбросить
// chip was clutter that nobody used.
// Settings now uses MetricScroller tiles (same as the account tab's
// weight/height/birth-year row) for visual + interaction consistency.
// Built lazily on first openSettings so the boot path doesn't pay the
// constructor cost upfront. Both classes expose the same surface
// (.value, .setValue, .refresh) so call-sites need no further change.
let _settingsWheels = null;
function ensureSettingsWheels() {
  if (_settingsWheels) return _settingsWheels;
  const make = (sel) => {
    const root = document.querySelector(`.account-metric[data-metric="${sel}"]`);
    if (!root) return null;
    return new MetricScroller(root, { onChange: () => {} });
  };
  _settingsWheels = { kcal: make('kcal'), water: make('water') };
  return _settingsWheels;
}
const settingsSheetError = $('settingsSheetError');

// ── Account sheet refs (Phase 4) ───────────────────────────
const accountSheet            = $('accountSheet');
const accountSheetBackdrop    = $('accountSheetBackdrop');
const btnOpenAccount          = $('btnOpenAccount');
const btnAccountCancel        = $('btnAccountCancel');
const btnAccountSubmit        = $('btnAccountSubmit');
const btnAccountLogout        = $('btnAccountLogout');
const btnAccountAvatarUpload  = $('btnAccountAvatarUpload');
const btnAccountAvatarRemove  = $('btnAccountAvatarRemove');
const accountAvatarInput      = $('accountAvatarInput');
const accountAvatarImg        = $('accountAvatarImg');
const accountAvatarPlaceholder = document.querySelector('.account-avatar-placeholder');
const accountUsernameLabel    = $('accountUsernameLabel');
const accountIdBadge          = $('accountIdBadge');
const accountDisplayName      = $('accountDisplayName');
const accountIdentityName     = $('accountIdentityName');     // display name shown in identity hero
const accountSheetError       = $('accountSheetError');
const accountActivityCurrent  = $('accountActivityCurrent');
const accountAdvancedEl       = $('accountAdvanced');
const btnAccountThemeToggle   = $('btnAccountThemeToggle');     // theme drawer disclosure
const accountThemeDrawer      = $('accountThemeDrawer');        // theme drawer container
const accountThemeLabel       = $('accountThemeLabel');         // theme name shown in disclosure-sub
const btnAccountChangePasswordRow = $('btnAccountChangePasswordRow');
const accountChangePasswordForm = $('accountChangePasswordForm');
const accountCurrentPassword  = $('accountCurrentPassword');
const accountNewPassword      = $('accountNewPassword');
const btnAccountChangePassword = $('btnAccountChangePassword');
const btnAccountDelete        = $('btnAccountDelete');

// Phase 6a — Account Settings sub-sheet element references.
const acctSettingsSheet           = $('acctSettingsSheet');
const acctSettingsIdBadge         = $('acctSettingsIdBadge');
const acctSettingsEmailRow        = $('acctSettingsEmailRow');
const acctSettingsEmailValue      = $('acctSettingsEmailValue');
const acctSettingsEmailPill       = $('acctSettingsEmailPill');
const btnAcctSettingsConfirmEmail = $('btnAcctSettingsConfirmEmail');
const acctSettingsError           = $('acctSettingsError');
const btnAccountSettingsEntry     = $('btnAccountSettingsEntry');

// Phase 6b — About + Help sub-sheet element references.
const aboutSheet              = $('aboutSheet');
const helpSheet               = $('helpSheet');
const btnAccountAboutEntry    = $('btnAccountAboutEntry');
const btnAccountHelpEntry     = $('btnAccountHelpEntry');

// Phase 6d.2 — sub-sheet card refs (the visual card that drags) and
// inner scroll bodies (the element whose scrollTop tells the drag
// handler whether it's safe to engage). Used by attachSheetDragToClose
// in setupAccount below.
const acctSettingsSheetCard   = $('acctSettingsSheetCard');
const aboutSheetCard          = $('aboutSheetCard');
const helpSheetCard           = $('helpSheetCard');

// Phase 6d.3 — in-app legal popup refs.
const legalModal              = $('legalModal');
const legalModalSheet         = $('legalModalSheet');
const legalModalContent       = $('legalModalContent');

// Phase 6c — Email change/add element references.
const btnAcctSettingsEditEmail    = $('btnAcctSettingsEditEmail');
const acctSettingsEmailEditForm   = $('acctSettingsEmailEditForm');
const acctSettingsEmailInput      = $('acctSettingsEmailInput');
const acctSettingsEmailEditPw     = $('acctSettingsEmailEditPassword');
const btnAcctSettingsEmailSave    = $('btnAcctSettingsEmailSave');

// Phase 6d.4 — additional element references for the redesigned
// Account Settings sub-sheet.
const acctSettingsEmailPillText      = $('acctSettingsEmailPillText');
const acctSettingsEmailHelper        = $('acctSettingsEmailHelper');
const btnAcctSettingsEmailCancel     = $('btnAcctSettingsEmailCancel');
const acctChangePasswordCollapse     = $('acctChangePasswordCollapse');

// Activity-level → human label (Russian) map. Used by the
// "selected name appears below the icon row" pattern.
const ACTIVITY_LABELS_RU = {
  sedentary:    'Сидячий',
  light:        'Лёгкий',
  moderate:     'Умеренный',
  active:       'Активный',
  very_active:  'Очень активный',
};

// Track the in-progress profile state so segmented controls can act
// like radio groups (only one selected at a time) without a nested
// data structure. Reset on every openAccount.
// _accountInitial holds the last-loaded server state so dirty-tracking
// can compute "did anything actually change?" without per-field watchers.
let _accountSelectedGender   = null;  // 'm' | 'f' | null  (was: 'other' option dropped)
let _accountSelectedActivity = null;
let _accountInitial          = null;
let _accountWheels           = null;

// Currently displayed month (the user can navigate prev/next from here)
let calendarYear  = new Date().getFullYear();
let calendarMonth = new Date().getMonth();   // 0-indexed
let calendarSelectedKey = null;

const RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                   'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function entriesByDayKey() {
  // Build a map { 'YYYY-MM-DD': [entry, ...] } from all saved entries.
  const map = {};
  loadEntries().forEach(e => {
    const k = dayKey(new Date(e.timestamp));
    (map[k] = map[k] || []).push(e);
  });
  return map;
}

function openCalendar() {
  if (!calendarSheet) return;
  calendarSheet.classList.add('open');
  calendarSheet.setAttribute('aria-hidden', 'false');
  // Reset to current month every time we open
  const today = new Date();
  calendarYear  = today.getFullYear();
  calendarMonth = today.getMonth();
  calendarSelectedKey = null;
  if (calendarDayDetail) calendarDayDetail.hidden = true;
  renderCalendarMonth();
}

function closeCalendar() {
  if (!calendarSheet) return;
  calendarSheet.classList.remove('open');
  calendarSheet.setAttribute('aria-hidden', 'true');
}

function navigateMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth < 0)  { calendarMonth = 11; calendarYear -= 1; }
  if (calendarMonth > 11) { calendarMonth = 0;  calendarYear += 1; }
  calendarSelectedKey = null;
  if (calendarDayDetail) calendarDayDetail.hidden = true;
  renderCalendarMonth();
}

function renderCalendarMonth() {
  if (!calendarGrid) return;
  calendarTitle.textContent = `${RU_MONTHS[calendarMonth]} ${calendarYear}`;

  // First weekday of the month, clamped to Mon-first (ISO weekday: 0=Sun → 6 if Sun, else day-1)
  const first = new Date(calendarYear, calendarMonth, 1);
  const firstDow = (first.getDay() + 6) % 7;     // Mon=0 ... Sun=6
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const today = new Date();
  const todayKey = dayKey(today);
  const entriesMap = entriesByDayKey();

  // Build cell array: leading empties to align week, then 1..N
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  calendarGrid.innerHTML = cells.map(d => {
    if (d === null) return `<button class="cal-day is-empty" tabindex="-1" aria-hidden="true"></button>`;
    const date = new Date(calendarYear, calendarMonth, d);
    const key  = dayKey(date);
    const isFuture = date.getTime() > today.getTime() && key !== todayKey;
    const dayEntries = (entriesMap[key] || []).filter(isEntryConsumed);
    const hasScans = dayEntries.length > 0;

    // Quality class: prefer cached LLM verdict; fall back to a quick
    // calorie-budget heuristic so cells colour even before the agent
    // has scored that date.
    let qClass = '';
    const cached = getCachedQuality(key);
    if (cached && cached.color) {
      qClass = cached.color === 'green'  ? 'q-good'
             : cached.color === 'yellow' ? 'q-ok'
             : cached.color === 'orange' ? 'q-bad' : '';
    } else if (hasScans) {
      const cal = computeDayTotals(dayEntries).calories;
      const ratio = cal / getSetting('daily_kcal');
      qClass = (ratio >= 0.7 && ratio <= 1.2) ? 'q-good'
             : (ratio >= 0.5 && ratio <= 1.4) ? 'q-ok' : 'q-bad';
    }

    const classes = ['cal-day'];
    if (isFuture)         classes.push('is-future');
    if (key === todayKey) classes.push('is-today');
    if (qClass)           classes.push(qClass);
    if (key === calendarSelectedKey) classes.push('is-selected');

    const dot = hasScans && !isFuture ? '<span class="cal-day-dot"></span>' : '';
    return `<button class="cal-day ${classes.join(' ')}" data-date="${key}" type="button">${d}${dot}</button>`;
  }).join('');

  // Lazy-fetch LLM-judged quality colors for any day that has consumed
  // entries but no cache yet. Each request is internally deduped, the
  // returned cell-class update happens inside requestDayQuality. Defer
  // by a tick so the grid paints first.
  setTimeout(prefetchVisibleQualities, 80);
}

async function prefetchVisibleQualities() {
  if (!calendarGrid) return;
  const map = entriesByDayKey();
  const queue = [];
  calendarGrid.querySelectorAll('.cal-day[data-date]').forEach(cell => {
    if (cell.classList.contains('is-future') || cell.classList.contains('is-empty')) return;
    const key = cell.dataset.date;
    const entries = (map[key] || []).filter(isEntryConsumed);
    if (!entries.length) return;
    const water = getWaterTotalForDay(new Date(key + 'T00:00:00'));
    queue.push({ key, entries, water });
  });

  // Batch into groups of 3 with a 250ms stagger. Without this, opening the
  // calendar on a 30-day-logged month fires 30 parallel requests in <100ms,
  // which (a) blows past the server's 10/min rate limit and (b) creates a
  // burst on Anthropic's API. Total worst case here: ~10 batches × 250ms =
  // 2.5s to schedule everything, never more than 3 in flight.
  const BATCH_SIZE = 3;
  const STAGGER_MS = 250;
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(({ key, entries, water }) =>
        requestDayQuality(key, entries, water).catch(() => {})
      )
    );
    if (i + BATCH_SIZE < queue.length) {
      await new Promise(r => setTimeout(r, STAGGER_MS));
    }
  }
}

function selectCalendarDay(key) {
  calendarSelectedKey = key;
  // Re-render to update .is-selected; cheap because grid is small.
  renderCalendarMonth();

  // Show day-detail panel
  const date = new Date(key + 'T00:00:00');
  const map = entriesByDayKey();
  const dayEntries = (map[key] || []).filter(isEntryConsumed);
  const tot = computeDayTotals(dayEntries);
  const water = getWaterTotalForDay(date);
  const cached = getCachedQuality(key);

  calendarDayDetail.hidden = false;
  calendarDayName.textContent = `${date.getDate()} ${RU_MONTHS[date.getMonth()].toLowerCase()}`;
  if (dayEntries.length === 0) {
    calendarDayStats.textContent = 'Нет записей в этот день.';
    calendarDayTip.textContent = '';
  } else {
    calendarDayStats.textContent =
      `${tot.calories.toLocaleString()} ккал · ${pluralizeScans(dayEntries.length)} · ${water} мл воды`;
    calendarDayTip.textContent = (cached && cached.tip) || (cached && cached.summary) || '';
  }

  // Lazy-fetch the LLM verdict for this day (if not cached and there's data)
  if (dayEntries.length > 0 && !cached) {
    requestDayQuality(key, dayEntries, water).catch(() => {});
  }
}

function setupCalendar() {
  if (!btnOpenCalendar) return;
  btnOpenCalendar.addEventListener('click', () => { haptic(); openCalendar(); });
  if (calendarBackdrop) calendarBackdrop.addEventListener('click', closeCalendar);
  if (btnCalPrev) btnCalPrev.addEventListener('click', () => navigateMonth(-1));
  if (btnCalNext) btnCalNext.addEventListener('click', () => navigateMonth(+1));
  if (calendarGrid) {
    calendarGrid.addEventListener('click', e => {
      const btn = e.target.closest('.cal-day[data-date]');
      if (!btn || btn.classList.contains('is-future') || btn.classList.contains('is-empty')) return;
      selectCalendarDay(btn.dataset.date);
      haptic(4);
    });
  }
  // Drag-to-close.
  const calendarContent = document.getElementById('calendarSheet')
    && document.getElementById('calendarSheet').querySelector('.calendar-content');
  if (calendarContent) attachSheetDragToClose(calendarContent, closeCalendar);
}

// ── Settings sheet (daily-targets editor) ───────
// Open/close mirror the calendar-sheet pattern. Inputs are populated from
// loadSettings() on open; commits go through setSettings() which fires
// hmc:settings-changed → centralized cascade re-renders every surface
// that displays a goal.
function openSettings() {
  if (!settingsSheet) return;
  const cur = loadSettings();
  const wheels = ensureSettingsWheels();
  if (wheels.kcal)  wheels.kcal.setValue(cur.daily_kcal);
  if (wheels.water) wheels.water.setValue(cur.daily_water_ml);
  setSettingsSheetError('');
  settingsSheet.classList.add('open');
  settingsSheet.setAttribute('aria-hidden', 'false');
  // Re-sync wheel scroll positions after the slide-up animation —
  // wheels need real layout to scroll-to-default cleanly.
  setTimeout(() => {
    if (_settingsWheels) {
      Object.values(_settingsWheels).forEach(w => w && w.refresh());
    }
  }, 340);
}

function closeSettings() {
  if (!settingsSheet) return;
  settingsSheet.classList.remove('open');
  settingsSheet.setAttribute('aria-hidden', 'true');
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
}

function setSettingsSheetError(msg) {
  if (settingsSheetError) settingsSheetError.textContent = msg || '';
}

function applySettingsFromInputs() {
  const wheels = ensureSettingsWheels();
  const kcal  = wheels.kcal  ? wheels.kcal.value  : null;
  const water = wheels.water ? wheels.water.value : null;
  // Bounds match the server-side DayQualityRequest schema (ge=500, le=8000)
  // so any local target the user picks here is accepted by the agent.
  if (!isFinite(kcal) || kcal < 500 || kcal > 8000) {
    setSettingsSheetError('Калории: число от 500 до 8000');
    return false;
  }
  if (!isFinite(water) || water < 500 || water > 6000) {
    setSettingsSheetError('Вода: число от 500 до 6000 мл');
    return false;
  }
  const ok = setSettings({ daily_kcal: kcal, daily_water_ml: water });
  if (!ok) {
    setSettingsSheetError('Не удалось сохранить настройки');
    return false;
  }
  closeSettings();
  haptic(8);
  return true;
}

// ── Account sheet (Phase 4 — redesigned) ──────────────────
// Slide-up profile editor. Pulls fresh user state from /api/auth/me
// every open so a multi-device edit on another browser is reflected.
// Major redesign: wheel pickers for weight/height/birth-year,
// icon cards for gender, icon strip for activity, dirty-state save
// row, advanced collapsible for change-pw + delete-account, top-right
// logout icon, capped 88vh height so the sheet reads as a tile.

// Default values for wheels when the user hasn't set anything yet.
// 70 kg + 170 cm are reasonable starting points for an adult; 1995
// puts the wheel ~30 years back which is a sensible center-of-mass.
const ACCOUNT_DEFAULTS = { weight_kg: 70, height_cm: 170, birth_year: 1995 };

function setAcctSettingsError(msg) {
  if (!acctSettingsError) return;
  acctSettingsError.textContent = msg || '';
}

function populateAcctSettingsSheet(user) {
  if (!user) return;
  // Page-id renders as `#000XXX · username` (or just one if the other
  // is missing). The new Phase 6d.4 layout puts this directly under
  // the page title rather than as a standalone badge mid-sheet.
  if (acctSettingsIdBadge) {
    const id = user.id ? '#' + String(user.id).padStart(6, '0') : '';
    const sep = id && user.username ? ' · ' : '';
    acctSettingsIdBadge.textContent = id + sep + (user.username || '');
  }
  if (!acctSettingsEmailRow) return;
  // Three email states drive: value, value-empty class, pill state +
  // text, helper text copy, button visibility + label.
  const hasEmail = !!(user.email && String(user.email).trim());
  const verified = hasEmail && !!user.email_verified;
  if (acctSettingsEmailValue) {
    acctSettingsEmailValue.textContent = hasEmail ? user.email : 'Не задан';
    acctSettingsEmailValue.classList.toggle('acct-field-value--empty', !hasEmail);
  }
  if (acctSettingsEmailPill) {
    acctSettingsEmailPill.dataset.state = verified ? 'verified' : 'unverified';
  }
  if (acctSettingsEmailPillText) {
    acctSettingsEmailPillText.textContent = verified ? 'Подтверждён' : 'Не подтверждён';
  }
  if (acctSettingsEmailHelper) {
    acctSettingsEmailHelper.textContent = !hasEmail
      ? 'Привяжите email для восстановления доступа'
      : (verified ? '' : 'Подтвердите email чтобы защитить аккаунт');
  }
  if (btnAcctSettingsConfirmEmail) {
    btnAcctSettingsConfirmEmail.hidden = !hasEmail || verified;
    btnAcctSettingsConfirmEmail.textContent = 'Подтвердить';
  }
  if (btnAcctSettingsEditEmail) {
    btnAcctSettingsEditEmail.textContent = hasEmail ? 'Изменить' : 'Добавить';
  }
  // Always reset the inline forms on populate so stale half-typed state
  // doesn't linger across sheet open / refresh-after-save.
  if (acctSettingsEmailEditForm) acctSettingsEmailEditForm.classList.remove('open');
  if (acctChangePasswordCollapse) acctChangePasswordCollapse.classList.remove('open');
  if (btnAccountChangePasswordRow) btnAccountChangePasswordRow.setAttribute('aria-expanded', 'false');
}

function openAcctSettingsSheet() {
  if (!acctSettingsSheet) return;
  setAcctSettingsError('');
  acctSettingsSheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => acctSettingsSheet.classList.add('visible'));
  document.documentElement.classList.add('acct-settings-sheet-open');
}
function closeAcctSettingsSheet() {
  if (!acctSettingsSheet) return;
  acctSettingsSheet.classList.remove('visible');
  document.documentElement.classList.remove('acct-settings-sheet-open');
  setTimeout(() => acctSettingsSheet.setAttribute('aria-hidden', 'true'), 400);
}

// Phase 6b — About + Help sub-sheets. Identical mechanics to the
// acct-settings sub-sheet above; kept as separate functions rather than
// generalized so each sheet's open behavior can diverge later (e.g.
// resetting accordion state on Help open).
function openAboutSheet() {
  if (!aboutSheet) return;
  aboutSheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => aboutSheet.classList.add('visible'));
  document.documentElement.classList.add('about-sheet-open');
}
function closeAboutSheet() {
  if (!aboutSheet) return;
  aboutSheet.classList.remove('visible');
  document.documentElement.classList.remove('about-sheet-open');
  setTimeout(() => aboutSheet.setAttribute('aria-hidden', 'true'), 400);
}
function openHelpSheet() {
  if (!helpSheet) return;
  // Phase 6d.5: reset all FAQ items + clear the search filter on each
  // open so the user starts from a clean state. Selectors updated to
  // the redesigned .help-faq-* class names.
  helpSheet.querySelectorAll('.help-faq-item.open').forEach(it => {
    it.classList.remove('open');
    const q = it.querySelector('.help-faq-q');
    if (q) q.setAttribute('aria-expanded', 'false');
  });
  helpSheet.querySelectorAll('.help-faq-item[hidden]').forEach(it => {
    it.hidden = false;
  });
  const search = helpSheet.querySelector('#helpFaqSearchInput');
  if (search) search.value = '';
  const empty = helpSheet.querySelector('#helpFaqEmpty');
  if (empty) empty.hidden = true;
  helpSheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => helpSheet.classList.add('visible'));
  document.documentElement.classList.add('help-sheet-open');
}
function closeHelpSheet() {
  if (!helpSheet) return;
  helpSheet.classList.remove('visible');
  document.documentElement.classList.remove('help-sheet-open');
  setTimeout(() => helpSheet.setAttribute('aria-hidden', 'true'), 400);
}

// Phase 6d.3 — In-app legal popup. Mirrors the /login implementation
// (fetch /privacy or /terms, parse with DOMParser, inject the
// .legal-doc article into #legalModalContent) but adapted for the main
// app: no X close (swipe + backdrop only), wider sheet (legal docs are
// content-heavy), inherits the user's current theme automatically since
// legal-article.css uses the shared --t1/--t2/--bg theme tokens.
const _legalCache = {};
let _legalInfoPromise = null;

function _getLegalInfo() {
  if (!_legalInfoPromise) {
    _legalInfoPromise = fetch('/api/legal/info', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}));
  }
  return _legalInfoPromise;
}

function _fillLegalPlaceholders(root, info) {
  if (!info) return;
  root.querySelectorAll('.legal-fill').forEach(el => {
    const key = el.dataset.legal;
    if (key && info[key]) el.textContent = info[key];
  });
}

function _rewireLegalInternalLinks(root) {
  // Internal /privacy ↔ /terms links inside the article get rewritten
  // to swap the modal content rather than navigate away.
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === '/privacy') {
      a.dataset.legal = 'privacy';
      a.removeAttribute('target');
    } else if (href === '/terms') {
      a.dataset.legal = 'terms';
      a.removeAttribute('target');
    }
  });
}

function _renderLegalError(path) {
  if (!legalModalContent) return;
  legalModalContent.innerHTML =
    '<div class="legal-error">Не удалось загрузить документ.<br>' +
    '<a href="' + path + '" target="_blank" rel="noopener">Открыть в новой вкладке →</a>' +
    '</div>';
}

async function openLegal(kind) {
  if (!legalModal || !legalModalContent) return false;
  const path = kind === 'terms' ? '/terms' : '/privacy';

  legalModalContent.innerHTML = '';
  legalModal.setAttribute('aria-hidden', 'false');
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
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const article = doc.querySelector('.legal-doc');
    if (!article) throw new Error('Article not found in response');
    const clone = article.cloneNode(true);
    _rewireLegalInternalLinks(clone);
    const info = await _getLegalInfo();
    _fillLegalPlaceholders(clone, info);
    legalModalContent.innerHTML = '';
    legalModalContent.appendChild(clone);
    legalModalContent.scrollTop = 0;
  } catch {
    _renderLegalError(path);
  }
  return true;
}

function closeLegal() {
  if (!legalModal) return;
  legalModal.classList.remove('visible');
  document.documentElement.classList.remove('legal-locked');
  setTimeout(() => {
    legalModal.setAttribute('aria-hidden', 'true');
    if (legalModalContent) legalModalContent.innerHTML = '';
  }, 400);
}

function setAccountSheetError(msg, kind) {
  if (!accountSheetError) return;
  accountSheetError.textContent = msg || '';
  accountSheetError.classList.toggle('success', kind === 'success');
}

function paintAccountAvatar(user) {
  // Avatar circle has two image layers (SVG silhouette + uploaded img)
  // and two corner badges (X to remove / + to add). Exactly one badge
  // is visible at a time, mirroring whether the user has a photo.
  if (!accountAvatarImg) return;
  if (user && user.avatar_path) {
    accountAvatarImg.src = `/api/auth/avatar/${user.id}?t=${Date.now()}`;
    accountAvatarImg.hidden = false;
    if (btnAccountAvatarRemove) btnAccountAvatarRemove.hidden = false;
    if (btnAccountAvatarUpload) btnAccountAvatarUpload.hidden = true;
  } else {
    accountAvatarImg.hidden = true;
    accountAvatarImg.removeAttribute('src');
    if (btnAccountAvatarRemove) btnAccountAvatarRemove.hidden = true;
    if (btnAccountAvatarUpload) btnAccountAvatarUpload.hidden = false;
  }
}

function paintAccountSegSelections() {
  document.querySelectorAll('.account-gender-seg').forEach(btn => {
    const sel = btn.dataset.gender === _accountSelectedGender;
    btn.classList.toggle('selected', sel);
    btn.setAttribute('aria-checked', sel ? 'true' : 'false');
  });
  const activityTiles = document.querySelectorAll('.account-activity-tile');
  let activeActivityIdx = -1;
  activityTiles.forEach((btn, idx) => {
    const sel = btn.dataset.activity === _accountSelectedActivity;
    btn.classList.toggle('selected', sel);
    btn.setAttribute('aria-checked', sel ? 'true' : 'false');
    if (sel) activeActivityIdx = idx;
  });
  // Drive the sliding-pill indicator on the activity grid: --act-idx
  // moves the pseudo-element to the selected tile's column, and
  // data-active toggles its visibility (hidden while no selection).
  const activityGrid = activityTiles[0]?.parentElement;
  if (activityGrid) {
    if (activeActivityIdx >= 0) {
      activityGrid.style.setProperty('--act-idx', String(activeActivityIdx));
      activityGrid.dataset.active = 'true';
    } else {
      delete activityGrid.dataset.active;
    }
  }
  // Update the "selected level" caption below the activity strip.
  if (accountActivityCurrent) {
    accountActivityCurrent.textContent =
      _accountSelectedActivity ? (ACTIVITY_LABELS_RU[_accountSelectedActivity] || '') : '';
  }
}

// ── WheelPicker — horizontal scroll-snap value picker ───────────
// One WheelPicker instance manages one numeric field. The track
// holds N cells, scroll-snap centers the chosen one, and we read
// scrollLeft on scroll-end to extract the value. The "selected"
// cell + the two on either side get progressive type sizing so the
// list feels like a physical roll, not a flat number list.
class WheelPicker {
  constructor(rootEl, opts) {
    this.root        = rootEl;                          // .wheel
    this.track       = rootEl.querySelector('.wheel-track');
    this.min         = parseInt(rootEl.dataset.min, 10);
    this.max         = parseInt(rootEl.dataset.max, 10);
    this.step        = parseInt(rootEl.dataset.step || '1', 10);
    // CRITICAL: must match the CSS `.wheel-cell { width: ... }` rule.
    // A mismatch (CSS 56 / JS 60) was silently reporting the wrong
    // value back from scrollLeft, which broke the dirty-diff and made
    // the save button never appear.
    this.cellWidth   = 56;
    this.value       = parseInt(rootEl.dataset.default, 10);
    this.onChange    = (opts && opts.onChange) || (() => {});
    this._scrollEnd  = null;
    this._populated  = false;
    this._observer   = null;
    this._populate();
    // Defer scroll-to-default until the wheel has real layout (it's
    // inside a transform:translateY sheet that's hidden until open).
    this._pendingValue = this.value;
    // Pad the track so the first/last cell can center under the
    // indicator. Padding = (wheel-width - cell-width) / 2.
    this._setTrackPadding();
    // The 'scroll' event still fires when scrollLeft is changed
    // programmatically (from pointermove + momentum + snap below),
    // and _onScroll's _paint() refreshes the selected/near cell
    // styling. The timer-based snap inside _onScroll is now a no-op
    // backstop — the pointer flow already snaps via _snapToNearest.
    this.track.addEventListener('scroll', () => this._onScroll(), { passive: true });

    // Pointer-driven scroll mechanism. CSS now sets
    //   .wheel-track { overflow: hidden; touch-action: none; }
    // so the browser doesn't drive scroll itself; we own it 100%.
    // Vertical drags become true no-ops — preventDefault on the
    // pointermove cancels any default the browser might attempt, and
    // we never set scrollLeft on the vertical axis. The user can no
    // longer drag cells out of the box because the cells are clipped
    // by overflow: hidden and we never let them move vertically.
    this._setupPointerScroll();
  }

  _setupPointerScroll() {
    let drag       = null;
    let momentumId = null;

    const cancelMomentum = () => {
      if (momentumId != null) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
    };

    const onPointerDown = (e) => {
      // New touch arrives → kill any in-flight inertia from the prior
      // swipe so the user feels "in control" again immediately.
      cancelMomentum();
      drag = {
        startX:      e.clientX,
        startY:      e.clientY,
        startScroll: this.track.scrollLeft,
        lastX:       e.clientX,
        lastT:       performance.now(),
        velocity:    0,
        axis:        null,             // 'x' | 'y' once locked
        pointerId:   e.pointerId,
      };
    };

    const onPointerMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      // Axis lock — first ~6px of motion decides whether we're
      // rolling the wheel (horizontal) or being ignored (vertical).
      // Once locked, we stay locked for this gesture so a wandering
      // finger can't suddenly switch modes.
      if (!drag.axis) {
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx < 6 && ady < 6) {
          // Not enough movement to call it. Still preventDefault to
          // keep the gesture from being claimed by anything else.
          e.preventDefault();
          return;
        }
        if (adx > ady) {
          drag.axis = 'x';
          // Capture the pointer so subsequent moves come to us even
          // if the finger drifts off the wheel-track bounds.
          try { this.track.setPointerCapture(drag.pointerId); } catch (_) {}
        } else {
          drag.axis = 'y';
          // Vertical = ignored. Don't capture (let it fall through
          // if anything else cares — it shouldn't, with touch-action:
          // none on this element).
        }
      }

      // Always preventDefault on pointermove — the wheel never wants
      // ANY default browser scrolling, vertical or horizontal.
      e.preventDefault();

      if (drag.axis === 'x') {
        const scrollLeft = drag.startScroll - dx;
        this.track.scrollLeft = scrollLeft;
        // Track velocity in px/ms for the momentum phase.
        const now = performance.now();
        const dt  = Math.max(1, now - drag.lastT);
        drag.velocity = (drag.lastX - e.clientX) / dt;
        drag.lastX = e.clientX;
        drag.lastT = now;
      }
      // axis === 'y' — do nothing. Cells stay put.
    };

    const onPointerUp = () => {
      if (!drag) return;
      const wasHorizontal = drag.axis === 'x';
      const v = drag.velocity;
      const pid = drag.pointerId;
      drag = null;

      try { this.track.releasePointerCapture(pid); } catch (_) {}

      if (!wasHorizontal) {
        // Either no axis was locked (a tap) or vertical drag (ignored).
        // Snap to nearest in case the prior state was sub-pixel off.
        this._snapToNearest();
        return;
      }

      // Apply momentum if release velocity is meaningful.
      if (Math.abs(v) > 0.05) {
        let vel = v * 16;          // px/frame at ~60fps
        const decay = 0.93;
        const minVel = 0.4;
        const tick = () => {
          if (Math.abs(vel) < minVel) {
            momentumId = null;
            this._snapToNearest();
            return;
          }
          this.track.scrollLeft += vel;
          vel *= decay;
          momentumId = requestAnimationFrame(tick);
        };
        momentumId = requestAnimationFrame(tick);
      } else {
        this._snapToNearest();
      }
    };

    this.track.addEventListener('pointerdown',   onPointerDown);
    this.track.addEventListener('pointermove',   onPointerMove);
    this.track.addEventListener('pointerup',     onPointerUp);
    this.track.addEventListener('pointercancel', onPointerUp);
    this._cancelMomentum = cancelMomentum;
  }

  _snapToNearest() {
    if (this._cancelMomentum) this._cancelMomentum();
    const x = this.track.scrollLeft;
    const idx = Math.round(x / this.cellWidth);
    const clamped = Math.max(0, Math.min(idx, this._cellIndex(this.max)));
    const targetX = clamped * this.cellWidth;
    if (Math.abs(targetX - x) < 1) {
      const v = this.min + clamped * this.step;
      if (v !== this.value) {
        this.value = v;
        this.onChange(v);
      }
      this._paint();
      return;
    }
    // Smooth animate to target over 220ms ease-out cubic.
    const startX = x;
    const dx     = targetX - startX;
    const startT = performance.now();
    const dur    = 220;
    let snapId   = null;
    const tick = (now) => {
      const t = Math.min(1, (now - startT) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      this.track.scrollLeft = startX + dx * eased;
      if (t < 1) {
        snapId = requestAnimationFrame(tick);
      } else {
        const v = this.min + clamped * this.step;
        if (v !== this.value) {
          this.value = v;
          this.onChange(v);
        }
        this._paint();
      }
    };
    snapId = requestAnimationFrame(tick);
  }

  _setTrackPadding() {
    const w = this.root.clientWidth;
    if (w === 0) return;  // not laid out yet
    const pad = Math.max(0, Math.round((w - this.cellWidth) / 2));
    this.track.style.scrollPadding = `0 ${pad}px`;
    // Also pad the cells container so first/last can scroll into
    // center. We use real padding on a pseudo-element via
    // ::before/::after via empty span guards inserted by _populate.
    const lead = this.track.querySelector('.wheel-pad-l');
    const tail = this.track.querySelector('.wheel-pad-r');
    if (lead) lead.style.minWidth = pad + 'px';
    if (tail) tail.style.minWidth = pad + 'px';
  }

  _populate() {
    this.track.innerHTML = '';
    const lead = document.createElement('span');
    lead.className = 'wheel-pad-l';
    lead.style.flexShrink = '0';
    this.track.appendChild(lead);
    // Build cells in an array as we go, then cache for hot-path reuse.
    // _paint() runs on every scroll tick (~60-120/sec while scrubbing)
    // and previously re-queried `.wheel-cell` from the DOM each time;
    // for a year-picker that's ~370 cells × every tick. Cache once.
    const cells = [];
    for (let v = this.min; v <= this.max; v += this.step) {
      const span = document.createElement('span');
      span.className = 'wheel-cell';
      span.textContent = String(v);
      span.dataset.value = String(v);
      this.track.appendChild(span);
      cells.push(span);
    }
    this._cells = cells;
    const tail = document.createElement('span');
    tail.className = 'wheel-pad-r';
    tail.style.flexShrink = '0';
    this.track.appendChild(tail);
  }

  _cellIndex(value) {
    return Math.round((value - this.min) / this.step);
  }

  _scrollToValue(v, smooth) {
    this._setTrackPadding();
    const idx = this._cellIndex(v);
    const x = idx * this.cellWidth;
    this.track.scrollTo({ left: x, behavior: smooth ? 'smooth' : 'auto' });
    // Force a paint pass so the visual "selected" updates even if
    // the scroll was a no-op (happens when value is already aligned).
    requestAnimationFrame(() => this._paint());
  }

  _onScroll() {
    this._paint();
    if (this._scrollEnd) clearTimeout(this._scrollEnd);
    // 160ms (was 90ms) — long enough that fleeting pauses during
    // kinetic deceleration don't trigger the snap handler mid-gesture.
    this._scrollEnd = setTimeout(() => {
      const x = this.track.scrollLeft;
      const idx = Math.round(x / this.cellWidth);
      const clamped = Math.max(0, Math.min(idx, this._cellIndex(this.max)));
      const v = this.min + clamped * this.step;
      if (this._programmatic) {
        // Programmatic scroll just settled. If it landed off the
        // intended cell (fractional pixel rounding, layout race),
        // re-snap WITHOUT firing onChange — the user didn't change
        // anything and we don't want to flip the form into a dirty
        // state on first openAccount. The intended value is what
        // setValue/refresh stored in this.value.
        if (v !== this.value) {
          this._scrollToValue(this.value, false);
        } else {
          this._programmatic = false;
        }
        this._paint();
        return;
      }
      if (v !== this.value) {
        this.value = v;
        this.onChange(v);
      }
      this._paint();
    }, 160);
  }

  _paint() {
    const x = this.track.scrollLeft;
    const idx = Math.round(x / this.cellWidth);
    const cells = this._cells;
    if (!cells) return;
    for (let i = 0; i < cells.length; i++) {
      const dist = Math.abs(i - idx);
      const c = cells[i];
      c.classList.toggle('is-selected', dist === 0);
      c.classList.toggle('is-near',     dist === 1);
    }
  }

  setValue(v) {
    this.value = v;
    // Mark the upcoming scroll as programmatic so the scroll-end
    // handler doesn't fire onChange (the form would otherwise see
    // the wheel "change" right after a populateAccountForm call and
    // think the user dirtied the field — flashing Save/Cancel).
    this._programmatic = true;
    if (this.root.clientWidth > 0) {
      this._scrollToValue(v, false);
    } else {
      // Not laid out yet — remember and apply when shown.
      this._pendingValue = v;
    }
  }

  // Call this from the sheet-open path to sync after the slide-up
  // animation has run (track has real width by then).
  refresh() {
    this._programmatic = true;
    if (this._pendingValue != null) {
      const v = this._pendingValue;
      this._pendingValue = null;
      this._scrollToValue(v, false);
    } else {
      this._scrollToValue(this.value, false);
    }
  }
}

// ── MetricScroller — neumorphic 3-column metric input ─────────
// Replaces the WheelPicker for account weight/height/birth-year. UX
// pattern: each metric is a card with current value + ghost neighbors
// (prev/next). User drags vertically, scrolls (mousewheel), or taps
// top/bottom half to step. Mirrors WheelPicker's public API
// (value, setValue, refresh) so account-form wiring stays unchanged.
class MetricScroller {
  constructor(rootEl, opts = {}) {
    this.root  = rootEl;
    this.min   = parseInt(rootEl.dataset.min,  10);
    this.max   = parseInt(rootEl.dataset.max,  10);
    this.step  = parseInt(rootEl.dataset.step, 10) || 1;
    this.value = parseInt(rootEl.dataset.default, 10) || this.min;
    this.onChange = opts.onChange || (() => {});

    this._valueEl = rootEl.querySelector('.account-metric-value');
    this._prevEl  = rootEl.querySelector('.account-metric-prev');
    this._nextEl  = rootEl.querySelector('.account-metric-next');

    this._startY = null;
    this._startVal = null;
    this._t = null;

    this._render();
    this._bindEvents();
  }

  setValue(v) {
    if (typeof v !== 'number' || isNaN(v)) return;
    const clamped = Math.max(this.min, Math.min(this.max, Math.round(v)));
    if (clamped === this.value) return;
    this.value = clamped;
    this._render();
    this.onChange(this.value);
  }

  refresh() { this._render(); }

  _render() {
    this._valueEl.textContent = this.value;
    this._prevEl.textContent = this.value > this.min ? this.value - this.step : '';
    this._nextEl.textContent = this.value < this.max ? this.value + this.step : '';
    this._refreshAria();
  }

  _refreshAria() {
    // aria-valuemin/max/now lets a screen reader announce the current
    // value when the spinbutton is focused. Cheap to set on every render
    // since the property writes are direct attribute updates.
    this.root.setAttribute('aria-valuemin', String(this.min));
    this.root.setAttribute('aria-valuemax', String(this.max));
    this.root.setAttribute('aria-valuenow', String(this.value));
  }

  _bumpFlash() {
    this.root.classList.add('is-bumping');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.root.classList.remove('is-bumping'), 180);
  }

  _step(delta) {
    if (this._startVal == null) return;
    const next = this._startVal + delta * this.step;
    const clamped = Math.max(this.min, Math.min(this.max, next));
    if (clamped !== this.value) {
      this.value = clamped;
      this._render();
      this._bumpFlash();
      this.onChange(this.value);
      haptic(3);
    }
  }

  _bindEvents() {
    // Make the scroller focusable + announce as a spinbutton for AT.
    // Without these, desktop / keyboard-only users had no way to change
    // weight / height / birth-year — the component was touch-and-wheel only.
    if (!this.root.hasAttribute('tabindex')) this.root.setAttribute('tabindex', '0');
    this.root.setAttribute('role', 'spinbutton');
    this._refreshAria();

    // Keyboard: arrows step ±1, PageUp/PageDown step ±10, Home/End jump
    // to bounds. Matches native <input type=number> conventions.
    this.root.addEventListener('keydown', (e) => {
      let delta = 0;
      if (e.key === 'ArrowUp'   || e.key === 'ArrowRight') delta = +1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')  delta = -1;
      if (e.key === 'PageUp')   delta = +10;
      if (e.key === 'PageDown') delta = -10;
      if (e.key === 'Home') { this.setValue(this.min); e.preventDefault(); return; }
      if (e.key === 'End')  { this.setValue(this.max); e.preventDefault(); return; }
      if (delta === 0) return;
      e.preventDefault();
      this._startVal = this.value;
      this._step(delta);
    });

    // Mouse wheel / trackpad scroll — desktop fast adjustment.
    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._startVal = this.value;
      this._step(e.deltaY > 0 ? -1 : 1);
    }, { passive: false });

    // Mouse drag — vertical only. 8px per step keeps drag feel calm.
    this.root.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this._startY = e.clientY;
      this._startVal = this.value;
      const onMove = (ev) => this._step(Math.round((this._startY - ev.clientY) / 14));
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Touch — stopPropagation prevents the sheet's drag-to-close
    // handler from firing when the user is adjusting a metric. Without
    // this, every up-drag on a metric was sending the sheet down. */
    this.root.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      this._startY = e.touches[0].clientY;
      this._startVal = this.value;
    }, { passive: true });
    this.root.addEventListener('touchmove', (e) => {
      if (this._startY == null) return;
      e.stopPropagation();
      this._step(Math.round((this._startY - e.touches[0].clientY) / 14));
      e.preventDefault();
    }, { passive: false });
    this.root.addEventListener('touchend', (e) => {
      e.stopPropagation();
      this._startY = null;
    });

    // Click on top/bottom half — single step adjustment for users
    // who don't realize drag is available.
    this.root.addEventListener('click', (e) => {
      // Suppress click that fires after a drag (only step on TRUE taps)
      const rect = this.root.getBoundingClientRect();
      const isTopHalf = e.clientY < rect.top + rect.height / 2;
      this._startVal = this.value;
      this._step(isTopHalf ? 1 : -1);
    });
  }
}

function ensureAccountWheels() {
  // Build metric scrollers lazily on first openAccount. Returned
  // objects mirror the legacy WheelPicker API (value getter, setValue,
  // refresh) so populateAccountForm/readAccountForm don't change. */
  if (_accountWheels) return _accountWheels;
  const make = (sel) => {
    const root = document.querySelector(`.account-metric[data-metric="${sel}"]`);
    if (!root) return null;
    return new MetricScroller(root, { onChange: () => recomputeAccountDirty() });
  };
  _accountWheels = {
    weight:     make('weight'),
    height:     make('height'),
    birth_year: make('birth_year'),
  };
  return _accountWheels;
}

function populateAccountForm(user) {
  if (!user) return;
  if (accountUsernameLabel) accountUsernameLabel.textContent = user.username || '';
  if (accountIdBadge)       accountIdBadge.textContent = user.id ? '#' + String(user.id).padStart(6, '0') : '';
  // Phase 6a: mirror id + email state into the Account Settings sub-sheet.
  populateAcctSettingsSheet(user);
  if (accountDisplayName)   accountDisplayName.value = user.display_name || '';
  // Identity hero name mirror — populated from the same source as the
  // input below it. Empty → fallback so the hero never shows blank.
  if (accountIdentityName) accountIdentityName.textContent = (user.display_name || '').trim() || '—';

  const wheels = ensureAccountWheels();
  if (wheels.weight)     wheels.weight.setValue(user.weight_kg  != null ? Math.round(user.weight_kg)  : ACCOUNT_DEFAULTS.weight_kg);
  if (wheels.height)     wheels.height.setValue(user.height_cm  != null ? Math.round(user.height_cm)  : ACCOUNT_DEFAULTS.height_cm);
  if (wheels.birth_year) wheels.birth_year.setValue(user.birth_year != null ? user.birth_year         : ACCOUNT_DEFAULTS.birth_year);

  _accountSelectedGender   = user.gender || null;
  _accountSelectedActivity = user.activity_level || null;
  paintAccountSegSelections();
  paintAccountAvatar(user);

  // Snapshot for dirty comparison — store the same shape we'll
  // compare against in recomputeAccountDirty. Also stash id +
  // avatar_path so cancelAccountChanges can rebuild a complete user
  // for paintAccountAvatar (avatar is committed server-side and is
  // NOT part of dirty form state, so cancel must preserve it).
  _accountInitial = {
    id:             user.id,
    avatar_path:    user.avatar_path || null,
    display_name:   user.display_name || '',
    weight_kg:      user.weight_kg  != null ? Math.round(user.weight_kg)  : ACCOUNT_DEFAULTS.weight_kg,
    height_cm:      user.height_cm  != null ? Math.round(user.height_cm)  : ACCOUNT_DEFAULTS.height_cm,
    birth_year:     user.birth_year != null ? user.birth_year             : ACCOUNT_DEFAULTS.birth_year,
    gender:         user.gender || null,
    activity_level: user.activity_level || null,
  };
  // Server-set values match initial → not dirty. Hide the action row.
  setAccountDirty(false);
  setAccountSheetError('');
}

function readAccountForm() {
  const wheels = ensureAccountWheels();
  return {
    display_name:   accountDisplayName ? accountDisplayName.value.trim() : '',
    weight_kg:      wheels.weight     ? wheels.weight.value     : null,
    height_cm:      wheels.height     ? wheels.height.value     : null,
    birth_year:     wheels.birth_year ? wheels.birth_year.value : null,
    gender:         _accountSelectedGender,
    activity_level: _accountSelectedActivity,
  };
}

function setAccountDirty(dirty) {
  const content = accountSheet && accountSheet.querySelector('.account-sheet-content');
  if (content) content.classList.toggle('has-changes', !!dirty);
}

function recomputeAccountDirty() {
  if (!_accountInitial) return;
  const cur = readAccountForm();
  const dirty = (
    cur.display_name   !== _accountInitial.display_name ||
    cur.weight_kg      !== _accountInitial.weight_kg ||
    cur.height_cm      !== _accountInitial.height_cm ||
    cur.birth_year     !== _accountInitial.birth_year ||
    cur.gender         !== _accountInitial.gender ||
    cur.activity_level !== _accountInitial.activity_level
  );
  setAccountDirty(dirty);
}

async function openAccount() {
  if (!accountSheet) return;
  // Open immediately. Wheels need real layout before they can scroll-
  // to-default, so we open first and refresh after the slide-up
  // animation. Loading errors stay silent — a half-populated form is
  // self-evidently broken; surfacing "Не удалось загрузить" inside
  // the sheet for transient network blips just confused fresh users.
  accountSheet.classList.add('open');
  accountSheet.setAttribute('aria-hidden', 'false');
  setAccountSheetError('');

  // Reset advanced collapsible to closed on every open so the sheet
  // doesn't re-open with a half-state from last time.
  if (accountAdvancedEl) accountAdvancedEl.classList.remove('open', 'pw-open');
  if (accountChangePasswordForm) accountChangePasswordForm.classList.remove('open');
  if (btnAccountChangePasswordRow) btnAccountChangePasswordRow.setAttribute('aria-expanded', 'false');
  const content = accountSheet.querySelector('.account-sheet-content');
  if (content) {
    content.classList.remove('advanced-open', 'has-changes', 'pw-form-open');
    content.style.transform = '';  // wipe any stale drag-to-close transform
  }

  // Pre-seed _accountInitial with defaults so dirty tracking works
  // even if the network /me call fails or hasn't returned yet. Without
  // this, recomputeAccountDirty bails (returns early) and the save
  // button never surfaces — exactly the bug from issue #3.
  _accountInitial = {
    display_name:   '',
    weight_kg:      ACCOUNT_DEFAULTS.weight_kg,
    height_cm:      ACCOUNT_DEFAULTS.height_cm,
    birth_year:     ACCOUNT_DEFAULTS.birth_year,
    gender:         null,
    activity_level: null,
  };

  // Wheels are pre-built at app boot in setupAccount() so the open
  // animation doesn't pay the DOM-cost of populating ~370 cells. The
  // refresh() pass below resyncs scroll positions once the sheet has
  // real layout post-slide-up.
  setTimeout(() => {
    if (_accountWheels) {
      Object.values(_accountWheels).forEach(w => w && w.refresh());
    }
  }, 340);

  try {
    const fresh = await fetchCurrentUser();
    if (fresh) populateAccountForm(fresh);
  } catch {
    /* swallow — leave the form at defaults; the safety _accountInitial
       above keeps dirty tracking functional regardless. */
  }
}

function closeAccount() {
  if (!accountSheet) return;
  accountSheet.classList.remove('open');
  accountSheet.setAttribute('aria-hidden', 'true');
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
}

function readAccountFormPatch() {
  // Build the patch the server expects. We only send fields that
  // changed vs the snapshot — keeps the wire smaller and avoids
  // accidentally re-writing a server-clamped value back as the
  // user-typed one.
  const cur = readAccountForm();
  const patch = {};
  if (!_accountInitial) return patch;
  if (cur.display_name   !== _accountInitial.display_name)   patch.display_name   = cur.display_name;
  if (cur.weight_kg      !== _accountInitial.weight_kg)      patch.weight_kg      = cur.weight_kg;
  if (cur.height_cm      !== _accountInitial.height_cm)      patch.height_cm      = cur.height_cm;
  if (cur.birth_year     !== _accountInitial.birth_year)     patch.birth_year     = cur.birth_year;
  if (cur.gender         !== _accountInitial.gender   && cur.gender)         patch.gender         = cur.gender;
  if (cur.activity_level !== _accountInitial.activity_level && cur.activity_level) patch.activity_level = cur.activity_level;
  return patch;
}

async function applyAccountFromInputs() {
  if (btnAccountSubmit) btnAccountSubmit.disabled = true;
  setAccountSheetError('');
  try {
    const patch = readAccountFormPatch();
    if (Object.keys(patch).length === 0) {
      // Nothing changed — close as if cancelled.
      closeAccount();
      return;
    }
    const fresh = await updateProfile(patch);
    populateAccountForm(fresh);
    closeAccount();
    haptic(8);
  } catch (err) {
    setAccountSheetError((err && err.message) || 'Не удалось сохранить');
  } finally {
    if (btnAccountSubmit) btnAccountSubmit.disabled = false;
  }
}

// ── Drag-down-to-close helper ────────────────────────────────────
// Generic gesture for the bottom sheets (account / settings / calendar).
// Drag-down works ANYWHERE on the sheet — but only when the sheet
// itself is scrolled to the top (scrollTop === 0). When scrolled
// down, vertical drag scrolls the content as expected; user has to
// scroll back to top to engage the close gesture. This matches iOS
// Maps / Apple Music's bottom-sheet behavior.
//
// Movement is locked to the vertical axis: a horizontal-dominant
// drag (e.g. spinning a wheel) bails out so the wheel's own scroll
// keeps working. Pointer capture so the gesture survives the finger
// leaving the element. Inline transform during drag, restored to ''
// on release for snap-back via CSS.
function attachSheetDragToClose(sheetContent, onClose, scrollTarget, opts = {}) {
  if (!sheetContent) return;
  // scrollTarget is the element that ACTUALLY scrolls — for sheets with
  // an inner scroll container (like the new account sheet's
  // .account-scroll), the outer .sheet-content's scrollTop is always 0
  // even when the user has scrolled the inner content. Without checking
  // the right element, drag-to-close engages even when the user is
  // mid-scroll inside the sheet.
  if (!scrollTarget) scrollTarget = sheetContent;
  // Defaults match the original sensitivity used for settings + calendar
  // sheets (don't change those — user said they feel right). Account
  // sheet passes higher thresholds via opts so its larger content area
  // doesn't dismiss on slight drags.
  const COMMIT_PX  = opts.commitPx ?? 80;
  const COMMIT_VELOCITY = opts.commitVelocity ?? 0.45;
  const AXIS_LOCK_PX = 8;       // how far before we decide it's a vertical drag
  const AXIS_RATIO   = 1.2;     // horizontal beats vertical by this much → bail

  let active = false;
  let axisLocked = false;
  let startY = 0;
  let startX = 0;
  let lastY  = 0;
  let lastT  = 0;
  let velocity = 0;
  let pointerId = null;

  sheetContent.addEventListener('pointerdown', (e) => {
    // Only allow drag-close when the actual scroll container is at the
    // top. For sheets with an inner scroll wrapper, scrollTarget points
    // to the wrapper; for simple sheets, scrollTarget defaults to
    // sheetContent itself.
    if (scrollTarget.scrollTop > 0) return;
    // Ignore touches starting on real interactive controls.
    // .account-metric is the new neumorphic metric scroller (drag
     // adjusts the value); without bailing here, every up-drag on a
    // metric was registering as a sheet drag-to-close. The pointer-
    // events used by this handler bubble even when the metric's own
    // touch handlers stopPropagation, so we have to opt out at the
    // closest()-target level instead. */
    if (e.target.closest('button, input, select, textarea, .wheel-track, .account-metric')) return;
    active = true;
    axisLocked = false;
    startY = lastY = e.clientY;
    startX = e.clientX;
    lastT = performance.now();
    velocity = 0;
    pointerId = e.pointerId;
    // Don't capture immediately — wait until axis is locked vertical,
    // so a horizontal-dominant gesture (wheel spin via parent dispatch
    // or any other lateral motion) can fall through to its own handler.
  });

  sheetContent.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Axis lock: decide whether this gesture is a sheet-drag (vertical)
    // or something else (horizontal). Bail out cleanly if horizontal
    // wins so wheel-spins never get hijacked by the close gesture.
    if (!axisLocked) {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < AXIS_LOCK_PX && absDy < AXIS_LOCK_PX) return;
      if (absDx * AXIS_RATIO > absDy) {
        // Horizontal-dominant — abandon the drag silently.
        active = false;
        return;
      }
      if (dy < 0) {
        // Upward drag — sheet doesn't open further upward, ignore.
        active = false;
        return;
      }
      // Vertical-dominant downward drag. Now we own the gesture.
      axisLocked = true;
      sheetContent.setPointerCapture(pointerId);
      sheetContent.style.transition = 'none';
    }

    const now = performance.now();
    const dt = Math.max(now - lastT, 1);
    velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = now;
    const delta = Math.max(0, dy);
    sheetContent.style.transform = `translate3d(0, ${delta}px, 0)`;
  });

  const finish = (e) => {
    if (!active) return;
    active = false;
    // If we never locked vertical, this was just a tap or horizontal
    // swipe — nothing to undo.
    if (!axisLocked) {
      pointerId = null;
      return;
    }
    if (pointerId != null && sheetContent.hasPointerCapture(pointerId)) {
      sheetContent.releasePointerCapture(pointerId);
    }
    pointerId = null;
    const delta = Math.max(0, lastY - startY);
    sheetContent.style.transition = '';
    if (delta > COMMIT_PX || velocity > COMMIT_VELOCITY) {
      // Continue the slide with a translate to off-screen, then
      // trigger the close path.
      sheetContent.style.transform = 'translate3d(0, 100%, 0)';
      setTimeout(() => {
        onClose();
        // Suppress transitions while we snap inline state back to
        // defaults — otherwise clearing `transform` lets the CSS-
        // default closed position (a small +4% offset for the
        // subtle entry animation on the account sheet) animate UP
        // from 100% offscreen, producing a "ghost floating back up"
        // while opacity is still fading. One frame of transition:none
        // makes the snap invisible.
        sheetContent.style.transition = 'none';
        sheetContent.style.transform  = '';
        sheetContent.style.opacity    = '';
        // Force layout to commit the snap, then re-enable transitions
        // on the next frame so future opens animate normally.
        void sheetContent.offsetHeight;
        requestAnimationFrame(() => {
          sheetContent.style.transition = '';
        });
      }, 320);
    } else {
      sheetContent.style.transform = '';
    }
  };
  sheetContent.addEventListener('pointerup',     finish);
  sheetContent.addEventListener('pointercancel', finish);
}

function cancelAccountChanges() {
  // Revert form fields to the loaded snapshot. populateAccountForm sets
  // dirty=false at its end, which hides the action row. The sheet
  // STAYS OPEN — cancel reverts edits, it doesn't close. Closing on
  // cancel was confusing because it kicked the user back to the
  // scanner just for backing out of an edit.
  if (_accountInitial) {
    const fakeUser = {
      username: accountUsernameLabel ? accountUsernameLabel.textContent : '',
      ..._accountInitial,
    };
    populateAccountForm(fakeUser);
  }
  haptic(4);
}

async function handleAvatarFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    setAccountSheetError('Файл слишком большой (макс 4 МБ)');
    return;
  }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    setAccountSheetError('Неподдерживаемый формат. Используйте JPEG, PNG или WebP.');
    return;
  }
  setAccountSheetError('Загружаем фото…');
  try {
    // Compress before upload — same compressImage helper used by the
    // analyze flow. Caps the long edge at 512px which is plenty for an
    // avatar and shrinks a 4MB phone photo to ~30KB on the wire.
    const blob = await compressImage(file, 512);
    const fresh = await uploadAvatar(blob);
    paintAccountAvatar(fresh);
    // Avatar is committed independently of form-save; mirror the new
    // path into the snapshot so a subsequent Cancel doesn't revert it.
    if (_accountInitial && fresh) _accountInitial.avatar_path = fresh.avatar_path || null;
    setAccountSheetError('');
  } catch (err) {
    setAccountSheetError((err && err.message) || 'Не удалось загрузить фото');
  }
}

// ── Glass confirm/info modal ─────────────────
// Promise-based replacement for native confirm(). The modal markup
// lives in index.html (#confirmModal); this helper just toggles
// classes + wires button handlers. Returns a Promise resolving to
// true on confirm, false on cancel/backdrop/Escape.
//
// opts:
//   title:        string (required)
//   body:         string (optional secondary copy)
//   confirmText:  string (default 'OK')
//   cancelText:   string (default 'Отмена')
//   danger:       bool — confirm button uses error-red styling
//   icon:         optional SVG markup string for the icon slot
function showConfirm(opts) {
  return new Promise(resolve => {
    const modal       = document.getElementById('confirmModal');
    const titleEl     = document.getElementById('confirmModalTitle');
    const bodyEl      = document.getElementById('confirmModalBody');
    const iconEl      = document.getElementById('confirmModalIcon');
    const btnCancel   = document.getElementById('btnConfirmModalCancel');
    const btnConfirm  = document.getElementById('btnConfirmModalConfirm');
    const backdrop    = document.getElementById('confirmModalBackdrop');
    if (!modal || !titleEl || !btnConfirm) { resolve(false); return; }

    titleEl.textContent  = opts.title || '';
    bodyEl.textContent   = opts.body  || '';
    iconEl.innerHTML     = opts.icon  || '';
    btnConfirm.textContent = opts.confirmText || 'OK';
    btnCancel.textContent  = opts.cancelText  || 'Отмена';
    modal.classList.toggle('danger', !!opts.danger);
    modal.classList.remove('info');

    const finish = (val) => {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      btnConfirm.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onOk     = () => { haptic(8); finish(true);  };
    const onCancel = () => { haptic(4); finish(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onOk(); }
    };
    btnConfirm.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  });
}
// Single-button variant. Auto-dismisses after `dismissMs` if provided.
function showInfo(opts) {
  return new Promise(resolve => {
    const modal      = document.getElementById('confirmModal');
    const titleEl    = document.getElementById('confirmModalTitle');
    const bodyEl     = document.getElementById('confirmModalBody');
    const iconEl     = document.getElementById('confirmModalIcon');
    const btnConfirm = document.getElementById('btnConfirmModalConfirm');
    const backdrop   = document.getElementById('confirmModalBackdrop');
    if (!modal || !titleEl || !btnConfirm) { resolve(true); return; }

    titleEl.textContent  = opts.title || '';
    bodyEl.textContent   = opts.body  || '';
    iconEl.innerHTML     = opts.icon  || '';
    btnConfirm.textContent = opts.confirmText || 'Хорошо';
    modal.classList.remove('danger');
    modal.classList.add('info');

    let timer = null;
    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      btnConfirm.removeEventListener('click', finish);
      backdrop.removeEventListener('click', finish);
      document.removeEventListener('keydown', onKey, true);
      resolve(true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.stopPropagation();
        finish();
      }
    };
    btnConfirm.addEventListener('click', finish);
    backdrop.addEventListener('click', finish);
    document.addEventListener('keydown', onKey, true);

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    if (opts.dismissMs && opts.dismissMs > 0) {
      timer = setTimeout(finish, opts.dismissMs);
    }
  });
}

async function handleAvatarRemove() {
  const ok = await showConfirm({
    title: 'Удалить фото профиля?',
    body: 'Аватар вернётся к стандартному силуэту.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  setAccountSheetError('');
  try {
    const fresh = await deleteAvatar();
    paintAccountAvatar(fresh);
    // Mirror cleared state into the snapshot — see handleAvatarFile.
    if (_accountInitial) _accountInitial.avatar_path = null;
  } catch (err) {
    setAccountSheetError((err && err.message) || 'Не удалось удалить фото');
  }
}

async function handleLogout() {
  const ok = await showConfirm({
    title: 'Выйти из аккаунта?',
    body: 'Сессия закроется. Войдёте позже тем же именем + паролем.',
    confirmText: 'Выйти',
    cancelText:  'Остаться',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><path d="M15 16l4-4m0 0l-4-4m4 4H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>',
  });
  if (!ok) return;
  await logoutUser();
  // Hard navigation to /login. Don't use replace to /; the server-side
  // redirect would bounce us back to /login anyway, but a direct hop
  // skips the round-trip and clears any in-memory app state.
  window.location.replace('/login');
}

async function handleChangePassword() {
  if (!accountCurrentPassword || !accountNewPassword) return;
  const cur = accountCurrentPassword.value;
  const nxt = accountNewPassword.value;
  // Errors render in the Phase 6a sub-sheet's own error slot — change-
  // password now lives inside that sub-sheet, not the parent account
  // sheet.
  if (!cur) { setAcctSettingsError('Введите текущий пароль'); return; }
  if (!nxt || nxt.length < 4) {
    setAcctSettingsError('Новый пароль: минимум 4 символа');
    return;
  }
  if (cur === nxt) {
    setAcctSettingsError('Новый пароль совпадает с текущим');
    return;
  }
  if (btnAccountChangePassword) btnAccountChangePassword.disabled = true;
  setAcctSettingsError('');
  try {
    await changePassword(cur, nxt);
    accountCurrentPassword.value = '';
    accountNewPassword.value     = '';
    haptic([8, 30, 8]);
    showInfo({
      title: 'Пароль обновлён',
      body: 'Используйте новый пароль при следующем входе.',
      confirmText: 'Хорошо',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><polyline points="5 12 10 17 19 7"/></svg>',
      dismissMs: 1800,
    });
  } catch (err) {
    setAcctSettingsError((err && err.message) || 'Не удалось сменить пароль');
  } finally {
    if (btnAccountChangePassword) btnAccountChangePassword.disabled = false;
  }
}

// ── Delete-account modal (designed; replaces native confirm/prompt) ──
const deleteModal           = $('deleteModal');
const deleteModalBackdrop   = $('deleteModalBackdrop');
const deleteReason          = $('deleteReason');
const deletePassword        = $('deletePassword');
const deleteModalError      = $('deleteModalError');
const btnDeleteModalCancel  = $('btnDeleteModalCancel');
const btnDeleteModalConfirm = $('btnDeleteModalConfirm');

function openDeleteModal() {
  if (!deleteModal) return;
  // Reset fields on each open so prior input doesn't leak.
  if (deleteReason)   deleteReason.value = '';
  if (deletePassword) deletePassword.value = '';
  if (deleteModalError) deleteModalError.textContent = '';
  if (btnDeleteModalConfirm) btnDeleteModalConfirm.disabled = false;
  deleteModal.classList.add('open');
  deleteModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => deletePassword && deletePassword.focus(), 280);
}
function closeDeleteModal() {
  if (!deleteModal) return;
  deleteModal.classList.remove('open');
  deleteModal.setAttribute('aria-hidden', 'true');
}

async function handleDeleteAccount() {
  // Replaces the old confirm()/prompt() pair with the designed modal.
  // The actual delete + redirect happens inside btnDeleteModalConfirm's
  // click handler below; this function just opens the modal.
  openDeleteModal();
}

async function confirmAccountDelete() {
  if (!deletePassword) return;
  const pw = deletePassword.value;
  const reason = deleteReason ? deleteReason.value.trim() : '';
  if (!pw) {
    if (deleteModalError) deleteModalError.textContent = 'Введите пароль для подтверждения';
    return;
  }
  if (btnDeleteModalConfirm) btnDeleteModalConfirm.disabled = true;
  if (deleteModalError) deleteModalError.textContent = '';
  try {
    await deleteAccount(pw, reason);
    // Clear every local cache so an attacker with the device can't
    // peek at the just-departed account's data via the back button.
    try { localStorage.clear(); } catch {}
    window.location.replace('/login');
  } catch (err) {
    if (deleteModalError) {
      deleteModalError.textContent = (err && err.message) || 'Не удалось удалить аккаунт';
    }
    if (btnDeleteModalConfirm) btnDeleteModalConfirm.disabled = false;
  }
}

function setupAccount() {
  if (!btnOpenAccount || !accountSheet) return;

  // Pre-build wheels at app boot so first-open of the account sheet
  // doesn't pay the ~370-cell DOM cost during its slide-up animation.
  // Building takes ~5-10ms; doing it lazily on open caused a visible
  // hitch as the sheet was finishing its motion.
  ensureAccountWheels();

  btnOpenAccount.addEventListener('click', () => { haptic(); openAccount(); });
  if (accountSheetBackdrop) accountSheetBackdrop.addEventListener('click', closeAccount);
  if (btnAccountCancel)     btnAccountCancel.addEventListener('click', cancelAccountChanges);
  if (btnAccountSubmit)     btnAccountSubmit.addEventListener('click', applyAccountFromInputs);
  if (btnAccountLogout)     btnAccountLogout.addEventListener('click', handleLogout);

  if (btnAccountAvatarUpload && accountAvatarInput) {
    btnAccountAvatarUpload.addEventListener('click', () => accountAvatarInput.click());
    accountAvatarInput.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      handleAvatarFile(file);
      accountAvatarInput.value = '';
    });
  }
  if (btnAccountAvatarRemove) {
    btnAccountAvatarRemove.addEventListener('click', handleAvatarRemove);
  }

  // (The legacy `btnAccountAdvancedToggle` collapsible was replaced by
  // the always-visible Advanced card with inline disclosures — the
  // toggle button + its event handler block lived here and have been
  // removed since the element no longer exists in the DOM.)

  // Phase 6d.4: change-password collapse trigger. The .open class lives
  // on the .acct-collapse wrapper now (not on the inner content), so
  // CSS .acct-collapse.open .acct-collapse-content { grid-template-rows: 1fr }
  // can drive the height transition properly. Falls back to toggling
  // accountChangePasswordForm if the wrapper ref is missing (defensive
  // for any pre-6d.4 cached HTML).
  if (btnAccountChangePasswordRow) {
    const collapseEl = acctChangePasswordCollapse || accountChangePasswordForm;
    btnAccountChangePasswordRow.addEventListener('click', () => {
      if (!collapseEl) return;
      const open = !collapseEl.classList.contains('open');
      collapseEl.classList.toggle('open', open);
      btnAccountChangePasswordRow.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && accountCurrentPassword) {
        setTimeout(() => accountCurrentPassword.focus(), 290);
      }
      haptic(4);
    });
  }

  if (btnAccountChangePassword) {
    btnAccountChangePassword.addEventListener('click', handleChangePassword);
  }
  if (btnAccountDelete) {
    btnAccountDelete.addEventListener('click', handleDeleteAccount);
  }
  [accountCurrentPassword, accountNewPassword].forEach(inp => {
    if (!inp) return;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); handleChangePassword(); }
    });
  });

  // Phase 6a — Account Settings sub-sheet wiring.
  if (btnAccountSettingsEntry) {
    btnAccountSettingsEntry.addEventListener('click', () => {
      haptic();
      openAcctSettingsSheet();
    });
  }
  document.querySelectorAll('[data-acct-settings-close]').forEach(el => {
    el.addEventListener('click', closeAcctSettingsSheet);
  });

  // Phase 6b — About + Help entries + sheet close attributes + FAQ
  // accordion. Accordion is a pure class toggle; CSS handles the
  // max-height transition and chevron rotation.
  if (btnAccountAboutEntry) {
    btnAccountAboutEntry.addEventListener('click', () => { haptic(); openAboutSheet(); });
  }
  if (btnAccountHelpEntry) {
    btnAccountHelpEntry.addEventListener('click', () => { haptic(); openHelpSheet(); });
  }
  document.querySelectorAll('[data-about-close]').forEach(el => {
    el.addEventListener('click', closeAboutSheet);
  });
  document.querySelectorAll('[data-help-close]').forEach(el => {
    el.addEventListener('click', closeHelpSheet);
  });

  // Phase 6d.2 — swipe-down dismiss for all three sub-sheets, matching
  // the parent settings/calendar/account sheet behavior. The X close
  // buttons were removed in favor of this gesture (matches Eugene's
  // expectation that all overlays in the app drag down to close).
  // scrollTarget is each sheet's inner body so the drag only engages
  // when the user is at the top of the scroll area.
  if (acctSettingsSheetCard) {
    const body = acctSettingsSheetCard.querySelector('.acct-settings-sheet-body');
    attachSheetDragToClose(acctSettingsSheetCard, closeAcctSettingsSheet, body);
  }
  if (aboutSheetCard) {
    const body = aboutSheetCard.querySelector('.about-sheet-body');
    attachSheetDragToClose(aboutSheetCard, closeAboutSheet, body);
  }
  if (helpSheetCard) {
    const body = helpSheetCard.querySelector('.help-sheet-body');
    attachSheetDragToClose(helpSheetCard, closeHelpSheet, body);
  }

  // Phase 6d.3 — legal popup wiring. One delegated click handler at the
  // document level catches every [data-legal] anchor (current + future)
  // and routes to openLegal(). [data-legal-close] handles backdrop tap.
  // ESC closes from anywhere. Drag-to-close on the sheet itself.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[data-legal]');
    if (a) {
      const kind = a.dataset.legal;
      if (kind === 'privacy' || kind === 'terms') {
        e.preventDefault();
        openLegal(kind);
      }
      return;
    }
    if (e.target.closest && e.target.closest('[data-legal-close]')) {
      closeLegal();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && legalModal && legalModal.classList.contains('visible')) {
      closeLegal();
    }
  });
  if (legalModalSheet) {
    attachSheetDragToClose(legalModalSheet, closeLegal, legalModalContent);
  }
  // Phase 6d.5: FAQ accordion (single-open behavior matching the
  // redesign — opening one auto-closes any other open). Selectors
  // updated to .help-faq-item / .help-faq-q. Plus a live substring
  // search filter that matches against question + answer text.
  const helpFaqItems = document.querySelectorAll('.help-faq-item');
  helpFaqItems.forEach(item => {
    const q = item.querySelector('.help-faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      // Close all others (single-open accordion).
      helpFaqItems.forEach(other => {
        if (other !== item) {
          other.classList.remove('open');
          const oq = other.querySelector('.help-faq-q');
          if (oq) oq.setAttribute('aria-expanded', 'false');
        }
      });
      item.classList.toggle('open', !wasOpen);
      q.setAttribute('aria-expanded', !wasOpen ? 'true' : 'false');
      haptic(4);
    });
  });
  const helpFaqSearchInput = document.getElementById('helpFaqSearchInput');
  const helpFaqEmpty       = document.getElementById('helpFaqEmpty');
  if (helpFaqSearchInput) {
    helpFaqSearchInput.addEventListener('input', () => {
      const query = helpFaqSearchInput.value.trim().toLowerCase();
      let visible = 0;
      helpFaqItems.forEach(item => {
        const qText = (item.querySelector('.help-faq-q-text')?.textContent || '').toLowerCase();
        const aText = (item.querySelector('.help-faq-a-pad')?.textContent || '').toLowerCase();
        const match = !query || qText.includes(query) || aText.includes(query);
        item.hidden = !match;
        if (match) visible++;
      });
      if (helpFaqEmpty) helpFaqEmpty.hidden = visible !== 0;
    });
  }
  // Phase 6c — Email change/add. The Изменить / Добавить button toggles
  // an inline form (matching the change-password disclosure pattern).
  // Submit calls /api/auth/email/change with the new email + current
  // password; on success refreshMeAndApply re-renders the row and the
  // populate-on-open handler closes the form.
  if (btnAcctSettingsEditEmail && acctSettingsEmailEditForm) {
    btnAcctSettingsEditEmail.addEventListener('click', () => {
      const open = !acctSettingsEmailEditForm.classList.contains('open');
      acctSettingsEmailEditForm.classList.toggle('open', open);
      if (open) {
        // Pre-fill so users editing only fix typos.
        if (acctSettingsEmailInput) {
          acctSettingsEmailInput.value = (_hmcCurrentUser && _hmcCurrentUser.email) || '';
        }
        if (acctSettingsEmailEditPw) acctSettingsEmailEditPw.value = '';
        setTimeout(() => acctSettingsEmailInput && acctSettingsEmailInput.focus(), 220);
        // Phase 6d.4: relabel button to a clear collapse cue while
        // the form is open. Restored to Изменить/Добавить on close
        // (handled by populate or here below).
        btnAcctSettingsEditEmail.textContent = 'Свернуть';
      } else {
        const hasEmail = !!(_hmcCurrentUser && _hmcCurrentUser.email);
        btnAcctSettingsEditEmail.textContent = hasEmail ? 'Изменить' : 'Добавить';
      }
      setAcctSettingsError('');
      haptic(4);
    });
  }
  // Phase 6d.4: explicit Cancel button inside the email-edit form.
  // Closes the form without submitting; populate handler resets the
  // edit-button label on the next user-state refresh.
  if (btnAcctSettingsEmailCancel && acctSettingsEmailEditForm) {
    btnAcctSettingsEmailCancel.addEventListener('click', () => {
      acctSettingsEmailEditForm.classList.remove('open');
      setAcctSettingsError('');
      const hasEmail = !!(_hmcCurrentUser && _hmcCurrentUser.email);
      if (btnAcctSettingsEditEmail) {
        btnAcctSettingsEditEmail.textContent = hasEmail ? 'Изменить' : 'Добавить';
      }
      haptic(4);
    });
  }
  if (btnAcctSettingsEmailSave) {
    btnAcctSettingsEmailSave.addEventListener('click', async () => {
      if (!acctSettingsEmailInput || !acctSettingsEmailEditPw) return;
      const email = acctSettingsEmailInput.value.trim();
      const pw    = acctSettingsEmailEditPw.value;
      if (!email || !email.includes('@') || !email.includes('.')) {
        setAcctSettingsError('Введите корректный email');
        return;
      }
      if (!pw) {
        setAcctSettingsError('Введите текущий пароль');
        return;
      }
      btnAcctSettingsEmailSave.disabled = true;
      setAcctSettingsError('');
      try {
        const res = await fetch('/api/auth/email/change', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, current_password: pw }),
        });
        if (res.ok) {
          if (typeof refreshMeAndApply === 'function') await refreshMeAndApply();
          haptic([8, 30, 8]);
          showInfo({
            title: 'Email сохранён',
            body:  'Подтвердите его — мы отправили ссылку на ' + email + '.',
            confirmText: 'Хорошо',
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><polyline points="5 12 10 17 19 7"/></svg>',
            dismissMs: 2400,
          });
        } else if (res.status === 401) {
          setAcctSettingsError('Неверный текущий пароль');
        } else if (res.status === 409) {
          setAcctSettingsError('Этот email уже используется');
        } else if (res.status === 422) {
          setAcctSettingsError('Некорректный email');
        } else if (res.status === 429) {
          setAcctSettingsError('Слишком часто — попробуйте позже');
        } else {
          setAcctSettingsError('Не удалось сохранить email');
        }
      } catch {
        setAcctSettingsError('Сетевая ошибка');
      } finally {
        btnAcctSettingsEmailSave.disabled = false;
      }
    });
  }

  if (btnAcctSettingsConfirmEmail) {
    btnAcctSettingsConfirmEmail.addEventListener('click', async () => {
      if (btnAcctSettingsConfirmEmail.disabled) return;
      btnAcctSettingsConfirmEmail.disabled = true;
      const orig = btnAcctSettingsConfirmEmail.textContent;
      btnAcctSettingsConfirmEmail.textContent = 'Отправляем…';
      setAcctSettingsError('');
      try {
        const res = await fetch('/api/auth/email/request-confirmation', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (res.ok) {
          btnAcctSettingsConfirmEmail.textContent = 'Отправлено';
        } else if (res.status === 429) {
          setAcctSettingsError('Слишком часто — попробуйте позже');
          btnAcctSettingsConfirmEmail.textContent = orig;
        } else if (res.status === 400) {
          // Already verified or no email — refresh state so the row
          // updates (verified pill / hide button).
          btnAcctSettingsConfirmEmail.textContent = orig;
          if (typeof refreshMeAndApply === 'function') await refreshMeAndApply();
        } else {
          setAcctSettingsError('Не получилось');
          btnAcctSettingsConfirmEmail.textContent = orig;
        }
      } catch {
        setAcctSettingsError('Сетевая ошибка');
        btnAcctSettingsConfirmEmail.textContent = orig;
      }
      setTimeout(() => {
        btnAcctSettingsConfirmEmail.disabled = false;
        if (btnAcctSettingsConfirmEmail.textContent === 'Отправлено') {
          btnAcctSettingsConfirmEmail.textContent = orig;
        }
      }, 4000);
    });
  }

  // Gender pill — radio-style.
  document.querySelectorAll('.account-gender-seg').forEach(btn => {
    btn.addEventListener('click', () => {
      _accountSelectedGender = btn.dataset.gender || null;
      paintAccountSegSelections();
      recomputeAccountDirty();
      haptic(4);
    });
  });
  // Activity icon-tiles — radio-style.
  document.querySelectorAll('.account-activity-tile').forEach(btn => {
    btn.addEventListener('click', () => {
      _accountSelectedActivity = btn.dataset.activity || null;
      paintAccountSegSelections();
      recomputeAccountDirty();
      haptic(4);
    });
  });

  // Theme picker — neumorphic swatch tiles inside the Advanced theme
  // drawer disclosure. Tapping a swatch swaps the theme via setTheme;
  // registered @property color tokens then interpolate smoothly
  // across the whole UI. The disclosure-sub label also updates so
  // the user can see the active theme name without expanding.
  const THEME_LABELS_RU = { warm: 'Очаг', verdant: 'Свеча', light: 'Лён', dark: 'Уголь' };
  const themeOpts = document.querySelectorAll('.account-theme-opt');
  function syncActiveLine() {
    const cur = (typeof getTheme === 'function') ? getTheme() : 'warm';
    themeOpts.forEach(opt => {
      opt.setAttribute('aria-checked', opt.dataset.themeName === cur ? 'true' : 'false');
    });
    if (accountThemeLabel) accountThemeLabel.textContent = THEME_LABELS_RU[cur] || '—';
  }
  themeOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      const name = opt.dataset.themeName;
      if (!name || typeof setTheme !== 'function') return;
      setTheme(name);
      haptic(6);
    });
  });
  window.addEventListener('hmc:theme-changed', syncActiveLine);
  syncActiveLine();

  // Theme drawer disclosure — toggles the swatch grid open/closed.
  if (btnAccountThemeToggle && accountThemeDrawer) {
    btnAccountThemeToggle.addEventListener('click', () => {
      const open = accountThemeDrawer.classList.toggle('open');
      btnAccountThemeToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      haptic(4);
    });
  }

  // Identity hero name — mirrors the display-name input as the user
  // types so the hero stays in sync. Empty input → fallback to '—'.
  if (accountDisplayName && accountIdentityName) {
    const syncIdentityName = () => {
      const v = accountDisplayName.value.trim();
      accountIdentityName.textContent = v || '—';
    };
    accountDisplayName.addEventListener('input', syncIdentityName);
    // Also sync on form populate; populateAccountForm sets the input
    // value but doesn't fire 'input', so we run sync there too via
    // the initial syncIdentityName below.
    syncIdentityName();
  }

  // Display name — input event tracks dirty state per keystroke.
  if (accountDisplayName) {
    accountDisplayName.addEventListener('input', () => recomputeAccountDirty());
    accountDisplayName.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyAccountFromInputs(); }
    });
  }

  // Drag-to-close on the account sheet — always closes (drag-down is
  // an explicit "leave this view" gesture; if the user has unsaved
  // changes they'll lose them, which is the expected meaning of an
  // explicit dismissal).
  const accountContent = accountSheet.querySelector('.account-sheet-content');
  if (accountContent) {
    // Pass the inner .account-scroll as the scroll target — the sheet
    // can only be drag-closed when that inner scroller is at scrollTop:0.
    // Without this, dragging up to scroll back to the top would also
    // dismiss the sheet (the user's "can't reach the top" complaint).
    // Account-specific thresholds (110px / 0.65 px-per-ms) make the
    // sheet "playful" — small drags spring back, only deliberate
    // commits close. Settings + calendar keep the original 80 / 0.45.
    const accountScroll = accountSheet.querySelector('.account-scroll');
    attachSheetDragToClose(accountContent, closeAccount, accountScroll, {
      commitPx: 110,
      commitVelocity: 0.65,
    });
  }

  // Delete-account modal wiring.
  if (btnDeleteModalCancel)  btnDeleteModalCancel.addEventListener('click', closeDeleteModal);
  if (btnDeleteModalConfirm) btnDeleteModalConfirm.addEventListener('click', confirmAccountDelete);
  if (deleteModalBackdrop)   deleteModalBackdrop.addEventListener('click', closeDeleteModal);
  if (deletePassword) {
    deletePassword.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmAccountDelete(); }
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && deleteModal && deleteModal.classList.contains('open')) {
      e.stopPropagation();
      closeDeleteModal();
    }
  }, true);  // capture phase so this fires BEFORE the account sheet's Esc handler

  // Escape closes (revert via cancel-changes if there are pending edits).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && accountSheet.classList.contains('open')) {
      const content = accountSheet.querySelector('.account-sheet-content');
      if (content && content.classList.contains('has-changes')) {
        cancelAccountChanges();
      } else {
        closeAccount();
      }
    }
  });
}

function setupSettings() {
  if (!btnOpenSettings || !settingsSheet) return;
  btnOpenSettings.addEventListener('click', () => { haptic(); openSettings(); });
  if (settingsBackdrop)  settingsBackdrop.addEventListener('click', closeSettings);
  if (btnSettingsCancel) btnSettingsCancel.addEventListener('click', closeSettings);
  if (btnSettingsSubmit) btnSettingsSubmit.addEventListener('click', applySettingsFromInputs);

  // Drag-to-close — same pattern as the account sheet.
  const settingsContent = settingsSheet.querySelector('.settings-sheet-content');
  if (settingsContent) attachSheetDragToClose(settingsContent, closeSettings);
  // Pre-build wheels at boot so first-open of the settings sheet
  // doesn't pay the cell-population DOM cost during its slide-up.
  ensureSettingsWheels();
  // Escape closes the sheet (only when actually open — don't steal Escape
  // from other modals or the global error overlay).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && settingsSheet.classList.contains('open')) {
      closeSettings();
    }
  });
}

// ── Report overlay (Phase B) ─────────────────────────────────
// Open / close the hovering report tile. Three exits in this phase:
//   • Top-right X      → closeReportOverlay
//   • Bottom-right X   → closeReportOverlay
//   • Backdrop tap     → closeReportOverlay
// All three currently behave the same (close → return to scanner tab,
// no consumed-flag commit). Phase C will add swipe gestures that
// commit the consumed flag in one motion.

// Two modes:
//   • 'fresh'  → just-analyzed scan. X buttons hidden; swipe required to
//                close + commit choice (right=eat, left=skip). The eager-
//                save already wrote consumed=false, so a left swipe is a
//                no-op commit; a right swipe promotes to consumed=true.
//   • 'review' → re-view from recents/history. X buttons visible; swipe
//                disabled. The entry's consumed flag is already decided.
function openReportOverlay(mode) {
  if (!reportOverlay) return;
  reportOverlay.dataset.mode = mode === 'review' ? 'review' : 'fresh';
  if (reportScroll) reportScroll.scrollTop = 0;
  // Clear any prior swipe transform so a re-open isn't pre-shifted
  if (reportContent) {
    reportContent.style.transform = '';
    reportContent.style.transition = '';
    reportContent.style.boxShadow = '';
  }
  reportOverlay.classList.add('open');
  reportOverlay.setAttribute('aria-hidden', 'false');
  appShell.classList.add('context-report');
  // Phase 3 stacking discipline (see LIQUID GLASS section in app.css).
  appShell.classList.add('overlay-active');
}

function closeReportOverlay() {
  if (!reportOverlay) return;
  reportOverlay.classList.remove('open');
  reportOverlay.setAttribute('aria-hidden', 'true');
  appShell.classList.remove('context-report');
  appShell.classList.remove('overlay-active');
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
}

// ── Swipe-to-choose (stable rewrite) ─────────────────────────
// Design:
//   • Active only when overlay is in fresh mode.
//   • One source of truth for position: `lastX` from the most recent
//     successful pointermove. Pointer up/cancel events have unreliable
//     clientX on some browsers (Android Chrome touch quirks, pointer-
//     cancel from system gestures), which previously caused direction
//     mis-reads — a slight right-move could end up reading as left.
//   • No velocity shortcut. v1 commits purely on distance: 70px past
//     start, in either direction. Predictable and impossible to flip.
//   • pointercancel ALWAYS snaps back. Cancellation = "we can't trust
//     the intent here" → never commit on cancel.
//   • Direction lock at 8px+ with a 1.2× ratio prevents diagonal pans
//     from being mis-claimed as horizontal.

const SWIPE_THRESHOLD_PX = 70;        // distance past start to commit
const SWIPE_LOCK_PX      = 8;         // movement before direction is decided
const SWIPE_AXIS_RATIO   = 1.2;       // horizontal beats vertical by this much

let _swipeState = null;

function onSwipePointerDown(e) {
  if (!reportOverlay || reportOverlay.dataset.mode !== 'fresh') return;
  if (!reportOverlay.classList.contains('open')) return;
  // Only exclude actual interactive controls. Photo / items / analysis
  // / empty space are all valid swipe-start zones.
  if (e.target.closest('button, input')) return;
  _swipeState = {
    pointerId: e.pointerId,
    startX:    e.clientX,
    startY:    e.clientY,
    lastX:     e.clientX,
    direction: null,       // 'h' | 'v' — locked once movement is decisive
  };
}

function onSwipePointerMove(e) {
  if (!_swipeState || _swipeState.pointerId !== e.pointerId) return;
  const dx = e.clientX - _swipeState.startX;
  const dy = e.clientY - _swipeState.startY;

  // Direction lock: once the user has moved more than SWIPE_LOCK_PX in
  // either axis, decide. Require a clear ratio so near-diagonal pans
  // don't snap to whichever side is barely larger.
  if (!_swipeState.direction) {
    if (Math.abs(dx) > SWIPE_LOCK_PX || Math.abs(dy) > SWIPE_LOCK_PX) {
      if (Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_RATIO) {
        _swipeState.direction = 'h';
        // Capture the pointer so events keep flowing even when the card
        // visually moves out from under the finger.
        try { reportContent.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (Math.abs(dy) > Math.abs(dx) * SWIPE_AXIS_RATIO) {
        _swipeState.direction = 'v';
      }
      // Else: still ambiguous, wait for the next move.
    }
  }

  if (_swipeState.direction !== 'h') return;

  // Once we're tracking horizontal, we own the gesture. Block native.
  e.preventDefault();
  _swipeState.lastX = e.clientX;

  // Live transform — translate, slight rotate, directional tint glow.
  const rot = dx * 0.025;
  reportContent.style.transition = 'none';
  reportContent.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
  const tint = Math.min(Math.abs(dx) / 240, 0.55);
  if (dx > 0) {
    reportContent.style.boxShadow = `0 0 80px rgba(139,158,107,${tint})`;
  } else {
    reportContent.style.boxShadow = `0 0 80px rgba(216,97,60,${tint * 0.7})`;
  }
}

function onSwipePointerUp(e) {
  if (!_swipeState || _swipeState.pointerId !== e.pointerId) return;
  const state = _swipeState;
  _swipeState = null;

  // Cancellation path (system claimed the gesture, app went background,
  // pinch detected, etc.) — never commit. Always snap back.
  if (e.type === 'pointercancel') {
    snapBackReport();
    return;
  }

  // If we never locked to horizontal, it's either a tap or a vertical
  // scroll — neither is a swipe-commit. No reset needed because we
  // didn't apply any transforms.
  if (state.direction !== 'h') return;

  // Use the cached lastX from pointermove. Pointerup events have
  // unreliable clientX on some browsers (the bug we hit before).
  const dx = state.lastX - state.startX;

  if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) {
    commitSwipe(dx > 0 ? 'right' : 'left');
  } else {
    snapBackReport();
  }
}

// Snap-back helper — used by below-threshold release AND by
// pointercancel. Single source of truth for the reset state means
// the visual reset is identical regardless of how the gesture ended.
function snapBackReport() {
  if (!reportContent) return;
  reportContent.style.transition =
    'transform .32s cubic-bezier(.34, 1.56, .64, 1), box-shadow .25s ease';
  reportContent.style.transform = '';
  reportContent.style.boxShadow = '';
}

function commitSwipe(direction) {
  // Animate the card off-screen in the swipe direction, then commit
  // the consumed flag and close the overlay.
  const off = direction === 'right' ? window.innerWidth + 80 : -window.innerWidth - 80;
  const finalRot = direction === 'right' ? 14 : -14;
  reportContent.style.transition =
    'transform .26s ease-out, opacity .22s ease, box-shadow .22s ease';
  reportContent.style.transform = `translateX(${off}px) rotate(${finalRot}deg)`;
  reportContent.style.opacity = '0';
  reportContent.style.boxShadow = '';
  haptic(direction === 'right' ? [12, 30, 8] : 8);

  setTimeout(() => {
    if (direction === 'right' && currentEntryId) {
      // Promote eager-saved entry to consumed=true. Fires
      // hmc:history-changed which cascades to all the surfaces.
      setEntryConsumed(currentEntryId, true);
      // Phase 3A: server-side mirror so the consumed promotion
      // survives a browser-data clear / cross-device.
      patchServerEntry(currentEntryId, { consumed: true });
    }
    closeReportOverlay();
    // Reset transform after the close transition starts so a future
    // open isn't pre-shifted off-screen.
    setTimeout(() => {
      reportContent.style.transition = '';
      reportContent.style.transform = '';
      reportContent.style.opacity = '';
    }, 100);
  }, 260);
}

function setupReportOverlay() {
  if (!reportOverlay) return;
  // New review-mode close bars (top + bottom of the card, ~40px tall,
  // tap anywhere on them to close).
  if (btnReportCloseBarTop)    btnReportCloseBarTop.addEventListener('click', () => { haptic(6); closeReportOverlay(); });
  if (btnReportCloseBarBottom) btnReportCloseBarBottom.addEventListener('click', () => { haptic(6); closeReportOverlay(); });
  // Legacy hidden close buttons — kept for safety so the old click
  // path still works if anything relied on them. Phase D will delete.
  if (btnReportCloseTop)    btnReportCloseTop.addEventListener('click', () => { haptic(6); closeReportOverlay(); });
  if (btnReportCloseBottom) btnReportCloseBottom.addEventListener('click', () => { haptic(6); closeReportOverlay(); });
  if (reportOverlayBackdrop) {
    reportOverlayBackdrop.addEventListener('click', () => { haptic(4); closeReportOverlay(); });
  }
  // Swipe handlers — only commit when in fresh mode (gated inside the
  // handlers themselves so this scaffold is mode-aware).
  if (reportContent) {
    reportContent.addEventListener('pointerdown', onSwipePointerDown);
    reportContent.addEventListener('pointermove', onSwipePointerMove);
    reportContent.addEventListener('pointerup', onSwipePointerUp);
    reportContent.addEventListener('pointercancel', onSwipePointerUp);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && reportOverlay.classList.contains('open')) {
      // Escape only closes in review mode — fresh mode requires a swipe
      // commitment, matching the user-flow contract.
      if (reportOverlay.dataset.mode === 'review') closeReportOverlay();
    }
  });
}

// Compute a content hash so we know when to invalidate the cached verdict
// (entry added/removed/edited, water changed). Cheap deterministic hash —
// just a stable string of ids + calories + water — no need for a real hash.
function dayContentHash(entries, waterMl) {
  return entries.map(e => `${e.id}:${e.totalCalories}:${e.consumed === false ? 0 : 1}`).join('|') + `|w${waterMl}`;
}

// Lazy-fetch the LLM verdict for a given date. Cached locally per date;
// re-fetches only if the cache is missing or its hash doesn't match the
// current day content. Updates the calendar grid + day-detail panel in
// place when the response arrives.
const inflightDayQuality = new Set();

async function requestDayQuality(dateKey, entries, waterMl) {
  if (inflightDayQuality.has(dateKey)) return null;

  const hash = dayContentHash(entries, waterMl);
  const cached = getCachedQuality(dateKey);
  if (cached && cached.hash === hash) return cached;

  // Build agent payload
  const items = [];
  entries.forEach(e => {
    const arr = (e.result && e.result.items) || [];
    arr.forEach(it => {
      items.push({
        name:            it.name || 'Блюдо',
        calories:        it.calories || 0,
        protein_g:       it.protein_g || 0,
        fat_g:           it.fat_g || 0,
        carbs_g:         it.carbs_g || 0,
        estimated_grams: it.estimated_grams || 0,
      });
    });
  });
  if (!items.length) return null;

  inflightDayQuality.add(dateKey);
  try {
    const verdict = await fetchDayQuality({
      date: dateKey,
      items,
      water_ml: waterMl,
      target_calories: getSetting('daily_kcal'),
    });
    setCachedQuality(dateKey, { ...verdict, hash });

    // Update visible calendar cells if the sheet is still open + showing
    // the relevant month.
    const cell = calendarGrid && calendarGrid.querySelector(`.cal-day[data-date="${dateKey}"]`);
    if (cell) {
      cell.classList.remove('q-good', 'q-ok', 'q-bad');
      const cls = verdict.color === 'green'  ? 'q-good'
                : verdict.color === 'yellow' ? 'q-ok'
                : verdict.color === 'orange' || verdict.color === 'red' ? 'q-bad' : '';
      if (cls) cell.classList.add(cls);
    }

    // If this day is currently selected, refresh the detail panel
    if (calendarSelectedKey === dateKey && !calendarDayDetail.hidden) {
      calendarDayTip.textContent = verdict.tip || verdict.summary || '';
    }

    return verdict;
  } catch (err) {
    // Silent — calendar stays on its heuristic color, no user-facing error
    return null;
  } finally {
    inflightDayQuality.delete(dateKey);
  }
}


// ══════════════════════════════════════════════
// INIT — MUST BE THE LAST THING IN THE FILE
// All `const` declarations above need to have executed before any setup*
// function references them (otherwise we hit Temporal Dead Zone errors
// that silently break the whole script). Keep this block at the bottom.
//
// Each step is wrapped in try/catch so one bad function can't silently
// kill every later setup. Errors are logged + surfaced via a small
// debug toast so they're visible on the user's device, not buried in
// DevTools the user might not be looking at.
// ══════════════════════════════════════════════

function showInitError(stepName, err) {
  console.error(`[init] ${stepName} failed:`, err);
  // Build a small floating toast so the user can see what's broken without
  // opening DevTools. Auto-dismisses after 8s, click to dismiss sooner.
  try {
    let toast = document.getElementById('hmcInitErrorToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'hmcInitErrorToast';
      toast.style.cssText = 'position:fixed;bottom:80px;left:12px;right:12px;z-index:9999;padding:10px 14px;background:rgba(216,97,60,.18);border:1px solid rgba(216,97,60,.4);border-radius:10px;font:12px/1.4 -apple-system,sans-serif;color:#F1E9D2;backdrop-filter:blur(8px);';
      toast.addEventListener('click', () => toast.remove());
      document.body.appendChild(toast);
    }
    const line = document.createElement('div');
    line.textContent = `${stepName}: ${err && err.message ? err.message : err}`;
    toast.appendChild(line);
    setTimeout(() => { try { toast.remove(); } catch {} }, 8000);
  } catch {}
}

function safeRun(stepName, fn) {
  try { fn(); }
  catch (err) { showInitError(stepName, err); }
}

// Surface uncaught errors AND unhandled promise rejections from anywhere
// in the script — clicks, async fetches, etc. Without this, an iOS Safari
// runtime error in any handler is invisible unless the user is in DevTools.
window.addEventListener('error', e => {
  showInitError('runtime', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  showInitError('async', e.reason);
});

// Phase 3: low-power detection. Adds <html class="glass-lite"> on
// devices that would struggle with backdrop-filter, OR when the user
// has asked the OS to reduce transparency / motion. The .glass-lite
// rule swaps every glass surface to opaque-tinted with no blur. Done
// before render so first paint already matches the chosen tier.
safeRun('applyGlassLite', () => {
  const reduceTransparency = window.matchMedia &&
    window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lowMemory = typeof navigator.deviceMemory === 'number' &&
                    navigator.deviceMemory < 4;
  const fewCores  = typeof navigator.hardwareConcurrency === 'number' &&
                    navigator.hardwareConcurrency < 4;
  if (reduceTransparency || reduceMotion || lowMemory || fewCores) {
    document.documentElement.classList.add('glass-lite');
  }
});

// Theme must apply before any rendering so the first paint matches the
// user's stored preference. Default <html data-theme="warm"> in HTML
// means warm users see no flash; only users on a non-default palette
// experience a brief warm→theirs swap.
safeRun('applyStoredTheme',     () => applyStoredTheme());

// Position the bottom-nav ink slide under the initial active button.
// Deferred via rAF so layout has settled (font load + flex sizing).
safeRun('positionNavInk', () => {
  requestAnimationFrame(() => requestAnimationFrame(positionNavInk));
});

// Reconciliation: the boot path also fires syncSettingsFromServer()
// asynchronously below. If the server has a different theme stored
// (multi-device case — user picked dark on phone, opens laptop), the
// pulled settings dispatch hmc:settings-changed and we re-apply.
// applyStoredTheme is idempotent so this is a no-op when local already
// matches the server. No View Transition wrapping here — boot
// reconciliation should be silent, not animated.
safeRun('themeReconcileListener', () => {
  window.addEventListener('hmc:settings-changed', () => applyStoredTheme());
});

safeRun('renderDayHero',        () => renderDayHero());
safeRun('renderRecent',         () => renderRecent());
safeRun('renderWaterTile',      () => renderWaterTile());
safeRun('setupWaterTile',       () => setupWaterTile());
safeRun('setupAnalyzingOverlayCancel', () => setupAnalyzingOverlayCancel());
safeRun('setupCalendar',        () => setupCalendar());
safeRun('setupSettings',        () => setupSettings());
safeRun('setupAccount',         () => setupAccount());
safeRun('setupReportOverlay',   () => setupReportOverlay());
safeRun('initShutterEntrance',  () => initShutterEntrance());
safeRun('setupItemEditing',     () => setupItemEditing());
safeRun('setupAddSheet',        () => setupAddSheet());
safeRun('setupValidation',      () => setupValidation());
safeRun('setupAnalysisCard',    () => setupAnalysisCard());

// "Все →" link in the recent-section header switches to the history view.
safeRun('btnViewAllHistory wire', () => {
  const btnViewAllHistory = $('btnViewAllHistory');
  if (btnViewAllHistory) {
    btnViewAllHistory.addEventListener('click', () => switchView('history'));
  }
});

// Phase 10 + Phase 3: session-expired-while-away guard, also
// doubling as the boot-time read of /api/auth/me that tells the
// guest UI which header chrome to render. Single fetch, dual purpose:
// 401 → kick to /login; 200 → set body[data-user-role] and paint
// the guest scan counter when applicable.
//
// Why 401-handling matters even after the server-side / route gate:
// the browser may serve a cached HTML page whose cookie's session has
// since expired server-side. Without this, the user sees a stale app
// whose background syncs silently 401. The /me probe surfaces it
// immediately.
safeRun('sessionGuardAndGuestUI', async () => {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      window.location.replace('/login');
      return;
    }
    if (res.ok) {
      const user = await res.json();
      applyGuestUIState(user);
    }
  } catch { /* network glitch — let the user see whatever cache holds */ }
});

// ── Phase 3: guest UI state (header swap + scan counter) ───────────
// applyGuestUIState writes `data-user-role` on <body> so CSS can
// toggle which header-actions block is visible (gear/calendar/account
// for users; counter + Создать-аккаунт for guests). For guests we
// also paint the dot counter from `user.scan_count` (the /api/auth/me
// handler now stuffs lifetime scan count into that field).

// Cached snapshot of /api/auth/me — used by the upgrade sheet to
// pre-fill the username field with the current guest_xxx value, and
// by the email-pending banner (3.5c) to read email_verified.
let _hmcCurrentUser = null;

function applyGuestUIState(user) {
  if (!user) return;
  // Stash for later use (upgrade sheet pre-fills username from this).
  _hmcCurrentUser = user;
  document.body.dataset.userRole = user.role || 'user';
  if (user.role === 'guest') {
    paintGuestCounter(user.scan_count || 0);
  }
  applyEmailPendingBanner(user);
}

// Phase 3.5c: email-pending banner.
// Shown ONLY when role='user' (not admin/guest), email is set, and
// it's not yet verified. Admins are exempt — they're seeded without
// emails. Guests don't have email yet by definition.
function applyEmailPendingBanner(user) {
  const banner = document.getElementById('emailPendingBanner');
  if (!banner) return;
  const show = !!(
    user &&
    user.role === 'user' &&
    user.email &&
    !user.email_verified
  );
  banner.classList.toggle('visible', show);
}

function paintGuestCounter(usedCount) {
  const counter = document.getElementById('guestCounter');
  const btn     = document.getElementById('btnGuestUpgrade');
  if (!counter) return;
  const cap = 5;
  const used = Math.min(Math.max(usedCount | 0, 0), cap);
  counter.querySelectorAll('.guest-counter-dot').forEach((dot, i) => {
    dot.classList.toggle('used', i < used);
  });
  counter.classList.toggle('full', used >= cap);
  if (btn) btn.classList.toggle('urgent', used >= cap);
}

// "Создать аккаунт" click handler. Opens the upgrade sheet (defined
// below). The sheet's submit hits POST /api/auth/upgrade-guest; on
// success the user_id stays the same and applyGuestUIState() rebinds
// the page to user-mode header chrome.
safeRun('guestUpgradeBtn wire', () => {
  const btn = document.getElementById('btnGuestUpgrade');
  if (!btn) return;
  btn.addEventListener('click', () => openUpgradeSheet());
});

// ── Phase 3.5b: upgrade sheet ─────────────────────────────────────

function openUpgradeSheet() {
  const sheet = document.getElementById('upgradeSheet');
  if (!sheet) return;

  // Pre-fill username from the cached /me payload — guest_xxx by
  // default. Only fill if the field is empty so we don't clobber a
  // user-typed value when they reopen after a validation error.
  const usernameInput = document.getElementById('upgradeUsername');
  if (usernameInput && !usernameInput.value && _hmcCurrentUser && _hmcCurrentUser.username) {
    usernameInput.value = _hmcCurrentUser.username;
  }
  // Clear any prior error from a previous attempt.
  const errEl = document.getElementById('upgradeError');
  if (errEl) {
    errEl.classList.remove('visible');
    errEl.textContent = '';
  }
  upgradeCheckReady();

  sheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => sheet.classList.add('visible'));
  document.documentElement.classList.add('upgrade-sheet-open');
}
function closeUpgradeSheet() {
  const sheet = document.getElementById('upgradeSheet');
  if (!sheet) return;
  sheet.classList.remove('visible');
  document.documentElement.classList.remove('upgrade-sheet-open');
  setTimeout(() => sheet.setAttribute('aria-hidden', 'true'), 400);
}
window.openUpgradeSheet  = openUpgradeSheet;
window.closeUpgradeSheet = closeUpgradeSheet;

function upgradeCheckReady() {
  const form = document.getElementById('upgradeForm');
  if (!form) return;
  const u  = document.getElementById('upgradeUsername');
  const e  = document.getElementById('upgradeEmail');
  const p  = document.getElementById('upgradePassword');
  const pc = document.getElementById('upgradePasswordConfirm');
  const c  = document.getElementById('upgradeConsent');
  const usernameOk = u && /^[A-Za-z0-9]{1,32}$/.test(u.value.trim());
  const emailOk    = e && e.value.trim().length >= 3 && e.value.includes('@') && e.value.includes('.');
  const passOk     = p && p.value.length >= 4;
  const matchOk    = p && pc && p.value === pc.value && pc.value.length >= 4;
  const consentOk  = c && c.checked;
  form.classList.toggle('ready', usernameOk && emailOk && passOk && matchOk && consentOk);
}

function showUpgradeError(msg) {
  const el = document.getElementById('upgradeError');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}
function clearUpgradeError() {
  const el = document.getElementById('upgradeError');
  if (!el) return;
  el.classList.remove('visible');
  setTimeout(() => { if (!el.classList.contains('visible')) el.textContent = ''; }, 220);
}

// Map known server error strings to friendly Russian. Server messages
// are already mostly Russian but we want a single fallback phrase for
// anything we don't expect.
const UPGRADE_ERROR_MAP = {
  'Только гостевые аккаунты можно регистрировать':
    'Только гостевые аккаунты можно регистрировать',
  'Согласие на обработку персональных данных обязательно':
    'Подтвердите согласие на обработку персональных данных',
  'Это имя уже занято':              'Это имя уже занято',
  'Этот email уже используется':     'Этот email уже используется',
  'Это имя или email уже используется': 'Это имя или email уже используется',
  'Этот аккаунт уже зарегистрирован':   'Аккаунт уже зарегистрирован',
  'Неверный формат email':              'Неверный формат email',
  'Это имя зарезервировано':            'Это имя зарезервировано',
  'Username must be 1-32 letters or digits (no symbols, no spaces)':
    'Имя: 1–32 символа, только буквы и цифры',
  'Password must be at least 4 characters':
    'Пароль должен быть минимум 4 символа',
};
function localizeUpgradeError(detail) {
  if (typeof detail === 'string' && UPGRADE_ERROR_MAP[detail]) return UPGRADE_ERROR_MAP[detail];
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    return (first && (first.msg || first.message)) || 'Проверьте данные и попробуйте снова';
  }
  return 'Что-то пошло не так. Попробуйте снова.';
}

safeRun('upgradeSheet wire', () => {
  const sheet = document.getElementById('upgradeSheet');
  const form  = document.getElementById('upgradeForm');
  if (!sheet || !form) return;

  // Close handlers — backdrop tap, ✕ button, ESC.
  sheet.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-upgrade-close]')) {
      closeUpgradeSheet();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('visible')) {
      closeUpgradeSheet();
    }
  });

  // Readiness gating — recompute on any input/checkbox change.
  ['upgradeUsername','upgradeEmail','upgradePassword','upgradePasswordConfirm']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', upgradeCheckReady);
    });
  const consent = document.getElementById('upgradeConsent');
  if (consent) consent.addEventListener('change', upgradeCheckReady);

  // Submit handler.
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearUpgradeError();

    const username = document.getElementById('upgradeUsername').value.trim();
    const email    = document.getElementById('upgradeEmail').value.trim();
    const password = document.getElementById('upgradePassword').value;
    const confirm  = document.getElementById('upgradePasswordConfirm').value;
    const consentChecked = document.getElementById('upgradeConsent').checked;

    if (!/^[A-Za-z0-9]{1,32}$/.test(username)) {
      showUpgradeError('Имя: 1–32 символа, только буквы и цифры');
      return;
    }
    if (!email.includes('@') || !email.includes('.')) {
      showUpgradeError('Неверный формат email');
      return;
    }
    if (password.length < 4) {
      showUpgradeError('Пароль должен быть минимум 4 символа');
      return;
    }
    if (password !== confirm) {
      showUpgradeError('Пароли не совпадают');
      return;
    }
    if (!consentChecked) {
      const label = consent && consent.closest('.upgrade-consent');
      if (label) {
        label.classList.remove('nudge');
        void label.offsetWidth;
        label.classList.add('nudge');
      }
      showUpgradeError('Подтвердите согласие на обработку персональных данных');
      return;
    }

    const submitBtn = document.getElementById('upgradeSubmit');
    busy = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');
    }

    try {
      const res = await fetch('/api/auth/upgrade-guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password, consent: true }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON */ }
        showUpgradeError(localizeUpgradeError(body.detail));
        busy = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
        }
        return;
      }
      const data = await res.json();
      // Success — apply the new user state. body[data-user-role] flips
      // to 'user', the guest counter + upgrade button vanish, the
      // gear/calendar/account icons reappear.
      _hmcCurrentUser = data.user || _hmcCurrentUser;
      if (data.user) applyGuestUIState(data.user);
      closeUpgradeSheet();
      // Light celebratory haptic (existing helper) + small alert.
      // A proper toast lands in 3.5c with the email-pending banner.
      if (typeof haptic === 'function') haptic(12);
      // Nudge the user toward checking email if they want to confirm now.
      // Banner from 3.5c will become the persistent indicator.
      setTimeout(() => {
        // Soft success cue. Native alert is placeholder; 3.5c banner
        // is the polished version.
        if (data.user && data.user.email && !data.user.email_verified) {
          // Don't alert spam — just update internal state. The
          // forthcoming banner is the user-visible cue.
        }
      }, 0);
    } catch (err) {
      showUpgradeError('Сетевая ошибка. Проверьте подключение.');
      busy = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
      }
    }
  });

  // Initial readiness pass (in case browser autofill populated fields).
  upgradeCheckReady();
});


// ── Phase 3.5c: email-pending banner — resend + verified handler ──

safeRun('emailPendingBanner wire', () => {
  const btn = document.getElementById('btnResendEmail');
  if (!btn) return;

  const DEFAULT_LABEL = 'Отправить заново';

  async function handleResend() {
    if (btn.disabled) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Отправляем…';
    btn.classList.remove('success');
    try {
      const res = await fetch('/api/auth/email/request-confirmation', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        btn.textContent = 'Отправлено';
        btn.classList.add('success');
      } else if (res.status === 429) {
        btn.textContent = 'Слишком часто';
      } else if (res.status === 400) {
        // Either no email set or already verified — both edge cases
        // mean the banner shouldn't be there. Refresh state and let
        // applyEmailPendingBanner hide it.
        btn.textContent = 'Уже подтверждён';
        await refreshMeAndApply();
      } else {
        btn.textContent = 'Не получилось';
      }
    } catch {
      btn.textContent = 'Сетевая ошибка';
    }
    // Restore button to default after a beat. Keep .success styling
    // for the full 4s so the user sees the confirmation, then revert.
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = DEFAULT_LABEL;
      btn.classList.remove('success');
    }, 4000);
  }
  btn.addEventListener('click', handleResend);
});

// Refetch /api/auth/me and re-apply UI state. Used by the
// ?verified=1 handler below and after the resend button hits the
// "already verified" path. Failures are silent — the banner stays in
// whatever state it was, the user can refresh manually.
async function refreshMeAndApply() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const user = await res.json();
      applyGuestUIState(user);
    }
  } catch { /* network glitch */ }
}

// Detect the ?verified=1 query string set by /api/auth/email/verify
// after a successful token consumption. Refreshes /me so the banner
// disappears, then strips the param from the URL so a hard reload
// doesn't keep re-triggering the refresh.
safeRun('verifiedParam handler', () => {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch { return; }
  if (!params.has('verified')) return;
  const verified = params.get('verified') === '1';
  // Strip the param from the visible URL.
  const cleanUrl = window.location.pathname + window.location.hash;
  try { window.history.replaceState({}, '', cleanUrl); } catch { /* file:// or sandbox */ }
  if (verified) {
    // Re-fetch /me so email_verified=1 propagates and the banner hides.
    refreshMeAndApply();
  }
});

// When the user's history changes (a scan just completed), the
// counter needs to advance. We refetch /me — the server is the source
// of truth for lifetime scan count, and the round-trip is one cheap
// query. Skip the fetch entirely for non-guests to avoid pointless
// load on every entry-list change.
window.addEventListener('hmc:history-changed', async () => {
  if (document.body.dataset.userRole !== 'guest') return;
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const user = await res.json();
      paintGuestCounter(user.scan_count || 0);
    }
  } catch { /* ignore */ }
});

// Phase 2: sync the canonical history from the server. Fire-and-forget;
// the renderers above already ran with whatever localStorage held — when
// the sync completes it overwrites localStorage and dispatches
// `hmc:history-changed`, which re-runs renderRecent/renderDayHero/etc.
// User experience: a beat after login the recent tiles + day-hero
// populate themselves with server data. No spinner needed because the
// initial paint already happened from the cached state.
safeRun('syncEntriesFromServer', () => {
  if (typeof syncEntriesFromServer === 'function') {
    syncEntriesFromServer();
  }
});

// Phase 3B: pull settings + water log from the server. Same fire-and-
// forget pattern — settings sync dispatches `hmc:settings-changed`
// which cascades to day-hero / water-tile / calendar; water sync
// dispatches `hmc:water-changed` which re-renders the water tile.
safeRun('syncSettingsFromServer', () => {
  if (typeof syncSettingsFromServer === 'function') {
    syncSettingsFromServer();
  }
});
safeRun('syncWaterLogFromServer', () => {
  if (typeof syncWaterLogFromServer === 'function') {
    syncWaterLogFromServer();
  }
});
