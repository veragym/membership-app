/**
 * 업무계획 서브탭 (promo 탭 > 업무계획)
 * ───────────────────────────────────
 * 구성:
 *   상단 : 월간 업무 달력 (Task bar week-span)
 *   하단 : 체크리스트 풀 (미완료 TaskItem 플랫 리스트)
 *
 * 데이터 모델:
 *   tasks(id, title, description, category, start_date, end_date, status, ...)
 *   task_items(id, task_id, order_index, content, is_done, done_at, done_by)
 *   v_tasks_with_progress (items_total, items_done, progress_pct 포함)
 *
 * 외부 노출 API:
 *   PromoCalendarTab.render(container)
 *
 * 의존:
 *   · window.supabase (api.js에서 생성)
 *   · Auth.getTrainer() · Modal · Toast
 *
 * 드래그 정렬: native HTML5 Drag and Drop API (외부 lib 無)
 */
const PromoCalendarTab = (() => {

  // ═══ 상수 ═══════════════════════════════════════════════════════════
  const CATEGORIES = ['홍보', '이벤트', '발주', '유지보수', '기타'];
  const CATEGORY_COLORS = {
    '홍보':     '#EC4899',
    '이벤트':   '#F59E0B',
    '발주':     '#10B981',
    '유지보수': '#3B82F6',
    '기타':     '#6B7280'
  };
  const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const FILTER_LABELS = { all: '전체', week: '이번주', today: '오늘' };

  // ═══ 상태 ═══════════════════════════════════════════════════════════
  let hostContainer = null;
  let viewMonth = null;            // {y, m} (1-based month)
  let monthTasks = [];             // v_tasks_with_progress rows
  let poolItems = [];              // 미완료 task_items (+ nested task)
  let poolFilter = 'all';
  let collapsedGroups = new Set();   // task_id → collapsed
  let poolInitialCollapse = true;    // 탭 진입 첫 렌더에서 모든 그룹 접힘

  // drag state (checklist editor)
  let dragRowId = null;

  // ═══ 유틸 ═══════════════════════════════════════════════════════════
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 'YYYY-MM-DD' → 'M/D' (년도 생략, 선행 0 제거)
  function shortDate(ymd) {
    if (!ymd) return '';
    const parts = String(ymd).split('-');
    if (parts.length < 3) return ymd;
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toYMD(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function parseYMD(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function diffDays(a, b) { return Math.round((b - a) / 86400000); }
  function clampDate(d, lo, hi) { return d < lo ? lo : (d > hi ? hi : d); }

  // cryptographically-safe-ish UUID (클라 임시 id — 저장 전 실제 UUID로 대체)
  function tmpId() { return 'tmp_' + Math.random().toString(36).slice(2, 11); }

  // ═══ ENTRY ══════════════════════════════════════════════════════════
  function render(container) {
    hostContainer = container;
    if (!viewMonth) {
      const now = new Date();
      viewMonth = { y: now.getFullYear(), m: now.getMonth() + 1 };
    }
    // 탭 진입 시 항상 모두 접힌 상태로 시작
    poolInitialCollapse = true;
    collapsedGroups = new Set();
    container.innerHTML = `
      <div class="plan-root">
        <section class="plan-cal-section">
          <div class="plan-cal-header">
            <div class="plan-cal-nav">
              <button type="button" class="plan-btn-ghost" id="planCalPrev" aria-label="이전 달">◀</button>
              <div class="plan-cal-title" id="planCalTitle">—</div>
              <button type="button" class="plan-btn-ghost" id="planCalNext" aria-label="다음 달">▶</button>
              <button type="button" class="plan-btn-sm" id="planCalToday">오늘</button>
            </div>
            <div class="plan-cal-actions">
              <button type="button" class="plan-btn-sm" id="planCalTplMgr" title="매월 반복되는 업무 템플릿 관리">📋 고정업무 관리</button>
              <button type="button" class="plan-btn-sm" id="planCalTplGen" title="이 달에 고정업무를 일괄 생성">↻ 이 달 고정업무 생성</button>
              <button type="button" class="plan-btn-primary" id="planCalNewBtn">+ 새 업무</button>
            </div>
          </div>
          <div class="plan-cal-grid" id="planCalGrid"></div>
          <div class="plan-cal-legend">
            ${CATEGORIES.map(c => `<span class="plan-legend-chip"><i style="background:${CATEGORY_COLORS[c]}"></i>${c}</span>`).join('')}
          </div>
        </section>

        <section class="plan-pool-section">
          <div class="plan-pool-header">
            <div class="plan-pool-title">전체 체크리스트</div>
            <div class="plan-pool-filter">
              ${Object.keys(FILTER_LABELS).map(k =>
                `<button type="button" class="plan-filter-btn ${k==='all'?'active':''}" data-f="${k}">${FILTER_LABELS[k]}</button>`
              ).join('')}
            </div>
          </div>
          <div class="plan-pool-body" id="planPoolBody">
            <div class="plan-placeholder">불러오는 중…</div>
          </div>
        </section>
      </div>
    `;

    container.querySelector('#planCalPrev').addEventListener('click', () => shiftMonth(-1));
    container.querySelector('#planCalNext').addEventListener('click', () => shiftMonth(+1));
    container.querySelector('#planCalToday').addEventListener('click', () => {
      const n = new Date();
      viewMonth = { y: n.getFullYear(), m: n.getMonth()+1 };
      refreshCalendar();
    });
    container.querySelector('#planCalNewBtn').addEventListener('click', () => openTaskModal(null, null));
    container.querySelector('#planCalTplMgr').addEventListener('click', () => openTemplateListModal());
    container.querySelector('#planCalTplGen').addEventListener('click', () => handleGenerateMonthFromTemplates());
    container.querySelectorAll('.plan-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        poolFilter = btn.dataset.f;
        container.querySelectorAll('.plan-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
        renderPool();
      });
    });

    refreshCalendar();
    refreshPool();
  }

  function shiftMonth(delta) {
    let { y, m } = viewMonth;
    m += delta;
    if (m < 1)  { m = 12; y--; }
    if (m > 12) { m = 1;  y++; }
    viewMonth = { y, m };
    refreshCalendar();
  }

  // ═══ 월간 달력 ═════════════════════════════════════════════════════
  async function refreshCalendar() {
    const { y, m } = viewMonth;
    const titleEl = hostContainer.querySelector('#planCalTitle');
    if (titleEl) titleEl.textContent = `${y}년 ${m}월`;

    const monthStart = new Date(y, m - 1, 1);
    const monthEnd   = new Date(y, m,     0); // last day of month
    const fromYMD = toYMD(monthStart);
    const toYMDs  = toYMD(monthEnd);

    // start_date <= month_end AND end_date >= month_start
    const { data, error } = await supabase
      .from('v_tasks_with_progress')
      .select('*')
      .lte('start_date', toYMDs)
      .gte('end_date',   fromYMD)
      .neq('status', 'cancelled')
      .order('start_date');

    if (error) {
      console.error('tasks fetch failed:', error);
      Toast.error('업무 목록을 불러오지 못했습니다: ' + error.message);
      monthTasks = [];
    } else {
      monthTasks = data || [];
    }
    renderCalendarGrid();
  }

  function renderCalendarGrid() {
    const { y, m } = viewMonth;
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd   = new Date(y, m,     0);
    const startDow = monthStart.getDay(); // 0 = Sun
    const daysInMonth = monthEnd.getDate();

    // grid starts at the Sunday of the week containing day 1
    const gridStart = addDays(monthStart, -startDow);
    const rows = Math.ceil((startDow + daysInMonth) / 7);

    const todayYMD = toYMD(new Date());
    const grid = hostContainer.querySelector('#planCalGrid');
    if (!grid) return;

    // 헤더 요일 + 각 날짜 셀 생성
    let html = `<div class="plan-cal-weekhdr">`;
    for (let i = 0; i < 7; i++) {
      const cls = i === 0 ? 'sun' : (i === 6 ? 'sat' : '');
      html += `<div class="plan-cal-wkcell ${cls}">${DAY_KO[i]}</div>`;
    }
    html += `</div>`;

    for (let r = 0; r < rows; r++) {
      html += `<div class="plan-cal-week" data-wk="${r}">`;
      for (let c = 0; c < 7; c++) {
        const d = addDays(gridStart, r * 7 + c);
        const ymd = toYMD(d);
        const inMonth = d.getMonth() === (m - 1);
        const isToday = ymd === todayYMD;
        const cls = [
          'plan-cal-cell',
          inMonth ? '' : 'out-of-month',
          isToday ? 'today' : '',
          c === 0 ? 'sun' : (c === 6 ? 'sat' : '')
        ].filter(Boolean).join(' ');
        html += `<div class="${cls}" data-ymd="${ymd}">
          <div class="plan-cal-daynum">${d.getDate()}</div>
          <div class="plan-cal-bars" data-ymd="${ymd}"></div>
        </div>`;
      }
      html += `</div>`;
    }
    grid.innerHTML = html;

    // Task bar 배치 (주별)
    placeTaskBars(gridStart, rows);

    // 셀 클릭 → 해당 날짜에 새 업무 / bar 클릭 → 편집
    grid.querySelectorAll('.plan-cal-cell').forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.plan-task-bar')) return;
        openTaskModal(null, cell.dataset.ymd);
      });
    });
    grid.querySelectorAll('.plan-task-bar').forEach(bar => {
      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = bar.dataset.taskId;
        const t = monthTasks.find(x => x.id === id);
        if (t) openTaskModal(t, null);
      });
    });
  }

  // 주별로 Task를 세그먼트로 쪼개서 bar 삽입
  function placeTaskBars(gridStart, rows) {
    if (!monthTasks.length) return;
    for (let r = 0; r < rows; r++) {
      const weekStart = addDays(gridStart, r * 7);
      const weekEnd   = addDays(weekStart, 6);

      // 이번 주에 걸치는 Task 필터
      const segs = monthTasks.map(t => {
        const ts = parseYMD(t.start_date);
        const te = parseYMD(t.end_date);
        if (te < weekStart || ts > weekEnd) return null;
        const segStart = ts < weekStart ? weekStart : ts;
        const segEnd   = te > weekEnd   ? weekEnd   : te;
        const startCol = diffDays(weekStart, segStart); // 0~6
        const span     = diffDays(segStart, segEnd) + 1;
        return { task: t, startCol, span, continuesLeft: ts < weekStart, continuesRight: te > weekEnd };
      }).filter(Boolean);

      if (!segs.length) continue;

      // lane assignment (스택 높이 관리)
      segs.sort((a, b) => a.task.start_date.localeCompare(b.task.start_date) || a.startCol - b.startCol);
      const lanes = []; // lanes[i] = endCol occupied
      segs.forEach(s => {
        let laneIdx = lanes.findIndex(endCol => endCol < s.startCol);
        if (laneIdx === -1) { lanes.push(s.startCol + s.span - 1); laneIdx = lanes.length - 1; }
        else lanes[laneIdx] = s.startCol + s.span - 1;
        s.lane = laneIdx;
      });

      // 주 전체 오버레이 레이어에 bar 삽입
      const weekEl = hostContainer.querySelector(`.plan-cal-week[data-wk="${r}"]`);
      if (!weekEl) continue;
      // bars overlay
      let overlay = weekEl.querySelector('.plan-cal-baroverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'plan-cal-baroverlay';
        weekEl.appendChild(overlay);
      }
      overlay.innerHTML = segs.map(s => {
        const t = s.task;
        const color = CATEGORY_COLORS[t.category] || CATEGORY_COLORS['기타'];
        const pct = Math.max(0, Math.min(100, Number(t.progress_pct) || 0));
        const leftPct  = (s.startCol / 7) * 100;
        const widthPct = (s.span / 7) * 100;
        const top = 24 + s.lane * 22; // day number reserves ~24px
        const borderRadius = `${s.continuesLeft ? 0 : 4}px ${s.continuesRight ? 0 : 4}px ${s.continuesRight ? 0 : 4}px ${s.continuesLeft ? 0 : 4}px`;
        const title = `${t.title} · ${pct}%`;
        return `<div class="plan-task-bar"
          style="left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);top:${top}px;background:${color};border-radius:${borderRadius}"
          data-task-id="${t.id}" title="${esc(title)}">
            <span class="plan-task-bar-label">${esc(t.title)} · ${pct}%</span>
        </div>`;
      }).join('');
    }
  }

  // ═══ 체크리스트 풀 ══════════════════════════════════════════════════
  async function refreshPool() {
    const body = hostContainer?.querySelector('#planPoolBody');
    if (body) body.innerHTML = `<div class="plan-placeholder">불러오는 중…</div>`;

    // 완료된 항목도 함께 로드 (완료돼도 리스트에 유지)
    const { data, error } = await supabase
      .from('task_items')
      .select('id, task_id, order_index, content, is_done, tasks(id, title, category, start_date, end_date, status)')
      .order('order_index')
      .limit(1000);

    if (error) {
      console.error('pool fetch failed:', error);
      Toast.error('체크리스트를 불러오지 못했습니다: ' + error.message);
      poolItems = [];
    } else {
      poolItems = (data || []).filter(it => it.tasks && it.tasks.status !== 'cancelled' && it.tasks.status !== 'archived');
    }
    renderPool();
  }

  function renderPool() {
    const body = hostContainer?.querySelector('#planPoolBody');
    if (!body) return;

    const todayYMD = toYMD(new Date());
    const weekEnd  = toYMD(addDays(new Date(), 6));

    let items = poolItems.slice();
    if (poolFilter === 'today') {
      items = items.filter(it => it.tasks && it.tasks.start_date <= todayYMD && it.tasks.end_date >= todayYMD);
    } else if (poolFilter === 'week') {
      items = items.filter(it => it.tasks && it.tasks.start_date <= weekEnd && it.tasks.end_date >= todayYMD);
    }

    if (!items.length) {
      body.innerHTML = `<div class="plan-placeholder">체크리스트가 없습니다.</div>`;
      return;
    }

    // Task별로 그룹핑
    const groupMap = {};
    items.forEach(it => {
      const key = it.task_id;
      if (!groupMap[key]) groupMap[key] = { task: it.tasks, items: [] };
      groupMap[key].items.push(it);
    });

    // 그룹 내부 항목은 order_index 기준
    Object.values(groupMap).forEach(g => {
      g.items.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
      g.total = g.items.length;
      g.done  = g.items.filter(x => x.is_done).length;
      g.isComplete = g.total > 0 && g.done === g.total;
    });

    // 탭 진입 첫 렌더 — 모든 그룹 접힘 상태로 시작
    if (poolInitialCollapse) {
      Object.values(groupMap).forEach(g => collapsedGroups.add(g.task.id));
      poolInitialCollapse = false;
    }

    // 정렬: 미완료 우선 → 종료일(빠른 순) → 시작일(빠른 순)
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
      const color = CATEGORY_COLORS[t.category] || CATEGORY_COLORS['기타'];
      const collapsed = collapsedGroups.has(t.id);
      const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
      const completeCls = g.isComplete ? 'is-complete' : '';
      const completeBadge = g.isComplete ? `<span class="plan-pool-done-badge">완료</span>` : '';
      return `
        <div class="plan-pool-group ${completeCls}" data-task-id="${t.id}">
          <div class="plan-pool-group-hdr">
            <button type="button" class="plan-pool-toggle" data-role="toggle" aria-label="${collapsed ? '펼치기' : '접기'}" title="${collapsed ? '펼치기' : '접기'}">${collapsed ? '▸' : '▾'}</button>
            <div class="plan-pool-group-main">
              <div class="plan-pool-group-line1">
                <span class="plan-pool-chip" style="background:${color}">${esc(t.category || '기타')}</span>
                <span class="plan-pool-group-title" data-role="edit" title="${esc(t.title)}">${esc(t.title)}</span>
                ${completeBadge}
              </div>
              <div class="plan-pool-group-line2">
                <span class="plan-pool-group-count">${pct}%</span>
                <span class="plan-pool-group-meta">${shortDate(t.start_date)} ~ ${shortDate(t.end_date)}</span>
              </div>
            </div>
          </div>
          <div class="plan-pool-items" ${collapsed ? 'hidden' : ''}>
            ${g.items.map(it => `
              <label class="plan-pool-item ${it.is_done ? 'is-done' : ''}">
                <input type="checkbox" class="plan-pool-check" data-id="${it.id}" ${it.is_done ? 'checked' : ''}>
                <span class="plan-pool-item-text">${esc(it.content || '')}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    // 이벤트 바인딩
    body.querySelectorAll('.plan-pool-check').forEach(cb => {
      cb.addEventListener('change', () => handlePoolToggle(cb.dataset.id, cb.checked, cb));
    });
    body.querySelectorAll('.plan-pool-group').forEach(groupEl => {
      const id = groupEl.dataset.taskId;
      const toggleBtn = groupEl.querySelector('[data-role=toggle]');
      const titleEl   = groupEl.querySelector('[data-role=edit]');
      if (toggleBtn) toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsedGroups.has(id)) collapsedGroups.delete(id); else collapsedGroups.add(id);
        renderPool();
      });
      if (titleEl) titleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = monthTasks.find(x => x.id === id) || (poolItems.find(it => it.task_id === id) || {}).tasks;
        if (t) openTaskModal(t, null);
      });
    });
  }

  async function handlePoolToggle(itemId, checked, cbEl) {
    const trainer = Auth.getTrainer();
    const patch = { is_done: checked };
    if (checked && trainer?.id) patch.done_by = trainer.id;
    // 낙관적 UI
    const row = cbEl.closest('.plan-pool-item');
    if (row) row.style.opacity = '.5';

    const { error } = await supabase.from('task_items').update(patch).eq('id', itemId);
    if (error) {
      console.error('toggle failed:', error);
      Toast.error('체크 반영 실패: ' + error.message);
      if (row) row.style.opacity = '';
      cbEl.checked = !checked;
      return;
    }
    Toast.success(checked ? '완료 처리되었습니다' : '완료 해제되었습니다');
    await Promise.all([refreshPool(), refreshCalendar()]);
  }

  // ═══ Task 생성/편집 모달 ════════════════════════════════════════════
  async function openTaskModal(task, defaultStartYMD) {
    const isEdit = !!(task && task.id);
    let items = [];
    if (isEdit) {
      const { data, error } = await supabase.from('task_items')
        .select('*').eq('task_id', task.id).order('order_index');
      if (error) {
        console.error('items fetch failed:', error);
        Toast.error('체크리스트를 불러오지 못했습니다.');
        return;
      }
      items = data || [];
    }

    const today = toYMD(new Date());
    const startVal = isEdit ? task.start_date : (defaultStartYMD || today);
    const endVal   = isEdit ? task.end_date   : (defaultStartYMD || today);
    const titleVal = isEdit ? task.title : '';
    const descVal  = isEdit ? (task.description || '') : '';
    const catVal   = isEdit ? (task.category || '기타') : '기타';

    Modal.open({
      type: 'center', size: 'md',
      title: isEdit ? '업무 수정' : '업무 등록',
      html: `
        <form id="planTaskForm" class="plan-task-form">
          <div class="plan-form-row">
            <label>제목</label>
            <input type="text" name="title" value="${esc(titleVal)}" maxlength="120" required placeholder="예: 4월 전단지 발주">
          </div>
          <div class="plan-form-grid3">
            <div class="plan-form-row">
              <label>카테고리</label>
              <select name="category">
                ${CATEGORIES.map(c => `<option value="${c}" ${c===catVal?'selected':''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="plan-form-row">
              <label>시작일</label>
              <input type="date" name="start_date" value="${startVal}" required>
            </div>
            <div class="plan-form-row">
              <label>종료일</label>
              <input type="date" name="end_date" value="${endVal}" required>
            </div>
          </div>
          <div class="plan-form-row">
            <label>설명</label>
            <textarea name="description" rows="2" placeholder="선택">${esc(descVal)}</textarea>
          </div>

          <div class="plan-items-editor">
            <div class="plan-items-hdr">
              <span>체크리스트 (드래그로 순서 변경)</span>
              <button type="button" class="plan-btn-sm" id="planItemAdd">+ 항목 추가</button>
            </div>
            <div class="plan-items-list" id="planItemsList"></div>
          </div>

          <div class="plan-task-actions">
            ${isEdit ? `<button type="button" class="btn btn-danger" id="planTaskDel">삭제</button>` : ''}
            <button type="button" class="btn btn-secondary" id="planTaskCancel">취소</button>
            <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        const listEl = el.querySelector('#planItemsList');
        // 초기 렌더
        const workingItems = items.map(it => ({ id: it.id, content: it.content, is_done: it.is_done, order_index: it.order_index }));
        if (!workingItems.length) workingItems.push({ id: tmpId(), content: '', is_done: false, order_index: 0 });
        renderItemsEditor(listEl, workingItems);

        el.querySelector('#planItemAdd').addEventListener('click', () => {
          workingItems.push({ id: tmpId(), content: '', is_done: false, order_index: workingItems.length });
          renderItemsEditor(listEl, workingItems);
          // 새 항목 입력란에 포커스
          const last = listEl.querySelector('.plan-item-row:last-child input[type=text]');
          if (last) last.focus();
        });

        el.querySelector('#planTaskCancel').addEventListener('click', () => Modal.close());
        if (isEdit) el.querySelector('#planTaskDel').addEventListener('click', () => handleTaskDelete(task.id));

        el.querySelector('#planTaskForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          await handleTaskSubmit(e.target, isEdit ? task.id : null, workingItems, items);
        });
      }
    });
  }

  function renderItemsEditor(listEl, workingItems) {
    listEl.innerHTML = workingItems.map((it, idx) => `
      <div class="plan-item-row" draggable="true" data-id="${it.id}">
        <span class="plan-item-handle" title="드래그로 순서 변경">≡</span>
        <label class="plan-item-done">
          <input type="checkbox" data-role="done" ${it.is_done ? 'checked' : ''} title="완료 체크">
        </label>
        <input type="text" data-role="content" value="${esc(it.content || '')}" placeholder="예: 전단지 디자인 초안" maxlength="200">
        <button type="button" class="plan-item-del" data-role="del" title="삭제">✕</button>
      </div>
    `).join('');

    // 입력/체크/삭제 바인딩
    listEl.querySelectorAll('.plan-item-row').forEach(row => {
      const id = row.dataset.id;
      const idx = workingItems.findIndex(x => x.id === id);
      if (idx < 0) return;
      row.querySelector('[data-role=content]').addEventListener('input', (e) => {
        workingItems[idx].content = e.target.value;
      });
      row.querySelector('[data-role=done]').addEventListener('change', (e) => {
        workingItems[idx].is_done = e.target.checked;
      });
      row.querySelector('[data-role=del]').addEventListener('click', () => {
        workingItems.splice(idx, 1);
        renderItemsEditor(listEl, workingItems);
      });

      // HTML5 native drag
      row.addEventListener('dragstart', (e) => {
        dragRowId = id;
        row.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch(_) {}
      });
      row.addEventListener('dragend', () => {
        dragRowId = null;
        row.classList.remove('dragging');
        listEl.querySelectorAll('.plan-item-row').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch(_) {}
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const srcId = dragRowId;
        const dstId = id;
        if (!srcId || srcId === dstId) return;
        const srcIdx = workingItems.findIndex(x => x.id === srcId);
        const dstIdx = workingItems.findIndex(x => x.id === dstId);
        if (srcIdx < 0 || dstIdx < 0) return;
        const [moved] = workingItems.splice(srcIdx, 1);
        workingItems.splice(dstIdx, 0, moved);
        renderItemsEditor(listEl, workingItems);
      });
    });
  }

  async function handleTaskSubmit(form, editId, workingItems, originalItems) {
    const fd = new FormData(form);
    const trainer = Auth.getTrainer();
    if (!trainer) { Toast.error('로그인 정보를 확인할 수 없습니다.'); return; }

    const payload = {
      title:       (fd.get('title') || '').trim(),
      category:    fd.get('category') || '기타',
      description: (fd.get('description') || '').trim() || null,
      start_date:  fd.get('start_date'),
      end_date:    fd.get('end_date'),
    };
    if (!payload.title)      { Toast.error('제목은 필수입니다.'); return; }
    if (!payload.start_date || !payload.end_date) { Toast.error('기간을 입력하세요.'); return; }
    if (payload.end_date < payload.start_date)    { Toast.error('종료일이 시작일보다 이전일 수 없습니다.'); return; }

    // 유효 항목만(공백 제거)
    const cleanItems = workingItems
      .map(it => ({ ...it, content: (it.content || '').trim() }))
      .filter(it => it.content);

    try {
      let taskId = editId;
      if (editId) {
        const { error } = await supabase.from('tasks').update(payload).eq('id', editId);
        if (error) throw error;
      } else {
        payload.created_by = trainer.id || null;
        const { data, error } = await supabase.from('tasks').insert(payload).select('id').single();
        if (error) throw error;
        taskId = data.id;
      }

      // 항목 동기화
      // 1) 삭제: 기존에 있었지만 워킹에는 없는 id
      if (editId && originalItems.length) {
        const keepIds = new Set(cleanItems.map(it => it.id).filter(x => !String(x).startsWith('tmp_')));
        const deleteIds = originalItems.filter(o => !keepIds.has(o.id)).map(o => o.id);
        if (deleteIds.length) {
          const { error } = await supabase.from('task_items').delete().in('id', deleteIds);
          if (error) throw error;
        }
      }
      // 2) upsert (순서 재할당 0..n-1)
      if (cleanItems.length) {
        const rows = cleanItems.map((it, idx) => {
          const isNew = String(it.id).startsWith('tmp_');
          const row = {
            task_id: taskId,
            content: it.content,
            order_index: idx,
            is_done: !!it.is_done
          };
          if (!isNew) row.id = it.id;
          return row;
        });
        const { error } = await supabase.from('task_items').upsert(rows);
        if (error) throw error;
      }

      Toast.success(editId ? '수정되었습니다' : '등록되었습니다');
      Modal.close();
      await Promise.all([refreshCalendar(), refreshPool()]);
    } catch (e) {
      console.error('task save failed:', e);
      Toast.error('저장 실패: ' + (e.message || e));
    }
  }

  async function handleTaskDelete(id) {
    if (!confirm('이 업무와 모든 체크리스트 항목을 삭제하시겠습니까?\n(되돌릴 수 없습니다)')) return;
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) {
      console.error('task delete failed:', error);
      Toast.error('삭제 실패: ' + error.message);
      return;
    }
    Toast.success('삭제되었습니다');
    Modal.close();
    await Promise.all([refreshCalendar(), refreshPool()]);
  }

  // ═══ 매월 고정업무 템플릿 ═══════════════════════════════════════════
  // 월의 마지막 일수
  function lastDayOfMonth(y, m /* 1-based */) {
    return new Date(y, m, 0).getDate();
  }
  // 템플릿의 day_of_month_start를 실제 날짜로 clamp (예: 31일 템플릿을 2월에 적용 시 28/29)
  function clampDayToMonth(day, y, m) {
    return Math.min(day, lastDayOfMonth(y, m));
  }

  async function openTemplateListModal() {
    const { data: tpls, error } = await supabase
      .from('task_templates')
      .select('*')
      .order('day_of_month_start');
    if (error) { Toast.error('템플릿 로드 실패: ' + error.message); return; }

    Modal.open({
      type: 'center', size: 'md',
      title: '매월 고정업무 템플릿',
      html: `
        <div class="plan-tpl-list-wrap">
          <div class="plan-tpl-list-hdr">
            <span class="plan-tpl-list-hint">월마다 자동으로 생성할 업무를 템플릿으로 등록합니다.</span>
            <button type="button" class="btn btn-primary" id="planTplNew">+ 새 템플릿</button>
          </div>
          <div class="plan-tpl-list" id="planTplList">
            ${(tpls || []).length === 0
              ? `<div class="plan-placeholder">등록된 템플릿이 없습니다.</div>`
              : (tpls || []).map(tp => {
                  const color = CATEGORY_COLORS[tp.category] || CATEGORY_COLORS['기타'];
                  const dayLabel = tp.day_of_month_start >= 29
                    ? `매월 ${tp.day_of_month_start}일 (없으면 말일)`
                    : `매월 ${tp.day_of_month_start}일`;
                  return `
                    <div class="plan-tpl-row ${tp.is_active ? '' : 'is-inactive'}" data-id="${tp.id}">
                      <span class="plan-pool-chip" style="background:${color}">${esc(tp.category)}</span>
                      <div class="plan-tpl-row-main">
                        <div class="plan-tpl-row-title">${esc(tp.title)}</div>
                        <div class="plan-tpl-row-meta">${dayLabel} · ${tp.duration_days}일간</div>
                      </div>
                      <label class="plan-tpl-active-toggle" title="${tp.is_active ? '사용중 — 클릭 시 중지' : '중지 — 클릭 시 사용'}">
                        <input type="checkbox" data-role="active" ${tp.is_active ? 'checked' : ''}>
                        <span>${tp.is_active ? '사용' : '중지'}</span>
                      </label>
                      <button type="button" class="btn btn-sm" data-role="edit">수정</button>
                    </div>
                  `;
                }).join('')
            }
          </div>
          <div class="plan-tpl-list-footer">
            <button type="button" class="btn btn-secondary" id="planTplClose">닫기</button>
          </div>
        </div>
      `,
      onOpen: (el) => {
        el.querySelector('#planTplNew').addEventListener('click', () => openTemplateEditModal(null));
        el.querySelector('#planTplClose').addEventListener('click', () => Modal.close());
        el.querySelectorAll('.plan-tpl-row').forEach(row => {
          const id = row.dataset.id;
          row.querySelector('[data-role=edit]').addEventListener('click', () => openTemplateEditModal(id));
          row.querySelector('[data-role=active]').addEventListener('change', async (e) => {
            const nextActive = e.target.checked;
            const { error: err } = await supabase.from('task_templates').update({ is_active: nextActive }).eq('id', id);
            if (err) { Toast.error('변경 실패: ' + err.message); e.target.checked = !nextActive; return; }
            Toast.success(nextActive ? '사용으로 변경' : '중지로 변경');
            openTemplateListModal();
          });
        });
      }
    });
  }

  async function openTemplateEditModal(tplId) {
    const isEdit = !!tplId;
    let tpl = { title: '', description: '', category: '기타', day_of_month_start: 1, duration_days: 1, is_active: true };
    let items = [];
    if (isEdit) {
      const [{ data: t, error: e1 }, { data: its, error: e2 }] = await Promise.all([
        supabase.from('task_templates').select('*').eq('id', tplId).single(),
        supabase.from('task_template_items').select('*').eq('template_id', tplId).order('order_index')
      ]);
      if (e1 || e2) { Toast.error('템플릿 로드 실패'); return; }
      tpl = t;
      items = its || [];
    }

    Modal.open({
      type: 'center', size: 'md',
      title: isEdit ? '템플릿 수정' : '템플릿 등록',
      html: `
        <form id="planTplForm" class="plan-task-form">
          <div class="plan-form-row">
            <label>제목</label>
            <input type="text" name="title" value="${esc(tpl.title || '')}" maxlength="120" required placeholder="예: 월초 회의 준비">
          </div>
          <div class="plan-form-grid3">
            <div class="plan-form-row">
              <label>카테고리</label>
              <select name="category">
                ${CATEGORIES.map(c => `<option value="${c}" ${c===tpl.category?'selected':''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="plan-form-row">
              <label>시작일 (매월 N일)</label>
              <input type="number" name="day_of_month_start" min="1" max="31" value="${tpl.day_of_month_start}" required>
            </div>
            <div class="plan-form-row">
              <label>기간 (일)</label>
              <input type="number" name="duration_days" min="1" max="31" value="${tpl.duration_days}" required>
            </div>
          </div>
          <div class="plan-form-row">
            <label>설명</label>
            <textarea name="description" rows="2" placeholder="선택">${esc(tpl.description || '')}</textarea>
          </div>

          <div class="plan-items-editor">
            <div class="plan-items-hdr">
              <span>체크리스트 (드래그로 순서 변경)</span>
              <button type="button" class="plan-btn-sm" id="planTplItemAdd">+ 항목 추가</button>
            </div>
            <div class="plan-items-list" id="planTplItemsList"></div>
          </div>

          <div class="plan-task-actions">
            ${isEdit ? `<button type="button" class="btn btn-danger" id="planTplDel">삭제</button>` : ''}
            <button type="button" class="btn btn-secondary" id="planTplCancel">취소</button>
            <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        const listEl = el.querySelector('#planTplItemsList');
        const workingItems = items.map(it => ({ id: it.id, content: it.content, is_done: false, order_index: it.order_index }));
        if (!workingItems.length) workingItems.push({ id: tmpId(), content: '', is_done: false, order_index: 0 });
        renderItemsEditor(listEl, workingItems);

        el.querySelector('#planTplItemAdd').addEventListener('click', () => {
          workingItems.push({ id: tmpId(), content: '', is_done: false, order_index: workingItems.length });
          renderItemsEditor(listEl, workingItems);
          const last = listEl.querySelector('.plan-item-row:last-child input[type=text]');
          if (last) last.focus();
        });

        el.querySelector('#planTplCancel').addEventListener('click', () => openTemplateListModal());
        if (isEdit) el.querySelector('#planTplDel').addEventListener('click', async () => {
          if (!confirm('이 템플릿을 삭제하시겠습니까?\n(이미 생성된 업무는 그대로 남습니다)')) return;
          const { error } = await supabase.from('task_templates').delete().eq('id', tplId);
          if (error) { Toast.error('삭제 실패: ' + error.message); return; }
          Toast.success('삭제되었습니다');
          openTemplateListModal();
        });

        el.querySelector('#planTplForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          await handleTemplateSubmit(e.target, tplId, workingItems, items);
        });
      }
    });
  }

  async function handleTemplateSubmit(form, editId, workingItems, originalItems) {
    const fd = new FormData(form);
    const trainer = Auth.getTrainer();
    const payload = {
      title:       (fd.get('title') || '').trim(),
      category:    fd.get('category') || '기타',
      description: (fd.get('description') || '').trim() || null,
      day_of_month_start: Number(fd.get('day_of_month_start')),
      duration_days:      Number(fd.get('duration_days')),
    };
    if (!payload.title) { Toast.error('제목은 필수입니다.'); return; }
    if (!(payload.day_of_month_start >= 1 && payload.day_of_month_start <= 31)) { Toast.error('시작일은 1~31 사이'); return; }
    if (!(payload.duration_days      >= 1 && payload.duration_days      <= 31)) { Toast.error('기간은 1~31 사이'); return; }

    const cleanItems = workingItems
      .map(it => ({ ...it, content: (it.content || '').trim() }))
      .filter(it => it.content);

    try {
      let tplId = editId;
      if (editId) {
        const { error } = await supabase.from('task_templates').update(payload).eq('id', editId);
        if (error) throw error;
      } else {
        payload.created_by = trainer?.id || null;
        payload.is_active = true;
        const { data, error } = await supabase.from('task_templates').insert(payload).select('id').single();
        if (error) throw error;
        tplId = data.id;
      }

      // items 동기화
      if (editId && originalItems.length) {
        const keepIds = new Set(cleanItems.map(it => it.id).filter(x => !String(x).startsWith('tmp_')));
        const deleteIds = originalItems.filter(o => !keepIds.has(o.id)).map(o => o.id);
        if (deleteIds.length) {
          const { error } = await supabase.from('task_template_items').delete().in('id', deleteIds);
          if (error) throw error;
        }
      }
      if (cleanItems.length) {
        const rows = cleanItems.map((it, idx) => {
          const isNew = String(it.id).startsWith('tmp_');
          const row = { template_id: tplId, content: it.content, order_index: idx };
          if (!isNew) row.id = it.id;
          return row;
        });
        const { error } = await supabase.from('task_template_items').upsert(rows);
        if (error) throw error;
      }

      Toast.success(editId ? '수정되었습니다' : '등록되었습니다');
      openTemplateListModal();
    } catch (e) {
      console.error('template save failed:', e);
      Toast.error('저장 실패: ' + (e.message || e));
    }
  }

  async function handleGenerateMonthFromTemplates() {
    const { y, m } = viewMonth;
    const ym = `${y}-${pad(m)}`;
    if (!confirm(`${y}년 ${m}월에 고정업무 템플릿을 일괄 생성하시겠습니까?\n(이미 생성된 템플릿은 건너뜁니다)`)) return;

    // 1) active 템플릿 + 항목 로드
    const { data: tpls, error: e1 } = await supabase
      .from('task_templates')
      .select('*, task_template_items(*)')
      .eq('is_active', true);
    if (e1) { Toast.error('템플릿 로드 실패: ' + e1.message); return; }
    if (!tpls || !tpls.length) { Toast.info('활성화된 템플릿이 없습니다.'); return; }

    // 2) 이미 이번달에 생성된 template_id 조회
    const { data: exist, error: e2 } = await supabase
      .from('tasks')
      .select('template_id')
      .eq('template_ym', ym)
      .not('template_id', 'is', null);
    if (e2) { Toast.error('중복 확인 실패: ' + e2.message); return; }
    const existingIds = new Set((exist || []).map(x => x.template_id));

    // 3) 미생성 템플릿들 insert
    const trainer = Auth.getTrainer();
    let created = 0, skipped = 0, failed = 0;
    for (const tpl of tpls) {
      if (existingIds.has(tpl.id)) { skipped++; continue; }
      const day   = clampDayToMonth(tpl.day_of_month_start, y, m);
      const start = new Date(y, m - 1, day);
      const end   = addDays(start, (tpl.duration_days || 1) - 1);
      const endClamped = end.getMonth() !== (m - 1)
        ? new Date(y, m - 1, lastDayOfMonth(y, m)) // 월 넘어가면 말일로 자름
        : end;

      const taskPayload = {
        title:        tpl.title,
        description:  tpl.description,
        category:     tpl.category,
        start_date:   toYMD(start),
        end_date:     toYMD(endClamped),
        template_id:  tpl.id,
        template_ym:  ym,
        created_by:   trainer?.id || null,
      };
      const { data: inserted, error } = await supabase.from('tasks').insert(taskPayload).select('id').single();
      if (error) { console.error('task create failed:', error); failed++; continue; }

      const tplItems = (tpl.task_template_items || []).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
      if (tplItems.length) {
        const rows = tplItems.map((it, idx) => ({
          task_id: inserted.id, content: it.content, order_index: idx, is_done: false,
        }));
        const { error: e3 } = await supabase.from('task_items').insert(rows);
        if (e3) console.error('items create failed:', e3);
      }
      created++;
    }

    const msg = `생성 ${created}건${skipped ? ` · 이미 있음 ${skipped}건` : ''}${failed ? ` · 실패 ${failed}건` : ''}`;
    if (failed > 0) Toast.error(msg); else Toast.success(msg);
    await Promise.all([refreshCalendar(), refreshPool()]);
  }

  // ═══ 일정 모달용: 미완료 task_items 옵션 로더 (promo.js에서 사용) ══
  async function fetchOpenTaskItems() {
    const { data, error } = await supabase
      .from('task_items')
      .select('id, content, order_index, tasks(title, status)')
      .eq('is_done', false)
      .order('order_index')
      .limit(200);
    if (error) {
      console.error('open items fetch failed:', error);
      return [];
    }
    return (data || [])
      .filter(it => it.tasks && it.tasks.status !== 'cancelled' && it.tasks.status !== 'archived')
      .map(it => ({ id: it.id, label: `${it.tasks.title} · ${it.content}` }));
  }

  return { render, fetchOpenTaskItems };
})();
