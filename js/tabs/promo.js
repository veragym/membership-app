/**
 * 업무/홍보/센터 관리 탭
 * 하위 4개 탭: 업무관리 / 홍보관리 / 센터관리 / 메뉴얼생성
 *
 * 업무관리:
 *   - 1/3 영역: 일정표 (30분 단위 · 4일, 라이트 테마)
 *   - 2/3 영역: 오늘 이후 업무 목록 (placeholder)
 *   - DB: public.staff_schedules (트레이너 schedules와 분리)
 *   - 작성자(staff_id) = 로그인한 상담 직원(Auth.getTrainer().id)
 */
const PromoTab = (() => {
  const CAL_START_H = 6, CAL_END_H = 23, CAL_SLOT_PX = 56;
  const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const TYPE_COLORS = {
    업무: '#10B981', 홍보: '#EC4899', 청소: '#3B82F6', 식사: '#F59E0B', 기타: '#6B7280'
  };
  const TYPE_OPTIONS = ['업무', '홍보', '청소', '식사', '기타'];

  let activeSubTab = 'ops';
  let scheduleData = [];

  function init() {
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
            <span class="ops-panel-title">일정표</span>
            <span style="font-size:11px;color:var(--color-text-muted)">30분 단위 · 4일 · 빈 칸 클릭해서 등록</span>
          </div>
          <div class="ops-panel-body">
            <div class="ops-cal-wrap">
              <div class="ops-cal-date-row" id="opsCalDateRow"></div>
              <div class="ops-cal-grid-scroll" id="opsCalGridScroll">
                <div class="ops-cal-grid" id="opsCalGrid"></div>
              </div>
            </div>
          </div>
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
    `;
    loadScheduleView();
  }

  function getCalDates() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return [-1, 0, 1, 2].map(i => { const d = new Date(t); d.setDate(d.getDate() + i); return d; });
  }
  function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function timeToY(hh, mm) { return ((hh - CAL_START_H) + mm/60) * CAL_SLOT_PX; }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function loadScheduleView() {
    const dates = getCalDates();
    const from = toYMD(dates[0]), to = toYMD(dates[3]);
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
      dates.map(d => {
        const isToday = toYMD(d) === todayYMD;
        const isPast  = toYMD(d) < todayYMD;
        return `<div class="ops-cal-day-hdr${isToday ? ' today' : isPast ? ' past' : ''}">
          <div class="ops-cal-dhdr-name">${DAY_KO[d.getDay()]}</div>
          <div class="ops-cal-dhdr-num">${d.getDate()}</div>
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

  // ─── 예정 업무 리스트 (우측 2/3) ───
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

  // ─── 등록/수정 모달 ───
  function openSchedModal(row, defaultDate, defaultTime) {
    const isEdit = !!row;
    const dateVal = isEdit ? row.sched_date : defaultDate;
    const startVal = isEdit ? row.start_time.slice(0,5) : defaultTime;
    const endVal = isEdit && row.end_time ? row.end_time.slice(0,5) : addMinutes(startVal, 30);
    const typeVal = isEdit ? row.type : '업무';
    const titleVal = isEdit ? (row.title || '') : '';
    const notesVal = isEdit ? (row.notes || '') : '';

    Modal.open({
      type: 'center',
      size: 'md',
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
            <div class="form-row">
              <label>날짜</label>
              <input type="date" name="sched_date" value="${dateVal}" required>
            </div>
            <div class="form-row">
              <label>시작</label>
              <input type="time" name="start_time" value="${startVal}" step="1800" required>
            </div>
            <div class="form-row">
              <label>종료</label>
              <input type="time" name="end_time" value="${endVal}" step="1800">
            </div>
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
        if (isEdit) {
          el.querySelector('#schedDelBtn').addEventListener('click', () => handleDelete(row.id));
        }
        el.querySelector('#schedForm').addEventListener('submit', (e) => {
          e.preventDefault();
          handleSubmit(e.target, isEdit ? row.id : null);
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

  async function handleSubmit(form, editId) {
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
    if (!payload.sched_date || !payload.start_time) {
      Toast.error('날짜와 시작 시각은 필수입니다.');
      return;
    }
    if (payload.end_time && payload.end_time <= payload.start_time) {
      Toast.error('종료 시각이 시작보다 늦어야 합니다.');
      return;
    }

    let error;
    if (editId) {
      ({ error } = await supabase.from('staff_schedules').update(payload).eq('id', editId));
    } else {
      ({ error } = await supabase.from('staff_schedules').insert(payload));
    }
    if (error) { Toast.error('저장 실패: ' + error.message); return; }
    Toast.success(editId ? '수정되었습니다' : '등록되었습니다');
    Modal.close();
    loadScheduleView();
  }

  async function handleDelete(id) {
    if (!confirm('이 일정을 삭제하시겠습니까?')) return;
    const { error } = await supabase.from('staff_schedules').delete().eq('id', id);
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    Toast.success('삭제되었습니다');
    Modal.close();
    loadScheduleView();
  }

  // ───────── 홍보관리 ─────────
  function renderPromo(container) {
    container.innerHTML = `
      <div class="stats-grid">
        <div class="stats-card">
          <div class="stats-card-icon">📢</div>
          <h4>홍보 캠페인 관리</h4>
          <p>전단지, 온라인 광고, 제휴업체 등 캠페인별 등록 및 집행 현황</p>
        </div>
        <div class="stats-card">
          <div class="stats-card-icon">📍</div>
          <h4>지역별 홍보 효과</h4>
          <p>거주지 데이터와 유입경로를 교차하여 지역별 홍보 효과 분석</p>
        </div>
        <div class="stats-card">
          <div class="stats-card-icon">💸</div>
          <h4>홍보 비용 대비 성과</h4>
          <p>캠페인별 투입 비용 대비 문의 건수 및 전환율(ROI) 추적</p>
        </div>
        <div class="stats-card">
          <div class="stats-card-icon">📋</div>
          <h4>전단지 배포 기록</h4>
          <p>배포 일자, 장소, 수량, 반응률 기록 및 이력 관리</p>
        </div>
      </div>
    `;
  }

  function renderCenter(container) {
    container.innerHTML = `<div class="ops-placeholder">센터관리 — 준비 중</div>`;
  }

  function renderManual(container) {
    container.innerHTML = `<div class="ops-placeholder">메뉴얼생성 — 준비 중</div>`;
  }

  return { init };
})();
