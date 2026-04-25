/**
 * 홍보관리 → 경쟁사 분석 (Phase 1 MVP)
 * ─────────────────────────────────
 * place_rank_snapshots 테이블에서 키워드별 최신 스냅샷(상위 20개)을 로드.
 *
 * UI:
 *   - 키워드 드롭다운
 *   - 상위 20 테이블 (DOM 순위 / 업체명 / 주소 / 광고 / 광고제외순위)
 *   - 광고 집행 업체 배지 리스트
 *
 * 데이터 흐름:
 *   place_rank_keywords → 활성 키워드 목록
 *   place_rank_snapshots → 선택 키워드의 가장 최근 snapshot_at 기준 20개
 */
const PromoCompetitorsTab = (() => {
  let keywords = [];
  let activeKeywordId = null;
  let snapshots = [];
  let latestAt = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.floor(h / 24)}일 전`;
  }

  function isVeragym(name) {
    const n = (name || '').toLowerCase().replace(/\s|-/g, '');
    return n.includes('베라짐') || n.includes('veragym') || n.includes('vera짐');
  }

  async function render(container) {
    container.innerHTML = `
      <div class="competitors-root">
        <div class="competitors-head">
          <h3 class="competitors-title">경쟁사 분석</h3>
          <div class="competitors-controls">
            <select id="cmpKwSelect" class="competitors-select"></select>
            <span class="competitors-updated" id="cmpUpdated"></span>
          </div>
        </div>
        <div id="cmpBody" class="competitors-body">
          <div class="place-rank-empty">로드 중…</div>
        </div>
      </div>
    `;
    await loadKeywords();
    populateKeywordSelect();
    if (activeKeywordId) await loadAndRenderSnapshots();
    bindEvents();
  }

  async function loadKeywords() {
    const { data, error } = await supabase
      .from('place_rank_keywords')
      .select('id, keyword, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) { console.error('[competitors] kw load', error); keywords = []; return; }
    keywords = data || [];
    if (keywords.length && !activeKeywordId) activeKeywordId = keywords[0].id;
  }

  function populateKeywordSelect() {
    const sel = document.getElementById('cmpKwSelect');
    if (!sel) return;
    sel.innerHTML = keywords.map(k =>
      `<option value="${esc(k.id)}" ${k.id === activeKeywordId ? 'selected' : ''}>${esc(k.keyword)}</option>`
    ).join('');
  }

  function bindEvents() {
    const sel = document.getElementById('cmpKwSelect');
    if (sel) {
      sel.addEventListener('change', async () => {
        activeKeywordId = sel.value;
        await loadAndRenderSnapshots();
      });
    }
  }

  async function loadAndRenderSnapshots() {
    const body = document.getElementById('cmpBody');
    if (!body || !activeKeywordId) return;
    body.innerHTML = `<div class="place-rank-empty">로드 중…</div>`;

    // 최신 snapshot_at 1건 조회 → 그 시각 기준 모든 row
    const { data: latestRow, error: e1 } = await supabase
      .from('place_rank_snapshots')
      .select('snapshot_at')
      .eq('keyword_id', activeKeywordId)
      .order('snapshot_at', { ascending: false })
      .limit(1);
    if (e1) { body.innerHTML = `<div class="place-rank-empty">로드 실패: ${esc(e1.message)}</div>`; return; }
    if (!latestRow || !latestRow.length) {
      body.innerHTML = `<div class="place-rank-empty">아직 스냅샷 데이터 없음 — "⚡ 지금 조회"를 한 번 실행해주세요.</div>`;
      latestAt = null;
      document.getElementById('cmpUpdated').textContent = '';
      return;
    }

    latestAt = latestRow[0].snapshot_at;

    const { data, error } = await supabase
      .from('place_rank_snapshots')
      .select('dom_rank, organic_rank, page, is_ad, business_name, address, image_url, snapshot_at')
      .eq('keyword_id', activeKeywordId)
      .eq('snapshot_at', latestAt)
      .order('dom_rank', { ascending: true });
    if (error) { body.innerHTML = `<div class="place-rank-empty">로드 실패: ${esc(error.message)}</div>`; return; }

    snapshots = data || [];
    renderSnapshots();
  }

  function renderSnapshots() {
    const body = document.getElementById('cmpBody');
    const updEl = document.getElementById('cmpUpdated');
    if (!body) return;
    if (updEl) updEl.textContent = latestAt ? `${formatAgo(latestAt)} 갱신` : '';

    if (!snapshots.length) {
      body.innerHTML = `<div class="place-rank-empty">스냅샷 없음</div>`;
      return;
    }

    const rows = snapshots.map(s => {
      const highlight = isVeragym(s.business_name) ? 'is-veragym' : '';
      const adBadge = s.is_ad
        ? `<span class="cmp-badge cmp-badge-ad">광고</span>`
        : `<span class="cmp-rank-num">${s.organic_rank ?? '-'}위</span>`;
      const thumb = s.image_url
        ? `<img class="cmp-thumb" src="${esc(s.image_url)}" alt="" onerror="this.style.display='none'">`
        : `<div class="cmp-thumb cmp-thumb-empty">—</div>`;
      return `
        <tr class="${highlight}">
          <td class="cmp-dom">${s.dom_rank}</td>
          <td class="cmp-thumb-cell">${thumb}</td>
          <td class="cmp-name">
            ${isVeragym(s.business_name) ? '🏅 ' : ''}${esc(s.business_name || '')}
            ${s.address ? `<div class="cmp-addr">${esc(s.address)}</div>` : ''}
          </td>
          <td class="cmp-page">${s.page ? s.page + 'p' : ''}</td>
          <td class="cmp-ad-cell">${adBadge}</td>
        </tr>
      `;
    }).join('');

    const ads = snapshots.filter(s => s.is_ad);
    const adList = ads.length
      ? ads.map(a => `<span class="cmp-ad-chip">${esc(a.business_name || '-')}</span>`).join('')
      : `<span class="cmp-hint">광고 집행 중인 업체 없음</span>`;

    body.innerHTML = `
      <div class="cmp-table-wrap">
        <table class="cmp-table">
          <thead>
            <tr>
              <th style="width:48px;">#</th>
              <th style="width:64px;">사진</th>
              <th>업체명</th>
              <th style="width:56px;">페이지</th>
              <th style="width:80px;">구분</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="cmp-ads">
        <div class="cmp-ads-title">📢 이 키워드에 광고 집행 중 (${ads.length}개)</div>
        <div class="cmp-ads-list">${adList}</div>
      </div>
    `;
  }

  return { render };
})();
