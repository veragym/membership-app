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
          <div class="ops-panel ops-panel-resv">
            <div class="ops-panel-header">
              <span class="ops-panel-title">예약자 리스트</span>
              <span style="font-size:11px;color:var(--color-text-muted)">일회성 · 최대 20개 · 새로고침 후에도 창 닫기 전까지 유지</span>
            </div>
            <div class="ops-panel-body" id="resvListBody"></div>
          </div>
          <div class="ops-panel">
            <div class="ops-panel-header">
              <span class="ops-panel-title">예정 업무 (오늘 이후)</span>
              <div class="ops-upcoming-actions">
                <button type="button" class="btn-upcoming-action" id="btnUpcomingDelSelected" disabled>선택삭제</button>
                <button type="button" class="btn-upcoming-action btn-upcoming-danger" id="btnUpcomingDelAll">전체삭제</button>
              </div>
            </div>
            <div class="ops-panel-body" id="opsUpcomingList">
              <div class="ops-placeholder">불러오는 중…</div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btnShareSched').addEventListener('click', shareScheduleImage);
    document.getElementById('btnUpcomingDelSelected').addEventListener('click', handleUpcomingDeleteSelected);
    document.getElementById('btnUpcomingDelAll').addEventListener('click', handleUpcomingDeleteAll);
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
  // 이미지 구성:
  //   ┌────────────┬───────────┐
  //   │ 통계 정보  │ 금일 일정 │
  //   ├────────────┴───────────┤
  //   │      예약자 리스트      │
  //   └────────────────────────┘
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

  // ═══ 예정 업무 리스트 ═══
  function renderUpcoming() {
    const el = document.getElementById('opsUpcomingList');
    if (!el) return;
    const delAllBtn = document.getElementById('btnUpcomingDelAll');
    const todayYMD = toYMD(new Date());
    const upcoming = scheduleData.filter(s => s.sched_date >= todayYMD);
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

  // ───────── 홍보관리 (2단계 서브탭: 캠페인 / 플레이스) ─────────
  let activePromoSub = 'campaign';

  function renderPromo(container) {
    container.innerHTML = `
      <div class="promo-sub-bar">
        <button type="button" class="promo-sub-btn ${activePromoSub === 'campaign' ? 'active' : ''}" data-sub="campaign">캠페인</button>
        <button type="button" class="promo-sub-btn ${activePromoSub === 'place' ? 'active' : ''}" data-sub="place">플레이스</button>
      </div>
      <div id="promo-sub-content"></div>
    `;
    container.querySelectorAll('.promo-sub-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activePromoSub = btn.dataset.sub;
        container.querySelectorAll('.promo-sub-btn').forEach(b => b.classList.toggle('active', b === btn));
        loadPromoSub(activePromoSub);
      });
    });
    loadPromoSub(activePromoSub);
  }

  function loadPromoSub(sub) {
    const c = document.getElementById('promo-sub-content');
    if (!c) return;
    if (sub === 'campaign') renderPromoCampaigns(c);
    else if (sub === 'place') {
      if (typeof PromoPlaceTab !== 'undefined' && PromoPlaceTab.render) {
        PromoPlaceTab.render(c);
      } else {
        c.innerHTML = `<div class="ops-placeholder">플레이스 모듈 로드 실패 — 새로고침 후 재시도</div>`;
      }
    }
  }

  // 기존 캠페인 placeholder 카드 — 레이아웃/텍스트 모두 원본 그대로 유지
  function renderPromoCampaigns(container) {
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
