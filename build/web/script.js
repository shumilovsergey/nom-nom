// ════════════════════════════════════════════════════════════════════════
// nom-nom — client logic
// Chrome (profile popover, tabs) + app logic. All data comes from /api/* — no
// hardcoded meals/favorites. The app block only runs on the logged-in screen.
// ════════════════════════════════════════════════════════════════════════

// ── Profile button: initial letter + popover toggle ─────────────────────────
const profileBtn = document.getElementById('profileBtn');
if (profileBtn) {
  const name = profileBtn.dataset.name || '';
  const initial = profileBtn.querySelector('.profile-initial');
  if (initial) initial.textContent = (name[0] || '?').toUpperCase();
  const popover = document.getElementById('profilePopover');
  profileBtn.addEventListener('click', () => {
    const open = popover.classList.toggle('open');
    profileBtn.classList.toggle('open', open);
  });
  document.addEventListener('click', e => {
    if (!profileBtn.contains(e.target) && !popover.contains(e.target)) {
      popover.classList.remove('open');
      profileBtn.classList.remove('open');
    }
  });
}

// ── App logic (only on the scanner screen) ──────────────────────────────────
(function app() {
  if (!document.querySelector('.screen')) return; // logged-out: nothing to wire

  // ── tiny fetch wrapper: throws {status, message} on non-2xx ──
  async function api(method, url, body, signal) {
    const opt = { method, headers: {}, signal };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Ошибка');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── client cache, hydrated from /api/state ──
  let MEALS = [];
  let FAVORITES = [];
  let DONUT = { kcal: 0, prot: 0 };
  let GOALS = { kcal: 2000, prot: 120 }; // server defaults; personal after /api/state
  let WEIGHTS = [];   // recent entries, newest first; [0] may be today
  let TODAY = '';     // server's MSK day — marks which entry is "today"

  async function loadState() {
    const s = await api('GET', '/api/state');
    MEALS = s.meals || [];
    FAVORITES = s.favorites || [];
    DONUT = s.donut || { kcal: 0, prot: 0 };
    if (s.goals && s.goals.kcal > 0 && s.goals.prot > 0) GOALS = s.goals;
    WEIGHTS = s.weights || [];
    TODAY = s.day || '';
    const cs = document.getElementById('c-status');
    const cu = document.getElementById('c-uses');
    if (cs) cs.textContent = s.status || '—';
    if (cu) cu.textContent = s.usesToday ?? 0;
    drawHistory();
    drawToday();
    wDrawPanel();
    snapTableToBottom();
  }

  // ── today's donut: two rings (calories outer, protein inner) ──
  // 100% = the personal goal. Past the goal the base ring stays full and a second
  // lap in a lighter tint draws on top; past 2× both laps cap and the numbers
  // ("+N over") carry the rest — arcs never draw beyond a full circle.
  const CAL_C = 2 * Math.PI * 52;
  const PROT_C = 2 * Math.PI * 39;

  // base lap fraction, second-lap fraction (both clamped to one full circle)
  const laps = frac => [Math.min(1, frac), Math.min(1, Math.max(0, frac - 1))];
  const setArc = (id, frac, C) => document.getElementById(id)
    .setAttribute('stroke-dasharray', `${(frac * C).toFixed(1)} ${C.toFixed(1)}`);

  function drawToday() {
    const kcal = Number(DONUT.kcal) || 0;
    const prot = Number(DONUT.prot) || 0;
    const [calBase, calOver] = laps(kcal / GOALS.kcal);
    const [protBase, protOver] = laps(prot / GOALS.prot);

    const kcalEl = document.getElementById('d-kcal');
    kcalEl.textContent = kcal.toLocaleString();
    kcalEl.classList.toggle('long', kcalEl.textContent.length > 5); // huge totals shrink, not overflow
    document.getElementById('d-prot').textContent = Math.round(prot).toLocaleString();

    setArc('d-cal-arc', calBase, CAL_C);
    setArc('d-cal-over', calOver, CAL_C);
    setArc('d-prot-arc', protBase, PROT_C);
    setArc('d-prot-over', protOver, PROT_C);
  }

  // ── meals table — today only, newest first ──
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function drawHistory() {
    const wrap = document.getElementById('history-rows');
    if (!MEALS.length) {
      wrap.innerHTML = `<div class="empty">Вы еще не ном-ном сегодня</div>`;
      return;
    }
    wrap.innerHTML = MEALS.map(m => `
      <div class="row" data-id="${m.id}">
        <span class="meal">
          <span class="name">${m.fav ? '★ ' : ''}${esc(m.name)}</span>
          <span class="time">${esc(m.time || '')}</span>
        </span>
        <span class="kcal">${Number(m.kcal).toLocaleString()}</span>
      </div>`).join('');
  }

  // ── daily goals (the gear): prefill from state, save, redraw the donut ──
  document.getElementById('gear-btn').addEventListener('click', () => {
    document.getElementById('g-kcal').value = GOALS.kcal;
    document.getElementById('g-prot').value = GOALS.prot;
    openOverlay('overlay-goals');
  });

  document.getElementById('goals-save').addEventListener('click', async e => {
    const kcal = Math.round(Number(document.getElementById('g-kcal').value));
    const prot = Math.round(Number(document.getElementById('g-prot').value));
    if (!(kcal >= 100 && kcal <= 20000)) { toast('Калории: от 100 до 20000'); return; }
    if (!(prot >= 10 && prot <= 1000)) { toast('Белок: от 10 до 1000 г'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('POST', '/api/goals', { kcal, prot });
      GOALS = { kcal, prot };
      closeOverlay('overlay-goals');
      drawToday();
      toast('Цели сохранены');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });

  // ── buy PRO (no shop yet — the beta-contacts sheet) ──
  document.getElementById('buy-pro').addEventListener('click', () => openOverlay('overlay-pro'));

  document.getElementById('copy-email').addEventListener('click', () => {
    const email = 'wumilovsergey@gmail.com';
    // hidden-textarea copy: for insecure contexts / webviews without clipboard API
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = email;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(email).catch(fallback);
    } else {
      fallback();
    }
    toast('Email скопирован'); // don't await the write — some webviews never settle it
  });

  // ══ Weight tab (skeleton/weight) ═══════════════════════════════════════════
  let wPeriod = 'week';
  let wPoints = [];      // fetched graph points [{day, kg}]
  let wPts = [];         // plotted geometry { x, y, kg, day }

  // 'YYYY-MM-DD' → Date without UTC-parsing pitfalls
  const wDate = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
  const wFmt = day => wDate(day).toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' });

  // today input + history table (today is "row 1" — the input card above the head)
  function wDrawPanel() {
    const todays = WEIGHTS.find(w => w.day === TODAY);
    document.getElementById('w-today-date').textContent = TODAY ? wFmt(TODAY) : 'Сегодня';
    const input = document.getElementById('w-input');
    if (todays && document.activeElement !== input) input.value = todays.kg.toFixed(1);

    // today is listed as the top row too (editable from the table like any day),
    // in addition to the big input card above the head
    document.getElementById('w-rows').innerHTML = WEIGHTS.length ? WEIGHTS.map(w => `
      <div class="w-row${w.day === TODAY ? ' today' : ''}">
        <span class="date">${w.day === TODAY ? 'Сегодня' : wFmt(w.day)}</span>
        <span class="kg-cell">
          <span class="kg">${w.kg.toFixed(1)}</span>
          <button class="edit" data-day="${w.day}" data-kg="${w.kg.toFixed(1)}">Изменить</button>
        </span>
      </div>`).join('')
      : `<div class="empty">Записей пока нет</div>`;
  }

  async function wLoadGraph() {
    try {
      const r = await api('GET', `/api/weight/graph?period=${wPeriod}`);
      wPoints = r.points || [];
      // re-snap, not just redraw: late-arriving content (x-axis labels, fonts)
      // may have shifted the anchor the first measurement used
      wSnap();
    } catch (e) { toast(e.message); }
  }

  function wDrawChart() {
    const svg = document.getElementById('w-chart');
    const nodata = document.getElementById('w-nodata');
    nodata.hidden = wPoints.length > 0;
    if (!wPoints.length) {
      ['w-grid', 'w-dots', 'w-xaxis'].forEach(id => document.getElementById(id).innerHTML = '');
      document.getElementById('w-curve').setAttribute('points', '');
      document.getElementById('w-area').setAttribute('points', '');
      return;
    }
    // plot in real pixel coords so dots stay circular at any graph height
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return; // panel hidden — redrawn on tab open
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const padX = 8, padTop = 18, padBottom = 22;
    const values = wPoints.map(p => p.kg);
    const min = Math.min(...values), max = Math.max(...values);
    const span = (max - min) || 1;
    const stepX = wPoints.length > 1 ? (W - padX * 2) / (wPoints.length - 1) : 0;
    wPts = wPoints.map((p, i) => ({
      x: wPoints.length > 1 ? padX + i * stepX : W / 2, // lone point sits centered
      y: padTop + (1 - (p.kg - min) / span) * (H - padTop - padBottom),
      kg: p.kg, day: p.day,
    }));
    const line = wPts.map(p => `${p.x},${p.y}`).join(' ');

    document.getElementById('w-grid').innerHTML = [0, 0.5, 1].map(t => {
      const y = padTop + t * (H - padTop - padBottom);
      return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    }).join('');
    document.getElementById('w-curve').setAttribute('points', line);
    document.getElementById('w-area').setAttribute('points',
      `${wPts[0].x},${H} ${line} ${wPts[wPts.length - 1].x},${H}`);

    // thin out dots' value labels & x-axis ticks together when the row gets crowded
    const every = wPoints.length > 8 ? 2 : 1;
    // dots + a dim, always-on kg value above each (no need to press-and-hold to read it)
    document.getElementById('w-dots').innerHTML = wPts.map((p, i) =>
      `<circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2.5"/>` +
      (i % every ? '' :
        `<text class="w-dot-lbl" x="${p.x}" y="${p.y - 10}">${p.kg.toFixed(1)}</text>`)
    ).join('');

    // x labels: weekdays / dates / months; thin out when the row gets crowded
    const lbl = d => wPeriod === 'week' ? wDate(d).toLocaleDateString('ru-RU', { weekday: 'short' })
               : wPeriod === 'year' ? wDate(d).toLocaleDateString('ru-RU', { month: 'short' })
               : wFmt(d);
    document.getElementById('w-xaxis').innerHTML =
      wPoints.map((p, i) => `<span>${i % every ? '' : lbl(p.day)}</span>`).join('');
  }

  // ── save today / edit a past day ──
  async function wSave(kg, day) {
    await api('POST', '/api/weight', day ? { kg, day } : { kg });
    await loadState();
    await wLoadGraph();
  }

  document.getElementById('w-save').addEventListener('click', async e => {
    const input = document.getElementById('w-input');
    const kg = parseFloat(input.value);
    if (isNaN(kg) || kg <= 0 || kg > 500) { input.focus(); toast('Введи вес в кг'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await wSave(kg);
      input.blur();
      toast('Вес сохранён');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });

  document.getElementById('w-rows').addEventListener('click', async e => {
    const btn = e.target.closest('.edit');
    if (!btn) return; // the extra tap required to touch history
    const next = prompt(`Вес за ${wFmt(btn.dataset.day)} (кг)`, btn.dataset.kg);
    if (next === null) return;
    const kg = parseFloat(String(next).replace(',', '.'));
    if (isNaN(kg) || kg <= 0 || kg > 500) { toast('Введи вес в кг'); return; }
    try { await wSave(kg, btn.dataset.day); } catch (err) { toast(err.message); }
  });

  document.getElementById('w-toggle').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#w-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    wPeriod = btn.dataset.period;
    wLoadGraph();
  });

  // grow the graph so the history table head snaps to the bottom (bottom_snap.md)
  const W_GRAPH_BASE = 170;
  function wSnap() {
    if (document.getElementById('panel-weight').hidden) return;
    const svg = document.getElementById('w-chart');
    const screen = document.querySelector('.screen');
    const anchor = document.querySelector('#w-history .table-head');
    svg.style.height = W_GRAPH_BASE + 'px';
    const anchorBottom = anchor.getBoundingClientRect().bottom - screen.getBoundingClientRect().top;
    const vh = (window.visualViewport && window.visualViewport.height) || document.documentElement.clientHeight;
    svg.style.height = (W_GRAPH_BASE + Math.max(0, vh - anchorBottom)) + 'px';
    wDrawChart(); // re-plot at the new height
  }

  // ── meal card popup (reusable add/edit) ──
  let editingId = null;       // null = adding a new meal
  let addingFromScan = false; // card prefilled by an AI scan — tokens already spent

  function openMeal(meal) {
    editingId = meal && meal.id ? meal.id : null;
    addingFromScan = false; // scan handlers flip this on right after opening
    const g = id => document.getElementById(id);
    g('m-name').value = meal ? (meal.name || '') : '';
    g('m-kcal').value = meal && meal.kcal != null ? meal.kcal : '';
    g('m-grams').value = meal && meal.grams != null ? meal.grams : '';
    g('m-prot').value = meal && meal.prot != null ? meal.prot : '';
    g('m-fat').value = meal && meal.fat != null ? meal.fat : '';
    g('m-carb').value = meal && meal.carb != null ? meal.carb : '';
    g('meal-fav').classList.toggle('on', !!(meal && meal.fav));
    g('meal-del').style.display = editingId ? 'flex' : 'none';
    document.getElementById('overlay').classList.add('show');
  }

  function closeMeal() {
    document.getElementById('overlay').classList.remove('show');
    editingId = null;
    addingFromScan = false;
  }

  // Dismissing (X / backdrop) an AI-scanned card must not lose it — the scan
  // already cost tokens. Auto-save it to today's meals; the user can delete it
  // from the list if it wasn't wanted. Manual cards still just close.
  async function dismissMeal() {
    if (!addingFromScan) { closeMeal(); return; }
    const data = mealPayload();
    const fav = document.getElementById('meal-fav').classList.contains('on');
    closeMeal();
    try {
      await api('POST', '/api/meal', data);
      if (fav) await api('POST', '/api/favorite', data); // the star survives the dismiss too
      await loadState();
      toast('Скан сохранён в приёмы за сегодня');
    } catch (e) { toast(e.message); }
  }

  function mealPayload() {
    const num = id => Number(document.getElementById(id).value) || 0;
    return {
      name: document.getElementById('m-name').value.trim() || 'Блюдо',
      kcal: num('m-kcal'), grams: num('m-grams'),
      prot: num('m-prot'), fat: num('m-fat'), carb: num('m-carb'),
    };
  }

  async function saveMeal() {
    const data = mealPayload();
    const fav = document.getElementById('meal-fav').classList.contains('on');
    try {
      if (editingId) await api('POST', `/api/meal/${editingId}`, data);
      else await api('POST', '/api/meal', data);
      if (fav) await api('POST', '/api/favorite', data); // star upserts the template
      closeMeal();
      await loadState();
    } catch (e) { toast(e.message); }
  }

  async function deleteMeal() {
    if (editingId == null) return;
    try {
      await api('DELETE', `/api/meal/${editingId}`);
      closeMeal();
      await loadState();
      toast('Приём удалён');
    } catch (e) { toast(e.message); }
  }

  // ── favorites picker (pick one saved meal -> eat it today) ──
  let favSelected = null; // index into FAVORITES, or null

  function openFav() {
    favSelected = null;
    drawFav();
    document.getElementById('overlay-fav').classList.add('show');
  }

  function drawFav() {
    const rows = document.getElementById('fav-rows');
    if (!FAVORITES.length) {
      rows.innerHTML = `<div class="empty">Избранного пока нет — отметь блюдо звездой ★.</div>`;
      return;
    }
    rows.innerHTML = FAVORITES.map((f, i) => `
      <div class="fav-row${i === favSelected ? ' sel' : ''}" data-i="${i}">
        <span class="fname">${esc(f.name)}</span>
        <span class="fg">${f.grams} г</span>
        <span class="fk">${Number(f.kcal).toLocaleString()}</span>
      </div>`).join('');
  }

  async function deleteFav() {
    if (favSelected == null) { toast('Сначала выбери блюдо'); return; }
    const f = FAVORITES[favSelected];
    try {
      await api('DELETE', `/api/favorite/${f.id}`);
      favSelected = null;
      await loadState();
      drawFav(); // keep the picker open
    } catch (e) { toast(e.message); }
  }

  async function acceptFav() {
    if (favSelected == null) { toast('Сначала выбери блюдо'); return; }
    const f = FAVORITES[favSelected];
    try {
      await api('POST', '/api/meal', {
        name: f.name, kcal: f.kcal, grams: f.grams, prot: f.prot, fat: f.fat, carb: f.carb,
      });
      closeOverlay('overlay-fav');
      await loadState();
    } catch (e) { toast(e.message); }
  }

  // ── AI scan (photo + text) → prefill the meal sheet for review ──
  // The full-screen loader blocks all input while the scan runs. The abort is a
  // client backstop just above the server's own 20s deadline on the Claude call,
  // so a wedged request can never freeze the app.
  const SCAN_ABORT_MS = 25000;

  const showLoading = on => document.getElementById('loading').classList.toggle('show', on);

  function scanFailed(err) {
    // quota/limit errors carry a meaningful server message; everything else
    // (timeout, network, 5xx) gets the generic "try again later"
    const msg = err && [402, 403, 429].includes(err.status) && err.message
      ? err.message
      : 'Упс, что-то пошло не так. Попробуй ещё раз позже.';
    document.getElementById('error-text').textContent = msg;
    document.getElementById('overlay-error').classList.add('show');
  }

  async function runScan(payload, btn) {
    if (btn) btn.disabled = true;
    showLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SCAN_ABORT_MS);
    try {
      return await api('POST', '/api/scan', payload, ctrl.signal);
    } finally {
      clearTimeout(timer);
      showLoading(false);
      if (btn) btn.disabled = false;
    }
  }

  const closeError = () => document.getElementById('overlay-error').classList.remove('show');
  document.getElementById('error-ok').addEventListener('click', closeError);
  document.getElementById('overlay-error').addEventListener('click', e => {
    if (e.target.id === 'overlay-error') closeError();
  });

  // ── toast ──
  let toastT;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ── header: pill tabs ──
  document.getElementById('navTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('#navTabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    document.getElementById('panel-scaner').hidden = which !== 'scaner';
    document.getElementById('panel-weight').hidden = which !== 'weight';
    document.getElementById('panel-credits').hidden = which !== 'credits';
    if (which === 'scaner') snapTableToBottom();
    if (which === 'weight') { requestAnimationFrame(wSnap); wLoadGraph(); }
  });

  // ── sources row ──
  document.getElementById('sources').addEventListener('click', e => {
    const btn = e.target.closest('.source');
    if (!btn) return;
    const src = btn.dataset.src;
    if (src === 'manual') { openMeal(null); return; }
    if (src === 'photo') { openOverlay('overlay-photo'); return; }
    if (src === 'text') { openOverlay('overlay-text'); return; }
    openFav();
  });

  // ── favorites picker wiring ──
  document.getElementById('fav-rows').addEventListener('click', e => {
    const row = e.target.closest('.fav-row');
    if (!row) return;
    favSelected = Number(row.dataset.i);
    drawFav();
  });
  document.getElementById('fav-accept').addEventListener('click', acceptFav);
  document.getElementById('fav-del').addEventListener('click', deleteFav);
  document.getElementById('overlay-fav').addEventListener('click', e => {
    if (e.target.id === 'overlay-fav' || e.target.closest('[data-close-fav]')) closeOverlay('overlay-fav');
  });

  // ── AI photo: live camera, capture, gallery ──
  let camStream = null;
  async function startCamera() {
    const vf = document.getElementById('viewfinder');
    const video = document.getElementById('cam');
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = camStream;
      await video.play();
      vf.classList.add('live');
    } catch (_) {
      vf.classList.remove('live'); // denied / no camera / insecure context
    }
  }
  function stopCamera() {
    const vf = document.getElementById('viewfinder');
    const video = document.getElementById('cam');
    vf.classList.remove('live');
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    if (video) video.srcObject = null;
  }

  // capture the current video frame as base64 jpeg (no data: prefix)
  function captureFrame() {
    const video = document.getElementById('cam');
    if (!video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  async function scanPhoto(base64, btn) {
    try {
      const result = await runScan({ mode: 'photo', image: base64, media_type: 'image/jpeg' }, btn);
      closeOverlay('overlay-photo');
      openMeal(result); // prefilled, adding — user reviews and saves
      addingFromScan = true;
    } catch (e) { scanFailed(e); }
  }

  document.getElementById('photo-take').addEventListener('click', e => {
    const base64 = captureFrame();
    if (!base64) { toast('Камера недоступна — выбери фото из галереи'); return; }
    scanPhoto(base64, e.currentTarget);
  });

  document.getElementById('photo-file').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1];
      scanPhoto(base64, null);
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-picking the same file
  });

  // ── AI text ──
  document.getElementById('text-send').addEventListener('click', async e => {
    const ta = document.getElementById('text-desc');
    const desc = ta.value.trim();
    if (!desc) { toast('Опиши блюдо'); return; }
    try {
      const result = await runScan({ mode: 'text', text: desc }, e.currentTarget);
      closeOverlay('overlay-text');
      openMeal(result);
      addingFromScan = true;
    } catch (err) { scanFailed(err); }
  });

  // ── generic overlays (text/photo) ──
  function openOverlay(id) {
    document.getElementById(id).classList.add('show');
    if (id === 'overlay-photo') startCamera();
  }
  function closeOverlay(id) {
    document.getElementById(id).classList.remove('show');
    if (id === 'overlay-photo') stopCamera();
    if (id === 'overlay-text') document.getElementById('text-desc').value = '';
  }
  document.querySelectorAll('#overlay-text, #overlay-photo, #overlay-goals, #overlay-pro').forEach(ov => {
    ov.addEventListener('click', e => {
      if (e.target === ov || e.target.closest('[data-close]')) closeOverlay(ov.id);
    });
  });

  // ── meal sheet wiring ──
  document.getElementById('history-rows').addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const m = MEALS.find(x => x.id === Number(row.dataset.id));
    if (m) openMeal(m);
  });
  document.getElementById('meal-close').addEventListener('click', dismissMeal);
  document.getElementById('meal-save').addEventListener('click', saveMeal);
  document.getElementById('meal-del').addEventListener('click', deleteMeal);
  document.getElementById('meal-fav').addEventListener('click', e => e.currentTarget.classList.toggle('on'));
  document.getElementById('overlay').addEventListener('click', e => {
    if (e.target.id === 'overlay') dismissMeal();
  });

  // ── bottom-snap (skeleton/bottom_snap.md) ──
  // The donut card is the flexible element (the doc's "graph"). We grow it to absorb the
  // free space so the meals table HEADER snaps to the very bottom edge — it just peeks, so
  // the user sees a table exists and can scroll up to reveal today's rows, while the donut
  // stays big and airy. Pinning the header (not the whole list) is what keeps the donut
  // from collapsing. Measured, so it adapts to any resolution and re-runs on resize/rotate.
  function snapTableToBottom() {
    const panel = document.getElementById('panel-scaner');
    if (panel.hidden) return;                                  // only on the active panel
    const card = document.getElementById('donut-card');        // flexible element
    const screen = document.querySelector('.screen');          // scroll column
    const anchor = panel.querySelector('#history .table-head'); // edge to pin: the table "hat"

    card.style.height = '';                                    // 1) reset to natural minimum

    // 2) anchor bottom, measured from the column top — scroll-independent
    const anchorBottom = anchor.getBoundingClientRect().bottom - screen.getBoundingClientRect().top;

    // 3) pour the leftover space into the donut card; visualViewport (not clientHeight) so
    //    the mobile toolbar is accounted for. Clamp >= 0 → short screens just scroll.
    const vh = (window.visualViewport && window.visualViewport.height) || document.documentElement.clientHeight;
    const slack = vh - anchorBottom;
    if (slack > 0) card.style.height = (card.offsetHeight + slack) + 'px';
  }
  // Re-snap only while parked at the top. Mobile browsers fire (visual)viewport
  // resizes mid-swipe (toolbar collapse/expand): re-snapping then grows/shrinks
  // the page under the finger and re-pins the table head to the new bottom —
  // every swipe gets undone and the page feels unscrollable.
  function resnapIfTop() { if (window.scrollY <= 4) { snapTableToBottom(); wSnap(); } }
  window.addEventListener('resize', resnapIfTop);
  window.addEventListener('orientationchange', () => { snapTableToBottom(); wSnap(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resnapIfTop);

  // ── init ──
  drawHistory();
  drawToday();
  requestAnimationFrame(snapTableToBottom);
  loadState().catch(e => toast(e.message));
})();
