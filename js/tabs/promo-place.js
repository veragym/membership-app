/**
 * 홍보관리 → 플레이스 서브탭
 * ─────────────────────────────
 * 네이버 플레이스 검색 순위 추적
 *
 * 데이터:
 *   - place_rank_keywords (admin CRUD)
 *   - place_rank_history  (authenticated SELECT / service_role INSERT)
 *   - place_rank_jobs     (admin INSERT for manual trigger)
 *
 * 조회 흐름:
 *   1) 사용자가 키워드 CRUD
 *   2) 자동: GitHub Actions cron (2시간마다) → history 누적
 *   3) 수동: "지금 조회" → Supabase Edge Function `trigger-place-rank`
 *      → GitHub workflow_dispatch → 크롤러 → history insert
 *
 * UI:
 *   - 좌측: 키워드 리스트 + 추가폼 + 삭제
 *   - 우측: 지점별(미사/동탄) 현재 순위 카드 + 24h 경량 SVG 라인차트
 */
const PromoPlaceTab = (() => {
  let keywords = [];
  let historyByKw = {};        // keyword_id -> latest rows[]  (최신 1건씩 × branch)
  let trendByKw = {};          // keyword_id -> rows[] (24h)
  let refreshTimer = null;
  let isLoading = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 베라짐 본점 분류: 주소에 '미사' / '동탄' 포함 여부 자동 태깅과 동일 규칙
  const BRANCH_LABEL = { misa: '미사점', dongtan: '동탄점' };
  const BRANCH_COLOR = { misa: '#6366F1', dongtan: '#14B8A6', null: '#9CA3AF' };

  // ─── ENTRY ───
  function render(container) {
    container.innerHTML = `
      <div class="place-rank-root">
        <div class="place-rank-header">
          <h3 class="place-rank-title">네이버 플레이스 순위 추적</h3>
          <div class="place-rank-header-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="prPrefillBtn" title="예시 키워드 일괄 추가">예시 키워드 채우기</button>
            <button type="button" class="btn btn-primary" id="prManualBtn">⚡ 지금 조회</button>
          </div>
        </div>

        <div class="place-rank-layout">
          <!-- 좌: 키워드 관리 -->
          <aside class="place-rank-kw-panel">
            <div class="place-rank-panel-title">키워드</div>
            <form id="prAddForm" class="place-rank-add">
              <input type="text" id="prKwInput" maxlength="60" placeholder="예: 미사헬스장" required>
              <button type="submit" class="btn btn-primary btn-sm">추가</button>
            </form>
            <div class="place-rank-kw-list" id="prKwList">
              <div class="place-rank-empty">불러오는 중…</div>
            </div>
            <div class="place-rank-hint">
              · 주소에 <b>미사</b> 포함 → 미사점으로 자동 분류<br>
              · 자동 조회: 2시간마다 · 1~5페이지 순회
            </div>
          </aside>

          <!-- 우: 결과 -->
          <section class="place-rank-result-panel">
            <div id="prResultBody">
              <div class="place-rank-empty">키워드를 추가하면 이곳에 순위가 표시됩니다.</div>
            </div>
          </section>
        </div>
      </div>
    `;
    bindHeader();
    bindAddForm();
    loadAll();
  }

  function bindHeader() {
    document.getElementById('prManualBtn').addEventListener('click', triggerManualAll);
    document.getElementById('prPrefillBtn').addEventListener('click', handlePrefill);
  }

  function bindAddForm() {
    const form = document.getElementById('prAddForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('prKwInput');
      const kw = input.value.trim();
      if (!kw) return;
      await addKeyword(kw);
      input.value = '';
    });
  }

  // ─── DATA LOAD ───
  async function loadAll() {
    if (isLoading) return;
    isLoading = true;
    try {
      await loadKeywords();
      await loadHistory();
      renderKeywordList();
      renderResults();
    } catch (e) {
      console.error('[place-rank] loadAll failed', e);
      Toast.error('데이터를 불러오지 못했습니다: ' + (e.message || e));
    } finally {
      isLoading = false;
    }
  }

  async function loadKeywords() {
    const { data, error } = await supabase
      .from('place_rank_keywords')
      .select('id, keyword, is_active, sort_order, created_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    keywords = data || [];
  }

  async function loadHistory() {
    if (!keywords.length) {
      historyByKw = {}; trendByKw = {}; return;
    }
    const kwIds = keywords.map(k => k.id);
    // 최근 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('place_rank_history')
      .select('id, keyword_id, keyword, branch, page, rank, is_found, card_name, card_address, error, source, checked_at')
      .in('keyword_id', kwIds)
      .gte('checked_at', since)
      .order('checked_at', { ascending: false })
      .limit(1000);
    if (error) throw error;

    trendByKw = {};
    historyByKw = {};
    (data || []).forEach(row => {
      if (!trendByKw[row.keyword_id]) trendByKw[row.keyword_id] = [];
      trendByKw[row.keyword_id].push(row);
      // 각 branch별 최신 1건만 historyByKw에 저장
      const bkey = row.branch || 'null';
      if (!historyByKw[row.keyword_id]) historyByKw[row.keyword_id] = {};
      if (!historyByKw[row.keyword_id][bkey]) historyByKw[row.keyword_id][bkey] = row;
    });
  }

  // ─── RENDER: 키워드 리스트 ───
  function renderKeywordList() {
    const el = document.getElementById('prKwList');
    if (!el) return;
    if (!keywords.length) {
      el.innerHTML = `<div class="place-rank-empty">키워드가 없습니다.<br>예: 미사헬스장, 동탄헬스장</div>`;
      return;
    }
    el.innerHTML = keywords.map(k => {
      const last = latestCheckedAt(k.id);
      const lastTxt = last ? formatAgo(last) : '미조회';
      return `
        <div class="place-rank-kw-item ${k.is_active ? '' : 'inactive'}" data-id="${esc(k.id)}">
          <div class="place-rank-kw-main">
            <div class="place-rank-kw-name">${esc(k.keyword)}</div>
            <div class="place-rank-kw-meta">${lastTxt}</div>
          </div>
          <div class="place-rank-kw-actions">
            <button type="button" class="place-rank-kw-toggle" data-action="toggle" title="${k.is_active ? '비활성화' : '활성화'}">${k.is_active ? '🟢' : '⚪'}</button>
            <button type="button" class="place-rank-kw-del" data-action="del" title="삭제">×</button>
          </div>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.place-rank-kw-item').forEach(item => {
      const id = item.dataset.id;
      item.querySelector('[data-action="toggle"]').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleKeyword(id);
      });
      item.querySelector('[data-action="del"]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteKeyword(id);
      });
    });
  }

  function latestCheckedAt(kwId) {
    const rows = trendByKw[kwId];
    if (!rows || !rows.length) return null;
    return rows[0].checked_at;
  }

  function formatAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '방금';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ─── RENDER: 결과 카드 (미사 / 동탄 섹션 분리) ───
  function renderResults() {
    const body = document.getElementById('prResultBody');
    if (!body) return;
    if (!keywords.length) {
      body.innerHTML = `<div class="place-rank-empty">키워드를 추가하면 이곳에 순위가 표시됩니다.</div>`;
      return;
    }

    const renderSection = (branch) => {
      const cards = keywords.map(k => {
        const row = (historyByKw[k.id] || {})[branch];
        const rowNull = (historyByKw[k.id] || {}).null; // branch 태깅 실패 케이스
        const useRow = row || null;
        return buildRankCard(k, useRow, branch, rowNull);
      }).join('');
      return `
        <div class="place-rank-section">
          <div class="place-rank-section-title" style="border-left-color:${BRANCH_COLOR[branch]}">
            ${BRANCH_LABEL[branch]}
          </div>
          <div class="place-rank-grid">${cards}</div>
        </div>
      `;
    };

    body.innerHTML = renderSection('misa');
  }

  function buildRankCard(kw, row, branch, rowNull) {
    const hasRow = !!row;
    const rankTxt = hasRow && row.is_found
      ? `${row.page}p <span style="color:#6B7280">·</span> ${row.rank}위`
      : hasRow
        ? '미노출'
        : '—';
    const rankColor = hasRow && row.is_found ? '#111827' : '#9CA3AF';
    const cardName = hasRow && row.is_found ? esc(row.card_name || '') : '';
    const cardAddr = hasRow && row.is_found ? esc(row.card_address || '') : '';
    const checked = hasRow ? formatAgo(row.checked_at) : '미조회';

    // 트렌드 — 해당 branch의 24h 데이터만
    const trendRows = (trendByKw[kw.id] || []).filter(r => r.branch === branch);
    const sparkline = buildSparkline(trendRows);

    // branch 태깅 실패 데이터가 있으면 하단 경고
    const warnNull = rowNull && !hasRow
      ? `<div class="place-rank-card-warn">⚠ 이 키워드는 주소에 지점명이 없어 분류 실패 — 최근 결과: ${esc(rowNull.card_address || rowNull.card_name || '-')}</div>`
      : '';

    return `
      <div class="place-rank-card">
        <div class="place-rank-card-head">
          <div class="place-rank-card-kw">${esc(kw.keyword)}</div>
          <div class="place-rank-card-time">${checked}</div>
        </div>
        <div class="place-rank-card-rank" style="color:${rankColor}">${rankTxt}</div>
        ${cardName ? `<div class="place-rank-card-sub">${cardName}</div>` : ''}
        ${cardAddr ? `<div class="place-rank-card-addr">${cardAddr}</div>` : ''}
        <div class="place-rank-card-chart">${sparkline}</div>
        ${warnNull}
      </div>
    `;
  }

  // ─── 경량 SVG 라인차트 (24h · rank=낮을수록 위로) ───
  // 1~75위 범위를 세로 축으로. 미노출(rank=null) 시 점 표시 안함.
  function buildSparkline(rows) {
    if (!rows || !rows.length) return `<div class="place-rank-spark-empty">24h 데이터 없음</div>`;
    // 오름차순(시간)
    const sorted = [...rows].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
    const W = 220, H = 48, PAD = 4;
    const now = Date.now();
    const t24h = 24 * 60 * 60 * 1000;
    const x = (iso) => {
      const t = now - new Date(iso).getTime(); // 과거일수록 큰 값
      return W - PAD - (t / t24h) * (W - PAD * 2);
    };
    // y: rank 1~75 가정 (5페이지 × 15카드), 미노출=75
    const MAX_RANK_APPROX = 75;
    const y = (row) => {
      if (!row.is_found) return H - PAD;
      const overall = ((row.page || 1) - 1) * 15 + (row.rank || 1);
      const v = Math.min(overall, MAX_RANK_APPROX);
      return PAD + (v / MAX_RANK_APPROX) * (H - PAD * 2);
    };
    const pts = sorted.map(r => `${x(r.checked_at).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
    const dots = sorted.filter(r => r.is_found).map(r =>
      `<circle cx="${x(r.checked_at).toFixed(1)}" cy="${y(r).toFixed(1)}" r="2" fill="#6366F1"/>`
    ).join('');
    return `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="place-rank-spark">
        <polyline points="${pts}" fill="none" stroke="#6366F1" stroke-width="1.5" stroke-linejoin="round" />
        ${dots}
      </svg>
    `;
  }

  // ─── MUTATIONS ───
  async function addKeyword(keyword) {
    const existing = keywords.find(k => k.keyword === keyword);
    if (existing) {
      Toast.info('이미 등록된 키워드입니다.');
      return;
    }
    const trainer = Auth.getTrainer();
    const { error } = await supabase.from('place_rank_keywords').insert({
      keyword,
      is_active: true,
      sort_order: keywords.length,
      created_by: trainer ? trainer.id : null,
    });
    if (error) {
      console.error('[place-rank] addKeyword failed', error);
      Toast.error('추가 실패: ' + error.message);
      return;
    }
    Toast.success(`'${keyword}' 추가됨`);
    await loadAll();
  }

  async function deleteKeyword(id) {
    const kw = keywords.find(k => k.id === id);
    if (!kw) return;
    if (!confirm(`'${kw.keyword}' 키워드를 삭제하시겠습니까?\n(과거 히스토리도 함께 삭제됩니다)`)) return;
    const { error } = await supabase.from('place_rank_keywords').delete().eq('id', id);
    if (error) {
      Toast.error('삭제 실패: ' + error.message);
      return;
    }
    Toast.success('삭제되었습니다');
    await loadAll();
  }

  async function toggleKeyword(id) {
    const kw = keywords.find(k => k.id === id);
    if (!kw) return;
    const { error } = await supabase.from('place_rank_keywords')
      .update({ is_active: !kw.is_active }).eq('id', id);
    if (error) {
      Toast.error('변경 실패: ' + error.message);
      return;
    }
    await loadAll();
  }

  async function handlePrefill() {
    const examples = ['미사헬스장', '동탄헬스장', '망월동헬스장', '청계동헬스장', '미사강변헬스장'];
    const toAdd = examples.filter(kw => !keywords.some(k => k.keyword === kw));
    if (!toAdd.length) { Toast.info('이미 모두 등록되어 있습니다.'); return; }
    if (!confirm(`다음 ${toAdd.length}개 키워드를 추가할까요?\n- ` + toAdd.join('\n- '))) return;
    const trainer = Auth.getTrainer();
    const rows = toAdd.map((kw, i) => ({
      keyword: kw,
      is_active: true,
      sort_order: keywords.length + i,
      created_by: trainer ? trainer.id : null,
    }));
    const { error } = await supabase.from('place_rank_keywords').insert(rows);
    if (error) { Toast.error('일괄 추가 실패: ' + error.message); return; }
    Toast.success(`${toAdd.length}개 추가됨`);
    await loadAll();
  }

  // ─── MANUAL TRIGGER ───
  async function triggerManualAll() {
    if (!keywords.length) { Toast.info('먼저 키워드를 추가해주세요.'); return; }
    const btn = document.getElementById('prManualBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '요청 중…';
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (!jwt) throw new Error('로그인 세션이 없습니다');

      const res = await fetch(`${SUPABASE_URL}/functions/v1/trigger-place-rank`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keyword_id: 'all' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      Toast.success('크롤러 실행 요청됨 — 1분 이내 결과가 반영됩니다.');
      // 자동 폴링: 30초 간격으로 3회 재조회
      if (refreshTimer) clearInterval(refreshTimer);
      let count = 0;
      refreshTimer = setInterval(async () => {
        count++;
        await loadAll();
        if (count >= 3) { clearInterval(refreshTimer); refreshTimer = null; }
      }, 30000);
    } catch (e) {
      console.error('[place-rank] manual trigger failed', e);
      Toast.error('지금 조회 실패: ' + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // 탭 전환 시 타이머 정리 (app.js가 직접 호출하진 않지만 방어적으로)
  function dispose() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  return { render, dispose };
})();
