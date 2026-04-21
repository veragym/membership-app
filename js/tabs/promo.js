/**
 * 업무/홍보/센터 관리 탭
 * 하위 4개: 업무관리 / 홍보관리 / 센터관리 / 메뉴얼생성
 *
 * 업무관리:
 *   - 좌 2/5: 일정표 (오늘/내일 2일 · 30분 · staff_schedules)
 *     + [시간표 공유] 버튼 — html2canvas로 PNG 다운로드
 *   - 우 3/5:
 *       · 예약자 리스트 (최대 10개 · sessionStorage · inquiries 자동완성)
 *         ※ 일회성 데이터 — DB에 절대 쓰지 않음. 문의관리에 영향 없음.
 *       · 예정 업무 리스트
 */
const PromoTab = (() => {
  const CAL_START_H = 6, CAL_END_H = 23, CAL_SLOT_PX = 64;
  const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const TYPE_COLORS = {
    업무: '#10B981', 홍보: '#EC4899', 청소: '#3B82F6', 식사: '#F59E0B', 기타: '#6B7280'
  };
  const TYPE_OPTIONS = ['업무', '홍보', '청소', '식사', '기타'];

  const RESV_STORAGE_KEY = 'promo.reservations';
  const RESV_MAX = 10;

  let activeSubTab = 'ops';
  let scheduleData = [];
  let reservations = [];
  let _suggestionTimer = null;

  function init() {
    reservations = loadReservations();
    renderLayout();
    loadSubTab(activeSubTab);
  }

  function renderLayout() {
    const pane = document.getElementById('tab-promo');
    pane.innerHTML = `
      <div class="stats-subtab-bar">
        <button class="stats-subtab ${activeSubTab === 'ops' ? 'active' : ''}" data-tab="ops">업무관리</button>
        <button class="stats-subtab ${activeSubTab === 'promo' ? 'active' : ''}" data-tab="promo">홍보관리</button>
        <button class="stats-subtab ${activeSubTab === 'center' ? 'active' : ''}" data-tab="center">센터관리</button>
        <button class="stats-subtab ${activeSubTab === 'manual' ? 'active' : ''}" data-tab="manual">메뉴얼생성</button>
      </div>
      <div id="promo-content"></div>
    `;
    pane.querySelectorAll('.stats-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeSubTab = btn.dataset.tab;
        pane.querySelectorAll('.stats-subtab').forEach(b => b.classList.toggle('active', b === btn));
        loadSubTab(activeSubTab);
      });
    });
  }

  function loadSubTab(tab) {
    const c = document.getElementById('promo-content');
    if (tab === 'ops') renderOps(c);
    else if (tab === 'promo') renderPromo(c);
    else if (tab === 'center') renderCenter(c);
    else if (tab === 'manual') renderManual(c);
  }

  // ───────── 업무관리 ─────────
  function renderOps(container) {
    container.innerHTML = `
      <div class="ops-layout">
        <div class="ops-panel">
          <div class="ops-panel-header">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="ops-panel-title">일정표</span>
              <button type="button" class="btn-share-sched" id="btnShareSched" title="PC 화면용 PNG 자동 저장">📷 시간표 공유</button>
            </div>
            <span style="font-size:11px;color:var(--color-text-muted)">오늘·내일 · 30분 단위</span>
          </div>
          <div class="ops-panel-body">
            <div class="ops-cal-wrap" id="opsCalWrap">
              <div class="ops-cal-date-row" id="opsCalDateRow"></div>
              <div class="ops-cal-grid-scroll" id="opsCalGridScroll">
                <div class="ops-cal-grid ops-cal-grid-2d" id="opsCalGrid"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="ops-right-col">
          <div class="ops-panel">
            <div class="ops-panel-header">
              <span class="ops-panel-title">예약자 리스트</span>
              <span style="font-size:11px;color:var(--color-text-muted)">일회성 · 최대 10개 · 새로고침 후에도 창 닫기 전까지 유지</span>
            </div>
            <div class="ops-panel-body" id="resvListBody"></div>
          </div>
          <div class="ops-panel">
            <div class="ops-panel-header">
              <span class="ops-panel-title">예정 업무 (오늘 이후)</span>
            </div>
            <div class="ops-panel-body" id="opsUpcomingList">
              <div class="ops-placeholder">불러오는 중…</div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btnShareSched').addEventListener('click', shareScheduleImage);
    renderReservations();
    loadScheduleView();
  }

  // ═══ 날짜/시간 헬퍼 ═══
  function getCalDates() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return [0, 1].map(i => { const d = new Date(t); d.setDate(d.getDate() + i); return d; });
  }
  function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function timeToY(hh, mm) { return ((hh - CAL_START_H) + mm/60) * CAL_SLOT_PX; }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function loadScheduleView() {
    const dates = getCalDates();
    const from = toYMD(dates[0]), to = toYMD(dates[dates.length - 1]);
    const { data, error } = await supabase
      .from('staff_schedules')
      .select('id, staff_id, sched_date, start_time, end_time, type, title, notes, color, status')
      .gte('sched_date', from).lte('sched_date', to)
      .neq('status', 'cancelled')
      .order('sched_date').order('start_time');
    if (error) {
      Toast.error('일정 불러오기 실패: ' + error.message);
      scheduleData = [];
    } else {
      scheduleData = data || [];
    }
    renderCalGrid(dates);
    renderUpcoming();
  }

  function renderCalGrid(dates) {
    const todayYMD = toYMD(new Date()), now = new Date(), nowH = now.getHours(), nowM = now.getMinutes();
    const TOTAL_PX = (CAL_END_H - CAL_START_H + 1) * CAL_SLOT_PX;

    const dateRow = document.getElementById('opsCalDateRow');
    if (!dateRow) return;
    dateRow.innerHTML = '<div class="ops-cal-gutter"></div>' +
      dates.map((d, i) => {
        const isToday = i === 0;
        const label = isToday ? '오늘' : '내일';
        return `<div class="ops-cal-day-hdr${isToday ? ' today' : ''}">
          <div class="ops-cal-dhdr-name">${label} · ${DAY_KO[d.getDay()]}</div>
          <div class="ops-cal-dhdr-num">${d.getMonth()+1}/${d.getDate()}</div>
        </div>`;
      }).join('');

    let timeCol = `<div class="ops-cal-time-col" style="height:${TOTAL_PX}px">`;
    for (let h = CAL_START_H; h <= CAL_END_H; h++) {
      const y = timeToY(h, 0);
      const lbl = h < 12 ? `오전 ${h}시` : h === 12 ? `오후 12시` : `오후 ${h-12}시`;
      const transform = h === CAL_START_H ? 'translateY(2px)' : 'translateY(-50%)';
      timeCol += `<div class="ops-cal-time-label" style="top:${y}px;transform:${transform}">${lbl}</div>`;
    }
    timeCol += `</div>`;

    const dayCols = dates.map(d => {
      const ymd = toYMD(d), isToday = ymd === todayYMD;
      let col = `<div class="ops-cal-day-col-body" style="height:${TOTAL_PX}px">`;
      for (let h = CAL_START_H; h <= CAL_END_H; h++) {
        const y0 = timeToY(h, 0), y30 = timeToY(h, 30);
        const t00 = `${String(h).padStart(2,'0')}:00`, t30 = `${String(h).padStart(2,'0')}:30`;
        const past00 = isToday && (h < nowH || (h === nowH && nowM >= 60));
        const past30 = isToday && (h < nowH || (h === nowH && nowM >= 30));
        col += `<div class="ops-cal-gridline-hr" style="top:${y0}px"></div>`;
        col += `<div class="ops-cal-click-zone${past00 ? ' past' : ''}" style="top:${y0}px;height:${CAL_SLOT_PX/2}px" data-ymd="${ymd}" data-time="${t00}"></div>`;
        col += `<div class="ops-cal-gridline-half" style="top:${y30}px"></div>`;
        col += `<div class="ops-cal-click-zone${past30 ? ' past' : ''}" style="top:${y30}px;height:${CAL_SLOT_PX/2}px" data-ymd="${ymd}" data-time="${t30}"></div>`;
      }
      col += `<div class="ops-cal-gridline-hr" style="top:${TOTAL_PX}px"></div>`;

      scheduleData.filter(s => s.sched_date === ymd).forEach(s => {
        const [sh, sm] = s.start_time.split(':').map(Number);
        let eh, em;
        if (s.end_time) { [eh, em] = s.end_time.split(':').map(Number); } else { eh = sh + 1; em = sm; }
        const top = timeToY(sh, sm);
        const dur = (eh - sh) + (em - sm)/60;
        const height = Math.max(dur * CAL_SLOT_PX, 20);
        const sType = s.type || '업무';
        const evBg = s.color || TYPE_COLORS[sType] || TYPE_COLORS['업무'];
        const title = s.title || sType;
        const sub = s.notes || (s.title ? sType : '');
        col += `<div class="ops-cal-event" style="background:${evBg}dd;top:${top}px;height:${height}px;" data-sched-id="${s.id}">
          <div class="ops-cal-event-title">${esc(title)}</div>
          ${sub ? `<div class="ops-cal-event-sub">${esc(sub)}</div>` : ''}
        </div>`;
      });

      if (isToday) {
        const ny = timeToY(nowH, nowM);
        if (ny >= 0 && ny <= TOTAL_PX) col += `<div class="ops-cal-now-line" style="top:${ny}px"></div>`;
      }
      col += `</div>`;
      return col;
    }).join('');

    const grid = document.getElementById('opsCalGrid');
    grid.innerHTML = timeCol + dayCols;

    grid.querySelectorAll('.ops-cal-click-zone:not(.past)').forEach(z => {
      z.addEventListener('click', () => openSchedModal(null, z.dataset.ymd, z.dataset.time));
    });
    grid.querySelectorAll('.ops-cal-event').forEach(ev => {
      ev.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = ev.dataset.schedId;
        const row = scheduleData.find(s => s.id === id);
        if (row) openSchedModal(row);
      });
    });

    const scroll = document.getElementById('opsCalGridScroll');
    if (scroll) scroll.scrollTop = Math.max(0, timeToY(Math.max(CAL_START_H, nowH - 1), 0));
  }

  // ═══ 시간표 이미지 공유 ═══
  async function shareScheduleImage() {
    if (typeof html2canvas === 'undefined') {
      Toast.error('이미지 라이브러리 로드 실패 — 새로고침 후 재시도해주세요.');
      return;
    }
    const wrap = document.getElementById('opsCalWrap');
    if (!wrap) return;
    const btn = document.getElementById('btnShareSched');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '생성 중…';
    try {
      // ── 캡처용 임시 컨테이너: 헤더 + 스케줄 본문 ──
      const dates = getCalDates();
      const dateLabel = dates.map(d => `${d.getMonth()+1}/${d.getDate()}(${DAY_KO[d.getDay()]})`).join(' · ');
      const totalPx = (CAL_END_H - CAL_START_H + 1) * CAL_SLOT_PX;
      const exportEl = document.createElement('div');
      exportEl.style.cssText = `position:fixed;left:-10000px;top:0;background:#fff;padding:24px;width:880px;font-family:'Pretendard Variable',sans-serif;`;
      exportEl.innerHTML = `
        <div style="text-align:center;margin-bottom:14px;">
          <div style="font-size:20px;font-weight:700;color:#111">베라짐 상담 업무 시간표</div>
          <div style="font-size:12px;color:#666;margin-top:4px">${dateLabel} · 상담팀</div>
        </div>
      `;
      const clone = wrap.cloneNode(true);
      // 스크롤 영역을 전체 높이로 펼침
      const scroll = clone.querySelector('.ops-cal-grid-scroll');
      if (scroll) { scroll.style.maxHeight = 'none'; scroll.style.overflow = 'visible'; scroll.style.height = (totalPx + 40) + 'px'; }
      // click-zone / now-line 은 캡처에서 제거
      clone.querySelectorAll('.ops-cal-click-zone, .ops-cal-now-line').forEach(n => n.remove());
      exportEl.appendChild(clone);
      document.body.appendChild(exportEl);

      const canvas = await html2canvas(exportEl, { backgroundColor: '#ffffff', scale: 2, logging: false, useCORS: true });
      document.body.removeChild(exportEl);

      const ymd = toYMD(new Date());
      const filename = `베라짐_상담업무시간표_${ymd}.png`;

      // ── 클립보드 복사 시도 (있으면 즉시 카카오톡 붙여넣기 가능) ──
      let copied = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copied = true;
        }
      } catch (_) { /* fallback to download */ }

      // ── 다운로드도 함께 (파일로도 남김) ──
      const link = document.createElement('a');
      link.download = filename;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link); link.click(); document.body.removeChild(link);

      Toast.success(copied
        ? '이미지 복사 + 다운로드 완료 — 카카오톡에 붙여넣기(Ctrl+V) 또는 파일 첨부'
        : '이미지 다운로드 완료 — 카카오톡에 파일 첨부');
    } catch (e) {
      Toast.error('이미지 생성 실패: ' + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ═══ 예정 업무 리스트 ═══
  function renderUpcoming() {
    const el = document.getElementById('opsUpcomingList');
    if (!el) return;
    const todayYMD = toYMD(new Date());
    const upcoming = scheduleData.filter(s => s.sched_date >= todayYMD);
    if (!upcoming.length) {
      el.innerHTML = '<div class="ops-placeholder">예정된 업무가 없습니다.</div>';
      return;
    }
    el.innerHTML = `<div class="ops-upcoming-list">` + upcoming.map(s => {
      const bg = s.color || TYPE_COLORS[s.type] || TYPE_COLORS['업무'];
      return `<div class="ops-upcoming-item" data-sched-id="${s.id}">
        <div class="ops-upcoming-chip" style="background:${bg}">${esc(s.type)}</div>
        <div class="ops-upcoming-main">
          <div class="ops-upcoming-title">${esc(s.title || s.type)}</div>
          <div class="ops-upcoming-meta">${s.sched_date} · ${s.start_time.slice(0,5)}${s.end_time ? '–' + s.end_time.slice(0,5) : ''}</div>
          ${s.notes ? `<div class="ops-upcoming-notes">${esc(s.notes)}</div>` : ''}
        </div>
      </div>`;
    }).join('') + `</div>`;
    el.querySelectorAll('.ops-upcoming-item').forEach(it => {
      it.addEventListener('click', () => {
        const row = scheduleData.find(s => s.id === it.dataset.schedId);
        if (row) openSchedModal(row);
      });
    });
  }

  // ═══ 일정 등록/수정 모달 ═══
  function openSchedModal(row, defaultDate, defaultTime) {
    const isEdit = !!row;
    const dateVal = isEdit ? row.sched_date : defaultDate;
    const startVal = isEdit ? row.start_time.slice(0,5) : defaultTime;
    const endVal = isEdit && row.end_time ? row.end_time.slice(0,5) : addMinutes(startVal, 30);
    const typeVal = isEdit ? row.type : '업무';
    const titleVal = isEdit ? (row.title || '') : '';
    const notesVal = isEdit ? (row.notes || '') : '';

    Modal.open({
      type: 'center', size: 'md',
      title: isEdit ? '일정 수정' : '일정 등록',
      html: `
        <form id="schedForm" class="sched-form">
          <div class="form-row">
            <label>유형</label>
            <div class="sched-type-pills">
              ${TYPE_OPTIONS.map(t => `<button type="button" class="sched-type-pill ${t === typeVal ? 'active' : ''}" data-type="${t}" style="--pill-color:${TYPE_COLORS[t]}">${t}</button>`).join('')}
            </div>
            <input type="hidden" name="type" value="${typeVal}">
          </div>
          <div class="form-row">
            <label>제목</label>
            <input type="text" name="title" value="${esc(titleVal)}" placeholder="예: 팀 회의, 전단지 배포" maxlength="100">
          </div>
          <div class="form-row-2">
            <div class="form-row"><label>날짜</label><input type="date" name="sched_date" value="${dateVal}" required></div>
            <div class="form-row"><label>시작</label><input type="time" name="start_time" value="${startVal}" step="1800" required></div>
            <div class="form-row"><label>종료</label><input type="time" name="end_time" value="${endVal}" step="1800"></div>
          </div>
          <div class="form-row">
            <label>메모</label>
            <textarea name="notes" rows="3" placeholder="세부 내용">${esc(notesVal)}</textarea>
          </div>
          <div class="sched-form-actions">
            ${isEdit ? `<button type="button" class="btn btn-danger" id="schedDelBtn">삭제</button>` : ''}
            <button type="button" class="btn btn-secondary" id="schedCancelBtn">취소</button>
            <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        const pills = el.querySelectorAll('.sched-type-pill');
        const typeInput = el.querySelector('input[name="type"]');
        pills.forEach(p => p.addEventListener('click', () => {
          pills.forEach(x => x.classList.toggle('active', x === p));
          typeInput.value = p.dataset.type;
        }));
        el.querySelector('#schedCancelBtn').addEventListener('click', () => Modal.close());
        if (isEdit) el.querySelector('#schedDelBtn').addEventListener('click', () => handleSchedDelete(row.id));
        el.querySelector('#schedForm').addEventListener('submit', (e) => {
          e.preventDefault();
          handleSchedSubmit(e.target, isEdit ? row.id : null);
        });
      }
    });
  }

  function addMinutes(hhmm, mins) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + mins;
    const h2 = Math.min(23, Math.floor(total / 60));
    const m2 = total % 60;
    return `${String(h2).padStart(2,'0')}:${String(m2).padStart(2,'0')}`;
  }

  async function handleSchedSubmit(form, editId) {
    const fd = new FormData(form);
    const staff = Auth.getTrainer();
    if (!staff) { Toast.error('로그인 정보를 확인할 수 없습니다.'); return; }
    const payload = {
      staff_id: staff.id,
      sched_date: fd.get('sched_date'),
      start_time: fd.get('start_time'),
      end_time: fd.get('end_time') || null,
      type: fd.get('type'),
      title: (fd.get('title') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
      color: TYPE_COLORS[fd.get('type')] || TYPE_COLORS['업무'],
    };
    if (!payload.sched_date || !payload.start_time) { Toast.error('날짜와 시작 시각은 필수입니다.'); return; }
    if (payload.end_time && payload.end_time <= payload.start_time) { Toast.error('종료 시각이 시작보다 늦어야 합니다.'); return; }
    let error;
    if (editId) ({ error } = await supabase.from('staff_schedules').update(payload).eq('id', editId));
    else ({ error } = await supabase.from('staff_schedules').insert(payload));
    if (error) { Toast.error('저장 실패: ' + error.message); return; }
    Toast.success(editId ? '수정되었습니다' : '등록되었습니다');
    Modal.close();
    loadScheduleView();
  }

  async function handleSchedDelete(id) {
    if (!confirm('이 일정을 삭제하시겠습니까?')) return;
    const { error } = await supabase.from('staff_schedules').delete().eq('id', id);
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    Toast.success('삭제되었습니다');
    Modal.close();
    loadScheduleView();
  }

  // ═══════════════════════════════════════════════
  // 예약자 리스트 (sessionStorage · 일회성 · DB 미저장)
  // ═══════════════════════════════════════════════
  function loadReservations() {
    try {
      const raw = sessionStorage.getItem(RESV_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, RESV_MAX) : [];
    } catch (_) { return []; }
  }
  function saveReservations() {
    try { sessionStorage.setItem(RESV_STORAGE_KEY, JSON.stringify(reservations)); } catch (_) {}
  }

  function renderReservations() {
    const body = document.getElementById('resvListBody');
    if (!body) return;
    const atMax = reservations.length >= RESV_MAX;
    const rows = reservations.map((r, i) => renderResvRow(r, i, false)).join('');
    const addRow = !atMax ? renderResvRow({ name:'', phone:'', content:'', status:'pending' }, reservations.length, true) : '';
    body.innerHTML = `
      <div class="resv-table">
        <div class="resv-head">
          <div>이름</div><div>연락처</div><div>내용</div><div style="text-align:center">상태</div><div></div>
        </div>
        ${rows}
        ${addRow}
        ${atMax ? '<div class="resv-cap-note">※ 최대 10건까지 등록됩니다. 삭제 후 추가하세요.</div>' : ''}
      </div>
    `;
    bindResvEvents();
  }

  function renderResvRow(r, idx, isAdd) {
    const status = r.status || 'pending';
    const statusLabel = status === 'completed' ? '상담완료' : '미완료';
    return `
      <div class="resv-row ${isAdd ? 'resv-row-add' : ''}" data-idx="${idx}">
        <div class="resv-cell">
          <input type="text" class="resv-input" data-field="name" value="${esc(r.name||'')}" placeholder="${isAdd ? '이름 입력' : ''}" autocomplete="off">
          <div class="resv-suggest" data-for="name"></div>
        </div>
        <div class="resv-cell">
          <input type="text" class="resv-input" data-field="phone" value="${esc(r.phone||'')}" placeholder="${isAdd ? '010-…' : ''}" autocomplete="off" inputmode="numeric">
          <div class="resv-suggest" data-for="phone"></div>
        </div>
        <div class="resv-cell">
          <input type="text" class="resv-input" data-field="content" value="${esc(r.content||'')}" placeholder="${isAdd ? '상담 내용' : ''}">
        </div>
        <div class="resv-cell" style="display:flex;align-items:center;justify-content:center">
          ${isAdd ? '<span class="resv-status-placeholder">—</span>' :
            `<button type="button" class="resv-status-btn ${status}" data-action="status">${statusLabel}</button>`}
        </div>
        <div class="resv-cell" style="display:flex;align-items:center;justify-content:center">
          ${isAdd ? '' : `<button type="button" class="resv-del-btn" data-action="del" title="삭제">-</button>`}
        </div>
      </div>
    `;
  }

  function bindResvEvents() {
    const body = document.getElementById('resvListBody');
    if (!body) return;
    body.querySelectorAll('.resv-row').forEach(row => {
      const idx = Number(row.dataset.idx);
      const isAdd = row.classList.contains('resv-row-add');

      row.querySelectorAll('.resv-input').forEach(inp => {
        const field = inp.dataset.field;
        inp.addEventListener('input', () => {
          if (isAdd) {
            // 빈 행에서 입력 시작 → 첫 입력이 저장될 때까지 대기 (blur 또는 Enter 시 저장)
            if (field === 'name' || field === 'phone') triggerSuggest(row, field, inp.value);
          } else {
            reservations[idx][field] = inp.value;
            saveReservations();
            if (field === 'name' || field === 'phone') triggerSuggest(row, field, inp.value);
          }
        });
        inp.addEventListener('blur', () => {
          setTimeout(() => closeSuggest(row, field), 150);
          if (isAdd) commitAddRow(row);
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') closeSuggest(row, field);
        });
      });

      const statusBtn = row.querySelector('[data-action="status"]');
      if (statusBtn) {
        statusBtn.addEventListener('click', () => {
          const cur = reservations[idx].status || 'pending';
          reservations[idx].status = cur === 'completed' ? 'pending' : 'completed';
          saveReservations();
          renderReservations();
        });
      }
      const delBtn = row.querySelector('[data-action="del"]');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          reservations.splice(idx, 1);
          saveReservations();
          renderReservations();
        });
      }
    });
  }

  function commitAddRow(row) {
    const name = row.querySelector('[data-field="name"]').value.trim();
    const phone = row.querySelector('[data-field="phone"]').value.trim();
    const content = row.querySelector('[data-field="content"]').value.trim();
    if (!name && !phone && !content) return; // 빈 행 무시
    if (reservations.length >= RESV_MAX) return;
    reservations.push({ name, phone, content, status: 'pending' });
    saveReservations();
    renderReservations();
  }

  // ─── 문의관리 자동완성 (DB 읽기만, 쓰기 없음) ───
  function triggerSuggest(row, field, query) {
    if (_suggestionTimer) clearTimeout(_suggestionTimer);
    const q = (query || '').trim();
    if (q.length < 1) { closeSuggest(row, field); return; }
    _suggestionTimer = setTimeout(() => fetchSuggestions(row, field, q), 220);
  }

  async function fetchSuggestions(row, field, q) {
    const col = field === 'name' ? 'name' : 'phone';
    const pattern = field === 'phone' ? q.replace(/[^0-9]/g, '') : q;
    if (!pattern) { closeSuggest(row, field); return; }
    const { data, error } = await supabase
      .from('inquiries')
      .select('id, name, phone')
      .ilike(col, `${pattern}%`)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return;
    const seen = new Set();
    const uniq = [];
    (data || []).forEach(r => {
      const key = `${r.name || ''}|${r.phone || ''}`;
      if (!seen.has(key)) { seen.add(key); uniq.push(r); }
    });
    showSuggest(row, field, uniq.slice(0, 6));
  }

  function showSuggest(row, field, items) {
    const box = row.querySelector(`.resv-suggest[data-for="${field}"]`);
    if (!box) return;
    if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = items.map(r =>
      `<div class="resv-suggest-item" data-name="${esc(r.name||'')}" data-phone="${esc(r.phone||'')}">
        <span class="s-name">${esc(r.name || '-')}</span>
        <span class="s-phone">${esc(r.phone || '')}</span>
      </div>`
    ).join('');
    box.style.display = 'block';
    box.querySelectorAll('.resv-suggest-item').forEach(it => {
      it.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const name = it.dataset.name, phone = it.dataset.phone;
        row.querySelector('[data-field="name"]').value = name;
        row.querySelector('[data-field="phone"]').value = phone;
        box.style.display = 'none';
        // 저장
        if (row.classList.contains('resv-row-add')) commitAddRow(row);
        else {
          const idx = Number(row.dataset.idx);
          reservations[idx].name = name;
          reservations[idx].phone = phone;
          saveReservations();
          renderReservations();
        }
      });
    });
  }

  function closeSuggest(row, field) {
    const box = row.querySelector(`.resv-suggest[data-for="${field}"]`);
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }

  // ───────── 홍보관리 ─────────
  function renderPromo(container) {
    container.innerHTML = `
      <div class="stats-grid">
        <div class="stats-card"><div class="stats-card-icon">📢</div><h4>홍보 캠페인 관리</h4><p>전단지, 온라인 광고, 제휴업체 등 캠페인별 등록 및 집행 현황</p></div>
        <div class="stats-card"><div class="stats-card-icon">📍</div><h4>지역별 홍보 효과</h4><p>거주지 데이터와 유입경로를 교차하여 지역별 홍보 효과 분석</p></div>
        <div class="stats-card"><div class="stats-card-icon">💸</div><h4>홍보 비용 대비 성과</h4><p>캠페인별 투입 비용 대비 문의 건수 및 전환율(ROI) 추적</p></div>
        <div class="stats-card"><div class="stats-card-icon">📋</div><h4>전단지 배포 기록</h4><p>배포 일자, 장소, 수량, 반응률 기록 및 이력 관리</p></div>
      </div>
    `;
  }
  function renderCenter(container) { container.innerHTML = `<div class="ops-placeholder">센터관리 — 준비 중</div>`; }
  function renderManual(container) { container.innerHTML = `<div class="ops-placeholder">메뉴얼생성 — 준비 중</div>`; }

  return { init };
})();
