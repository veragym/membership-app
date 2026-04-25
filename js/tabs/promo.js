/**
 * 업무/홍보/센터 관리 탭
 * 하위 4개: 업무관리 / 홍보관리 / 센터관리 / 메뉴얼생성
 *
 * 업무관리:
 *   - 좌 2/5: 일정표 (오늘/내일 2일 · 30분 · staff_schedules)
 *     + [시간표 공유] 버튼 — html2canvas로 PNG 다운로드
 *   - 우 3/5:
 *       · 예약자 리스트 (최대 20개 · sessionStorage · inquiries 자동완성)
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
  const RESV_MAX = 20;

  let activeSubTab = 'ops';
  let scheduleData = [];
  let reservations = [];
  let _suggestionTimer = null;
  let opsRefreshTimer = null;

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
        <button class="stats-subtab ${activeSubTab === 'plan' ? 'active' : ''}" data-tab="plan">업무계획</button>
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
    else if (tab === 'plan') renderPlan(c);
    else if (tab === 'promo') renderPromo(c);
    else if (tab === 'center') renderCenter(c);
    else if (tab === 'manual') renderManual(c);
  }

  // ───────── 업무계획 (월간 달력 + 체크리스트 풀) ─────────
  function renderPlan(container) {
    if (typeof PromoCalendarTab !== 'undefined' && PromoCalendarTab.render) {
      PromoCalendarTab.render(container);
    } else {
      container.innerHTML = `<div class="ops-placeholder">업무계획 모듈 로드 실패 — 새로고침 후 재시도</div>`;
    }
  }

  // ───────── 업무관리 ─────────
  function renderOps(container) {
    container.innerHTML = `
      <div class="ops-layout">
        <div class="ops-panel">
          <div class="ops-panel-header">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="ops-panel-title">일정표</span>
              <button type="button" class="btn-share-sched" id="btnShareSched" title="PC 화면용 PNG 자동 저장">📷 시간표 공유</button>
              <button type="button" class="btn-share-sched" id="btnSchedTplMgr" title="반복되는 시간단위 일정 템플릿 관리">📋 고정일정 관리</button>
              <button type="button" class="btn-share-sched" id="btnSchedTplGen" title="오늘에 맞는 고정일정을 일괄 생성">↻ 오늘 고정일정 생성</button>
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
          <div class="ops-panel ops-panel-resv">
            <div class="ops-panel-header">
              <span class="ops-panel-title">예약자 리스트</span>
              <span style="font-size:11px;color:var(--color-text-muted)">일회성 · 최대 20개 · 새로고침 후에도 창 닫기 전까지 유지</span>
            </div>
            <div class="ops-panel-body" id="resvListBody"></div>
          </div>
          <div class="ops-bottom-row">
            <div class="ops-panel">
              <div class="ops-panel-header">
                <span class="ops-panel-title">시간 일정 (오늘 이후)</span>
                <div class="ops-upcoming-actions">
                  <button type="button" class="btn-upcoming-action" id="btnUpcomingDelSelected" disabled>선택삭제</button>
                  <button type="button" class="btn-upcoming-action btn-upcoming-danger" id="btnUpcomingDelAll">전체삭제</button>
                </div>
              </div>
              <div class="ops-panel-body" id="opsUpcomingList">
                <div class="ops-placeholder">불러오는 중…</div>
              </div>
            </div>
            <div class="ops-panel ops-panel-today">
              <div class="ops-panel-header">
                <span class="ops-panel-title">금일 업무</span>
                <span style="font-size:11px;color:var(--color-text-muted)">업무계획 탭 · 체크 즉시 저장</span>
              </div>
              <div class="ops-panel-body" id="opsTodayTasks">
                <div class="ops-placeholder">불러오는 중…</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btnShareSched').addEventListener('click', shareScheduleImage);
    document.getElementById('btnSchedTplMgr').addEventListener('click', openScheduleTemplateListModal);
    document.getElementById('btnSchedTplGen').addEventListener('click', handleGenerateTodaySchedTemplates);
    document.getElementById('btnUpcomingDelSelected').addEventListener('click', handleUpcomingDeleteSelected);
    document.getElementById('btnUpcomingDelAll').addEventListener('click', handleUpcomingDeleteAll);
    renderReservations();
    loadScheduleView();
    loadTodayTasks();
    startOpsRefreshTimer();
  }

  // 1분마다 현재 시각 기준으로 달력·리스트 재렌더 (종료 시각 경과 반영)
  function startOpsRefreshTimer() {
    stopOpsRefreshTimer();
    opsRefreshTimer = setInterval(() => {
      if (activeSubTab !== 'ops' || !document.getElementById('opsCalGrid')) {
        stopOpsRefreshTimer();
        return;
      }
      renderCalGrid(getCalDates());
      renderUpcoming();
    }, 60000);
  }
  function stopOpsRefreshTimer() {
    if (opsRefreshTimer) { clearInterval(opsRefreshTimer); opsRefreshTimer = null; }
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

  // 한국 휴대전화 포맷: 입력값에서 숫자만 추출해 010-XXXX-XXXX / 0XX-XXX-XXXX 로 변환
  function formatPhone(input) {
    const d = String(input || '').replace(/[^0-9]/g, '');
    if (!d) return '';
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0,3)}-${d.slice(3)}`;
    if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
    // 11자리 또는 그 이상은 010-XXXX-XXXX 형태 (뒷자리 초과시 잘라냄)
    return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7,11)}`;
  }

  async function loadScheduleView() {
    const dates = getCalDates();
    const from = toYMD(dates[0]), to = toYMD(dates[dates.length - 1]);
    const { data, error } = await supabase
      .from('staff_schedules')
      .select('id, staff_id, sched_date, start_time, end_time, type, title, notes, color, status, task_item_id')
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

  // ═══ 금일 업무 (업무계획 탭에서 등록된 Task 중 오늘이 기간에 포함된 것) ═══
  // 데이터 모델: tasks(id, title, category, start_date, end_date, status) + task_items(id, task_id, order_index, content, is_done)
  // v12: 카테고리 색상은 설정 > 업무카테고리 드롭다운에서 관리. 하드코딩 제거.
  const FALLBACK_TASK_COLOR = '#6B7280';
  let TODAY_TASK_CATEGORY_COLORS = {}; // DB에서 로드됨

  async function loadTaskCategoryColors() {
    try {
      const rows = await Dropdown.fetchFull('업무카테고리');
      TODAY_TASK_CATEGORY_COLORS = {};
      rows.forEach(r => { TODAY_TASK_CATEGORY_COLORS[r.value] = r.color || FALLBACK_TASK_COLOR; });
    } catch (e) {
      console.warn('[promo] 업무카테고리 로드 실패:', e);
    }
  }
  // 'YYYY-MM-DD' → 'M/D'
  function shortYMD(ymd) {
    if (!ymd) return '';
    const p = String(ymd).split('-');
    if (p.length < 3) return ymd;
    return `${Number(p[1])}/${Number(p[2])}`;
  }

  async function loadTodayTasks() {
    const body = document.getElementById('opsTodayTasks');
    if (!body) return;
    const todayYMD = toYMD(new Date());

    // 업무 카테고리 색상 로드 (첫 호출 시 DB 조회, 이후 캐시)
    await loadTaskCategoryColors();

    const { data, error } = await supabase
      .from('task_items')
      .select('id, task_id, order_index, content, is_done, tasks(id, title, category, start_date, end_date, status)')
      .order('order_index')
      .limit(1000);

    if (error) {
      console.error('today tasks fetch failed:', error);
      body.innerHTML = `<div class="ops-placeholder">업무를 불러오지 못했습니다: ${esc(error.message)}</div>`;
      return;
    }

    const rows = (data || []).filter(it =>
      it.tasks &&
      it.tasks.status !== 'cancelled' &&
      it.tasks.status !== 'archived' &&
      it.tasks.start_date <= todayYMD &&
      it.tasks.end_date   >= todayYMD
    );

    if (!rows.length) {
      body.innerHTML = `<div class="ops-placeholder">오늘 진행 중인 업무가 없습니다.</div>`;
      return;
    }

    // Task별 그룹핑
    const groupMap = {};
    rows.forEach(it => {
      const key = it.task_id;
      if (!groupMap[key]) groupMap[key] = { task: it.tasks, items: [] };
      groupMap[key].items.push(it);
    });
    Object.values(groupMap).forEach(g => {
      g.items.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
      g.total = g.items.length;
      g.done  = g.items.filter(x => x.is_done).length;
      g.isComplete = g.total > 0 && g.done === g.total;
    });

    // 정렬: 미완료 우선 → 종료일 빠른 순 → 시작일 빠른 순
    const groups = Object.values(groupMap).sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
      const ea = a.task?.end_date || '9999-12-31';
      const eb = b.task?.end_date || '9999-12-31';
      if (ea !== eb) return ea < eb ? -1 : 1;
      const sa = a.task?.start_date || '9999-12-31';
      const sb = b.task?.start_date || '9999-12-31';
      if (sa !== sb) return sa < sb ? -1 : 1;
      return 0;
    });

    body.innerHTML = groups.map(g => {
      const t = g.task;
      const color = TODAY_TASK_CATEGORY_COLORS[t.category] || TODAY_TASK_CATEGORY_COLORS['기타'] || FALLBACK_TASK_COLOR;
      const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
      const completeCls = g.isComplete ? 'is-complete' : '';
      const completeBadge = g.isComplete ? `<span class="plan-pool-done-badge">완료</span>` : '';
      return `
        <div class="plan-pool-group ${completeCls}" data-task-id="${t.id}">
          <div class="plan-pool-group-hdr">
            <div class="plan-pool-group-main">
              <div class="plan-pool-group-line1">
                <span class="plan-pool-chip" style="background:${color}">${esc(t.category || '기타')}</span>
                <span class="plan-pool-group-title" title="${esc(t.title)}">${esc(t.title)}</span>
                ${completeBadge}
                <span class="plan-pool-group-right">
                  <span class="plan-pool-group-count">${pct}%</span>
                  <span class="plan-pool-group-meta">${shortYMD(t.start_date)} ~ ${shortYMD(t.end_date)}</span>
                </span>
              </div>
            </div>
          </div>
          <div class="plan-pool-items">
            ${g.items.map(it => `
              <label class="plan-pool-item ${it.is_done ? 'is-done' : ''}">
                <input type="checkbox" class="ops-today-check" data-id="${it.id}" ${it.is_done ? 'checked' : ''}>
                <span class="plan-pool-item-text">${esc(it.content || '')}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    body.querySelectorAll('.ops-today-check').forEach(cb => {
      cb.addEventListener('change', () => handleTodayTaskToggle(cb.dataset.id, cb.checked, cb));
    });
  }

  async function handleTodayTaskToggle(itemId, checked, cbEl) {
    const trainer = (typeof Auth !== 'undefined' && Auth.getTrainer) ? Auth.getTrainer() : null;
    const patch = { is_done: checked };
    if (checked && trainer?.id) patch.done_by = trainer.id;

    const row = cbEl.closest('.plan-pool-item');
    if (row) row.style.opacity = '.5';

    const { error } = await supabase.from('task_items').update(patch).eq('id', itemId);
    if (error) {
      console.error('today task toggle failed:', error);
      Toast.error('체크 반영 실패: ' + error.message);
      if (row) row.style.opacity = '';
      cbEl.checked = !checked;
      return;
    }
    Toast.success(checked ? '완료 처리되었습니다' : '완료 해제되었습니다');
    await loadTodayTasks();
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
        const past = isSchedPast(s, now);
        col += `<div class="ops-cal-event${past ? ' is-past' : ''}" style="background:${evBg}dd;top:${top}px;height:${height}px;" data-sched-id="${s.id}">
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
  // 이미지 구성:
  //   ┌────────────┬───────────┐
  //   │ 통계 정보  │ 금일 일정 │
  //   ├────────────┴───────────┤
  //   │      예약자 리스트      │
  //   └────────────────────────┘
  // ═══ 고정일정 (schedule_templates) 관리 ═══
  // 요일 0=일, 6=토
  const DOW_LABELS = ['일','월','화','수','목','금','토'];

  // 소요시간 선택지 — 매일 실행 시각이 다르므로 start_time 대신 duration 저장
  const DURATION_OPTIONS = [
    { min: 15,  label: '15분' },
    { min: 30,  label: '30분' },
    { min: 45,  label: '45분' },
    { min: 60,  label: '1시간' },
    { min: 90,  label: '1시간 30분' },
    { min: 120, label: '2시간' },
    { min: 180, label: '3시간' },
    { min: 240, label: '4시간' },
  ];
  function durationLabel(min) {
    const m = Number(min) || 30;
    const hit = DURATION_OPTIONS.find(o => o.min === m);
    if (hit) return hit.label;
    if (m % 60 === 0) return `${m / 60}시간`;
    if (m > 60) return `${Math.floor(m / 60)}시간 ${m % 60}분`;
    return `${m}분`;
  }
  // "HH:MM" + duration_min → "HH:MM"
  function addMinutesHHMM(hhmm, minutesToAdd) {
    if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + Number(minutesToAdd || 0);
    const nh = Math.floor(total / 60) % 24;
    const nm = total % 60;
    return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`;
  }

  async function openScheduleTemplateListModal() {
    Modal.open({
      type: 'center', size: 'lg',
      title: '고정일정 관리',
      html: `
        <div class="plan-tpl-wrap">
          <div class="plan-tpl-toolbar">
            <span class="plan-tpl-desc">반복되는 시간단위 일정을 템플릿으로 등록해두면 "↻ 오늘 고정일정 생성" 버튼 한 번으로 일괄 생성됩니다.</span>
            <button type="button" class="plan-btn-primary" id="schedTplNew">+ 새 템플릿</button>
          </div>
          <div class="plan-tpl-list" id="schedTplList">
            <div class="ops-placeholder">불러오는 중…</div>
          </div>
        </div>
      `,
      onOpen: (el) => {
        el.querySelector('#schedTplNew').addEventListener('click', () => openScheduleTemplateEditModal(null));
        loadScheduleTemplates(el.querySelector('#schedTplList'));
      }
    });
  }

  async function loadScheduleTemplates(listEl) {
    const { data, error } = await supabase
      .from('schedule_templates')
      .select('*')
      .order('is_active', { ascending: false })
      .order('title');
    if (error) {
      listEl.innerHTML = `<div class="ops-placeholder">불러오기 실패: ${esc(error.message)}</div>`;
      return;
    }
    const rows = data || [];
    if (!rows.length) {
      listEl.innerHTML = `<div class="ops-placeholder">등록된 고정일정이 없습니다. "+ 새 템플릿"으로 추가해 보세요.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(t => {
      const dowLabel = (!t.days_of_week || !t.days_of_week.length)
        ? '매일'
        : t.days_of_week.map(d => DOW_LABELS[d]).join('·');
      const color = t.color || TYPE_COLORS[t.type] || TYPE_COLORS['업무'];
      const durLabel = durationLabel(t.duration_min);
      const activeCls = t.is_active ? '' : 'is-inactive';
      return `
        <div class="plan-tpl-row ${activeCls}" data-id="${t.id}">
          <div class="plan-tpl-row-main">
            <div class="plan-tpl-row-line1">
              <span class="plan-pool-chip" style="background:${color}">${esc(t.type || '업무')}</span>
              <span class="plan-tpl-row-title">${esc(t.title || '')}</span>
              ${t.is_active ? '' : '<span class="plan-tpl-inactive-badge">비활성</span>'}
            </div>
            <div class="plan-tpl-row-line2">
              <span class="plan-pool-group-meta">${durLabel}</span>
              <span class="plan-pool-group-meta">· ${dowLabel}</span>
              ${t.notes ? `<span class="plan-pool-group-meta">· ${esc(t.notes)}</span>` : ''}
            </div>
          </div>
          <div class="plan-tpl-row-actions">
            <button type="button" class="plan-btn-sm" data-role="edit">수정</button>
          </div>
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.plan-tpl-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('[data-role=edit]').addEventListener('click', () => openScheduleTemplateEditModal(id));
    });
  }

  async function openScheduleTemplateEditModal(tplId) {
    let tpl = { id: null, title: '', type: '업무', duration_min: 30, notes: '', days_of_week: [], is_active: true };
    if (tplId) {
      const { data, error } = await supabase.from('schedule_templates').select('*').eq('id', tplId).single();
      if (error || !data) { Toast.error('템플릿 로드 실패'); return; }
      tpl = data;
      tpl.duration_min = Number(tpl.duration_min) || 30;
    }
    const isEdit = !!tplId;

    Modal.open({
      type: 'center', size: 'md',
      title: isEdit ? '고정일정 수정' : '고정일정 등록',
      html: `
        <form id="schedTplForm" class="sched-form">
          <div class="form-row">
            <label>제목</label>
            <input type="text" name="title" value="${esc(tpl.title)}" maxlength="120" required placeholder="예: 전일 원장 스캔파일 최신화">
          </div>
          <div class="form-row">
            <label>유형</label>
            <div class="sched-type-pills">
              ${TYPE_OPTIONS.map(t => `<button type="button" class="sched-type-pill ${t === tpl.type ? 'active' : ''}" data-type="${t}" style="--pill-color:${TYPE_COLORS[t]}">${t}</button>`).join('')}
            </div>
            <input type="hidden" name="type" value="${tpl.type}">
          </div>
          <div class="form-row">
            <label>소요시간 <span style="color:var(--color-text-muted);font-weight:400">(실제 실행시각은 매일 달라도 OK)</span></label>
            <div class="sched-type-pills" id="schedTplDurPills">
              ${DURATION_OPTIONS.map(o => `<button type="button" class="sched-type-pill ${o.min === tpl.duration_min ? 'active' : ''}" data-dur="${o.min}" style="--pill-color:var(--color-primary)">${o.label}</button>`).join('')}
            </div>
            <input type="hidden" name="duration_min" value="${tpl.duration_min}">
          </div>
          <div class="form-row">
            <label>활성</label>
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" name="is_active" ${tpl.is_active ? 'checked' : ''} style="width:16px;height:16px">
              <span style="font-size:13px">활성화</span>
            </label>
          </div>
          <div class="form-row">
            <label>요일 <span style="color:var(--color-text-muted);font-weight:400">(선택 없음 = 매일)</span></label>
            <div class="sched-type-pills" id="schedTplDowPills">
              ${DOW_LABELS.map((d, i) => `<button type="button" class="sched-type-pill ${(tpl.days_of_week||[]).includes(i) ? 'active' : ''}" data-dow="${i}" style="--pill-color:var(--color-primary)">${d}</button>`).join('')}
            </div>
          </div>
          <div class="form-row">
            <label>메모</label>
            <textarea name="notes" rows="2" placeholder="선택">${esc(tpl.notes || '')}</textarea>
          </div>
          <div class="sched-form-actions">
            ${isEdit ? `<button type="button" class="btn btn-danger" id="schedTplDelBtn">삭제</button>` : ''}
            <button type="button" class="btn btn-secondary" id="schedTplCancelBtn">취소</button>
            <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        // type pill 선택 (유형 영역 pill 만 대상)
        const typePills = el.querySelectorAll('.sched-type-pill[data-type]');
        const typeInput = el.querySelector('input[name="type"]');
        typePills.forEach(p => p.addEventListener('click', () => {
          typePills.forEach(x => x.classList.toggle('active', x === p));
          typeInput.value = p.dataset.type;
        }));
        // duration pill 단일 선택
        const durPills = el.querySelectorAll('#schedTplDurPills .sched-type-pill[data-dur]');
        const durInput = el.querySelector('input[name="duration_min"]');
        durPills.forEach(p => p.addEventListener('click', () => {
          durPills.forEach(x => x.classList.toggle('active', x === p));
          durInput.value = p.dataset.dur;
        }));
        // dow pill 다중 토글
        const dowPills = el.querySelectorAll('#schedTplDowPills .sched-type-pill[data-dow]');
        dowPills.forEach(p => p.addEventListener('click', () => p.classList.toggle('active')));

        el.querySelector('#schedTplCancelBtn').addEventListener('click', () => Modal.close());
        if (isEdit) {
          el.querySelector('#schedTplDelBtn').addEventListener('click', async () => {
            if (!confirm('이 템플릿을 삭제하시겠습니까? (이미 생성된 일정은 유지됩니다)')) return;
            const { error } = await supabase.from('schedule_templates').delete().eq('id', tplId);
            if (error) { Toast.error('삭제 실패: ' + error.message); return; }
            Toast.success('삭제되었습니다');
            openScheduleTemplateListModal();
          });
        }
        el.querySelector('#schedTplForm').addEventListener('submit', (e) => {
          e.preventDefault();
          handleScheduleTemplateSubmit(e.target, tplId, el);
        });
      }
    });
  }

  async function handleScheduleTemplateSubmit(form, editId, formEl) {
    const fd = new FormData(form);
    const trainer = (typeof Auth !== 'undefined' && Auth.getTrainer) ? Auth.getTrainer() : null;
    const dowList = Array.from(formEl.querySelectorAll('#schedTplDowPills .sched-type-pill.active'))
      .map(p => Number(p.dataset.dow))
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    const payload = {
      title: (fd.get('title') || '').trim(),
      type:  fd.get('type') || '업무',
      duration_min: Math.max(5, parseInt(fd.get('duration_min'), 10) || 30),
      start_time: null,   // v14: 템플릿은 시각 미지정 — 생성 시점에 부여
      end_time:   null,
      notes: (fd.get('notes') || '').trim() || null,
      days_of_week: dowList,
      is_active: !!fd.get('is_active')
    };
    if (!payload.title) { Toast.error('제목은 필수'); return; }
    try {
      if (editId) {
        const { error } = await supabase.from('schedule_templates').update(payload).eq('id', editId);
        if (error) throw error;
      } else {
        payload.created_by = trainer?.id || null;
        const { error } = await supabase.from('schedule_templates').insert(payload);
        if (error) throw error;
      }
      Toast.success(editId ? '수정되었습니다' : '등록되었습니다');
      openScheduleTemplateListModal();
    } catch (e) {
      console.error('schedule template save failed:', e);
      Toast.error('저장 실패: ' + (e.message || e));
    }
  }

  // 오늘 날짜에 맞는 고정일정 일괄 생성 (요일 필터 적용, 중복 방지)
  // v14: 템플릿은 duration_min 만 가짐 → 사용자에게 시작시각 하나만 묻고
  //      활성 템플릿을 제목순으로 이어 붙여(cascade) 배치. 이후 개별 편집 가능.
  async function handleGenerateTodaySchedTemplates() {
    const now = new Date();
    const todayYMD = toYMD(now);
    const dow = now.getDay();  // 0=Sun..6=Sat

    const { data: tpls, error: e1 } = await supabase
      .from('schedule_templates')
      .select('*')
      .eq('is_active', true)
      .order('title');
    if (e1) { Toast.error('템플릿 조회 실패: ' + e1.message); return; }
    const activeTpls = (tpls || []).filter(t => !t.days_of_week || !t.days_of_week.length || t.days_of_week.includes(dow));
    if (!activeTpls.length) {
      Toast.info('오늘 요일에 적용할 활성 고정일정이 없습니다.');
      return;
    }

    // 이미 오늘 날짜로 생성된 template_id 조회 → 중복 방지
    const { data: existing, error: e2 } = await supabase
      .from('staff_schedules')
      .select('template_id')
      .eq('template_date', todayYMD)
      .not('template_id', 'is', null);
    if (e2) { Toast.error('기존 일정 조회 실패: ' + e2.message); return; }
    const existingIds = new Set((existing || []).map(r => r.template_id));

    const toGenerate = activeTpls.filter(t => !existingIds.has(t.id));
    if (!toGenerate.length) {
      Toast.info('오늘 고정일정은 이미 모두 생성되어 있습니다.');
      return;
    }

    // 시작시각 입력 받기 (기본 09:00). 이후 cascade.
    const startStr = prompt(
      `오늘 생성할 고정일정 ${toGenerate.length}건의 시작 시각을 입력하세요 (HH:MM)\n` +
      `제목순으로 이어 붙여 배치됩니다. 생성 후 개별 편집 가능.`,
      '09:00'
    );
    if (startStr === null) return;  // 취소
    if (!/^\d{1,2}:\d{2}$/.test(startStr.trim())) {
      Toast.error('시작 시각 형식이 올바르지 않습니다 (예: 09:00)');
      return;
    }
    let cursor = startStr.trim().padStart(5, '0');

    const toInsert = toGenerate.map(t => {
      const dur = Number(t.duration_min) || 30;
      const st  = cursor;
      const et  = addMinutesHHMM(st, dur);
      cursor = et;
      return {
        staff_id:     null,
        sched_date:   todayYMD,
        start_time:   st,
        end_time:     et,
        type:         t.type || '업무',
        title:        t.title,
        notes:        t.notes,
        color:        t.color,
        status:       'active',
        template_id:  t.id,
        template_date: todayYMD
      };
    });

    const { error: e3 } = await supabase.from('staff_schedules').insert(toInsert);
    if (e3) { Toast.error('일괄 생성 실패: ' + e3.message); return; }
    Toast.success(`${toInsert.length}건 생성 (${toInsert[0].start_time}~${toInsert[toInsert.length-1].end_time})`);
    loadScheduleView();
  }

  async function shareScheduleImage() {
    if (typeof html2canvas === 'undefined') {
      Toast.error('이미지 라이브러리 로드 실패 — 새로고침 후 재시도해주세요.');
      return;
    }
    const btn = document.getElementById('btnShareSched');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '생성 중…';
    try {
      const today = new Date();
      const todayYMD = toYMD(today);
      const stats = await fetchStatsForShare(today);

      // 카카오톡 모바일 뷰 최적화 · 기존 1100px → 2/3 사이즈(740px)
      const exportEl = document.createElement('div');
      exportEl.style.cssText =
        `position:fixed;left:-10000px;top:0;background:#fff;padding:16px;width:740px;` +
        `font-family:'Pretendard Variable','Pretendard',sans-serif;color:#111;box-sizing:border-box;`;
      exportEl.innerHTML = `
        <div style="text-align:center;margin-bottom:12px">
          <div style="font-size:18px;font-weight:800">베라짐 상담 업무 브리프</div>
          <div style="font-size:11px;color:#666;margin-top:3px">
            ${today.getFullYear()}년 ${today.getMonth()+1}월 ${today.getDate()}일 (${DAY_KO[today.getDay()]}) · 상담팀
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;align-items:stretch">
          <div>${buildShareStatsHTML(stats, today)}</div>
          <div>${buildShareCalendarHTML(todayYMD, today)}</div>
        </div>
        <div>${buildShareReservationsHTML()}</div>
      `;
      document.body.appendChild(exportEl);

      const canvas = await html2canvas(exportEl, { backgroundColor: '#ffffff', scale: 2, logging: false, useCORS: true });
      document.body.removeChild(exportEl);

      const filename = `베라짐_상담업무_${todayYMD}.png`;

      let copied = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copied = true;
        }
      } catch (_) { /* fallback to download */ }

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

  // ─── 공유 이미지용 통계 산출 (stats 탭 로직 포팅) ───
  async function fetchStatsForShare(today) {
    const y = today.getFullYear(), m = today.getMonth() + 1;
    const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
    const todayYMD = toYMD(today);

    // 제외 상품: stats 탭과 동일 localStorage 키 사용
    let excluded = new Set(['1일', '쿠폰']);
    try {
      const saved = localStorage.getItem('stats.fc_excluded_products');
      if (saved) excluded = new Set(JSON.parse(saved));
    } catch (_) {}

    const fetchRev = async (fromD, toD) => {
      const { data: fcData } = await supabase.from('registrations')
        .select('product, total_payment')
        .gte('registered_date', fromD).lte('registered_date', toD);
      const fcFiltered = (fcData || []).filter(r => !excluded.has(r.product));
      const fc = Math.round(fcFiltered.reduce((s, r) => s + (r.total_payment || 0), 0) / 1.1);
      const { data: ptData } = await supabase.from('pt_registrations')
        .select('contract_amount')
        .gte('contract_date', fromD).lte('contract_date', toD);
      const pt = (ptData || []).reduce((s, r) => s + (r.contract_amount || 0), 0);
      return { fc, pt };
    };

    // 주차 정보 계산 (stats.js computeWeekInfo 규칙과 동일: v8 — 1주=월1일, 2주~ 월요일, 월경계 미교차)
    const firstDay = new Date(y, m - 1, 1);
    const lastDay  = new Date(y, m, 0);
    const weeks = [new Date(firstDay)];
    const dow = firstDay.getDay();
    const daysToMon = dow === 0 ? 1 : (8 - dow);
    const nextMon = new Date(firstDay);
    nextMon.setDate(nextMon.getDate() + daysToMon);
    for (let d = new Date(nextMon); d <= lastDay; d.setDate(d.getDate() + 7)) weeks.push(new Date(d));
    let idx = 0;
    for (let i = 0; i < weeks.length; i++) { if (today >= weeks[i]) idx = i; else break; }
    const wkStart = weeks[idx];
    const wkNext = weeks[idx + 1];
    const wkEnd = wkNext
      ? new Date(wkNext.getFullYear(), wkNext.getMonth(), wkNext.getDate() - 1)
      : new Date(lastDay);
    const weekStartYMD = toYMD(wkStart), weekEndYMD = toYMD(wkEnd);
    const weekNumber = idx + 1;

    const [monthRev, todayRev, weekRev, targets] = await Promise.all([
      fetchRev(monthStart, todayYMD),
      fetchRev(todayYMD, todayYMD),
      fetchRev(weekStartYMD, weekEndYMD),
      (async () => {
        const { data } = await supabase.from('revenue_targets')
          .select('target_type, target_amount').eq('target_week', weekStartYMD);
        const out = { FC: 0, PT: 0 };
        (data || []).forEach(r => { out[r.target_type] = r.target_amount; });
        return out;
      })(),
    ]);

    return { monthRev, todayRev, weekRev, targets, weekNumber };
  }

  function buildShareStatsHTML(stats, today) {
    const { monthRev, todayRev, weekRev, targets, weekNumber } = stats;
    const fmt = n => (n || 0).toLocaleString() + '원';
    const total = monthRev.fc + monthRev.pt;
    const todayTotal = todayRev.fc + todayRev.pt;
    const fcTarget = targets.FC || 0, ptTarget = targets.PT || 0;
    const fcRemain = fcTarget - weekRev.fc;
    const ptRemain = ptTarget - weekRev.pt;
    const totTarget = fcTarget + ptTarget;
    const totRemain = fcRemain + ptRemain;
    const remainTxt = (v) => {
      if (v > 0)  return { t: `-${fmt(v)}`,  c: '#EF4444' };
      if (v < 0)  return { t: `+${fmt(-v)}`, c: '#3B82F6' };
      return { t: fmt(0), c: '#3B82F6' };
    };
    const fcR = remainTxt(fcRemain), ptR = remainTxt(ptRemain), totR = remainTxt(totRemain);
    const m = today.getMonth() + 1;

    const rowCSS = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed #E5E7EB;font-size:13px';
    const rowTodayCSS = rowCSS + ';color:#6B7280;font-size:12px;padding:4px 0 4px 12px;border-bottom:none';
    return `
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px;height:100%;box-sizing:border-box">
        <div style="font-size:15px;font-weight:700;margin-bottom:10px">${m}월 당월 매출</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div style="background:#F9FAFB;border-radius:10px;padding:12px">
            <div style="font-size:11px;color:#6B7280">금일 매출</div>
            <div style="font-size:18px;font-weight:800;margin-top:4px">${fmt(todayTotal)}</div>
          </div>
          <div style="background:#FEF3C7;border-radius:10px;padding:12px">
            <div style="font-size:11px;color:#92400E">당월 매출</div>
            <div style="font-size:18px;font-weight:800;margin-top:4px;color:#92400E">${fmt(total)}</div>
          </div>
        </div>
        <div style="${rowCSS}"><span>FC 총 매출 (부가세 제외)</span><b>${fmt(monthRev.fc)}</b></div>
        <div style="${rowTodayCSS}"><span>FC 금일 매출</span><b>${fmt(todayRev.fc)}</b></div>
        <div style="${rowCSS}"><span>PT 매출 (계약금액)</span><b>${fmt(monthRev.pt)}</b></div>
        <div style="${rowTodayCSS}"><span>PT 금일 매출</span><b>${fmt(todayRev.pt)}</b></div>
        <div style="margin-top:12px;padding:6px 10px;background:#EEF2FF;color:#4338CA;border-radius:6px;font-size:12px;font-weight:700;text-align:center">
          ${weekNumber}주차 목표 매출
        </div>
        <div style="${rowCSS}"><span>FC 목표 매출</span><b>${fmt(fcTarget)}</b></div>
        <div style="${rowCSS}"><span>FC 남은 매출</span><b style="color:${fcR.c}">${fcR.t}</b></div>
        <div style="${rowCSS}"><span>PT 목표 매출</span><b>${fmt(ptTarget)}</b></div>
        <div style="${rowCSS}"><span>PT 남은 매출</span><b style="color:${ptR.c}">${ptR.t}</b></div>
        <div style="${rowCSS};border-bottom:none;font-weight:700"><span>총 목표 매출</span><b>${fmt(totTarget)}</b></div>
        <div style="${rowCSS};border-bottom:none;font-weight:700"><span>총 남은 매출</span><b style="color:${totR.c}">${totR.t}</b></div>
      </div>
    `;
  }

  function buildShareCalendarHTML(todayYMD, today) {
    // 이벤트 내용(제목 + 메모 2줄)이 잘리지 않도록 1시간 슬롯 = 44px로 확보
    const SLOT_PX = 44;
    const totalPx = (CAL_END_H - CAL_START_H + 1) * SLOT_PX;
    // 시간 라벨 열
    let timeCol = `<div style="position:relative;width:58px;flex:none;border-right:1px solid #E5E7EB;height:${totalPx}px">`;
    for (let h = CAL_START_H; h <= CAL_END_H; h++) {
      const y = (h - CAL_START_H) * SLOT_PX;
      const lbl = h < 12 ? `오전 ${h}시` : h === 12 ? `오후 12시` : `오후 ${h-12}시`;
      const transform = h === CAL_START_H ? 'translateY(2px)' : 'translateY(-50%)';
      timeCol += `<div style="position:absolute;top:${y}px;right:6px;transform:${transform};font-size:10px;color:#6B7280;white-space:nowrap">${lbl}</div>`;
    }
    timeCol += `</div>`;

    // 날짜 열 (오늘만)
    let dayCol = `<div style="position:relative;flex:1;height:${totalPx}px">`;
    for (let h = CAL_START_H; h <= CAL_END_H; h++) {
      const y0 = (h - CAL_START_H) * SLOT_PX;
      const y30 = y0 + SLOT_PX / 2;
      dayCol += `<div style="position:absolute;left:0;right:0;top:${y0}px;border-top:1px solid #E5E7EB"></div>`;
      dayCol += `<div style="position:absolute;left:0;right:0;top:${y30}px;border-top:1px dashed #F3F4F6"></div>`;
    }
    dayCol += `<div style="position:absolute;left:0;right:0;top:${totalPx}px;border-top:1px solid #E5E7EB"></div>`;

    scheduleData.filter(s => s.sched_date === todayYMD).forEach(s => {
      const [sh, sm] = s.start_time.split(':').map(Number);
      let eh, em;
      if (s.end_time) { [eh, em] = s.end_time.split(':').map(Number); } else { eh = sh + 1; em = sm; }
      const top = ((sh - CAL_START_H) + sm/60) * SLOT_PX;
      const dur = (eh - sh) + (em - sm)/60;
      const height = Math.max(dur * SLOT_PX, 18);
      const sType = s.type || '업무';
      const bg = s.color || TYPE_COLORS[sType] || TYPE_COLORS['업무'];
      const title = s.title || sType;
      dayCol += `<div style="position:absolute;left:4px;right:4px;top:${top}px;height:${height}px;background:${bg};color:#fff;border-radius:4px;padding:4px 6px;font-size:11px;font-weight:600;overflow:hidden;box-sizing:border-box;line-height:1.2">
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
        ${s.notes ? `<div style="font-size:10px;opacity:.9;margin-top:1px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.notes)}</div>` : ''}
      </div>`;
    });
    dayCol += `</div>`;

    return `
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:14px;height:100%;box-sizing:border-box;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:15px;font-weight:700">금일 일정표</div>
          <div style="font-size:11px;color:#6B7280">${today.getMonth()+1}/${today.getDate()} (${DAY_KO[today.getDay()]})</div>
        </div>
        <div style="display:flex;flex:1;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
          ${timeCol}
          ${dayCol}
        </div>
      </div>
    `;
  }

  function buildShareReservationsHTML() {
    const todayYMD = toYMD(new Date());
    const today = reservations.filter(r => (r.resv_date || todayYMD) === todayYMD);
    const gridCols = '32px 70px 0.9fr 1.1fr 2.5fr 90px';
    const rows = today.length
      ? today.map((r, i) => {
          const status = r.status || 'pending';
          const statusStyle = status === 'completed'
            ? 'background:#D1FAE5;color:#065F46'
            : 'background:#FEF3C7;color:#92400E';
          const statusLabel = status === 'completed' ? '상담완료' : '미완료';
          return `
            <div style="display:grid;grid-template-columns:${gridCols};gap:8px;padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;align-items:center">
              <div style="color:#9CA3AF;text-align:center">${i+1}</div>
              <div style="color:#4B5563">${esc(r.resv_time || '-')}</div>
              <div style="font-weight:600">${esc(r.name || '-')}</div>
              <div style="color:#4B5563">${esc(r.phone || '-')}</div>
              <div style="color:#374151">${esc(r.content || '-')}</div>
              <div style="text-align:center"><span style="${statusStyle};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600">${statusLabel}</span></div>
            </div>
          `;
        }).join('')
      : `<div style="padding:20px;text-align:center;color:#9CA3AF;font-size:12px">금일 예약자가 없습니다.</div>`;
    return `
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#F9FAFB;border-bottom:1px solid #E5E7EB">
          <div style="font-size:15px;font-weight:700">금일 예약자 리스트</div>
          <div style="font-size:11px;color:#6B7280">${todayYMD} · ${today.length}건</div>
        </div>
        <div style="display:grid;grid-template-columns:${gridCols};gap:8px;padding:8px 10px;background:#F3F4F6;font-size:11px;color:#6B7280;font-weight:600">
          <div style="text-align:center">#</div><div>시간</div><div>이름</div><div>연락처</div><div>내용</div><div style="text-align:center">상태</div>
        </div>
        ${rows}
      </div>
    `;
  }

  // 스케줄 한 건이 이미 종료되었는지 (오늘 날짜이고 end_time ≤ 현재 시각)
  function isSchedPast(s, now) {
    if (!s || !s.sched_date) return false;
    const todayYMD = toYMD(now);
    if (s.sched_date < todayYMD) return true;
    if (s.sched_date > todayYMD) return false;
    // 오늘 날짜 — end_time 기준 비교 (end_time 없으면 start_time + 30min)
    const endStr = s.end_time ? s.end_time.slice(0, 5) : addMinutes((s.start_time || '00:00').slice(0, 5), 30);
    const [eh, em] = endStr.split(':').map(Number);
    const endMin = eh * 60 + em;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return endMin <= nowMin;
  }

  // ═══ 예정 업무 리스트 ═══
  function renderUpcoming() {
    const el = document.getElementById('opsUpcomingList');
    if (!el) return;
    const delAllBtn = document.getElementById('btnUpcomingDelAll');
    const now = new Date();
    // 종료 시각 지난 건은 리스트에서 자동 제외 (DB는 유지 → 달력에는 faded로 표시)
    const upcoming = scheduleData.filter(s => !isSchedPast(s, now));
    if (!upcoming.length) {
      el.innerHTML = '<div class="ops-placeholder">예정된 업무가 없습니다.</div>';
      if (delAllBtn) delAllBtn.disabled = true;
      updateUpcomingSelectedBtn();
      return;
    }
    if (delAllBtn) delAllBtn.disabled = false;
    el.innerHTML = `<div class="ops-upcoming-list">` + upcoming.map(s => {
      const bg = s.color || TYPE_COLORS[s.type] || TYPE_COLORS['업무'];
      return `<div class="ops-upcoming-item" data-sched-id="${s.id}">
        <label class="ops-upcoming-check" title="선택">
          <input type="checkbox" class="ops-upcoming-checkbox" data-sched-id="${s.id}">
        </label>
        <div class="ops-upcoming-chip" style="background:${bg}">${esc(s.type)}</div>
        <div class="ops-upcoming-main">
          <div class="ops-upcoming-title">${esc(s.title || s.type)}</div>
          <div class="ops-upcoming-meta">${s.sched_date} · ${s.start_time.slice(0,5)}${s.end_time ? '–' + s.end_time.slice(0,5) : ''}</div>
          ${s.notes ? `<div class="ops-upcoming-notes">${esc(s.notes)}</div>` : ''}
        </div>
      </div>`;
    }).join('') + `</div>`;

    // 체크박스는 row 클릭(모달 열기)과 분리
    el.querySelectorAll('.ops-upcoming-check, .ops-upcoming-checkbox').forEach(n => {
      n.addEventListener('click', (e) => e.stopPropagation());
    });
    el.querySelectorAll('.ops-upcoming-checkbox').forEach(cb => {
      cb.addEventListener('change', updateUpcomingSelectedBtn);
    });
    el.querySelectorAll('.ops-upcoming-item').forEach(it => {
      it.addEventListener('click', (e) => {
        if (e.target.closest('.ops-upcoming-check')) return;
        const row = scheduleData.find(s => s.id === it.dataset.schedId);
        if (row) openSchedModal(row);
      });
    });
    updateUpcomingSelectedBtn();
  }

  function getSelectedUpcomingIds() {
    const el = document.getElementById('opsUpcomingList');
    if (!el) return [];
    return Array.from(el.querySelectorAll('.ops-upcoming-checkbox:checked')).map(cb => cb.dataset.schedId);
  }
  function updateUpcomingSelectedBtn() {
    const btn = document.getElementById('btnUpcomingDelSelected');
    if (!btn) return;
    const n = getSelectedUpcomingIds().length;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `선택삭제 (${n})` : '선택삭제';
  }

  async function handleUpcomingDeleteSelected() {
    const ids = getSelectedUpcomingIds();
    if (!ids.length) return;
    if (!confirm(`선택한 ${ids.length}건의 일정을 삭제하시겠습니까?`)) return;
    const { error } = await supabase.from('staff_schedules').delete().in('id', ids);
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    Toast.success(`${ids.length}건 삭제되었습니다`);
    loadScheduleView();
  }

  async function handleUpcomingDeleteAll() {
    const todayYMD = toYMD(new Date());
    const upcoming = scheduleData.filter(s => s.sched_date >= todayYMD);
    if (!upcoming.length) return;
    if (!confirm(`오늘 이후 예정된 ${upcoming.length}건의 일정을 모두 삭제하시겠습니까?\n(되돌릴 수 없습니다)`)) return;
    const { error } = await supabase.from('staff_schedules').delete().gte('sched_date', todayYMD);
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    Toast.success(`${upcoming.length}건 전체 삭제되었습니다`);
    loadScheduleView();
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
    const taskItemIdVal = isEdit ? (row.task_item_id || '') : '';

    Modal.open({
      type: 'center', size: 'md',
      title: isEdit ? '일정 수정' : '일정 등록',
      html: `
        <form id="schedForm" class="sched-form">
          ${isEdit ? '' : `
          <div class="form-row">
            <label>고정일정에서 불러오기 <span style="color:var(--color-text-muted);font-weight:400">(선택)</span></label>
            <select id="schedTplPick">
              <option value="">— 선택 —</option>
            </select>
          </div>
          `}
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
            <label>연결 체크리스트</label>
            <select name="task_item_id" id="schedTaskItemSelect">
              <option value="">선택 없음 (불러오는 중…)</option>
            </select>
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

        // 연결 체크리스트 옵션 로드 (미완료 TaskItem — 수정 모드면 현재 선택 항목도 포함)
        loadTaskItemOptions(el.querySelector('#schedTaskItemSelect'), taskItemIdVal, isEdit ? row : null);

        // 고정일정 템플릿 드롭다운 (신규 등록일 때만)
        const schedTplSel = el.querySelector('#schedTplPick');
        if (schedTplSel) {
          loadScheduleTemplatesForPicker(schedTplSel);
          schedTplSel.addEventListener('change', () => {
            const tplId = schedTplSel.value;
            if (!tplId) return;
            applyScheduleTemplateToForm(el, tplId);
            schedTplSel.value = '';
          });
        }
      }
    });
  }

  // 고정일정 템플릿 옵션 로드
  async function loadScheduleTemplatesForPicker(selectEl) {
    const { data, error } = await supabase
      .from('schedule_templates')
      .select('id, title, type, duration_min, days_of_week')
      .eq('is_active', true)
      .order('title');
    if (error) { console.error('sched template picker load failed:', error); return; }
    const opts = (data || []).map(t => {
      const dur = durationLabel(t.duration_min);
      const dow = (!t.days_of_week || !t.days_of_week.length) ? '매일' : t.days_of_week.map(d => DOW_LABELS[d]).join('·');
      return `<option value="${t.id}">${esc(`[${t.type}] ${t.title} · ${dur} · ${dow}`)}</option>`;
    }).join('');
    selectEl.innerHTML = `<option value="">— 선택 —</option>` + opts;
  }

  // 선택된 템플릿을 현재 일정 폼에 적용
  async function applyScheduleTemplateToForm(formEl, tplId) {
    const { data: tpl, error } = await supabase
      .from('schedule_templates').select('*').eq('id', tplId).single();
    if (error || !tpl) { Toast.error('템플릿 로드 실패'); return; }

    const titleInput = formEl.querySelector('input[name="title"]');
    if (titleInput) titleInput.value = tpl.title || '';

    // type 핍 클래스 토글 + hidden input
    const typeInput = formEl.querySelector('input[name="type"]');
    if (typeInput && tpl.type) typeInput.value = tpl.type;
    formEl.querySelectorAll('.sched-type-pill[data-type]').forEach(p => {
      p.classList.toggle('active', p.dataset.type === tpl.type);
    });

    // v14: 템플릿에는 시작시각이 없음. 폼의 현재 start_time 을 기준으로
    //       end_time = start + duration_min 으로 자동 계산.
    const startInp = formEl.querySelector('input[name="start_time"]');
    const endInp   = formEl.querySelector('input[name="end_time"]');
    const dur = Number(tpl.duration_min) || 30;
    if (startInp && endInp && startInp.value) {
      endInp.value = addMinutesHHMM(startInp.value, dur);
    }

    const notesInp = formEl.querySelector('textarea[name="notes"]');
    if (notesInp) notesInp.value = tpl.notes || '';

    Toast.success(`"${tpl.title}" 템플릿 적용 (${durationLabel(dur)})`);
  }

  // 미완료 task_items 옵션 로드 — PromoCalendarTab.fetchOpenTaskItems 재사용
  async function loadTaskItemOptions(selectEl, currentId, editRow) {
    if (!selectEl) return;
    try {
      let options = [];
      if (typeof PromoCalendarTab !== 'undefined' && PromoCalendarTab.fetchOpenTaskItems) {
        options = await PromoCalendarTab.fetchOpenTaskItems();
      }
      // 현재 row에 연결된 항목이 이미 완료 상태라 목록에 없을 수 있음 → 별도 fetch
      if (currentId && !options.find(o => o.id === currentId)) {
        const { data } = await supabase
          .from('task_items')
          .select('id, content, tasks(title)')
          .eq('id', currentId)
          .single();
        if (data && data.tasks) {
          options.unshift({ id: data.id, label: `${data.tasks.title} · ${data.content} (완료됨)` });
        }
      }
      const opts = ['<option value="">선택 없음</option>']
        .concat(options.map(o => `<option value="${o.id}" ${o.id === currentId ? 'selected' : ''}>${esc(o.label)}</option>`));
      selectEl.innerHTML = opts.join('');
    } catch (e) {
      console.error('loadTaskItemOptions failed:', e);
      selectEl.innerHTML = '<option value="">선택 없음</option>';
    }
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
      task_item_id: fd.get('task_item_id') || null,
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
    const addRow = !atMax ? renderResvRow({ resv_date: toYMD(new Date()), resv_time: '', name:'', phone:'', content:'', status:'pending' }, reservations.length, true) : '';
    body.innerHTML = `
      <div class="resv-table">
        <div class="resv-head">
          <div>예약일</div><div>시간</div><div>이름</div><div>연락처</div><div>내용</div><div style="text-align:center">상태</div><div></div>
        </div>
        <div class="resv-scroll">
          ${rows}
          ${addRow}
        </div>
        ${atMax ? '<div class="resv-cap-note">※ 최대 20건까지 등록됩니다. 삭제 후 추가하세요.</div>' : ''}
      </div>
    `;
    bindResvEvents();
  }

  function renderResvRow(r, idx, isAdd) {
    const status = r.status || 'pending';
    const statusLabel = status === 'completed' ? '상담완료' : '미완료';
    const dateVal = r.resv_date || toYMD(new Date());
    const timeVal = r.resv_time || '';
    return `
      <div class="resv-row ${isAdd ? 'resv-row-add' : ''}" data-idx="${idx}">
        <div class="resv-cell">
          <input type="date" class="resv-input resv-input-date" data-field="resv_date" value="${esc(dateVal)}">
        </div>
        <div class="resv-cell">
          <input type="time" class="resv-input resv-input-time" data-field="resv_time" value="${esc(timeVal)}" step="600">
        </div>
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
          // 전화번호 자동 포맷
          if (field === 'phone') {
            const caretAtEnd = inp.selectionStart === inp.value.length;
            const formatted = formatPhone(inp.value);
            if (formatted !== inp.value) {
              inp.value = formatted;
              if (caretAtEnd) inp.setSelectionRange(formatted.length, formatted.length);
            }
          }
          if (!isAdd) {
            reservations[idx][field] = inp.value;
            saveReservations();
          }
          if (field === 'name' || field === 'phone') triggerSuggest(row, field, inp.value);
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
    const resv_date = row.querySelector('[data-field="resv_date"]').value || toYMD(new Date());
    const resv_time = row.querySelector('[data-field="resv_time"]').value || '';
    const name = row.querySelector('[data-field="name"]').value.trim();
    const phone = formatPhone(row.querySelector('[data-field="phone"]').value);
    const content = row.querySelector('[data-field="content"]').value.trim();
    if (!name && !phone && !content) return; // 빈 행 무시
    if (reservations.length >= RESV_MAX) return;
    reservations.push({ resv_date, resv_time, name, phone, content, status: 'pending' });
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
        const name = it.dataset.name;
        const phone = formatPhone(it.dataset.phone);
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

  // ───────── 홍보관리 (세로 섹션 스택) ─────────
  // v13: [캠페인/플레이스] 서브탭 제거, 각 섹션 세로로 전체폭 나열.
  function renderPromo(container) {
    container.innerHTML = `
      <div class="promo-stack">
        <section class="promo-section" id="promo-sec-place"></section>
        <section class="promo-section promo-section-placeholder">
          <div class="promo-placeholder-body">앞으로 구축할 홍보관리 내용</div>
        </section>
        <section class="promo-section promo-section-placeholder">
          <div class="promo-placeholder-body">앞으로 구축할 홍보관리 내용</div>
        </section>
      </div>
    `;
    const placeHost = container.querySelector('#promo-sec-place');
    if (typeof PromoPlaceTab !== 'undefined' && PromoPlaceTab.render) {
      PromoPlaceTab.render(placeHost);
    } else {
      placeHost.innerHTML = `<div class="ops-placeholder">플레이스 모듈 로드 실패 — 새로고침 후 재시도</div>`;
    }
  }
  function renderCenter(container) { container.innerHTML = `<div class="ops-placeholder">센터관리 — 준비 중</div>`; }
  function renderManual(container) { container.innerHTML = `<div class="ops-placeholder">메뉴얼생성 — 준비 중</div>`; }

  return { init };
})();
