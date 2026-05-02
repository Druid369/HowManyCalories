/* ════════════════════════════════════════════════
   СЪЕМ — Admin Dashboard Logic
   Auth, data fetching, charts, scan table, modal
════════════════════════════════════════════════ */

(function () {
  'use strict';

  const PER_PAGE = 30;
  let currentPage = 0;
  let totalScans = 0;

  /* ── Auth (session-cookie based) ────────────────────────────────
     The /admin route is gated server-side: only role='admin' sessions
     ever receive this HTML. Client-side we still call /api/auth/me on
     load so we can:
       - handle the case where the session expired AFTER the page loaded
         (server-gate already passed; subsequent API calls would 401)
       - cleanly hide the legacy auth-gate element without flicker
       - bounce non-admins to / and unauthed visitors to /login

     Drop any stale legacy `admin_token` left over from the previous
     auth scheme so DevTools/localStorage stays clean. */
  const authGate   = document.getElementById('authGate');
  const dashboard  = document.getElementById('dashboard');

  localStorage.removeItem('admin_token');

  bootstrap();

  async function bootstrap() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!res.ok) {
        showFatal('Не удалось проверить аккаунт. Попробуйте обновить страницу.');
        return;
      }
      const user = await res.json();
      if (user.role !== 'admin') {
        // Logged-in but no admin role → bounce to the regular app
        window.location.replace('/');
        return;
      }
      // Authed admin — hide the legacy gate (now dead UI) and start
      if (authGate) authGate.style.display = 'none';
      if (dashboard) dashboard.style.display = 'block';
      initDashboard();
    } catch (e) {
      showFatal('Сетевая ошибка при проверке аккаунта.');
    }
  }

  function showFatal(msg) {
    if (authGate) {
      authGate.style.display = 'flex';
      const errEl = document.getElementById('authError');
      if (errEl) errEl.textContent = msg;
    }
    if (dashboard) dashboard.style.display = 'none';
  }

  // Session cookie is sent automatically; we only need credentials
  // 'same-origin' to ensure that. A 401 mid-session means the session
  // expired or got revoked — kick to /login.
  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) {
      window.location.replace('/login');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ── Dashboard Init ────────────────────── */
  // Module-level interval handles so re-initialization (e.g. an admin
  // who logs back in within the same tab) clears the prior intervals
  // before starting new ones — otherwise each visit stacks another
  // 1Hz clock tick and 30s stats poll.
  let _refreshInterval = null;
  let _clockInterval = null;

  function initDashboard() {
    if (_refreshInterval) clearInterval(_refreshInterval);
    if (_clockInterval) clearInterval(_clockInterval);
    startClock();
    loadStats();
    loadTimeline('day');
    loadScans(0);
    setupListeners();
    // Auto-refresh every 30s
    _refreshInterval = setInterval(() => {
      loadStats();
      loadScans(currentPage);
    }, 30000);
  }

  /* ── Clock ─────────────────────────────── */
  function startClock() {
    const el = document.getElementById('clockDisplay');
    function tick() {
      const now = new Date();
      el.textContent = now.toLocaleTimeString('en-GB');
    }
    tick();
    _clockInterval = setInterval(tick, 1000);
  }

  /* ── Stats ─────────────────────────────── */
  async function loadStats() {
    const s = await apiFetch('/api/admin/stats');

    document.getElementById('kpiToday').textContent = s.today;
    document.getElementById('kpiWeek').textContent = s.week;
    document.getElementById('kpiMonth').textContent = s.month;
    document.getElementById('kpiTotal').textContent = s.total.toLocaleString();
    document.getElementById('kpiAvgMs').textContent = s.avg_total_ms + 'ms';
    document.getElementById('kpiOpus').textContent = s.opus_rate + '%';

    // Performance bars (max = avg_total_ms for scaling)
    const maxMs = Math.max(s.avg_stage1_ms, s.avg_stage2_ms, s.avg_stage3_ms, 1);
    setBar('perfS1', s.avg_stage1_ms, maxMs, 'perfS1Val', s.avg_stage1_ms + 'ms');
    setBar('perfS2', s.avg_stage2_ms, maxMs, 'perfS2Val', s.avg_stage2_ms + 'ms');
    setBar('perfS3', s.avg_stage3_ms, maxMs, 'perfS3Val', s.avg_stage3_ms + 'ms');

    document.getElementById('statTokens').textContent = s.avg_tokens.toLocaleString();
    document.getElementById('statTotalTokens').textContent = formatK(s.total_tokens);
    document.getElementById('statCalWarn').textContent = s.calorie_warn_count;

    // Confidence distribution
    renderDistBars('confDist', s.confidence_dist, ['high', 'medium', 'low']);

    // Source distribution
    renderDistBars('sourceDist', s.source_dist);

    // Averages
    document.getElementById('avgCal').textContent = s.avg_calories;
    document.getElementById('avgItems').textContent = s.avg_items;
  }

  function setBar(fillId, val, max, valId, text) {
    const pct = Math.min((val / max) * 100, 100);
    document.getElementById(fillId).style.width = pct + '%';
    document.getElementById(valId).textContent = text;
  }

  function formatK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function renderDistBars(containerId, data, order) {
    const container = document.getElementById(containerId);
    const keys = order || Object.keys(data);
    const maxVal = Math.max(...Object.values(data), 1);

    container.innerHTML = keys
      .filter(k => data[k] !== undefined)
      .map(k => {
        const val = data[k] || 0;
        const pct = (val / maxVal) * 100;
        return `
          <div class="dist-item">
            <span class="dist-name">${k}</span>
            <div class="dist-track">
              <div class="dist-fill ${k}" style="width:${pct}%"></div>
            </div>
            <span class="dist-val">${val}</span>
          </div>`;
      }).join('');
  }

  /* ── Timeline Chart (Canvas) ───────────── */
  let timelineData = [];

  async function loadTimeline(period) {
    const data = await apiFetch('/api/admin/timeline?period=' + period);
    timelineData = data;
    drawChart();
  }

  function drawChart() {
    const canvas = document.getElementById('timelineChart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = 180 * dpr;
    ctx.scale(dpr, dpr);

    const W = canvas.offsetWidth;
    const H = 180;
    const pad = { top: 10, right: 10, bottom: 30, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    ctx.clearRect(0, 0, W, H);

    if (!timelineData.length) {
      ctx.fillStyle = '#4A4238';
      ctx.font = '11px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText('No data for this period', W / 2, H / 2);
      return;
    }

    const counts = timelineData.map(d => d.count);
    const maxCount = Math.max(...counts, 1);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = '#4A4238';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      const val = Math.round(maxCount * (1 - i / 4));
      ctx.fillText(val, pad.left - 8, y + 3);
    }

    // Bars
    const barGap = 2;
    const barW = Math.max((plotW / timelineData.length) - barGap, 2);

    timelineData.forEach((d, i) => {
      const x = pad.left + i * (barW + barGap);
      const h = (d.count / maxCount) * plotH;
      const y = pad.top + plotH - h;

      ctx.fillStyle = 'rgba(201,148,58,.6)';
      ctx.fillRect(x, y, barW, h);

      // Hover highlight effect area (top accent line)
      ctx.fillStyle = 'rgba(201,148,58,.9)';
      ctx.fillRect(x, y, barW, Math.min(2, h));
    });

    // X-axis labels (show every nth)
    ctx.fillStyle = '#4A4238';
    ctx.font = '8px JetBrains Mono';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(timelineData.length / 8));
    timelineData.forEach((d, i) => {
      if (i % step !== 0) return;
      const x = pad.left + i * (barW + barGap) + barW / 2;
      const label = d.bucket.includes('T')
        ? d.bucket.split('T')[1].replace(':00:00Z', 'h')
        : d.bucket.slice(5);
      ctx.fillText(label, x, H - 8);
    });
  }

  window.addEventListener('resize', drawChart);

  /* ── Scan Table ────────────────────────── */
  async function loadScans(page) {
    currentPage = page;
    const offset = page * PER_PAGE;
    const data = await apiFetch(`/api/admin/scans?limit=${PER_PAGE}&offset=${offset}`);
    totalScans = data.total;

    document.getElementById('scanCount').textContent = totalScans + ' scans';
    document.getElementById('pageInfo').textContent =
      `Page ${page + 1} of ${Math.max(1, Math.ceil(totalScans / PER_PAGE))}`;
    document.getElementById('prevBtn').disabled = page === 0;
    document.getElementById('nextBtn').disabled = offset + PER_PAGE >= totalScans;

    const tbody = document.getElementById('scanBody');

    if (!data.scans.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="scan-empty">No scans recorded yet</td></tr>';
      return;
    }

    tbody.innerHTML = data.scans.map(s => {
      const time = formatTime(s.created_at);
      const conf = s.confidence || 'medium';
      const sources = parseSources(s.data_sources);
      const items = parseItems(s.final_json);
      const itemNames = items.map(i => i.name).join(', ');
      const username = s.user_username || '—';
      const userInitial = username && username !== '—' ? username[0].toUpperCase() : '?';
      const userAvatarHtml = s.user_avatar_path
        ? `<div class="user-avatar-mini" data-user-id="${escapeHtml(s.user_id)}">
             <img alt="" src="/api/auth/avatar/${encodeURIComponent(s.user_id)}">
           </div>`
        : `<div class="user-avatar-mini">${escapeHtml(userInitial)}</div>`;

      return `
        <tr data-id="${escapeHtml(s.scan_id)}">
          <td><div class="scan-img-placeholder" data-hash="${escapeHtml(s.image_sha256)}">◻</div></td>
          <td>
            <div class="scan-user-cell">
              ${userAvatarHtml}
              <span class="user-name">${escapeHtml(username)}</span>
            </div>
          </td>
          <td>${escapeHtml(time)}</td>
          <td title="${escapeHtml(itemNames)}">${escapeHtml(s.item_count || 0)} items</td>
          <td>${escapeHtml(s.total_calories || 0)} kcal</td>
          <td><span class="conf-badge conf-${escapeHtml(conf)}">${escapeHtml(conf)}</span></td>
          <td>${sources.map(src => `<span class="src-tag">${escapeHtml(src)}</span>`).join('')}</td>
          <td>${escapeHtml(s.total_ms || 0)}ms</td>
          <td><span class="${s.opus_used ? 'opus-yes' : 'opus-no'}">${s.opus_used ? '✓' : '–'}</span></td>
        </tr>`;
    }).join('');

    // Load thumbnails — admin images need session-cookie auth, so we
    // fetch as blob + objectURL via loadThumbnail rather than setting
    // <img src> directly. (Earlier scaffold-code that set src directly
    // was firing one 401 per scan row on every render — removed.)
    data.scans.forEach(s => {
      const el = tbody.querySelector(`[data-hash="${s.image_sha256}"]`);
      if (el) loadThumbnail(el, s.image_sha256);
    });

    // Row click → modal
    tbody.querySelectorAll('tr[data-id]').forEach(row => {
      row.addEventListener('click', () => openDetail(row.dataset.id));
    });
  }

  async function loadThumbnail(el, hash) {
    try {
      const res = await fetch(`/api/admin/images/${hash}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.className = 'scan-img';
      img.src = url;
      el.replaceWith(img);
    } catch (e) {
      // Keep placeholder
    }
  }

  function formatTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function parseSources(raw) {
    try { return JSON.parse(raw) || []; }
    catch { return []; }
  }

  function parseItems(raw) {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.items || [];
    } catch { return []; }
  }

  /* ── Modal ─────────────────────────────── */
  const modalOverlay = document.getElementById('modalOverlay');
  const modalBody    = document.getElementById('modalBody');
  const modalClose   = document.getElementById('modalClose');

  modalClose.addEventListener('click', () => modalOverlay.style.display = 'none');
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) modalOverlay.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modalOverlay.style.display = 'none';
  });

  async function openDetail(scanId) {
    modalOverlay.style.display = 'flex';
    modalBody.innerHTML = '<p style="color:var(--t3)">Loading...</p>';

    const s = await apiFetch(`/api/admin/scans/${scanId}`);
    const items = parseItems(s.final_json);

    let html = '';

    // Image + meta grid
    html += `<div class="detail-row">
      <div class="detail-img-wrap">
        <div class="scan-img-placeholder" id="detailImg" style="width:160px;height:160px;font-size:24px">◻</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:1px;background:var(--border)">
        <div class="detail-cell"><span class="detail-key">SCAN ID</span><span class="detail-val">${escapeHtml(s.scan_id)}</span></div>
        <div class="detail-cell"><span class="detail-key">CREATED</span><span class="detail-val">${escapeHtml(s.created_at)}</span></div>
        <div class="detail-cell"><span class="detail-key">TOTAL</span><span class="detail-val">${escapeHtml(s.total_calories || 0)} kcal · ${escapeHtml(s.item_count || 0)} items · ${escapeHtml(s.confidence || '–')}</span></div>
        <div class="detail-cell"><span class="detail-key">TIMING</span><span class="detail-val">S1: ${escapeHtml(s.stage1_ms)}ms · S2: ${escapeHtml(s.stage2_ms)}ms · S3: ${escapeHtml(s.stage3_ms)}ms · Total: ${escapeHtml(s.total_ms)}ms</span></div>
      </div>
    </div>`;

    // Items
    if (items.length) {
      html += '<div class="detail-stage"><div class="detail-stage-head">DETECTED ITEMS</div>';
      html += '<div class="items-grid">';
      items.forEach(it => {
        // it.name and it.data_source are user-influenced (food name comes
        // from AI output, which the photographed content can steer). Other
        // fields are numeric per Pydantic schema but escape defensively.
        const name    = escapeHtml(it.name || '–');
        const source  = escapeHtml(it.data_source || '–');
        const cals    = escapeHtml(it.calories ?? 0);
        const grams   = escapeHtml(it.estimated_grams ?? '?');
        const protein = escapeHtml(it.protein_g ?? 0);
        const carbs   = escapeHtml(it.carbs_g ?? 0);
        const fat     = escapeHtml(it.fat_g ?? 0);
        html += `<div class="item-card">
          <div class="item-name">${name}</div>
          <div class="item-cal">${cals}<span style="font-size:11px;color:var(--t3)"> kcal</span></div>
          <div class="item-macros">
            ~${grams}г · Б${protein} У${carbs} Ж${fat}<br>
            ${source}
          </div>
        </div>`;
      });
      html += '</div></div>';
    }

    // Stage JSONs
    if (s.stage1_json) {
      html += `<div class="detail-stage">
        <div class="detail-stage-head">STAGE 1 — SONNET RAW</div>
        <div class="detail-json">${formatJSON(s.stage1_json)}</div>
      </div>`;
    }
    if (s.stage3_json) {
      html += `<div class="detail-stage">
        <div class="detail-stage-head">STAGE 3 — OPUS VERDICT</div>
        <div class="detail-json">${formatJSON(s.stage3_json)}</div>
      </div>`;
    }

    modalBody.innerHTML = html;

    // Load detail image
    const imgEl = document.getElementById('detailImg');
    if (imgEl) loadDetailImage(imgEl, s.image_sha256);
  }

  async function loadDetailImage(el, hash) {
    try {
      const res = await fetch(`/api/admin/images/${hash}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const blob = await res.blob();
      const img = document.createElement('img');
      img.className = 'detail-img';
      img.src = URL.createObjectURL(blob);
      el.replaceWith(img);
    } catch (e) {}
  }

  function formatJSON(raw) {
    try {
      const parsed = JSON.parse(raw);
      return escapeHtml(JSON.stringify(parsed, null, 2));
    } catch {
      return escapeHtml(raw);
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Listeners ─────────────────────────── */
  function setupListeners() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadStats();
      loadScans(currentPage);
    });

    document.getElementById('prevBtn').addEventListener('click', () => {
      if (currentPage > 0) loadScans(currentPage - 1);
    });
    document.getElementById('nextBtn').addEventListener('click', () => {
      if ((currentPage + 1) * PER_PAGE < totalScans) loadScans(currentPage + 1);
    });

    document.querySelectorAll('.chart-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadTimeline(btn.dataset.period);
      });
    });

    // ── Tab switching (Phase 5) ──────────────────────────────
    // Lazy-load the Users tab on first activation so the dashboard's
    // initial paint doesn't pay for an extra round-trip nobody sees.
    let usersLoaded = false;
    document.querySelectorAll('.dash-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.dash-tab').forEach(b => {
          const active = b.dataset.tab === target;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.tab-panel').forEach(p => {
          p.classList.toggle('active', p.id === 'tab-' + target);
        });
        if (target === 'users' && !usersLoaded) {
          usersLoaded = true;
          loadUsers();
        }
      });
    });
    const usersRefreshBtn = document.getElementById('usersRefreshBtn');
    if (usersRefreshBtn) usersRefreshBtn.addEventListener('click', loadUsers);
  }

  /* ── Users (Phase 5) ─────────────────────────── */
  // Cache the users array between fetches so action handlers can find
  // the row's display data (username etc.) without a re-fetch.
  let usersCache = [];

  async function loadUsers() {
    const tbody = document.getElementById('usersBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="users-empty">Loading...</td></tr>';
    try {
      usersCache = await apiFetch('/api/admin/users');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" class="users-empty">Failed to load users</td></tr>';
      return;
    }
    document.getElementById('usersCount').textContent = usersCache.length + ' users';

    if (!usersCache.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="users-empty">No users yet</td></tr>';
      return;
    }

    tbody.innerHTML = usersCache.map(u => {
      const initial = (u.username || '?')[0].toUpperCase();
      const avatarHtml = u.avatar_path
        ? `<div class="user-avatar-mini"><img alt="" src="/api/auth/avatar/${encodeURIComponent(u.id)}?t=${Date.now()}"></div>`
        : `<div class="user-avatar-mini">${escapeHtml(initial)}</div>`;
      const display = u.display_name ? `<span class="user-display">${escapeHtml(u.display_name)}</span>` : '';
      const lastLogin = u.last_login_at ? formatTime(u.last_login_at) : '—';
      const created = u.created_at ? formatTime(u.created_at) : '—';
      return `
        <tr data-user-id="${escapeHtml(u.id)}">
          <td>
            <div class="user-cell">
              ${avatarHtml}
              <div>
                <div class="user-name">@${escapeHtml(u.username)}</div>
                ${display}
              </div>
            </div>
          </td>
          <td><span class="user-badge role-${escapeHtml(u.role)}">${escapeHtml(u.role)}</span></td>
          <td><span class="user-badge status-${escapeHtml(u.status)}">${escapeHtml(u.status)}</span></td>
          <td>${escapeHtml(u.scan_count || 0)}</td>
          <td class="user-cell-time">${escapeHtml(lastLogin)}</td>
          <td class="user-cell-time">${escapeHtml(created)}</td>
          <td>
            <div class="user-actions" data-stop="1">
              <button class="user-action-btn" data-action="toggle-status" data-user-id="${escapeHtml(u.id)}">${u.status === 'active' ? 'DISABLE' : 'ENABLE'}</button>
              <button class="user-action-btn" data-action="reset-password" data-user-id="${escapeHtml(u.id)}">RESET PW</button>
              <button class="user-action-btn danger" data-action="delete" data-user-id="${escapeHtml(u.id)}">DELETE</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-user-id]').forEach(row => {
      row.addEventListener('click', e => {
        // Action buttons handle their own click; ignore clicks bubbling
        // up from inside the actions cell so the row-tap drill-down
        // doesn't fire alongside.
        if (e.target.closest('[data-stop="1"]')) return;
        openUserDetail(parseInt(row.dataset.userId, 10));
      });
    });
    tbody.querySelectorAll('.user-action-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const userId = parseInt(btn.dataset.userId, 10);
        if (action === 'toggle-status')   handleToggleStatus(userId);
        else if (action === 'reset-password') handleResetPassword(userId);
        else if (action === 'delete')        handleDeleteUser(userId);
      });
    });
  }

  async function handleToggleStatus(userId) {
    const u = usersCache.find(x => x.id === userId);
    if (!u) return;
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !confirm(`Disable @${u.username}? All their sessions will be revoked.`)) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || 'Failed to change status');
        return;
      }
      loadUsers();
    } catch (e) {
      alert('Network error');
    }
  }

  async function handleResetPassword(userId) {
    const u = usersCache.find(x => x.id === userId);
    if (!u) return;
    const pw = prompt(`New password for @${u.username} (min 4 chars). All sessions will be revoked.`);
    if (pw == null) return;
    if (pw.length < 4) { alert('Password must be at least 4 characters'); return; }
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || 'Failed to reset password');
        return;
      }
      alert(`Password reset for @${u.username}. They'll need to log in again.`);
      loadUsers();
    } catch (e) {
      alert('Network error');
    }
  }

  async function handleDeleteUser(userId) {
    const u = usersCache.find(x => x.id === userId);
    if (!u) return;
    const confirmText = prompt(`Type DELETE to confirm deletion of @${u.username}. This is irreversible.`);
    if (confirmText !== 'DELETE') return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || 'Failed to delete user');
        return;
      }
      loadUsers();
    } catch (e) {
      alert('Network error');
    }
  }

  /* ── User detail modal ─────────────────────── */
  const userModalOverlay = document.getElementById('userModalOverlay');
  const userModalBody    = document.getElementById('userModalBody');
  const userModalClose   = document.getElementById('userModalClose');

  if (userModalClose) userModalClose.addEventListener('click', () => userModalOverlay.style.display = 'none');
  if (userModalOverlay) {
    userModalOverlay.addEventListener('click', (e) => {
      if (e.target === userModalOverlay) userModalOverlay.style.display = 'none';
    });
  }

  async function openUserDetail(userId) {
    if (!userModalOverlay || !userModalBody) return;
    userModalOverlay.style.display = 'flex';
    userModalBody.innerHTML = '<p style="color:var(--t3)">Loading...</p>';
    try {
      const [user, scansResp] = await Promise.all([
        apiFetch(`/api/admin/users/${userId}`),
        apiFetch(`/api/admin/users/${userId}/scans?limit=50`),
      ]);
      userModalBody.innerHTML = renderUserDetail(user, scansResp);

      // Wire delete-from-modal action.
      userModalBody.querySelectorAll('[data-modal-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.modalAction;
          if (action === 'toggle-status') handleToggleStatus(userId).then(() => openUserDetail(userId));
          else if (action === 'reset-password') handleResetPassword(userId).then(() => openUserDetail(userId));
          else if (action === 'delete') {
            handleDeleteUser(userId).then(() => {
              userModalOverlay.style.display = 'none';
            });
          }
        });
      });
    } catch (e) {
      userModalBody.innerHTML = '<p style="color:var(--t3)">Failed to load user</p>';
    }
  }

  function renderUserDetail(user, scansResp) {
    const initial = (user.username || '?')[0].toUpperCase();
    const avatar = user.avatar_path
      ? `<img alt="" src="/api/auth/avatar/${encodeURIComponent(user.id)}?t=${Date.now()}">`
      : escapeHtml(initial);
    const fields = [
      ['ID',           user.id],
      ['USERNAME',     '@' + user.username],
      ['ROLE',         user.role],
      ['STATUS',       user.status],
      ['DISPLAY NAME', user.display_name || '—'],
      ['WEIGHT',       user.weight_kg != null ? user.weight_kg + ' kg' : '—'],
      ['HEIGHT',       user.height_cm != null ? user.height_cm + ' cm' : '—'],
      ['GENDER',       user.gender || '—'],
      ['BIRTH YEAR',   user.birth_year || '—'],
      ['ACTIVITY',     user.activity_level || '—'],
      ['SCAN COUNT',   user.scan_count || 0],
      ['CREATED',      user.created_at ? formatTime(user.created_at) : '—'],
      ['LAST LOGIN',   user.last_login_at ? formatTime(user.last_login_at) : '—'],
    ];
    const fieldsHtml = fields.map(([k, v]) => `
      <div class="user-detail-field">
        <span class="user-detail-field-key">${escapeHtml(k)}</span>
        <span class="user-detail-field-val">${escapeHtml(v)}</span>
      </div>`).join('');

    const scansHtml = scansResp.scans && scansResp.scans.length
      ? `<div class="user-scans-list">${scansResp.scans.map(s => `
          <div class="user-scan-row">
            <span class="ts">${escapeHtml(formatTime(s.created_at))}</span>
            <span class="kcal">${escapeHtml(s.total_calories || 0)} kcal</span>
            <span class="items">${escapeHtml(s.item_count || 0)} items</span>
            <span class="conf">${escapeHtml(s.confidence || '–')}</span>
          </div>`).join('')}</div>`
      : '<p style="color:var(--t3); font-style:italic; padding:12px">No scans yet</p>';

    return `
      <div class="user-detail-grid">
        <div class="user-detail-avatar">${avatar}</div>
        <div class="user-detail-fields">${fieldsHtml}</div>
      </div>
      <div class="user-detail-actions">
        <button class="user-action-btn" data-modal-action="toggle-status">${user.status === 'active' ? 'DISABLE' : 'ENABLE'}</button>
        <button class="user-action-btn" data-modal-action="reset-password">RESET PASSWORD</button>
        <button class="user-action-btn danger" data-modal-action="delete">DELETE ACCOUNT</button>
      </div>
      <div class="user-detail-section">
        <h4>RECENT SCANS (${scansResp.total || 0} TOTAL)</h4>
        ${scansHtml}
      </div>
    `;
  }

})();
