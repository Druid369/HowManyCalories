/* ════════════════════════════════════════════════
   FORK — App Logic
════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────
let selectedFile   = null;
let selectedPortion = '';
let currentBlobUrl = null;
let currentResult  = null;
let isSaved        = false;

// ── DOM refs ──────────────────────────────────
const $ = id => document.getElementById(id);

const scanZone     = $('scanZone');
const dragOverlay  = $('dragOverlay');
const cameraInput  = $('cameraInput');
const galleryInput = $('galleryInput');
const btnCamera    = $('btnCamera');
const btnGallery   = $('btnGallery');
const btnBack      = $('btnBack');
const btnSave      = $('btnSave');
const btnScanAgain = $('btnScanAgain');
const btnClear     = $('btnClear');

const analyzingImg  = $('analyzingImg');
const resultThumb   = $('resultThumb');
const calNumber     = $('calNumber');
const confidenceTag = $('confidenceTag');
const macroBars     = $('macroBars');
const itemsList     = $('itemsList');
const itemCount     = $('itemCount');
const insightCard   = $('insightCard');
const insightBody   = $('insightBody');
const notesCard     = $('notesCard');
const notesBody     = $('notesBody');
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

const views   = { scanner: $('view-scanner'),  history: $('view-history') };
const screens = { upload: $('screen-upload'), analyzing: $('screen-analyzing'), results: $('screen-results') };

// ── Navigation (spring-driven) ────────────────
let currentView = 'scanner';
let viewSwitching = false;

function switchView(name) {
  if (name === currentView || viewSwitching) return;
  viewSwitching = true;

  // direction: 1 = slide left (scanner→history), -1 = slide right (history→scanner)
  const direction = name === 'history' ? 1 : -1;
  const outEl = views[currentView];
  const inEl  = views[name];
  currentView = name;

  navScanner.classList.toggle('active', name === 'scanner');
  navHistory.classList.toggle('active', name === 'history');
  if (name === 'history') renderHistory();

  Spring.cancelElement(outEl);
  Spring.cancelElement(inEl);

  // Both views fully opaque — no crossfade, pure slide like a carousel
  outEl.style.pointerEvents = 'none';
  inEl.style.pointerEvents = 'none';

  const slideDistance = outEl.offsetWidth;

  // Position incoming view off-screen on the correct side
  inEl.classList.add('active');
  inEl.style.transform = `translateX(${slideDistance * direction}px)`;

  // Outgoing view starts at current position
  outEl.style.transform = 'translateX(0)';

  // Slide both views together
  Spring.springTo(outEl, {
    from: { x: 0 },
    to:   { x: -slideDistance * direction },
    preset: 'snappy',
  }).then(() => {
    outEl.classList.remove('active');
    outEl.style.transform = '';
    outEl.style.pointerEvents = '';
  });

  Spring.springTo(inEl, {
    from: { x: slideDistance * direction },
    to:   { x: 0 },
    preset: 'snappy',
  }).then(() => {
    inEl.style.transform = '';
    inEl.style.pointerEvents = '';
    viewSwitching = false;
  });
}

let currentScreen = 'upload';

function showScreen(name) {
  if (name === currentScreen && screens[name].classList.contains('active')) return;
  const outEl = screens[currentScreen];
  const inEl  = screens[name];
  const prev = currentScreen;
  currentScreen = name;

  // Cancel any running springs on both screens
  Spring.cancelElement(outEl);
  Spring.cancelElement(inEl);

  // Determine direction: upload(0) → analyzing(1) → results(2)
  const order = { upload: 0, analyzing: 1, results: 2 };
  const forward = order[name] > order[prev];

  // Clean slate
  outEl.style.transform = '';
  outEl.style.opacity = '1';
  inEl.classList.add('active');
  inEl.style.opacity = '0';
  inEl.style.transform = `translateY(${forward ? 30 : -30}px)`;

  // Fade/slide out current screen
  Spring.springTo(outEl, {
    from: { y: 0, opacity: 1 },
    to:   { y: forward ? -24 : 24, opacity: 0 },
    preset: 'smooth',
  }).then(() => {
    outEl.classList.remove('active');
    outEl.style.transform = '';
    outEl.style.opacity = '';
  });

  // Slide in new screen
  Spring.springTo(inEl, {
    from: { y: forward ? 30 : -30, opacity: 0 },
    to:   { y: 0, opacity: 1 },
    preset: 'snappy',
    delay: 3,
  }).then(() => {
    inEl.style.transform = '';
    inEl.style.opacity = '';
  });
}

navScanner.addEventListener('click', () => switchView('scanner'));
navHistory.addEventListener('click', () => switchView('history'));

// ── Haptic feedback ──────────────────────────
function haptic(pattern = 8) { navigator.vibrate && navigator.vibrate(pattern); }

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
scanZone.addEventListener('click', e => {
  if (e.target.closest('.scan-action-btn') || e.target.closest('.drag-overlay')) return;
  haptic();
  triggerFileInput(galleryInput);
});

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

// ── Handle file selection ─────────────────────
async function handleFile(file) {
  hideError();
  selectedFile = file;
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(file);

  analyzingImg.src = currentBlobUrl;
  showScreen('analyzing');

  try {
    const blob   = await compressImage(file);
    const result = await analyzeFood(blob, selectedPortion);
    currentResult = result;
    isSaved = false;

    // Success beat: hold on analyzing screen so the user registers completion
    const imgBox = document.querySelector('.analyzing-img-box');
    const analyzeTitle = document.querySelector('.analyzing-title');
    const analyzeSub = document.querySelector('.analyzing-sub');
    const progressTrack = document.querySelector('.progress-track');

    if (imgBox) imgBox.classList.add('scan-complete');
    if (analyzeTitle) analyzeTitle.textContent = 'Готово!';
    if (analyzeSub) analyzeSub.textContent = 'Результаты обработаны';
    if (progressTrack) progressTrack.style.opacity = '0';
    haptic([15, 50, 20]);

    await new Promise(r => setTimeout(r, 900));

    if (imgBox) imgBox.classList.remove('scan-complete');
    if (analyzeTitle) analyzeTitle.textContent = 'Анализируем блюдо';
    if (analyzeSub) analyzeSub.textContent = 'ИИ определяет продукты и рассчитывает питательную ценность';
    if (progressTrack) progressTrack.style.opacity = '';

    renderResults(result);
    autoSave();
  } catch (err) {
    showScreen('upload');
    showError(err.message || 'Ошибка анализа. Попробуйте ещё раз.');
  }
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
async function analyzeFood(blob, portionHint) {
  const fd = new FormData();
  fd.append('image', blob, 'food.jpg');
  if (portionHint) fd.append('portion_hint', portionHint);

  const res = await fetch('/api/analyze', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === 'object' ? err.detail.message : (err.detail || 'Analysis failed');
    throw new Error(msg);
  }
  return res.json();
}

// ── Render results ────────────────────────────
function renderResults(data, thumbUrl) {
  const { items, total, confidence, notes } = data;

  // Thumbnail
  resultThumb.src = thumbUrl || currentBlobUrl;

  // Calorie count-up
  calNumber.textContent = '0';
  animateNumber(calNumber, total.calories, 750);

  // Confidence tag
  confidenceTag.className = `confidence-tag conf-${confidence}`;
  const confLabels = { high: 'высокая точность', medium: 'средняя точность', low: 'низкая точность' };
  confidenceTag.textContent = confLabels[confidence] || confidence;

  // Data source indicator
  const sourceTag = document.getElementById('sourceTag');
  if (sourceTag && data.data_sources) {
    const hasVerified = data.data_sources.includes('verified');
    const hasUsda = data.data_sources.includes('usda');
    const hasOff = data.data_sources.includes('openfoodfacts');
    const hasBranded = data.data_sources.includes('ai_branded');
    if (hasVerified) {
      sourceTag.className = 'source-badge source-verified';
      sourceTag.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="flex-shrink:0"><path d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.745 3.745 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"/></svg> подтверждено';
    } else if (hasUsda || hasOff) {
      sourceTag.className = 'source-badge source-usda';
      sourceTag.textContent = hasUsda ? 'USDA данные' : 'OpenFoodFacts';
    } else if (hasBranded) {
      sourceTag.className = 'source-badge source-branded';
      sourceTag.textContent = 'данные бренда';
    } else {
      sourceTag.className = 'source-badge source-ai';
      sourceTag.textContent = 'ИИ оценка';
    }
    sourceTag.style.display = 'inline-flex';
  }

  // Macro bars (caloric distribution)
  const totalCal = (total.protein_g * 4) + (total.carbs_g * 4) + (total.fat_g * 9) || 1;
  const macros = [
    { lbl:'Б', val:total.protein_g, pct: Math.round(total.protein_g * 4 / totalCal * 100), color:'var(--protein)' },
    { lbl:'У', val:total.carbs_g,   pct: Math.round(total.carbs_g   * 4 / totalCal * 100), color:'var(--carbs)' },
    { lbl:'Ж', val:total.fat_g,     pct: Math.round(total.fat_g     * 9 / totalCal * 100), color:'var(--fat)' },
  ];
  macroBars.innerHTML = macros.map(m => `
    <div class="macro-row">
      <span class="macro-lbl" style="color:${m.color}">${m.lbl}</span>
      <div class="macro-track">
        <div class="macro-fill" data-pct="${m.pct}" style="background:${m.color}"></div>
      </div>
      <span class="macro-val">${m.val}г</span>
    </div>
  `).join('');

  // Items
  const itemWord = items.length === 1 ? 'продукт' : items.length < 5 ? 'продукта' : 'продуктов';
  itemCount.textContent = `${items.length} ${itemWord}`;
  itemsList.innerHTML = items.map((item, i) => `
    <div class="item-card" style="animation-delay:${i * 55}ms">
      <div class="item-info">
        <div class="item-name-row">
          <span class="item-name">${esc(item.name)}</span>
          ${item.data_source === 'verified'
            ? '<span class="source-badge source-verified"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.745 3.745 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"/></svg></span>'
            : item.data_source === 'usda'
            ? '<span class="source-badge source-usda">USDA</span>'
            : item.data_source === 'openfoodfacts'
            ? '<span class="source-badge source-usda">OFF</span>'
            : item.data_source === 'ai_branded'
            ? '<span class="source-badge source-branded">бренд</span>'
            : item.data_source === 'ai_estimate'
            ? '<span class="source-badge source-ai">ИИ</span>'
            : ''}
        </div>
        ${item.estimated_grams ? `<div class="item-grams">~${item.estimated_grams}г</div>` : ''}
        <div class="item-macros">
          <span class="mp">Б ${item.protein_g}г</span>
          <span class="mc">У ${item.carbs_g}г</span>
          <span class="mf">Ж ${item.fat_g}г</span>
        </div>
      </div>
      <div class="item-right">
        <div class="item-cal">${item.calories}</div>
        <div class="item-unit">ккал</div>
      </div>
    </div>
  `).join('');

  // Health insight
  const insight = data.health_insight;
  if (insight) {
    insightBody.textContent = insight;
    insightCard.style.display = 'block';
  } else {
    insightCard.style.display = 'none';
  }

  // Notes
  if (notes) {
    notesBody.textContent = notes;
    notesCard.style.display = 'block';
  } else {
    notesCard.style.display = 'none';
  }

  // Save button state
  if (isSaved) {
    btnSave.disabled = true;
    btnSave.textContent = 'Сохранено \u2713';
  } else {
    btnSave.disabled = false;
    btnSave.textContent = 'Сохранить';
  }

  showScreen('results');

  // Spring-driven results reveal
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Summary card entrance
    const summaryCard = document.querySelector('.summary-card');
    if (summaryCard) {
      summaryCard.style.opacity = '0';
      summaryCard.style.transform = 'translateY(20px) scale(0.97)';
      Spring.springTo(summaryCard, {
        from: { y: 20, opacity: 0, scale: 0.97 },
        to:   { y: 0, opacity: 1, scale: 1 },
        preset: 'bouncy',
        delay: 6,
      });
    }

    // Macro bars animate width with spring
    document.querySelectorAll('.macro-fill').forEach((el, i) => {
      const pct = parseFloat(el.dataset.pct);
      el.style.width = '0%';
      Spring.animate(null, {
        preset: 'snappy',
        delay: 12 + i * 5,
        onUpdate(progress) { el.style.width = (pct * progress) + '%'; },
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

    // Confidence tag pop-in
    if (confidenceTag) {
      confidenceTag.style.transform = 'scale(0)';
      Spring.springTo(confidenceTag, {
        from: { scale: 0 },
        to:   { scale: 1 },
        preset: 'bouncy',
        delay: 10,
      });
    }

    // Health insight card entrance
    if (insightCard.style.display === 'block') {
      insightCard.style.opacity = '0';
      insightCard.style.transform = 'translateY(12px)';
      Spring.springTo(insightCard, {
        from: { y: 12, opacity: 0 },
        to:   { y: 0, opacity: 1 },
        preset: 'snappy',
        delay: 18,
      });
    }

    // Notes card entrance
    if (notesCard.style.display === 'block') {
      notesCard.style.opacity = '0';
      notesCard.style.transform = 'translateY(12px)';
      Spring.springTo(notesCard, {
        from: { y: 12, opacity: 0 },
        to:   { y: 0, opacity: 1 },
        preset: 'snappy',
        delay: 22,
      });
    }
  }));
}

// ── Number count-up (spring-based with overshoot) ──
function animateNumber(el, target, _duration) {
  Spring.animate(null, {
    preset: 'snappy',
    delay: 8,
    onUpdate(progress) {
      el.textContent = Math.round(progress * target).toLocaleString();
    },
  });
}

// ── Auto-save to history ─────────────────────
function autoSave() {
  if (!currentResult || isSaved) return;
  thumbDataUrl(currentBlobUrl, dataUrl => {
    const entry = {
      id:            Date.now(),
      timestamp:     Date.now(),
      imageDataUrl:  dataUrl,
      result:        currentResult,
      itemNames:     currentResult.items.map(i => i.name).join(', '),
      totalCalories: currentResult.total.calories,
    };
    saveEntry(entry);
    isSaved = true;
    btnSave.textContent = 'Сохранено ✓';
    btnSave.disabled = true;
  });
}

btnSave.addEventListener('click', () => {
  if (!currentResult || isSaved) return;
  autoSave();
});

function thumbDataUrl(blobUrl, cb) {
  const img = new Image();
  img.onload = () => {
    const SZ = 120;
    let w = img.width, h = img.height;
    if (w >= h) { h = Math.round(h * SZ / w); w = SZ; }
    else        { w = Math.round(w * SZ / h); h = SZ; }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    cb(c.toDataURL('image/jpeg', 0.72));
  };
  img.src = blobUrl;
}

// ── localStorage history ──────────────────────
const STORAGE_KEY = 'hmc_v1';
const loadEntries = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } };

function saveEntry(entry) {
  const list = loadEntries();
  list.unshift(entry);
  if (list.length > 60) list.pop();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  renderRecent();
}

// ── Render recent scans (upload screen) ───────
function renderRecent() {
  const list = loadEntries().slice(0, 3);
  if (!list.length) { recentSection.classList.remove('show'); return; }
  recentSection.classList.add('show');
  recentList.innerHTML = list.map(e => `
    <div class="recent-item">
      ${e.imageDataUrl ? `<img class="recent-thumb" src="${e.imageDataUrl}" alt="">` : `<div class="recent-thumb"></div>`}
      <div class="recent-info">
        <div class="recent-name">${esc(e.itemNames || 'Блюдо')}</div>
        <div class="recent-meta">${formatDate(e.timestamp)} · ${formatTime(e.timestamp)}</div>
      </div>
      <div class="recent-cal">${e.totalCalories}</div>
    </div>
  `).join('');
  requestAnimationFrame(() => springAnimateList('.recent-item'));
}

// ── Daily summary ─────────────────────────────
const DAILY_GOAL = 2000;

function renderDailySummary() {
  const summary = $('dailySummary');
  const list = loadEntries();
  const today = new Date();
  const todayCals = list
    .filter(e => sameDay(new Date(e.timestamp), today))
    .reduce((sum, e) => sum + (e.totalCalories || 0), 0);

  if (!list.length) { summary.style.display = 'none'; return; }

  summary.style.display = 'block';
  const pct = Math.min((todayCals / DAILY_GOAL) * 100, 100);
  const over = todayCals > DAILY_GOAL;

  $('dailyCurrent').textContent = todayCals.toLocaleString();
  $('dailyCurrent').classList.toggle('over', over);
  $('dailyGoal').textContent = DAILY_GOAL.toLocaleString();

  const fill = $('dailyBarFill');
  fill.classList.toggle('over', over);
  requestAnimationFrame(() => { fill.style.width = pct + '%'; });
}

// ── View saved result ─────────────────────────
function viewSavedResult(entry) {
  if (!entry.result) return;
  currentResult = entry.result;
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = entry.imageDataUrl || '';
  isSaved = true;
  renderResults(entry.result, entry.imageDataUrl);
  switchView('scanner');
}

// ── Render history view ───────────────────────
function renderHistory() {
  const list = loadEntries();
  renderDailySummary();

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

  // Group by date label
  const groups = {};
  list.forEach(e => {
    const label = dayLabel(new Date(e.timestamp));
    (groups[label] = groups[label] || []).push(e);
  });

  historyContent.innerHTML = Object.entries(groups).map(([label, entries]) => `
    <div class="history-group">
      <div class="history-date">${label}</div>
      <div class="history-entries">
        ${entries.map((e, i) => `
          <div class="history-entry" data-entry-id="${e.id}" style="animation-delay:${i * 40}ms; cursor:pointer">
            ${e.imageDataUrl ? `<img class="history-thumb" src="${e.imageDataUrl}" alt="">` : `<div class="history-thumb"></div>`}
            <div class="history-info">
              <div class="history-name">${esc(e.itemNames || 'Блюдо')}</div>
              <div class="history-time">${formatTime(e.timestamp)}</div>
            </div>
            <div class="history-cal">${e.totalCalories}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Tap to view
  historyContent.querySelectorAll('.history-entry').forEach(el => {
    el.addEventListener('click', () => {
      const entry = loadEntries().find(e => String(e.id) === el.dataset.entryId);
      if (entry) viewSavedResult(entry);
    });
  });

  requestAnimationFrame(() => springAnimateList('.history-entry'));
}

// ── Clear history ─────────────────────────────
btnClear.addEventListener('click', () => {
  if (!loadEntries().length) return;
  if (confirm('Очистить всю историю сканирований?')) {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
    renderRecent();
  }
});

// ── Button wiring ─────────────────────────────
btnBack.addEventListener('click',      () => showScreen('upload'));
btnScanAgain.addEventListener('click', () => showScreen('upload'));
btnErrorRetry.addEventListener('click', () => { hideError(); showScreen('upload'); });

// ── Error handling ────────────────────────────
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
  const key = Object.keys(ERROR_MAP).find(k => msg.toLowerCase().includes(k.toLowerCase()));
  const info = key ? ERROR_MAP[key] : { title: 'Что-то пошло не так', detail: msg, warn: false };

  errorTitle.textContent = info.title;
  errorDetail.textContent = info.detail;
  errorIcon.classList.toggle('warn', !!info.warn);
  errorOverlay.classList.add('show');

  Spring.springTo(errorOverlay.querySelector('.error-card'), {
    from: { y: 20, opacity: 0, scale: 0.95 },
    to:   { y: 0, opacity: 1, scale: 1 },
    preset: 'snappy',
  });
}

function hideError() { errorOverlay.classList.remove('show'); }

// ── Utils ─────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function dayLabel(d) {
  const now = new Date();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (sameDay(d, now))  return 'Сегодня';
  if (sameDay(d, yest)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { month: 'long', day: 'numeric' });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDate(ts) { return new Date(ts).toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }


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

// Orbs (btnCamera, btnGallery) excluded — CSS float animation owns their transform
[btnBack, btnSave, btnScanAgain, btnClear, btnErrorRetry].forEach(el => {
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


// ── Orb entrance animation ────────────────────
function initOrbFloating() {
  const orbs = document.querySelectorAll('.scan-orb');
  if (!orbs.length) return;

  // Entrance: spring in from scale(0), then CSS float takes over
  orbs.forEach((orb, i) => {
    orb.style.opacity = '0';
    orb.style.transform = 'scale(0)';
    orb.style.animationPlayState = 'paused';
    Spring.springTo(orb, {
      from: { scale: 0, opacity: 0 },
      to: { scale: 1, opacity: 1 },
      preset: 'bouncy',
      delay: 8 + i * 6,
    }).then(() => {
      orb.style.transform = '';
      orb.style.animationPlayState = '';
    });
  });
}

// ── Init ──────────────────────────────────────
renderRecent();
initOrbFloating();
