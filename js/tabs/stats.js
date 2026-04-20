/**
 * 통계 탭 v2 — 세부탭 2개 [매출 추이] [기간별 비교]
 *
 * [매출 추이]
 *   3카드: 현재 매출 / 전월 대비 / 전년 대비
 *   회원권(registrations): total_payment / 1.1 (부가세 제외)
 *   PT(pt_registrations): contract_amount (그대로)
 *   상품 제외 필터 (localStorage) · 주별 목표(revenue_targets) · 카카오톡 복사
 */
const StatsTab = (() => {
  const EXCLUDE_STORAGE_KEY = 'stats.fc_excluded_products';
  let activeSubTab = 'trend';
  let allProducts = [];
  let excludedProducts = new Set();

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

    const current = await fetchRevenue(monthStart, isoDate(today));
    const lastM   = await fetchRevenue(isoDate(new Date(lastMonth.y, lastMonth.m - 1, 1)), isoDate(new Date(lastMonth.y, lastMonth.m, 0)));
    const lastY   = await fetchRevenue(isoDate(new Date(lastYear.y, lastYear.m - 1, 1)), isoDate(new Date(lastYear.y, lastYear.m, 0)));

    const weekStart = weekMonday(today);
    const targets = await fetchTargets(weekStart);
    const fcTarget = targets.FC ?? 0;
    const ptTarget = targets.PT ?? 0;

    // 오늘 매출 (카톡 템플릿용)
    const todayRev = await fetchRevenue(isoDate(today), isoDate(today));

    // 상품 목록 (제외 필터용)
    if (allProducts.length === 0) await loadProducts();

    // v4: 제외 상품 토글을 서브탭 바로 아래로, 버튼은 현재 매출 카드 하단 내부에, 3카드 그리드는 하단까지 채움
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
        ${renderCard('현재 매출', current, fcTarget, ptTarget, { current: true, withActions: true })}
        ${renderCard(`전월 대비 (${lastMonth.m}월)`, lastM, null, null, { compareBase: current })}
        ${renderCard(`전년 대비 (${lastYear.y}년 ${lastYear.m}월)`, lastY, null, null, { compareBase: current })}
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

    container.querySelector('#stats-set-target').addEventListener('click', () => openTargetModal(weekStart, fcTarget, ptTarget));
    container.querySelector('#stats-kakao-copy').addEventListener('click', () => {
      const text = buildKakaoText({ today, todayRev, current, fcTarget, ptTarget });
      navigator.clipboard.writeText(text)
        .then(() => Toast.success('카카오톡 메시지가 복사되었습니다'))
        .catch(() => Toast.error('복사 실패'));
    });
  }

  function renderCard(title, rev, fcTarget, ptTarget, opts = {}) {
    const fc = rev.fc, pt = rev.pt, total = fc + pt;
    const fmt = n => n.toLocaleString() + '원';
    let targetBlock = '';
    if (opts.current) {
      targetBlock = `
        <div class="stats-target-row"><span>FC 목표</span><b>${fmt(fcTarget)}</b></div>
        <div class="stats-target-row"><span>FC 남은</span><b class="${fcTarget - fc < 0 ? 'neg' : ''}">${fmt(fcTarget - fc)}</b></div>
        <div class="stats-target-row"><span>PT 목표</span><b>${fmt(ptTarget)}</b></div>
        <div class="stats-target-row"><span>PT 남은</span><b class="${ptTarget - pt < 0 ? 'neg' : ''}">${fmt(ptTarget - pt)}</b></div>
      `;
    }
    let deltaBlock = '';
    if (opts.compareBase) {
      const diff = opts.compareBase.fc + opts.compareBase.pt - total;
      const pct = total > 0 ? Math.round(((opts.compareBase.fc + opts.compareBase.pt) / total - 1) * 100) : 0;
      deltaBlock = `<div class="stats-delta ${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : ''}${fmt(diff)} (${pct >= 0 ? '+' : ''}${pct}%)</div>`;
    }
    // v4: 현재 매출 카드 하단에 액션 버튼 (주별 목표 수정 / 카카오톡 복사)
    const actionsBlock = opts.withActions ? `
      <div class="stats-card-actions">
        <button class="btn btn-secondary" id="stats-set-target">주별 목표 수정</button>
        <button class="btn btn-primary" id="stats-kakao-copy">카카오톡으로 복사하기</button>
      </div>
    ` : '';
    return `
      <div class="stats-card-v2">
        <h4>${escHtml(title)}</h4>
        <div class="stats-total">${fmt(total)}</div>
        <div class="stats-row"><span>FC (부가세 제외)</span><b>${fmt(fc)}</b></div>
        <div class="stats-row"><span>PT (계약금액)</span><b>${fmt(pt)}</b></div>
        ${deltaBlock}
        ${targetBlock}
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
    const { data } = await supabase.from('registrations').select('product').not('product', 'is', null);
    allProducts = [...new Set((data || []).map(r => r.product))].sort();
  }

  async function fetchTargets(weekStart) {
    const { data } = await supabase.from('revenue_targets').select('target_type, target_amount').eq('target_week', weekStart);
    const out = {};
    (data || []).forEach(r => { out[r.target_type] = r.target_amount; });
    return out;
  }

  // ───────── 목표 입력 모달 ─────────
  function openTargetModal(weekStart, fc, pt) {
    Modal.open({
      type: 'center',
      title: `주별 목표 매출 (${weekStart} 주)`,
      size: 'sm',
      html: `
        <form id="target-form">
          <div class="form-group">
            <label>FC 주별 목표 (원)</label>
            <input type="number" name="fc_target" value="${fc}" min="0" step="10000">
          </div>
          <div class="form-group">
            <label>PT 주별 목표 (원)</label>
            <input type="number" name="pt_target" value="${pt}" min="0" step="10000">
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">저장</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#target-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const fcVal = parseInt(fd.get('fc_target')) || 0;
          const ptVal = parseInt(fd.get('pt_target')) || 0;
          const upserts = [
            { target_type: 'FC', target_week: weekStart, target_amount: fcVal, updated_at: new Date().toISOString() },
            { target_type: 'PT', target_week: weekStart, target_amount: ptVal, updated_at: new Date().toISOString() },
          ];
          const { error } = await supabase.from('revenue_targets').upsert(upserts, { onConflict: 'target_type,target_week' });
          if (error) { Toast.error('저장 실패: ' + error.message); return; }
          Toast.success('목표 저장됨');
          Modal.close();
          loadSubTab('trend');
        });
      }
    });
  }

  // ───────── 카카오톡 템플릿 ─────────
  function buildKakaoText({ today, todayRev, current, fcTarget, ptTarget }) {
    const m = today.getMonth() + 1, d = today.getDate();
    const weekNo = Math.ceil(d / 7);
    const fmt = n => n.toLocaleString() + '원';
    const fcRemain = fcTarget - current.fc;
    const ptRemain = ptTarget - current.pt;
    return [
      `베라짐 미사점 ${m}월 ${weekNo}주차`,
      `현재 매출 보고드립니다.`,
      ``,
      `FC 현재 매출 ${fmt(todayRev.fc)}`,
      `${m}월 ${d}일까지 누적 매출`,
      `${fmt(current.fc)} (부가세 제외)`,
      `목표매출 ${fmt(fcTarget)}`,
      `목표까지 남은매출 ${fmt(fcRemain)}`,
      ``,
      `PT 현재 매출 ${fmt(todayRev.pt)}`,
      `${m}월 ${d}일까지 누적 매출`,
      `${fmt(current.pt)} (부가세 제외)`,
      `목표매출 ${fmt(ptTarget)}`,
      `목표까지 남은매출 ${fmt(ptRemain)}`,
      ``,
      `금일 매출 ${fmt(todayRev.fc + todayRev.pt)}`,
      `총 누적매출 ${fmt(current.fc + current.pt)} 입니다.`,
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

  return { init };
})();
