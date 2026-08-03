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
  const _defaultCompareState = () => {
    const d = new Date();
    return {
      mode: 'month',
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      fromDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
      toDate: isoDate(d),
    };
  };
  let compareState = _defaultCompareState();

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
    else await renderRevenueCompare(c);
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
        <div id="weeklyBreakdown" class="stats-weekly-card stats-card-v2">
          <div class="loading-center"><div class="spinner"></div></div>
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

    // 당월 주별 매출 (하단 전체 폭)
    loadWeeklyBreakdown(container, y, m, today);
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
          <th>계약건수</th>
          <th>${amtLabel}</th>
          <th>${avgHead}</th>
        </tr></thead>
        <tbody>${sorted.map(([name,v])=>`
          <tr>
            <td>${escHtml(name)}</td>
            <td class="stats-staff-count" title="계약(또는 업그레이드) 행 기준. 회원수와 다를 수 있음">${v.count}건</td>
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
    const fmtSigned = n => (n >= 0 ? '+' : '') + n.toLocaleString() + '원';

    // v3: 당월 카드 전용 — 금일 매출 병치 헤더 + FC/PT 섹션 내 금일 병치
    let topTodayBlock = '';
    let fcRow = `<div class="stats-row"><span>FC 총 매출 (부가세 제외)</span><b>${fmt(fc)}</b></div>`;
    let ptRow = `<div class="stats-row"><span>PT 매출 (계약금액)</span><b>${fmt(pt)}</b></div>`;

    // v5: 전월·전년 카드 — FC/PT 각각 차이 표시 (current - 이전기간)
    if (opts.compareBase) {
      const fcDiff = opts.compareBase.fc - fc;
      const ptDiff = opts.compareBase.pt - pt;
      const fcCls = fcDiff >= 0 ? 'pos' : 'neg';
      const ptCls = ptDiff >= 0 ? 'pos' : 'neg';
      fcRow = `<div class="stats-row"><span>FC 총 매출 (부가세 제외)</span><b>${fmt(fc)} <span class="stats-row-diff ${fcCls}">(${fmtSigned(fcDiff)})</span></b></div>`;
      ptRow = `<div class="stats-row"><span>PT 매출 (계약금액)</span><b>${fmt(pt)} <span class="stats-row-diff ${ptCls}">(${fmtSigned(ptDiff)})</span></b></div>`;
    }
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

  // ───────── 당월 주별 매출 (v8 주 규칙, revenue_targets 목표와 정렬) ─────────
  async function loadWeeklyBreakdown(container, year, month, today) {
    const el = container.querySelector('#weeklyBreakdown');
    if (!el) return;
    try {
      const starts  = monthWeekStartDates(year, month); // Date[]
      const lastDay = new Date(year, month, 0);
      // 각 주 [시작, 끝] 구간 (끝 = 다음 주 시작 -1일, 마지막 주는 월말)
      const ranges = starts.map((s, i) => {
        const next = starts[i + 1];
        const end = next
          ? new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1)
          : new Date(lastDay);
        return { no: i + 1, startISO: isoDate(s), endISO: isoDate(end) };
      });
      const weekKeys = ranges.map(r => r.startISO);

      // 매출: 당월 1회 조회 후 주별 버킷 (fetchRevenue 와 동일 계산: FC ÷1.1, 제외상품 필터)
      const monthStart  = isoDate(new Date(year, month - 1, 1));
      const monthEndISO = isoDate(lastDay);
      const [{ data: fcData, error: fcErr }, { data: ptData, error: ptErr }] = await Promise.all([
        supabase.from('registrations').select('product, total_payment, registered_date')
          .gte('registered_date', monthStart).lte('registered_date', monthEndISO),
        supabase.from('pt_registrations').select('contract_amount, contract_date')
          .gte('contract_date', monthStart).lte('contract_date', monthEndISO),
      ]);
      if (fcErr) throw fcErr;
      if (ptErr) throw ptErr;

      const bucketOf = (dateStr) => { // YYYY-MM-DD 문자열 비교로 주 index
        let idx = 0;
        for (let i = 0; i < weekKeys.length; i++) { if (dateStr >= weekKeys[i]) idx = i; else break; }
        return idx;
      };
      const fcSum = new Array(ranges.length).fill(0);
      const ptSum = new Array(ranges.length).fill(0);
      (fcData || []).forEach(r => {
        if (!r.registered_date || excludedProducts.has(r.product)) return;
        fcSum[bucketOf(r.registered_date)] += (r.total_payment || 0);
      });
      (ptData || []).forEach(r => {
        if (!r.contract_date) return;
        ptSum[bucketOf(r.contract_date)] += (r.contract_amount || 0);
      });

      const curWeekNo = computeWeekInfo(today).weekNumber;
      const fmt = n => n.toLocaleString() + '원';
      const mdRange = (a, b) => `${a.slice(5).replace('-', '/')}~${b.slice(5).replace('-', '/')}`;

      const rows = ranges.map((r, i) => {
        const fc = Math.round(fcSum[i] / 1.1); // 회원권(FC, 부가세 제외)
        const pt = ptSum[i];
        const total = fc + pt;
        const isCur = r.no === curWeekNo;
        return `
          <tr class="${isCur ? 'stats-weekly-current' : ''}">
            <td class="stats-weekly-wk">${r.no}주차${isCur ? ' <span class="stats-weekly-badge">이번 주</span>' : ''}</td>
            <td class="stats-weekly-range">${mdRange(r.startISO, r.endISO)}</td>
            <td class="stats-weekly-amt">${fmt(fc)}</td>
            <td class="stats-weekly-amt">${fmt(pt)}</td>
            <td class="stats-weekly-amt"><b>${fmt(total)}</b></td>
          </tr>`;
      }).join('');

      const monFc    = Math.round(fcSum.reduce((a, b) => a + b, 0) / 1.1);
      const monPt    = ptSum.reduce((a, b) => a + b, 0);
      const monTotal = monFc + monPt;

      el.innerHTML = `
        <h4>당월 주별 매출 <small>(${month}월)</small></h4>
        <table class="stats-weekly-table">
          <thead><tr><th>주차</th><th>기간</th><th>회원권</th><th>PT</th><th>매출합계</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2">당월 합계</td>
              <td class="stats-weekly-amt">${fmt(monFc)}</td>
              <td class="stats-weekly-amt">${fmt(monPt)}</td>
              <td class="stats-weekly-amt"><b>${fmt(monTotal)}</b></td>
            </tr>
          </tfoot>
        </table>
      `;
    } catch (e) {
      console.error('loadWeeklyBreakdown failed:', e);
      el.innerHTML = `<div class="stats-weekly-error">주별 매출을 불러오지 못했습니다.</div>`;
    }
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
    // v8 규칙 (monthWeekStartDates 공용): 1주=1일, 2주부터 월요일, 월 경계 안 넘음
    const weeks = monthWeekStartDates(year, month).map(isoDate);

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

  // ───────── [기간별 비교] — 회원권 매출 전용 ─────────
  async function renderRevenueCompare(container) {
    container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    const now = new Date();
    if (!compareState.month) {
      compareState.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const monthStart = month => `${month}-01`;
    const monthEnd = month => {
      const [y, m] = month.split('-').map(Number);
      return isoDate(new Date(y, m, 0));
    };
    const addDays = (dateStr, days) => {
      const d = new Date(`${dateStr}T00:00:00`);
      d.setDate(d.getDate() + days);
      return isoDate(d);
    };
    const daySpan = (from, to) => Math.max(0, Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000));
    const normalizeRange = (from, to) => from > to ? { fromDate: to, toDate: from } : { fromDate: from, toDate: to };
    const fmt = n => Math.round(n || 0).toLocaleString() + '원';
    const fmtCount = n => (n || 0).toLocaleString() + '건';
    const fmtRange = (from, to) => {
      const f = from.split('-'), t = to.split('-');
      return `${parseInt(f[1])}/${parseInt(f[2])} ~ ${parseInt(t[1])}/${parseInt(t[2])}`;
    };
    const diffStr = (cur, prev, suffix='원') => {
      const d = cur - prev;
      const pct = prev > 0 ? (d / prev * 100) : (cur > 0 ? 100 : 0);
      const sign = d > 0 ? '+' : (d < 0 ? '' : '±');
      const cls = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'flat');
      const body = suffix === '원' ? fmt(Math.abs(d)) : `${Math.abs(d).toLocaleString()}${suffix}`;
      return `<span class="cmp-diff ${cls}">${sign}${body} <small>(${sign}${pct.toFixed(1)}%)</small></span>`;
    };

    let curFrom, curTo;
    if (compareState.mode === 'range') {
      const range = normalizeRange(compareState.fromDate || monthStart(compareState.month), compareState.toDate || monthEnd(compareState.month));
      curFrom = range.fromDate;
      curTo = range.toDate;
    } else {
      curFrom = monthStart(compareState.month);
      curTo = monthEnd(compareState.month);
    }
    const prevTo = addDays(curFrom, -1);
    const prevFrom = addDays(prevTo, -daySpan(curFrom, curTo));

    if (allProducts.length === 0) await loadProducts();

    const fetchFcRows = async (fromDate, toDate) => {
      const { data, error } = await supabase.from('registrations')
        .select('registered_date, product, total_payment, total_payment_cash, total_payment_card, sales_manager, contract_manager')
        .gte('registered_date', fromDate).lte('registered_date', toDate);
      if (error) throw error;
      return (data || []).filter(r => !excludedProducts.has(r.product));
    };
    const [curRows, prevRows] = await Promise.all([
      fetchFcRows(curFrom, curTo),
      fetchFcRows(prevFrom, prevTo),
    ]);

    const net = r => Math.round((r.total_payment || 0) / 1.1);
    const summarize = rows => {
      const gross = rows.reduce((s, r) => s + (r.total_payment || 0), 0);
      const cash = rows.reduce((s, r) => s + (r.total_payment_cash || 0), 0);
      const card = rows.reduce((s, r) => s + (r.total_payment_card || 0), 0);
      const amount = Math.round(gross / 1.1);
      return { count: rows.length, gross, amount, cash, card, avg: rows.length ? Math.round(amount / rows.length) : 0 };
    };
    const groupRows = (rows, keyFn) => {
      const map = new Map();
      rows.forEach(r => {
        const key = keyFn(r) || '(미지정)';
        if (!map.has(key)) map.set(key, { count: 0, amount: 0 });
        const item = map.get(key);
        item.count++;
        item.amount += net(r);
      });
      return Array.from(map.entries())
        .map(([key, v]) => ({ key, ...v, avg: v.count ? Math.round(v.amount / v.count) : 0 }))
        .sort((a, b) => b.amount - a.amount);
    };

    const cur = summarize(curRows);
    const prev = summarize(prevRows);
    const byProduct = groupRows(curRows, r => r.product);
    const byManager = groupRows(curRows, r => r.sales_manager);
    const makeRows = rows => rows.length ? rows.map(r => `
      <tr>
        <td>${escHtml(r.key)}</td>
        <td class="cmp-num">${fmtCount(r.count)}</td>
        <td class="cmp-num">${fmt(r.amount)}</td>
        <td class="cmp-num">${fmt(r.avg)}</td>
      </tr>
    `).join('') : '<tr><td colspan="4" style="color:var(--color-text-muted);">데이터 없음</td></tr>';

    const months = [];
    const start = new Date(`${curFrom}T00:00:00`);
    const end = new Date(`${curTo}T00:00:00`);
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1)) {
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthly = months.map(month => {
      const rows = curRows.filter(r => (r.registered_date || '').slice(0, 7) === month);
      return { month, label: month.replace('-', '.'), ...summarize(rows) };
    });
    const maxAmount = Math.max(...monthly.map(m => m.amount), 1);
    const trendRows = monthly.map(m => `
      <div class="trend-bar-row">
        <div class="trend-bar-label">${escHtml(m.label)}</div>
        <div class="trend-bar-track" style="width:${(m.amount / maxAmount * 100).toFixed(1)}%;">
          <div class="trend-bar-reg" style="width:100%;" title="${fmt(m.amount)}"></div>
        </div>
        <div class="trend-bar-value">${fmt(m.amount)} <small>(${fmtCount(m.count)})</small></div>
      </div>
    `).join('');

    container.innerHTML = `
      <div class="stats-filter-panel">
        <div class="stats-staff-controls">
          <div class="stats-staff-tabs">
            <button class="stats-staff-tab ${compareState.mode === 'month' ? 'active' : ''}" data-cmp-mode="month">특정 월</button>
            <button class="stats-staff-tab ${compareState.mode === 'range' ? 'active' : ''}" data-cmp-mode="range">직접 기간</button>
          </div>
          <div class="stats-staff-selects">
            <input class="stats-staff-select" id="cmpMonth" type="month" value="${compareState.month}" style="${compareState.mode === 'month' ? '' : 'display:none'}">
            <input class="stats-staff-select" id="cmpFrom" type="date" value="${curFrom}" style="${compareState.mode === 'range' ? '' : 'display:none'}">
            <input class="stats-staff-select" id="cmpTo" type="date" value="${curTo}" style="${compareState.mode === 'range' ? '' : 'display:none'}">
          </div>
        </div>
        <details class="stats-filter-details" style="margin-top:8px">
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

      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">회원권 매출 기간 비교</div>
          <div class="cmp-card-sub">선택 기간 <strong>${fmtRange(curFrom, curTo)}</strong> vs 이전 기간 <strong>${fmtRange(prevFrom, prevTo)}</strong></div>
        </div>
        <table class="cmp-table">
          <thead><tr><th>구분</th><th>선택 기간</th><th>이전 기간</th><th>증감</th></tr></thead>
          <tbody>
            <tr><td>회원권 순매출 <small>(부가세 제외)</small></td><td class="cmp-num">${fmt(cur.amount)}</td><td class="cmp-num">${fmt(prev.amount)}</td><td>${diffStr(cur.amount, prev.amount)}</td></tr>
            <tr><td>총 결제액 <small>(부가세 포함)</small></td><td class="cmp-num">${fmt(cur.gross)}</td><td class="cmp-num">${fmt(prev.gross)}</td><td>${diffStr(cur.gross, prev.gross)}</td></tr>
            <tr><td>등록 건수</td><td class="cmp-num">${fmtCount(cur.count)}</td><td class="cmp-num">${fmtCount(prev.count)}</td><td>${diffStr(cur.count, prev.count, '건')}</td></tr>
            <tr><td>평균 결제 단가</td><td class="cmp-num">${fmt(cur.avg)}</td><td class="cmp-num">${fmt(prev.avg)}</td><td>${diffStr(cur.avg, prev.avg)}</td></tr>
            <tr><td>현금/계좌</td><td class="cmp-num">${fmt(cur.cash)}</td><td class="cmp-num">${fmt(prev.cash)}</td><td>${diffStr(cur.cash, prev.cash)}</td></tr>
            <tr><td>카드</td><td class="cmp-num">${fmt(cur.card)}</td><td class="cmp-num">${fmt(prev.card)}</td><td>${diffStr(cur.card, prev.card)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="cmp-card">
        <div class="cmp-card-header"><div class="cmp-card-title">상품별 회원권 매출</div><div class="cmp-card-sub">선택 기간 기준</div></div>
        <table class="cmp-table">
          <thead><tr><th>상품</th><th>건수</th><th>순매출</th><th>평균 단가</th></tr></thead>
          <tbody>${makeRows(byProduct)}</tbody>
        </table>
      </div>

      <div class="cmp-card">
        <div class="cmp-card-header"><div class="cmp-card-title">매출담당자별 회원권 매출</div><div class="cmp-card-sub">registrations.sales_manager 기준</div></div>
        <table class="cmp-table">
          <thead><tr><th>매출담당</th><th>건수</th><th>순매출</th><th>평균 단가</th></tr></thead>
          <tbody>${makeRows(byManager)}</tbody>
        </table>
      </div>

      <div class="cmp-card">
        <div class="cmp-card-header"><div class="cmp-card-title">선택 기간 월별 추이</div><div class="cmp-card-sub">직접 기간이 여러 월에 걸칠 때 월별 회원권 매출 흐름을 확인합니다.</div></div>
        <div class="trend-bar-list">${trendRows || '<div style="color:var(--color-text-muted);">데이터 없음</div>'}</div>
      </div>

      <div class="cmp-note">
        · 회원권 매출만 집계합니다. PT 등록 매출은 제외됩니다.<br>
        · 순매출은 registrations.total_payment / 1.1 기준입니다.<br>
        · 비교 기간은 선택 기간과 같은 일수의 직전 기간입니다.
      </div>
    `;

    container.querySelectorAll('[data-cmp-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        compareState.mode = btn.dataset.cmpMode;
        loadSubTab('compare');
      });
    });
    container.querySelector('#cmpMonth')?.addEventListener('change', e => {
      compareState.month = e.target.value || compareState.month;
      loadSubTab('compare');
    });
    container.querySelector('#cmpFrom')?.addEventListener('change', e => {
      compareState.fromDate = e.target.value || compareState.fromDate;
      loadSubTab('compare');
    });
    container.querySelector('#cmpTo')?.addEventListener('change', e => {
      compareState.toDate = e.target.value || compareState.toDate;
      loadSubTab('compare');
    });
    container.querySelectorAll('.chip-check input').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) excludedProducts.add(cb.value);
        else excludedProducts.delete(cb.value);
        localStorage.setItem(EXCLUDE_STORAGE_KEY, JSON.stringify([...excludedProducts]));
        loadSubTab('compare');
      });
    });
  }

  // ───────── [기간별 비교] — 마케팅 분석 대시보드 (legacy, unused) ─────────
  async function renderCompare(container) {
    container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    const now = new Date();
    const cy = now.getFullYear();
    const cm = now.getMonth() + 1;
    const cd = now.getDate();

    const cmFrom = `${cy}-${String(cm).padStart(2,'0')}-01`;
    const cmTo   = isoDate(now);

    const prevY = cm === 1 ? cy - 1 : cy;
    const prevM = cm === 1 ? 12 : cm - 1;
    const prevMonthLastDay = new Date(prevY, prevM, 0).getDate();
    const prevDay = Math.min(cd, prevMonthLastDay);
    const pmFrom = `${prevY}-${String(prevM).padStart(2,'0')}-01`;
    const pmTo   = `${prevY}-${String(prevM).padStart(2,'0')}-${String(prevDay).padStart(2,'0')}`;
    // 전월 전체 (1일 ~ 마지막일) — 이번 달 같은 기간 비교 외에 "전월 전체" 컬럼 표시용
    const pmFullFrom = `${prevY}-${String(prevM).padStart(2,'0')}-01`;
    const pmFullTo   = `${prevY}-${String(prevM).padStart(2,'0')}-${String(prevMonthLastDay).padStart(2,'0')}`;

    // 최근 6개월 (이번 달 포함, 시작 = 5개월 전 1일)
    const sixStart = new Date(cy, cm - 6, 1);
    const sixFrom = isoDate(sixStart);

    const COLS = 'status, inflow_channel, residence, category, inquiry_date';
    const [cmRes, pmRes, pmFullRes, sixRes] = await Promise.all([
      supabase.from('inquiries').select(COLS).gte('inquiry_date', cmFrom).lte('inquiry_date', cmTo),
      supabase.from('inquiries').select(COLS).gte('inquiry_date', pmFrom).lte('inquiry_date', pmTo),
      supabase.from('inquiries').select(COLS).gte('inquiry_date', pmFullFrom).lte('inquiry_date', pmFullTo),
      supabase.from('inquiries').select(COLS).gte('inquiry_date', sixFrom).lte('inquiry_date', cmTo),
    ]);
    const cmData = cmRes.data || [];
    const pmData = pmRes.data || [];
    const pmFullData = pmFullRes.data || [];
    const sixData = sixRes.data || [];

    const fmtRange = (from, to) => {
      const f = from.split('-'), t = to.split('-');
      return `${parseInt(f[1])}/${parseInt(f[2])} ~ ${parseInt(t[1])}/${parseInt(t[2])}`;
    };
    const diffStr = (cur, prev, suffix='건') => {
      const d = cur - prev;
      const pct = prev > 0 ? (d / prev * 100) : (cur > 0 ? 100 : 0);
      const sign = d > 0 ? '+' : (d < 0 ? '' : '±');
      const cls = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'flat');
      return `<span class="cmp-diff ${cls}">${sign}${d.toLocaleString()}${suffix} <small>(${sign}${pct.toFixed(1)}%)</small></span>`;
    };

    const groupByDim = (rows, dimKey) => {
      const map = new Map();
      rows.forEach(r => {
        const key = r[dimKey] && r[dimKey].trim() ? r[dimKey].trim() : '(없음)';
        if (!map.has(key)) map.set(key, { total: 0, registered: 0 });
        const m = map.get(key);
        m.total++;
        if (r.status === 'registered') m.registered++;
      });
      return Array.from(map.entries())
        .map(([k, v]) => ({ key: k, total: v.total, registered: v.registered, unregistered: v.total - v.registered, rate: v.total > 0 ? v.registered / v.total * 100 : 0 }))
        .sort((a, b) => b.total - a.total);
    };

    const cmReg   = cmData.filter(r => r.status === 'registered').length;
    const cmUnreg = cmData.length - cmReg;
    const pmReg   = pmData.filter(r => r.status === 'registered').length;
    const pmUnreg = pmData.length - pmReg;
    const pmFullReg   = pmFullData.filter(r => r.status === 'registered').length;
    const pmFullUnreg = pmFullData.length - pmFullReg;
    const cmRate  = cmData.length > 0 ? (cmReg / cmData.length * 100) : 0;
    const pmRate  = pmData.length > 0 ? (pmReg / pmData.length * 100) : 0;
    const pmFullRate = pmFullData.length > 0 ? (pmFullReg / pmFullData.length * 100) : 0;

    // 신규/재등록 분리 집계 헬퍼
    const splitByCategory = (rows) => {
      const newR  = rows.filter(r => r.category === '신규');
      const reR   = rows.filter(r => r.category === '재등록');
      const reg   = (arr) => arr.filter(r => r.status === 'registered').length;
      const calc  = (arr) => ({ total: arr.length, reg: reg(arr), rate: arr.length > 0 ? (reg(arr) / arr.length * 100) : 0 });
      return { new: calc(newR), re: calc(reR) };
    };
    const cmCat = splitByCategory(cmData);
    const pmCat = splitByCategory(pmData);
    const pmFullCat = splitByCategory(pmFullData);

    // 카드 1: 전월 대비 합계
    const card1 = `
      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">전월 대비 문의량</div>
          <div class="cmp-card-sub">
            이번 달 <strong>${fmtRange(cmFrom, cmTo)}</strong> vs
            전월 <strong>${fmtRange(pmFrom, pmTo)}</strong> 같은 기간 (참고: 전월 전체 ${fmtRange(pmFullFrom, pmFullTo)})
          </div>
        </div>
        <table class="cmp-table">
          <thead><tr>
            <th>구분</th><th>이번 달 (${cm}월)</th><th>전월 (${prevM}월) 같은 기간</th><th>전월 (${prevM}월) 전체</th><th>증감</th>
          </tr></thead>
          <tbody>
            <tr><td>미등록 문의</td><td class="cmp-num">${cmUnreg.toLocaleString()}건</td><td class="cmp-num">${pmUnreg.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullUnreg.toLocaleString()}건</td><td>${diffStr(cmUnreg, pmUnreg)}</td></tr>
            <tr><td>등록 완료</td><td class="cmp-num">${cmReg.toLocaleString()}건</td><td class="cmp-num">${pmReg.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullReg.toLocaleString()}건</td><td>${diffStr(cmReg, pmReg)}</td></tr>
            <tr class="cmp-total"><td>합계</td><td class="cmp-num">${cmData.length.toLocaleString()}건</td><td class="cmp-num">${pmData.length.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullData.length.toLocaleString()}건</td><td>${diffStr(cmData.length, pmData.length)}</td></tr>
            <tr><td>등록 전환율</td><td class="cmp-num">${cmRate.toFixed(1)}%</td><td class="cmp-num">${pmRate.toFixed(1)}%</td><td class="cmp-num cmp-pmfull">${pmFullRate.toFixed(1)}%</td><td>${diffStr(Number(cmRate.toFixed(1)), Number(pmRate.toFixed(1)), '%p').replace('%p건','%p')}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    // 카드 1.5: 신규 vs 재등록 분석
    const cmNewRate = cmCat.new.rate;
    const cmReRate  = cmCat.re.rate;
    const pmNewRate = pmCat.new.rate;
    const pmReRate  = pmCat.re.rate;
    const pmFullNewRate = pmFullCat.new.rate;
    const pmFullReRate  = pmFullCat.re.rate;
    const card1_5 = `
      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">신규 vs 재등록 분석</div>
          <div class="cmp-card-sub">문의자가 신규인지 재등록인지 분리 + 각각의 등록 전환율 (전월 전체 컬럼은 참고용)</div>
        </div>
        <table class="cmp-table">
          <thead><tr>
            <th>구분</th><th>이번 달 (${cm}월)</th><th>전월 (${prevM}월) 같은 기간</th><th>전월 (${prevM}월) 전체</th><th>증감</th>
          </tr></thead>
          <tbody>
            <tr class="cmp-section-head"><td colspan="5"><strong>🆕 신규 가입자</strong></td></tr>
            <tr><td>· 문의 건수</td><td class="cmp-num">${cmCat.new.total.toLocaleString()}건</td><td class="cmp-num">${pmCat.new.total.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullCat.new.total.toLocaleString()}건</td><td>${diffStr(cmCat.new.total, pmCat.new.total)}</td></tr>
            <tr><td>· 등록 완료</td><td class="cmp-num">${cmCat.new.reg.toLocaleString()}건</td><td class="cmp-num">${pmCat.new.reg.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullCat.new.reg.toLocaleString()}건</td><td>${diffStr(cmCat.new.reg, pmCat.new.reg)}</td></tr>
            <tr><td>· 등록 전환율</td><td class="cmp-num">${cmNewRate.toFixed(1)}%</td><td class="cmp-num">${pmNewRate.toFixed(1)}%</td><td class="cmp-num cmp-pmfull">${pmFullNewRate.toFixed(1)}%</td><td>${diffStr(Number(cmNewRate.toFixed(1)), Number(pmNewRate.toFixed(1)), '%p').replace('%p건','%p')}</td></tr>
            <tr class="cmp-section-head"><td colspan="5"><strong>🔁 재등록자</strong></td></tr>
            <tr><td>· 문의 건수</td><td class="cmp-num">${cmCat.re.total.toLocaleString()}건</td><td class="cmp-num">${pmCat.re.total.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullCat.re.total.toLocaleString()}건</td><td>${diffStr(cmCat.re.total, pmCat.re.total)}</td></tr>
            <tr><td>· 등록 완료</td><td class="cmp-num">${cmCat.re.reg.toLocaleString()}건</td><td class="cmp-num">${pmCat.re.reg.toLocaleString()}건</td><td class="cmp-num cmp-pmfull">${pmFullCat.re.reg.toLocaleString()}건</td><td>${diffStr(cmCat.re.reg, pmCat.re.reg)}</td></tr>
            <tr><td>· 등록 전환율</td><td class="cmp-num">${cmReRate.toFixed(1)}%</td><td class="cmp-num">${pmReRate.toFixed(1)}%</td><td class="cmp-num cmp-pmfull">${pmFullReRate.toFixed(1)}%</td><td>${diffStr(Number(cmReRate.toFixed(1)), Number(pmReRate.toFixed(1)), '%p').replace('%p건','%p')}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    // 카드 2: 유입 채널 TOP 5 (이번 달 vs 전월 매칭)
    const cmInflow = groupByDim(cmData, 'inflow_channel').slice(0, 5);
    const pmInflowMap = new Map(groupByDim(pmData, 'inflow_channel').map(x => [x.key, x]));
    const inflowRows = cmInflow.map(c => {
      const p = pmInflowMap.get(c.key) || { total: 0, registered: 0, rate: 0 };
      return `
        <tr>
          <td>${escHtml(c.key)}</td>
          <td class="cmp-num">${c.total}</td>
          <td class="cmp-num">${c.registered}</td>
          <td class="cmp-num"><strong>${c.rate.toFixed(1)}%</strong></td>
          <td class="cmp-num">${p.total}</td>
          <td>${diffStr(c.total, p.total)}</td>
        </tr>
      `;
    }).join('');
    const card2 = `
      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">유입 채널 TOP 5</div>
          <div class="cmp-card-sub">이번 달 ${cm}월 기준 채널별 전환율 + 전월 대비</div>
        </div>
        <table class="cmp-table cmp-table-7col">
          <thead><tr>
            <th>채널</th><th>이번 달</th><th>등록</th><th>전환율</th><th>전월</th><th>증감</th>
          </tr></thead>
          <tbody>${inflowRows || '<tr><td colspan="6" style="color:var(--color-text-muted);">데이터 없음</td></tr>'}</tbody>
        </table>
      </div>
    `;

    // 카드 3: 거주지 TOP 5
    const cmResidence = groupByDim(cmData, 'residence').slice(0, 5);
    const pmResidenceMap = new Map(groupByDim(pmData, 'residence').map(x => [x.key, x]));
    const residenceRows = cmResidence.map(c => {
      const p = pmResidenceMap.get(c.key) || { total: 0, registered: 0, rate: 0 };
      return `
        <tr>
          <td>${escHtml(c.key)}</td>
          <td class="cmp-num">${c.total}</td>
          <td class="cmp-num">${c.registered}</td>
          <td class="cmp-num"><strong>${c.rate.toFixed(1)}%</strong></td>
          <td class="cmp-num">${p.total}</td>
          <td>${diffStr(c.total, p.total)}</td>
        </tr>
      `;
    }).join('');
    const card3 = `
      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">거주지 TOP 5</div>
          <div class="cmp-card-sub">이번 달 ${cm}월 기준 거주지별 문의 + 전월 대비</div>
        </div>
        <table class="cmp-table cmp-table-7col">
          <thead><tr>
            <th>거주지</th><th>이번 달</th><th>등록</th><th>전환율</th><th>전월</th><th>증감</th>
          </tr></thead>
          <tbody>${residenceRows || '<tr><td colspan="6" style="color:var(--color-text-muted);">데이터 없음</td></tr>'}</tbody>
        </table>
      </div>
    `;

    // 카드 4: 최근 6개월 추이
    const monthMap = new Map();
    sixData.forEach(r => {
      const ym = (r.inquiry_date || '').slice(0, 7);
      if (!ym) return;
      if (!monthMap.has(ym)) monthMap.set(ym, { reg: 0, unreg: 0 });
      const m = monthMap.get(ym);
      if (r.status === 'registered') m.reg++; else m.unreg++;
    });
    const monthList = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(cy, cm - 1 - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const data = monthMap.get(ym) || { reg: 0, unreg: 0 };
      monthList.push({ ym, label: `${d.getMonth()+1}월`, ...data, total: data.reg + data.unreg });
    }
    const maxTotal = Math.max(...monthList.map(m => m.total), 1);
    const trendRows = monthList.map(m => {
      const totalPct = (m.total / maxTotal * 100).toFixed(1);
      const regPct = m.total > 0 ? (m.reg / m.total * 100).toFixed(1) : 0;
      const unregPct = m.total > 0 ? (m.unreg / m.total * 100).toFixed(1) : 0;
      return `
        <div class="trend-bar-row">
          <div class="trend-bar-label">${m.label}</div>
          <div class="trend-bar-track" style="width:${totalPct}%;">
            <div class="trend-bar-unreg" style="width:${unregPct}%;" title="미등록 ${m.unreg}건"></div>
            <div class="trend-bar-reg" style="width:${regPct}%;" title="등록 ${m.reg}건"></div>
          </div>
          <div class="trend-bar-value">${m.total}건 <small>(등록 ${m.reg})</small></div>
        </div>
      `;
    }).join('');
    const card4 = `
      <div class="cmp-card">
        <div class="cmp-card-header">
          <div class="cmp-card-title">최근 6개월 추이</div>
          <div class="cmp-card-sub">월별 문의량 — 미등록(회색) + 등록(주황) 누적</div>
        </div>
        <div class="trend-bar-list">${trendRows}</div>
      </div>
    `;

    container.innerHTML = card1 + card1_5 + card2 + card3 + card4 + `
      <div class="cmp-note">
        · 미등록 = inquiries.status ≠ 'registered' / 등록 = inquiries.status = 'registered'<br>
        · 전월은 같은 일자까지만 비교 (월말 비교 정확)<br>
        · 채널/거주지 TOP 5 는 이번 달 문의 건수 기준 정렬
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
  // v8 주 시작일 계산 (단일 소스) — openMonthlyTargetModal · computeWeekInfo · 당월 주별 매출 공용
  //   1주차 = 월 1일, 2주차부터 월요일 시작, 월 경계 안 넘음
  function monthWeekStartDates(year, month) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const weeks = [new Date(firstDay)];
    const dow = firstDay.getDay();
    const daysToMon = dow === 0 ? 1 : (8 - dow);
    const nextMon = new Date(firstDay);
    nextMon.setDate(nextMon.getDate() + daysToMon);
    for (let d = new Date(nextMon); d <= lastDay; d.setDate(d.getDate() + 7)) {
      weeks.push(new Date(d));
    }
    return weeks;
  }

  function computeWeekInfo(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1;
    const lastDay  = new Date(y, m, 0);
    const weeks = monthWeekStartDates(y, m);
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

  // 외부에서 [기간별 비교] 서브탭으로 바로 진입 (예: 문의관리 탭의 [통계보기] 버튼)
  function gotoCompare() {
    activeSubTab = 'compare';
    init();
  }

  return { init, gotoCompare };
})();
