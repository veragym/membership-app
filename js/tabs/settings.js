/**
 * 설정 탭 — 드롭다운 마스터 관리 (admin 전용)
 *
 * 관리 대상 (7 카테고리):
 *   거주지 / 상담형식 / 유입경로 / 상담목적 / 회원권상품 / PT상품 / 매출담당자
 *
 * 기능:
 *   - 옵션 추가
 *   - 옵션 수정 (표시명 변경 — 기존 레코드에는 영향 없음)
 *   - 순서 변경 (↑ ↓ 버튼 → sort_order UPDATE)
 *   - 비활성 (soft delete, is_active=false → 드롭다운에 안 보이지만 DB 유지)
 *   - 완전 삭제는 지원 안 함 (데이터 손실 방지)
 *
 * UI: 좌-우 2열 (카테고리 리스트 | 선택된 카테고리의 옵션 편집)
 */
const SettingsTab = (() => {
  const CATEGORIES = [
    { key: '구분',         desc: '신규/재등록' },
    { key: '거주지',       desc: '회원 거주 지역' },
    { key: '상담형식',     desc: '방문/전화 등' },
    { key: '유입경로',     desc: '인스타/지인 등' },
    { key: '상담목적',     desc: '다이어트/체형교정 등' },
    { key: '회원권상품',   desc: 'FC 등록상품 (1개월/3개월/...)' },
    { key: 'PT상품',       desc: 'PT 등록 패키지 (PT10회/PT20회/...)' },
    { key: '매출담당자',   desc: '매출 담당 직원' },
  ];

  let activeCategory = '구분';
  let currentOptions = [];  // 현재 카테고리의 옵션 리스트

  async function init() {
    // admin 아니면 접근 차단 (이중 안전장치 — tab-btn이 display:none이지만 직접 호출 가능성)
    if (!Auth.isPureAdmin()) {
      const pane = document.getElementById('tab-settings');
      pane.innerHTML = '<div class="empty-state">접근 권한이 없습니다. (admin 전용)</div>';
      return;
    }

    renderLayout();
    await loadCategory(activeCategory);
  }

  function renderLayout() {
    const pane = document.getElementById('tab-settings');
    pane.innerHTML = `
      <div class="settings-container">
        <!-- 좌측: 카테고리 리스트 -->
        <aside class="settings-sidebar">
          <div class="settings-sidebar-title">드롭다운 카테고리</div>
          <ul class="settings-category-list">
            ${CATEGORIES.map(c => `
              <li class="settings-category-item ${c.key === activeCategory ? 'active' : ''}"
                  data-category="${c.key}">
                <div class="cat-name">${c.key}</div>
                <div class="cat-desc">${c.desc}</div>
              </li>
            `).join('')}
          </ul>
        </aside>

        <!-- 우측: 선택된 카테고리 편집 패널 -->
        <section class="settings-panel">
          <header class="settings-panel-header">
            <h2 id="settings-panel-title">${activeCategory}</h2>
            <button class="btn btn-primary" id="btn-add-option">+ 옵션 추가</button>
          </header>
          <div id="settings-option-list" class="settings-option-list"></div>
        </section>
      </div>
    `;

    // 카테고리 클릭 → 로드
    pane.querySelectorAll('.settings-category-item').forEach(el => {
      el.addEventListener('click', async () => {
        const cat = el.dataset.category;
        activeCategory = cat;
        pane.querySelectorAll('.settings-category-item').forEach(e => e.classList.toggle('active', e === el));
        pane.querySelector('#settings-panel-title').textContent = cat;
        await loadCategory(cat);
      });
    });

    // 옵션 추가
    pane.querySelector('#btn-add-option').addEventListener('click', () => openAddForm());
  }

  async function loadCategory(category) {
    const listEl = document.getElementById('settings-option-list');
    listEl.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    const { data, error } = await supabase
      .from('dropdown_options')
      .select('id, value, sort_order, is_active')
      .eq('category', category)
      .order('is_active', { ascending: false })  // 활성 먼저
      .order('sort_order', { ascending: true });

    if (error) {
      Toast.error('옵션 로드 실패: ' + error.message);
      listEl.innerHTML = '<div class="empty-state">로드 실패</div>';
      return;
    }

    currentOptions = data || [];
    renderOptionList();
  }

  function renderOptionList() {
    const listEl = document.getElementById('settings-option-list');
    if (currentOptions.length === 0) {
      listEl.innerHTML = '<div class="empty-state">옵션이 없습니다. 우측 상단 [+ 옵션 추가] 버튼으로 추가하세요.</div>';
      return;
    }

    const activeOpts = currentOptions.filter(o => o.is_active);
    const inactiveOpts = currentOptions.filter(o => !o.is_active);

    let html = '';

    if (activeOpts.length > 0) {
      html += `
        <div class="settings-option-section">
          <div class="settings-section-title">활성 (${activeOpts.length})</div>
          <div class="settings-option-items">
            ${activeOpts.map((o, idx) => renderItem(o, idx, activeOpts.length)).join('')}
          </div>
        </div>
      `;
    }

    if (inactiveOpts.length > 0) {
      html += `
        <div class="settings-option-section">
          <div class="settings-section-title inactive">비활성 (${inactiveOpts.length})</div>
          <div class="settings-option-items">
            ${inactiveOpts.map(o => renderItem(o, null, 0)).join('')}
          </div>
        </div>
      `;
    }

    listEl.innerHTML = html;
    bindItemEvents();
  }

  function renderItem(opt, index, total) {
    const canMoveUp    = index !== null && index > 0;
    const canMoveDown  = index !== null && index < total - 1;
    const inactive     = !opt.is_active;

    return `
      <div class="settings-option-item ${inactive ? 'inactive' : ''}" data-id="${opt.id}">
        <div class="opt-order">${opt.sort_order}</div>
        <div class="opt-value">${escapeHtml(opt.value)}</div>
        <div class="opt-actions">
          ${!inactive ? `
            <button type="button" class="btn-icon btn-move-up"   ${canMoveUp ? '' : 'disabled'} title="위로">↑</button>
            <button type="button" class="btn-icon btn-move-down" ${canMoveDown ? '' : 'disabled'} title="아래로">↓</button>
            <button type="button" class="btn-icon btn-edit"     title="수정">수정</button>
            <button type="button" class="btn-icon btn-deactivate" title="비활성">비활성</button>
          ` : `
            <button type="button" class="btn-icon btn-activate" title="다시 활성화">활성화</button>
          `}
        </div>
      </div>
    `;
  }

  function bindItemEvents() {
    const listEl = document.getElementById('settings-option-list');
    listEl.querySelectorAll('.settings-option-item').forEach(row => {
      const id = row.dataset.id;
      const opt = currentOptions.find(o => o.id === id);
      if (!opt) return;

      row.querySelector('.btn-move-up')?.addEventListener('click', () => moveOption(opt, -1));
      row.querySelector('.btn-move-down')?.addEventListener('click', () => moveOption(opt, +1));
      row.querySelector('.btn-edit')?.addEventListener('click', () => openEditForm(opt));
      row.querySelector('.btn-deactivate')?.addEventListener('click', () => setActive(opt, false));
      row.querySelector('.btn-activate')?.addEventListener('click', () => setActive(opt, true));
    });
  }

  // ─── CRUD 작업 ───────────────────────────────────────────────

  function openAddForm() {
    Modal.open({
      type: 'center',
      title: `${activeCategory} — 옵션 추가`,
      size: 'sm',
      html: `
        <form id="add-option-form">
          <div class="form-group">
            <label>옵션 값 *</label>
            <input type="text" name="value" placeholder="예: 1개월" required autofocus>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">추가</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#add-option-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const value = new FormData(e.target).get('value').trim();
          if (!value) { Toast.warning('옵션 값을 입력해주세요.'); return; }
          await addOption(value);
        });
      }
    });
  }

  async function addOption(value) {
    // 다음 sort_order = 현재 활성 옵션의 max + 1
    const activeOpts = currentOptions.filter(o => o.is_active);
    const nextOrder = activeOpts.length > 0
      ? Math.max(...activeOpts.map(o => o.sort_order)) + 1
      : 1;

    const { error } = await supabase
      .from('dropdown_options')
      .insert({ category: activeCategory, value, sort_order: nextOrder, is_active: true });

    if (error) {
      if (error.code === '23505') {
        Toast.warning('이미 존재하는 옵션입니다. (활성/비활성 포함)');
      } else {
        Toast.error('추가 실패: ' + error.message);
      }
      return;
    }

    Toast.success(`"${value}" 추가 완료`);
    Modal.close();
    Dropdown.clearCache(activeCategory);  // 폼 드롭다운 캐시 갱신
    await loadCategory(activeCategory);
  }

  function openEditForm(opt) {
    Modal.open({
      type: 'center',
      title: `${activeCategory} — 옵션 수정`,
      size: 'sm',
      html: `
        <form id="edit-option-form">
          <div class="form-group">
            <label>옵션 값 *</label>
            <input type="text" name="value" value="${escapeHtml(opt.value)}" required autofocus>
          </div>
          <p class="form-hint">
            * 기존에 이 값으로 저장된 레코드(registrations/inquiries 등)에는 영향이 없습니다.<br>
            * 과거 데이터와 일관성 유지를 위해 오타 수정 외에는 가급적 새 옵션을 추가하세요.
          </p>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">저장</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#edit-option-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const newValue = new FormData(e.target).get('value').trim();
          if (!newValue) { Toast.warning('옵션 값을 입력해주세요.'); return; }
          if (newValue === opt.value) { Modal.close(); return; }
          await updateOption(opt.id, newValue);
        });
      }
    });
  }

  async function updateOption(id, newValue) {
    const { error } = await supabase
      .from('dropdown_options')
      .update({ value: newValue })
      .eq('id', id);

    if (error) {
      if (error.code === '23505') {
        Toast.warning('같은 값의 옵션이 이미 존재합니다.');
      } else {
        Toast.error('수정 실패: ' + error.message);
      }
      return;
    }

    Toast.success('수정 완료');
    Modal.close();
    Dropdown.clearCache(activeCategory);
    await loadCategory(activeCategory);
  }

  // 순서 변경: ±1 자리 swap (sort_order 교환)
  async function moveOption(opt, dir) {
    const activeOpts = currentOptions
      .filter(o => o.is_active)
      .sort((a, b) => a.sort_order - b.sort_order);

    const idx = activeOpts.findIndex(o => o.id === opt.id);
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= activeOpts.length) return;

    const target = activeOpts[targetIdx];

    // sort_order 교환. 2-step update로 UNIQUE(category, value) 등 제약과 무관
    const [orderA, orderB] = [opt.sort_order, target.sort_order];
    // 임시 sort_order (-1)로 이동 → UNIQUE 충돌 방지 (UNIQUE는 value만 걸려있지만 안전하게)
    const { error: e1 } = await supabase.from('dropdown_options').update({ sort_order: -1 }).eq('id', opt.id);
    if (e1) { Toast.error('순서 변경 실패: ' + e1.message); return; }
    const { error: e2 } = await supabase.from('dropdown_options').update({ sort_order: orderA }).eq('id', target.id);
    if (e2) { Toast.error('순서 변경 실패: ' + e2.message); return; }
    const { error: e3 } = await supabase.from('dropdown_options').update({ sort_order: orderB }).eq('id', opt.id);
    if (e3) { Toast.error('순서 변경 실패: ' + e3.message); return; }

    Dropdown.clearCache(activeCategory);
    await loadCategory(activeCategory);
  }

  async function setActive(opt, active) {
    const { error } = await supabase
      .from('dropdown_options')
      .update({ is_active: active })
      .eq('id', opt.id);

    if (error) {
      Toast.error((active ? '활성화' : '비활성화') + ' 실패: ' + error.message);
      return;
    }

    Toast.success(active ? '활성화 완료' : '비활성화 완료 (DB엔 유지됨)');
    Dropdown.clearCache(activeCategory);
    await loadCategory(activeCategory);
  }

  // ─── 유틸 ────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { init };
})();
