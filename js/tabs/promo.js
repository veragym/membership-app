/**
 * 홍보관리 탭 — 플레이스홀더 + 자리잡이 카드
 */
const PromoTab = (() => {
  function init() {
    const pane = document.getElementById('tab-promo');
    pane.innerHTML = `
      <div class="stats-header">
        <h2 class="stats-title">홍보관리</h2>
        <span class="stats-badge">준비중</span>
      </div>

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

  return { init };
})();
