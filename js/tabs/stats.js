/**
 * 통계 탭 v2 — 세부탭 2개 [매출 추이] [기간별 비교]
 *
 * [매출 추이] (v3 개편)
 *   3카드: 당월 매출 / 전월 대비 / 전년 대비
 *   "당월 매출" 카드 상단에 [금일 매출 | 당월 매출] 병치 행
 *   FC/PT 섹션: 총매출 + 금일매출 병치
 *   주차 목표 구분선(N주차) 하단: FC/PT/총 목표·남은 매출 (**주차 매출 기준**)
 *
 *   회원권(registrations): total_payment / 1.1 (부가세 제외)
 *   PT(pt_registrations): contract_amount (그대로)
 *   상품 제외 필터 (localStorage) · 주별 목표(revenue_targets) · 카카오톡 복사
 */
const StatsTab = (() => {
  const EXCLUDE_STORAGE_KEY = 'stats.fc_excluded_products';
  let activeSubTab = 'trend';
  let allProducts = [];
  let excludedProducts = new Set();

  // 우측 패널 — 회원권/PT 각각 독립된 기간 상태 (월/분기/반기/연간)
  const _defaultPeriod = () => {
    const d = new Date();
    return { type: 'month', year: d.getFullYear(), sub: d.getMonth() + 1 };
  };
  let fcPeriod = _defaultPeriod();
  let ptPeriod = _defaultPeriod();

  // 담당자별 통계 패널 상태

  function init() {
    const saved = localStorage.getItem(EXCLUDE_STORAGE_KEY);
    excludedProducts = new Set(saved ? JSON.parse(saved) : ['1일', '쿠폰']);
    renderLayout();
    loadSubTab(activeSubTab);
  }

  function renderLayout() {
    const pane = document.getElementById('tab-stats');
    pane.innerHTML = `
      <div class="stats-subtab-bar">
        <button class="stats-subtab ${activeSubTab === 'trend' ? 'active' : ''}" data-tab="trend">매출 추이</button>
        <button class="stats-subtab ${activeSubTab === 'compare' ? 'active' : ''}" data-tab="compare">기간별 비교</button>
      </div>
      <div id="stats-content"></div>
    `;
    pane.querySelectorAll('.stats-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeSubTab = btn.dataset.tab;
        pane.querySelectorAll('.stats-subtab').forEach(b => b.classList.toggle('active', b === btn));
        loadSubTab(activeSubTab);
      });
    });
  }

  async function loadSubTab(tab) {
    const c = document.getElementById('stats-content');
    c.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    if (tab === 'trend') await renderTrend(c);
    else await renderCompare(c);
  }

  // ───────── [매출 추이] ─────────
  async function renderTrend(container) {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
    const monthStart = isoDate(new Date(y, m - 1, 1));
    const monthEnd   = isoDate(new Date(y, m, 0));
    const lastMonth  = { y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1 };
    const lastYear   = { y: y - 1, m };

    // 당월/전월/전년 누적
    const current = await fetchRevenue(monthStart, isoDate(today));
    const lastM   = await fetchRevenue(isoDate(new Date(lastMonth.y, lastMonth.m - 1, 1)), isoDate(new Date(lastMonth.y, lastMonth.m, 0)));
    const lastY   = await fetchRevenue(isoDate(new Date(lastYear.y, lastYear.m - 1, 1)), isoDate(new Date(lastYear.y, lastYear.m, 0)));

    // v3: 주차 계산 (openMonthlyTargetModal v8 규칙과 일치)
    const weekInfo = computeWeekInfo(today);
    const targets = await fetchTargets(weekInfo.weekStartISO);
    const fcTarget = targets.FC ?? 0;
    const ptTarget = targets.PT ?? 0;

    // v3: 주차 매출 (주 시작 ~ 오늘, 오늘까지 누적). 남은 매출 계산은 주차 기준.
    const weekRev = await fetchRevenue(weekInfo.weekStartISO, isoDate(today));

    // 금일 매출
    const todayRev = await fetchRevenue(isoDate(today), isoDate(today));

    // 상품 목록 (제외 필터용)
    if (allProducts.length === 0) await loadProducts();

    container.innerHTML = `
      <div class="stats-filter-panel">
        <details class="stats-filter-details">
          <summary>회원권 합계 제외 상품 (${excludedProducts.size}건 제외 중)</summary>
          <div class="stats-filter-chips">
            ${allProducts.map(p => `
              <label class="chip-check">
                <input type="checkbox" value="${escHtml(p)}" ${excludedProducts.has(p) ? 'checked' : ''}>
                <span>${escHtml(p)}</span>
              </label>
            `).join('')}
          </div>
        </details>
      </div>

      <div class="stats-trend-grid">
        ${renderCard('당월 매출', current, fcTarget, ptTarget, {
          current: true, withActions: true,
          todayRev, weekRev, weekInfo
        })}
        <div class="stats-quad-grid">
          ${renderCard(`전월 대비 (${lastMonth.m}월)`, lastM, null, null, { compareBase: current })}
          <div class="stats-card-v2 stats-staff-card">
            <div class="stats-staff-header">
              <h4>회원권 <small>(매출담당자별)</small></h4>
            </div>
            ${renderPeriodControls('fc', fcPeriod)}
            <div id="staffBodyFc" class="stats-staff-body"></div>
          </div>
          ${renderCard(`전년 대비 (${lastYear.y}년 ${lastYear.m}월)`, lastY, null, null, { compareBase: current })}
          <div class="stats-card-v2 stats-staff-card">
            <div class="stats-staff-header">
              <h4>PT <small>(계약T별)</small></h4>
            </div>
            ${renderPeriodControls('pt', ptPeriod)}
            <div id="staffBodyPt" class="stats-staff-body"></div>
          </div>
        </div>
      </div>
    `;

    // 제외 체크 핸들러
    container.querySelectorAll('.chip-check input').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) excludedProducts.add(cb.value);
        else excludedProducts.delete(cb.value);
        localStorage.setItem(EXCLUDE_STORAGE_KEY, JSON.stringify([...excludedProducts]));
        loadSubTab('trend');
      });
    });

    container.querySelector('#stats-set-target').addEventListener('click', () => openMonthlyTargetModal(y, m));
    container.querySelector('#stats-kakao-copy').addEventListener('click', () => {
      const text = buildKakaoText({ today, todayRev, current, weekRev, weekInfo, fcTarget, ptTarget });
      navigator.clipboard.writeText(text)
        .then(() => Toast.success('카카오톡 메시지가 복사되었습니다'))
        .catch(() => Toast.error('복사 실패'));
    });

    // 우측 스태프 카드 — 회원권/PT 각각 독립 이벤트
    bindPeriodControls(container);
    loadFcData(container);
    loadPtData(container);
  }

  // ───────── 우측 패널: 기간 컨트롤 헬퍼 ─────────
  function renderPeriodControls(cardId, period) {
    const types = [['month','월'], ['quarter','분기'], ['half','반기'], ['year','연간']];
    const years = [2024, 2025, 2026, 2027];
    return `
      <div class="stats-staff-controls">
        <div class="stats-staff-tabs">
          ${types.map(([v,l]) => `
            <button class="stats-staff-tab ${period.type===v?'active':''}" data-card="${cardId}" data-period-type="${v}">${l}</button>
          `).join('')}
        </div>
        <div class="stats-staff-selects">
          <select class="stats-staff-select" data-card="${cardId}" data-field="year">
            ${years.map(y => `<option value="${y}" ${period.year===y?'selected':''}>${y}년</option>`).join('')}
          </select>
          <select class="stats-staff-select" data-card="${cardId}" data-field="sub" ${period.type==='year'?'style="display:none"':''}>
            ${buildPeriodSubOptions(period.type, period.sub)}
          </select>
        </div>
      </div>
    `;
  }

  function buildPeriodSubOptions(type, selected) {
    if (type === 'month') return Array.from({length:12},(_,i)=>i+1)
      .map(mo => `<option value="${mo}" ${selected===mo?'selected':''}>${mo}월</option>`).join('');
    if (type === 'quarter') return [1,2,3,4]
      .map(q => `<option value="${q}" ${selected===q?'selected':''}>${q}분기</option>`).join('');
    if (type === 'half') return [1,2]
      .map(h => `<option value="${h}" ${selected===h?'selected':''}>${h===1?'상반기':'하반기'}</option>`).join('');
    return '';
  }

  function computePeriodRange(period) {
    const { type, year, sub } = period;
    let startM, endM;
    if (type === 'month')   { startM = sub;           endM = sub; }
    else if (type==='quarter'){ startM = (sub-1)*3+1; endM = sub*3; }
    else if (type === 'half'){ startM = sub===1?1:7;  endM = sub===1?6:12; }
    else                     { startM = 1;            endM = 12; } // year
    return {
      fromDate: `${year}-${String(startM).padStart(2,'0')}-01`,
      toDate:   isoDate(new Date(year, endM, 0)),
    };
  }

  // 경과 개월 수 (평균 계산 기준) — 오늘 시점까지만 센다
  function computeElapsedMonths(period) {
    const { type, year, sub } = period;
    const today = new Date();
    const curY = today.getFullYear(), curM = today.getMonth() + 1;
    let startM, endM;
    if (type === 'month')   { startM = sub;           endM = sub; }
    else if (type==='quarter'){ startM = (sub-1)*3+1; endM = sub*3; }
    else if (type === 'half'){ startM = sub===1?1:7;  endM = sub===1?6:12; }
    else                     { startM = 1;            endM = 12; }
    if (year < curY) return endM - startM + 1; // 과거 연도: 전체 기간
    if (year > curY) return 0;                 // 미래 연도
    return Math.max(0, Math.min(endM, curM) - startM + 1);
  }

  function defaultSubFor(type) {
    const d = new Date();
    if (type === 'month')   return d.getMonth() + 1;
    if (type === 'quarter') return Math.ceil((d.getMonth()+1)/3);
    if (type === 'half')    return d.getMonth() < 6 ? 1 : 2;
    return 1; // year: unused
  }

  function bindPeriodControls(container) {
    const getPeriod = card => card === 'fc' ? fcPeriod : ptPeriod;
    const reload    = (container, card) => card === 'fc' ? loadFcData(container) : loadPtData(container);

    container.querySelectorAll('.stats-staff-tab[data-period-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.dataset.card;
        const p = getPeriod(card);
        p.type = btn.dataset.periodType;
        p.sub  = defaultSubFor(p.type);
        container.querySelectorAll(`.stats-staff-tab[data-card="${card}"]`).forEach(b => {
          b.classList.toggle('active', b.dataset.periodType === p.type);
        });
        const subSel = container.querySelector(`.stats-staff-select[data-card="${card}"][data-field="sub"]`);
        subSel.innerHTML = buildPeriodSubOptions(p.type, p.sub);
        subSel.style.display = p.type === 'year' ? 'none' : '';
        reload(container, card);
      });
    });
    container.querySelectorAll('.stats-staff-select[data-field="year"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const card = sel.dataset.card;
        getPeriod(card).year = +sel.value;
        reload(container, card);
      });
    });
    container.querySelectorAll('.stats-staff-select[data-field="sub"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const card = sel.dataset.card;
        getPeriod(card).sub = +sel.value;
        reload(container, card);
      });
    });
  }

  function renderStaffTable(body, headLabel, amtLabel, sorted, totalCount, total, elapsed, _totalLabel, avgLabel) {
    const fmt = n => n.toLocaleString() + '원';
    if (!sorted.length) { body.innerHTML = '<div class="stats-staff-empty">해당 기간 매출 없음</div>'; return; }
    const avgHead = elapsed > 0 ? `${avgLabel} <small>(÷${elapsed}개월)</small>` : avgLabel;
    const avgCell = amt => elapsed > 0 ? fmt(Math.round(amt/elapsed)) : '-';
    body.innerHTML = `
      <table class="stats-staff-table">
        <thead><tr>
          <th>${headLabel}</th>
          <th>건수</th>
          <th>${amtLabel}</th>
          <th>${avgHead}</th>
        </tr></thead>
        <tbody>${sorted.map(([name,v])=>`
          <tr>
            <td>${escHtml(name)}</td>
            <td class="stats-staff-count">${v.count}건</td>
            <td class="stats-staff-amount">${fmt(v.amount)}</td>
            <td class="stats-staff-amount stats-staff-avg-cell">${avgCell(v.amount)}</td>
          </tr>`).join('')}</tbody>
        <tfoot>
          <tr>
            <td>합계</td>
            <td>${totalCount}건</td>
            <td class="stats-staff-amount">${fmt(total)}</td>
            <td class="stats-staff-amount stats-staff-avg-cell">${avgCell(total)}</td>
          </tr>
        </tfoot>
      </table>`;
  }

  async function loadFcData(container) {
    const body = container.querySelector('#staffBodyFc');
    if (!body) return;
    body.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    const { fromDate, toDate } = computePeriodRange(fcPeriod);

    const { data } = await supabase.from('registrations')
      .select('sales_manager, total_payment, product')
      .gte('registered_date', fromDate).lte('registered_date', toDate);
    const rows = (data||[]).filter(r => !excludedProducts.has(r.product));
    const grouped = {};
    rows.forEach(r => {
      const name = r.sales_manager || '(미지정)';
      if (!grouped[name]) grouped[name] = { amount: 0, count: 0 };
      grouped[name].amount += Math.round((r.total_payment||0)/1.1);
      grouped[name].count++;
    });
    const sorted = Object.entries(grouped).sort((a,b)=>b[1].amount-a[1].amount);
    const total  = sorted.reduce((s,[,v])=>s+v.amount, 0);
    const elapsed = computeElapsedMonths(fcPeriod);
    renderStaffTable(body, '매출담당', '매출액', sorted, rows.length, total, elapsed, '총 매출액', '평균 매출액');
  }

  async function loadPtData(container) {
    const body = container.querySelector('#staffBodyPt');
    if (!body) return;
    body.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    const { fromDate, toDate } = computePeriodRange(ptPeriod);

    const { data } = await supabase.from('pt_registrations')
      .select('contract_amount, contract_trainer:trainers!pt_registrations_contract_trainer_id_fkey(name)')
      .gte('contract_date', fromDate).lte('contract_date', toDate);
    const grouped = {};
    (data||[]).forEach(r => {
      const name = r.contract_trainer?.name || '(미지정)';
      if (!grouped[name]) grouped[name] = { amount: 0, count: 0 };
      grouped[name].amount += (r.contract_amount||0);
      grouped[name].count++;
    });
    const sorted     = Object.entries(grouped).sort((a,b)=>b[1].amount-a[1].amount);
    const total      = sorted.reduce((s,[,v])=>s+v.amount, 0);
    const totalCount = sorted.reduce((s,[,v])=>s+v.count, 0);
    const elapsed    = computeElapsedMonths(ptPeriod);
    renderStaffTable(body, '계약T', '계약금액', sorted, totalCount, total, elapsed, '총 계약금액', '평균 계약금액');
  }

  function renderCard(title, rev, fcTarget, ptTarget, opts = {}) {
    const fc = rev.fc, pt = rev.pt, total = fc + pt;
    const fmt = n => n.toLocaleString() + '원';

    // v3: 당월 카드 전용 — 금일 매출 병치 헤더 + FC/PT 섹션 내 금일 병치
    let topTodayBlock = '';
    let fcRow = `<div class="stats-row"><span>FC 총 매출 (부가세 제외)</span><b>${fmt(fc)}</b></div>`;
    let ptRow = `<div class="stats-row"><span>PT 매출 (계약금액)</span><b>${fmt(pt)}</b></div>`;
    if (opts.current && opts.todayRev) {
      const t = opts.todayRev;
      const todayTotal = (t.fc || 0) + (t.pt || 0);
      topTodayBlock = `
        <div class="stats-today-grid">
          <div class="stats-today-col">
            <div class="stats-today-label">금일 매출</div>
            <div class="stats-today-value">${fmt(todayTotal)}</div>
            <div class="stats-today-hint">(금일 등록된 매출)</div>
          </div>
          <div class="stats-today-col stats-today-col-month">
            <div class="stats-today-label">당월 매출</div>
            <div class="stats-today-value">${fmt(total)}</div>
          </div>
        </div>
      `;
      fcRow = `
        <div class="stats-row"><span>FC 총 매출 (부가세 제외)</span><b>${fmt(fc)}</b></div>
        <div class="stats-row stats-row-today"><span>FC 금일 매출</span><b>${fmt(t.fc || 0)}</b></div>
      `;
      ptRow = `
        <div class="stats-row"><span>PT 매출 (계약금액)</span><b>${fmt(pt)}</b></div>
        <div class="stats-row stats-row-today"><span>PT 금일 매출</span><b>${fmt(t.pt || 0)}</b></div>
      `;
    }

    // v3: 주차 목표/남은 섹션 — 남은 매출 = 주차 목표 - 주차 매출
    // v4: 남은 매출 signed 표시 — 부족(remain > 0)은 "-금액" 빨강, 초과(remain < 0)은 "+금액" 파랑
    const fmtRemain = (remain) => {
      if (remain > 0)  return { text: `-${fmt(remain)}`,  cls: 'neg' };  // 부족 → 빨강
      if (remain < 0)  return { text: `+${fmt(-remain)}`, cls: 'pos' };  // 초과 → 파랑
      return { text: fmt(0), cls: 'pos' };                                // 정확히 달성
    };
    let targetBlock = '';
    if (opts.current) {
      const weekRev = opts.weekRev || { fc: 0, pt: 0 };
      const weekInfo = opts.weekInfo || { weekNumber: 0 };
      const fcRemain = fcTarget - weekRev.fc;
      const ptRemain = ptTarget - weekRev.pt;
      const totalTarget = fcTarget + ptTarget;
      const totalRemain = fcRemain + ptRemain;
      const fcR = fmtRemain(fcRemain);
      const ptR = fmtRemain(ptRemain);
      const totR = fmtRemain(totalRemain);
      targetBlock = `
        <div class="stats-target-divider">${weekInfo.weekNumber}주차 목표 매출</div>
        <div class="stats-target-row"><span>FC 목표 매출</span><b>${fmt(fcTarget)}</b></div>
        <div class="stats-target-row"><span>FC 남은 매출</span><b class="${fcR.cls}">${fcR.text}</b></div>
        <div class="stats-target-row"><span>PT 목표 매출</span><b>${fmt(ptTarget)}</b></div>
        <div class="stats-target-row"><span>PT 남은 매출</span><b class="${ptR.cls}">${ptR.text}</b></div>
        <div class="stats-target-row stats-target-total"><span>총 목표 매출</span><b>${fmt(totalTarget)}</b></div>
        <div class="stats-target-row stats-target-total"><span>총 남은 매출</span><b class="${totR.cls}">${totR.text}</b></div>
      `;
    }

    let deltaBlock = '';
    if (opts.compareBase) {
      const diff = opts.compareBase.fc + opts.compareBase.pt - total;
      const pct = total > 0 ? Math.round(((opts.compareBase.fc + opts.compareBase.pt) / total - 1) * 100) : 0;
      deltaBlock = `<div class="stats-delta ${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : ''}${fmt(diff)} (${pct >= 0 ? '+' : ''}${pct}%)</div>`;
    }

    const actionsBlock = opts.withActions ? `
      <div class="stats-card-actions">
        <button class="btn btn-secondary" id="stats-set-target">주별 목표 수정</button>
        <button class="btn btn-primary" id="stats-kakao-copy">카카오톡으로 복사하기</button>
      </div>
    ` : '';

    // 당월 카드: 상단 금일/당월 grid + FC/PT 행 + 구분선 + 목표. 나머지 카드: 기존 레이아웃.
    if (opts.current) {
      return `
        <div class="stats-card-v2 stats-card-current">
          <h4>${escHtml(title)}</h4>
          ${topTodayBlock}
          ${fcRow}
          ${ptRow}
          ${targetBlock}
          ${actionsBlock}
        </div>
      `;
    }
    return `
      <div class="stats-card-v2">
        <h4>${escHtml(title)}</h4>
        <div class="stats-total">${fmt(total)}</div>
        ${fcRow}
        ${ptRow}
        ${deltaBlock}
        ${actionsBlock}
      </div>
    `;
  }

  async function fetchRevenue(fromDate, toDate) {
    // v5: 제외 상품 필터는 클라이언트에서 적용 (한글 값 PostgREST in 필터 파싱 이슈 회피)
    const { data: fcData } = await supabase.from('registrations')
      .select('product, total_payment')
      .gte('registered_date', fromDate).lte('registered_date', toDate);
    const fcFiltered = (fcData || []).filter(r => !excludedProducts.has(r.product));
    const fc = Math.round(fcFiltered.reduce((s, r) => s + (r.total_payment || 0), 0) / 1.1);

    const { data: ptData } = await supabase.from('pt_registrations')
      .select('contract_amount')
      .gte('contract_date', fromDate).lte('contract_date', toDate);
    const pt = (ptData || []).reduce((s, r) => s + (r.contract_amount || 0), 0);

    return { fc, pt };
  }

  async function loadProducts() {
    // 우선 설정(dropdown_options.회원권상품)에서 상품 목록을 가져온다.
    // 실제 매출에 사용된 상품도 합쳐서, 설정에서 삭제된 과거 상품도 필터 칩에 남게 한다.
    const [{ data: dropData }, { data: regData }] = await Promise.all([
      supabase.from('dropdown_options')
        .select('value, sort_order')
        .eq('category', '회원권상품')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      supabase.from('registrations').select('product').not('product', 'is', null)
    ]);
    const fromSettings = (dropData || []).map(r => r.value);
    const fromRegs = (regData || []).map(r => r.product);
    // 설정 순서 유지 + 설정에 없는 과거 상품을 뒤에 붙여준다
    const seen = new Set();
    const merged = [];
    fromSettings.forEach(v => { if (!seen.has(v)) { seen.add(v); merged.push(v); } });
    [...new Set(fromRegs)].sort().forEach(v => { if (!seen.has(v)) { seen.add(v); merged.push(v); } });
    allProducts = merged;
  }

  async function fetchTargets(weekStart) {
    const { data } = await supabase.from('revenue_targets').select('target_type, target_amount').eq('target_week', weekStart);
    const out = {};
    (data || []).forEach(r => { out[r.target_type] = r.target_amount; });
    return out;
  }

  // ───────── 월별 목표 입력 모달 (해당 월에 걸치는 모든 주) ─────────
  async function openMonthlyTargetModal(year, month) {
    // v8 규칙: 1주는 월 1일부터(1일이 무슨 요일이든), 2주부터 월요일 시작, 월 경계 넘지 않음
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const weeks = [];
    // 1주차: 월 1일
    weeks.push(isoDate(firstDay));
    // 1일 다음 월요일 계산
    const dow = firstDay.getDay();  // 0=일, 1=월, ..., 6=토
    const daysToMon = dow === 0 ? 1 : (8 - dow);
    const nextMon = new Date(firstDay);
    nextMon.setDate(nextMon.getDate() + daysToMon);
    // 2주차부터 월요일 7일씩 말일까지
    for (let d = new Date(nextMon); d <= lastDay; d.setDate(d.getDate() + 7)) {
      weeks.push(isoDate(new Date(d)));
    }

    // 기존 목표 로드
    const { data } = await supabase.from('revenue_targets')
      .select('target_type, target_week, target_amount')
      .in('target_week', weeks);
    const existing = {};
    (data || []).forEach(r => { existing[`${r.target_type}_${r.target_week}`] = r.target_amount; });

    const rowsHtml = weeks.map((w, i) => {
      const fcVal = existing[`FC_${w}`] ?? 0;
      const ptVal = existing[`PT_${w}`] ?? 0;
      return `
        <div class="target-week-row">
          <div class="target-week-label">${month}월 ${i + 1}주 <small>(${w}~)</small></div>
          <div class="target-week-inputs">
            <label>FC<input type="number" data-week="${w}" data-type="FC" value="${fcVal}" min="0" step="10000"></label>
            <label>PT<input type="number" data-week="${w}" data-type="PT" value="${ptVal}" min="0" step="10000"></label>
          </div>
        </div>
      `;
    }).join('');

    Modal.open({
      type: 'center',
      title: `${year}년 ${month}월 주별 목표 매출`,
      size: 'lg',
      html: `
        <form id="target-form">
          <div class="target-weeks-list">${rowsHtml}</div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">전체 저장</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#target-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const inputs = el.querySelectorAll('input[data-week]');
          const nowIso = new Date().toISOString();
          const upserts = Array.from(inputs).map(inp => ({
            target_type: inp.dataset.type,
            target_week: inp.dataset.week,
            target_amount: parseInt(inp.value) || 0,
            updated_at: nowIso,
          }));
          const { error } = await supabase.from('revenue_targets')
            .upsert(upserts, { onConflict: 'target_type,target_week' });
          if (error) { Toast.error('저장 실패: ' + error.message); return; }
          Toast.success(`${weeks.length}주 목표 저장됨`);
          Modal.close();
          loadSubTab('trend');
        });
      }
    });
  }

  // ───────── 카카오톡 템플릿 ─────────
  // v4: 주차 매출 기준. 남은 매출 = 실제 - 목표 (달성 시 +, 미달 시 - 로 표기).
  //     총 누적매출과 총 목표 사이에 빈 줄 삽입.
  function buildKakaoText({ today, todayRev, current, weekRev, weekInfo, fcTarget, ptTarget }) {
    const m = today.getMonth() + 1, d = today.getDate();
    const weekNo = weekInfo?.weekNumber || 1;
    const fmt = n => n.toLocaleString() + '원';
    // 달성 시 +, 미달 시 - 로 명시. (실제 - 목표 부호 그대로)
    const fmtDiff = n => (n >= 0 ? '+' : '-') + Math.abs(n).toLocaleString() + '원';
    const wk = weekRev || { fc: 0, pt: 0 };
    const fcDiff = wk.fc - fcTarget;
    const ptDiff = wk.pt - ptTarget;
    const totalTarget = fcTarget + ptTarget;
    const totalDiff = fcDiff + ptDiff;
    return [
      `베라짐 미사점 ${m}월 ${weekNo}주차`,
      `현재 매출 보고드립니다.`,
      ``,
      `FC 금일 매출 ${fmt(todayRev.fc)}`,
      `${m}월 ${d}일까지 누적 매출`,
      `${fmt(current.fc)} (부가세 제외)`,
      `FC 목표 매출 ${fmt(fcTarget)}`,
      `FC 남은 매출 ${fmtDiff(fcDiff)}`,
      ``,
      `PT 금일 매출 ${fmt(todayRev.pt)}`,
      `${m}월 ${d}일까지 누적 매출`,
      `${fmt(current.pt)} (계약금액)`,
      `PT 목표 매출 ${fmt(ptTarget)}`,
      `PT 남은 매출 ${fmtDiff(ptDiff)}`,
      ``,
      `금일 매출 ${fmt(todayRev.fc + todayRev.pt)}`,
      `총 누적매출 ${fmt(current.fc + current.pt)}`,
      ``,
      `총 목표 매출 ${fmt(totalTarget)}`,
      `총 남은 매출 ${fmtDiff(totalDiff)} 입니다.`,
    ].join('\n');
  }

  // ───────── [기간별 비교] placeholder ─────────
  async function renderCompare(container) {
    container.innerHTML = `
      <div class="empty-state" style="padding:48px;">
        <div style="font-size:32px;">📅</div>
        <div style="margin-top:12px; font-weight:600;">기간별 비교</div>
        <div style="margin-top:8px; color:var(--color-text-muted);">
          추후 구현 예정 — 두 기간 선택 후 FC/PT 매출·건수·전환율 비교
        </div>
      </div>
    `;
  }

  // ───────── 유틸 ─────────
  // v6: 로컬 타임존 기준 YYYY-MM-DD. toISOString()은 UTC라 KST 자정 이전이면 하루 밀려 월/년 경계가 어긋남.
  function isoDate(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function weekMonday(dt) {
    const d = new Date(dt);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return isoDate(d);
  }

  // v3: openMonthlyTargetModal v8 규칙과 일치하는 주차 계산
  //   - 1주차: 월 1일 ~ 다음 월요일 직전 (1일이 무슨 요일이든)
  //   - 2주차 이후: 월요일~일요일 (단, 월 경계를 넘지 않고 말일에서 잘림)
  // 반환: { weekNumber, weekStart, weekEnd, weekStartISO }
  function computeWeekInfo(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1;
    const firstDay = new Date(y, m - 1, 1);
    const lastDay  = new Date(y, m, 0);
    const weeks = [];
    // 1주차 시작 = 1일
    weeks.push(new Date(firstDay));
    // 1일 다음 월요일 계산
    const dow = firstDay.getDay();
    const daysToMon = dow === 0 ? 1 : (8 - dow);
    const nextMon = new Date(firstDay);
    nextMon.setDate(nextMon.getDate() + daysToMon);
    for (let d = new Date(nextMon); d <= lastDay; d.setDate(d.getDate() + 7)) {
      weeks.push(new Date(d));
    }
    // date 가 속한 주 찾기: 각 주의 시작일 이상인 것 중 마지막
    let idx = 0;
    for (let i = 0; i < weeks.length; i++) {
      if (date >= weeks[i]) idx = i;
      else break;
    }
    const weekStart = weeks[idx];
    // 해당 주의 끝 = 다음 주 시작 - 1일, 없으면 월말
    const nextStart = weeks[idx + 1];
    const weekEnd = nextStart
      ? new Date(nextStart.getFullYear(), nextStart.getMonth(), nextStart.getDate() - 1)
      : new Date(lastDay);
    return {
      weekNumber: idx + 1,
      weekStart,
      weekEnd,
      weekStartISO: isoDate(weekStart),
      weekEndISO: isoDate(weekEnd),
    };
  }

  return { init };
})();
