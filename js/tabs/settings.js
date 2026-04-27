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
    { key: '업무카테고리', desc: '업무관리 카테고리 (색상 지정 가능)' },
    { key: '문자 템플릿',  desc: 'SMS 발송 템플릿 (1회 한정 옵션 / 변수 지원)' },
  ];

  // 색상 필수 카테고리 — 추가/수정 폼에 color picker 노출
  const COLOR_ENABLED = new Set(['업무카테고리']);
  const DEFAULT_COLOR = '#6B7280';

  // SMS 템플릿 전용 카테고리 옵션
  const SMS_TPL_CATEGORIES = [
    { value: 'registration', label: '회원권 등록' },
    { value: 'pt',           label: 'PT 등록' },
    { value: 'inquiry',      label: '문의 응대' },
    { value: 'spt',          label: 'SPT 안내' },
    { value: 'general',      label: '일반/이벤트' },
  ];

  // 문자 템플릿 사용 가능 변수 가이드
  const SMS_VARS_HINT = '{이름} {전화번호} {등록일} {등록상품} {회수} {거주지}';

  let activeCategory = '구분';
  let currentOptions = [];  // 현재 카테고리의 옵션 리스트

  // 인기순 자동정렬 카테고리 → 실제 사용 레코드 소스 매핑
  // match: 'exact'   → 드롭다운 value == DB 컬럼값 (문자열 동일)
  // match: 'ptCount' → 드롭다운 value 에서 "\d+회" 정수 추출 → pt_count 와 비교
  //   (pt_registrations.product 가 v7 이후 NULL 이라 pt_count 로 집계해야 함)
  const POPULARITY_SOURCES = {
    '회원권상품': { table: 'registrations',    column: 'product',  match: 'exact'   },
    'PT상품':    { table: 'pt_registrations', column: 'pt_count', match: 'ptCount' },
  };

  // 드롭다운 value → 집계 키 변환 ("PT12회" → 12)
  function valueToKey(value, match) {
    if (match === 'ptCount') {
      const m = String(value).match(/(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    }
    return value;  // 'exact'
  }

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
    pane.querySelector('#btn-add-option').addEventListener('click', () => {
      if (activeCategory === '문자 템플릿') openAddTemplate();
      else openAddForm();
    });
  }

  async function loadCategory(category) {
    const listEl = document.getElementById('settings-option-list');
    listEl.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    // 분기: SMS 템플릿
    if (category === '문자 템플릿') {
      await loadSmsTemplates();
      return;
    }

    const { data, error } = await supabase
      .from('dropdown_options')
      .select('id, value, sort_order, is_active, color')
      .eq('category', category)
      .order('is_active', { ascending: false })  // 활성 먼저
      .order('sort_order', { ascending: true });

    if (error) {
      Toast.error('옵션 로드 실패: ' + error.message);
      listEl.innerHTML = '<div class="empty-state">로드 실패</div>';
      return;
    }

    currentOptions = data || [];

    // 인기순 자동정렬 대상 카테고리라면 usage_count 주입 + sort_order 재배치
    if (POPULARITY_SOURCES[category]) {
      await applyPopularitySort(category);
    }

    renderOptionList();
  }

  /**
   * 지정 카테고리 옵션을 실제 사용 횟수로 집계하여
   *  - 각 옵션에 usage_count 필드 주입
   *  - 활성 옵션의 sort_order 를 인기순(내림차순)으로 재배치
   *  동률일 경우 기존 sort_order 유지. 집계 실패 시 조용히 fallback (기존 정렬 유지).
   */
  async function applyPopularitySort(category) {
    const src = POPULARITY_SOURCES[category];
    if (!src) return;

    const { data: usage, error } = await supabase
      .from(src.table)
      .select(src.column)
      .not(src.column, 'is', null);

    if (error) {
      console.warn('[settings] 인기순 집계 실패:', error.message);
      return;  // fallback: 기존 sort_order 그대로
    }

    // DB 컬럼값 → count 집계 (key 타입은 match 방식에 따라 string/number)
    const counts = new Map();
    (usage || []).forEach(r => {
      const v = r[src.column];
      if (v === null || v === undefined || v === '') return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });

    // 각 옵션에 usage_count 주입 (value → key 변환 후 매칭)
    currentOptions.forEach(o => {
      const key = valueToKey(o.value, src.match);
      o.usage_count = (key !== null && counts.get(key)) || 0;
    });

    // 활성 옵션만 인기순 재배치
    const activeOpts = currentOptions.filter(o => o.is_active);
    activeOpts.sort((a, b) => {
      if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
      return (a.sort_order || 0) - (b.sort_order || 0);  // 동률 tie-break
    });

    // DB 갱신이 필요한 옵션만 집계 (현재 sort_order ≠ 새 rank)
    const updates = [];
    activeOpts.forEach((opt, idx) => {
      const newOrder = idx + 1;
      if (opt.sort_order !== newOrder) {
        updates.push({ id: opt.id, newOrder });
      }
    });

    if (updates.length === 0) {
      // 이미 인기순 → 그래도 화면 정렬은 반영되도록 currentOptions 재정렬
      reorderCurrentOptions(activeOpts);
      return;
    }

    // 2-step update: UNIQUE(category, sort_order) 충돌 방지 위해 일단 음수로 이동
    // (dropdown_options 테이블에 해당 UNIQUE 제약이 걸려있지 않더라도 안전하게)
    try {
      // Step 1: 모두 임시 음수로
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        const { error: e } = await supabase.from('dropdown_options')
          .update({ sort_order: -(i + 1) }).eq('id', u.id);
        if (e) throw e;
      }
      // Step 2: 목표 순서로
      for (const u of updates) {
        const { error: e } = await supabase.from('dropdown_options')
          .update({ sort_order: u.newOrder }).eq('id', u.id);
        if (e) throw e;
      }

      // 로컬 상태 갱신
      activeOpts.forEach((opt, idx) => { opt.sort_order = idx + 1; });
      reorderCurrentOptions(activeOpts);
      Dropdown.clearCache(category);
    } catch (e) {
      console.warn('[settings] 인기순 sort_order 갱신 실패:', e.message);
      // 실패해도 화면은 인기순으로 보여줌
      reorderCurrentOptions(activeOpts);
    }
  }

  // currentOptions를 [활성(인기순) → 비활성] 으로 재배치
  function reorderCurrentOptions(sortedActiveOpts) {
    const inactiveOpts = currentOptions.filter(o => !o.is_active);
    currentOptions = [...sortedActiveOpts, ...inactiveOpts];
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

    const isPopularitySort = !!POPULARITY_SOURCES[activeCategory];
    const popularityHint = isPopularitySort
      ? '<div class="settings-section-hint">실제 등록 건수 기준 인기순 자동 정렬 (매번 로드 시 갱신)</div>'
      : '';

    if (activeOpts.length > 0) {
      html += `
        <div class="settings-option-section">
          <div class="settings-section-title">활성 (${activeOpts.length})</div>
          ${popularityHint}
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

    // 인기순 카테고리면 사용 횟수 배지 표시
    const showUsage = POPULARITY_SOURCES[activeCategory] && typeof opt.usage_count === 'number';
    const usageBadge = showUsage
      ? `<span class="opt-usage-badge" title="실제 등록 건수">${opt.usage_count}건</span>`
      : '';

    // 색상 스와치 (업무카테고리 등 COLOR_ENABLED 카테고리)
    const showColor = COLOR_ENABLED.has(activeCategory);
    const swatchColor = opt.color || DEFAULT_COLOR;
    const swatch = showColor
      ? `<span class="opt-color-swatch" style="background:${escapeHtml(swatchColor)}" title="${escapeHtml(swatchColor)}"></span>`
      : '';

    return `
      <div class="settings-option-item ${inactive ? 'inactive' : ''}" data-id="${opt.id}">
        <div class="opt-order">${opt.sort_order}</div>
        <div class="opt-value">${swatch}${escapeHtml(opt.value)}${usageBadge}</div>
        <div class="opt-actions">
          ${!inactive ? `
            <button type="button" class="btn-icon btn-move-up"   ${canMoveUp ? '' : 'disabled'} title="위로">↑</button>
            <button type="button" class="btn-icon btn-move-down" ${canMoveDown ? '' : 'disabled'} title="아래로">↓</button>
            <button type="button" class="btn-icon btn-edit"     title="수정">수정</button>
            <button type="button" class="btn-icon btn-deactivate" title="비활성">비활성</button>
            <button type="button" class="btn-icon btn-delete"    title="완전 삭제">삭제</button>
          ` : `
            <button type="button" class="btn-icon btn-activate" title="다시 활성화">활성화</button>
            <button type="button" class="btn-icon btn-delete"   title="완전 삭제">삭제</button>
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
      row.querySelector('.btn-delete')?.addEventListener('click', () => confirmDelete(opt));
    });
  }

  // ─── CRUD 작업 ───────────────────────────────────────────────

  function openAddForm() {
    const showColor = COLOR_ENABLED.has(activeCategory);
    const colorField = showColor ? `
      <div class="form-group">
        <label>색상</label>
        <input type="color" name="color" value="${DEFAULT_COLOR}">
      </div>
    ` : '';
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
          ${colorField}
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">추가</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#add-option-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const value = fd.get('value').trim();
          if (!value) { Toast.warning('옵션 값을 입력해주세요.'); return; }
          const color = showColor ? fd.get('color') : null;
          await addOption(value, color);
        });
      }
    });
  }

  async function addOption(value, color) {
    // 다음 sort_order = 현재 활성 옵션의 max + 1
    const activeOpts = currentOptions.filter(o => o.is_active);
    const nextOrder = activeOpts.length > 0
      ? Math.max(...activeOpts.map(o => o.sort_order)) + 1
      : 1;

    const row = { category: activeCategory, value, sort_order: nextOrder, is_active: true };
    if (color) row.color = color;

    const { error } = await supabase
      .from('dropdown_options')
      .insert(row);

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
    const showColor = COLOR_ENABLED.has(activeCategory);
    const curColor = opt.color || DEFAULT_COLOR;
    const colorField = showColor ? `
      <div class="form-group">
        <label>색상</label>
        <input type="color" name="color" value="${escapeHtml(curColor)}">
      </div>
    ` : '';
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
          ${colorField}
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
          const fd = new FormData(e.target);
          const newValue = fd.get('value').trim();
          if (!newValue) { Toast.warning('옵션 값을 입력해주세요.'); return; }
          const newColor = showColor ? fd.get('color') : null;
          const valueChanged = newValue !== opt.value;
          const colorChanged = showColor && newColor !== curColor;
          if (!valueChanged && !colorChanged) { Modal.close(); return; }
          await updateOption(opt.id, newValue, newColor, valueChanged, colorChanged);
        });
      }
    });
  }

  async function updateOption(id, newValue, newColor, valueChanged, colorChanged) {
    const patch = {};
    if (valueChanged) patch.value = newValue;
    if (colorChanged) patch.color = newColor;

    const { error } = await supabase
      .from('dropdown_options')
      .update(patch)
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

  // 삭제: 확인 모달 → DB row 완전 제거
  function confirmDelete(opt) {
    Modal.open({
      type: 'center',
      title: '옵션 삭제 확인',
      size: 'sm',
      html: `
        <p style="margin:0 0 12px;">
          <strong>"${escapeHtml(opt.value)}"</strong> 옵션을 완전 삭제하시겠습니까?
        </p>
        <p class="form-hint" style="color:var(--color-danger,#dc2626);">
          * 이 작업은 되돌릴 수 없습니다.<br>
          * 기존에 이 값을 사용한 레코드(회원 등록, 문의, 업무 등)는 영향받지 않습니다 —<br>
          &nbsp;&nbsp;DB엔 값이 그대로 남지만 드롭다운에는 더 이상 표시되지 않습니다.<br>
          * 과거 데이터 집계에 혼란을 주지 않으려면 <strong>비활성</strong>을 권장합니다.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
          <button type="button" class="btn btn-danger" id="btn-confirm-delete">완전 삭제</button>
        </div>
      `,
      onOpen: (el) => {
        el.querySelector('#btn-confirm-delete').addEventListener('click', async () => {
          await deleteOption(opt);
        });
      }
    });
  }

  async function deleteOption(opt) {
    const { error } = await supabase
      .from('dropdown_options')
      .delete()
      .eq('id', opt.id);

    if (error) {
      Toast.error('삭제 실패: ' + error.message);
      return;
    }

    Toast.success(`"${opt.value}" 완전 삭제됨`);
    Modal.close();
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

  // ═══════════════════════════════════════════════════════
  // SMS 템플릿 관리 (sms_templates 테이블)
  // ═══════════════════════════════════════════════════════
  let _smsTemplates = [];

  async function loadSmsTemplates() {
    const listEl = document.getElementById('settings-option-list');
    const { data, error } = await supabase
      .from('sms_templates')
      .select('id, name, category, msg, msg_type, title, send_once, sort_order, is_active')
      .order('is_active', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) {
      Toast.error('템플릿 로드 실패: ' + error.message);
      listEl.innerHTML = '<div class="empty-state">로드 실패</div>';
      return;
    }
    _smsTemplates = data || [];
    renderSmsTemplateList();
  }

  function renderSmsTemplateList() {
    const listEl = document.getElementById('settings-option-list');
    if (!_smsTemplates.length) {
      listEl.innerHTML = '<div class="empty-state">템플릿이 없습니다. + 옵션 추가 버튼으로 등록하세요.</div>';
      return;
    }
    const active = _smsTemplates.filter(t => t.is_active);
    const inactive = _smsTemplates.filter(t => !t.is_active);

    listEl.innerHTML = `
      ${active.length ? `<div class="settings-option-group-label">활성 (${active.length})</div>` : ''}
      <div class="settings-option-items">${active.map((t, i) => renderSmsTemplateItem(t, i, active.length)).join('')}</div>
      ${inactive.length ? `<div class="settings-option-group-label">비활성 (${inactive.length})</div>
        <div class="settings-option-items">${inactive.map(t => renderSmsTemplateItem(t, null, 0)).join('')}</div>` : ''}
    `;
    bindSmsTemplateEvents();
  }

  function renderSmsTemplateItem(tpl, index, total) {
    const inactive = !tpl.is_active;
    const canMoveUp   = index !== null && index > 0;
    const canMoveDown = index !== null && index < total - 1;
    const onceMark = tpl.send_once
      ? `<span class="opt-usage-badge" style="background:#FEE2E2;color:#B91C1C;">1회 한정</span>` : '';
    const catLabel = (SMS_TPL_CATEGORIES.find(c => c.value === tpl.category) || {}).label || tpl.category || '';
    const msgPreview = (tpl.msg || '').replace(/\n/g, ' ').slice(0, 60) + ((tpl.msg || '').length > 60 ? '…' : '');
    return `
      <div class="settings-option-item ${inactive ? 'inactive' : ''}" data-id="${tpl.id}">
        <div class="opt-order">${tpl.sort_order || ''}</div>
        <div class="opt-value" style="flex-direction:column; align-items:flex-start; gap:4px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <strong>${escapeHtml(tpl.name)}</strong>
            ${onceMark}
            ${catLabel ? `<span class="opt-usage-badge">${escapeHtml(catLabel)}</span>` : ''}
          </div>
          <div style="font-size:11px; color:var(--color-text-muted);">${escapeHtml(msgPreview)}</div>
        </div>
        <div class="opt-actions">
          ${!inactive ? `
            <button type="button" class="btn-icon btn-tpl-up"   ${canMoveUp ? '' : 'disabled'} title="위로">↑</button>
            <button type="button" class="btn-icon btn-tpl-down" ${canMoveDown ? '' : 'disabled'} title="아래로">↓</button>
            <button type="button" class="btn-icon btn-tpl-edit" title="수정">수정</button>
            <button type="button" class="btn-icon btn-deactivate btn-tpl-toggle" data-active="false" title="비활성">비활성</button>
            <button type="button" class="btn-icon btn-delete btn-tpl-delete" title="완전 삭제">삭제</button>
          ` : `
            <button type="button" class="btn-icon btn-activate btn-tpl-toggle" data-active="true" title="다시 활성화">활성화</button>
            <button type="button" class="btn-icon btn-delete btn-tpl-delete" title="완전 삭제">삭제</button>
          `}
        </div>
      </div>
    `;
  }

  function bindSmsTemplateEvents() {
    document.querySelectorAll('#settings-option-list .settings-option-item').forEach(row => {
      const id = row.dataset.id;
      const tpl = _smsTemplates.find(t => t.id === id);
      if (!tpl) return;
      row.querySelector('.btn-tpl-up')?.addEventListener('click', () => moveSmsTemplate(tpl, -1));
      row.querySelector('.btn-tpl-down')?.addEventListener('click', () => moveSmsTemplate(tpl, +1));
      row.querySelector('.btn-tpl-edit')?.addEventListener('click', () => openEditTemplate(tpl));
      row.querySelector('.btn-tpl-toggle')?.addEventListener('click', (e) => {
        const setTo = e.currentTarget.dataset.active === 'true';
        setSmsTemplateActive(tpl, setTo);
      });
      row.querySelector('.btn-tpl-delete')?.addEventListener('click', () => confirmDeleteTemplate(tpl));
    });
  }

  function buildTemplateForm(tpl) {
    const isEdit = !!tpl;
    const t = tpl || { name: '', category: 'general', msg: '', send_once: false, msg_type: 'auto', title: '' };
    const catOptions = SMS_TPL_CATEGORIES.map(c =>
      `<option value="${c.value}" ${c.value === t.category ? 'selected' : ''}>${c.label}</option>`
    ).join('');
    return `
      <form id="tpl-form">
        <div class="form-group">
          <label>템플릿 이름 *</label>
          <input type="text" name="name" value="${escapeHtml(t.name)}" required autofocus
            placeholder="예: 회원권 등록 환영">
        </div>
        <div class="form-group">
          <label>카테고리</label>
          <select name="category">${catOptions}</select>
        </div>
        <div class="form-group">
          <label>메시지 본문 *</label>
          <textarea name="msg" rows="10" required
            style="font-family:inherit; font-size:14px; resize:vertical; min-height:220px; width:100%;"
            placeholder="안녕하세요 {이름}님, ...">${escapeHtml(t.msg)}</textarea>
          <div class="form-hint">사용 가능 변수: <code>${SMS_VARS_HINT}</code></div>
        </div>
        <div class="form-group">
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; padding:10px 12px; background:var(--color-bg-0); border-radius:8px; border:1px solid var(--color-border);">
            <input type="checkbox" name="send_once" ${t.send_once ? 'checked' : ''}
              style="width:18px; height:18px; flex-shrink:0; accent-color:var(--color-primary, #F97316); margin:0;">
            <span style="font-size:14px;"><strong>1회 한정 템플릿</strong> — 같은 회원에게 1번만 발송 (재발송 시 경고)</span>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
          <button type="submit" class="btn btn-primary">${isEdit ? '저장' : '추가'}</button>
        </div>
      </form>
    `;
  }

  function openAddTemplate() {
    Modal.open({
      type: 'center',
      title: '문자 템플릿 추가',
      size: 'md',
      html: buildTemplateForm(null),
      onOpen: (el) => {
        el.querySelector('#tpl-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const next = (_smsTemplates.filter(t => t.is_active).reduce((m,t) => Math.max(m, t.sort_order||0), 0) + 1);
          const row = {
            name: fd.get('name').trim(),
            category: fd.get('category'),
            msg: fd.get('msg').trim(),
            send_once: fd.get('send_once') === 'on',
            msg_type: 'auto',
            sort_order: next,
            is_active: true,
          };
          if (!row.name || !row.msg) { Toast.warning('이름·메시지 필수'); return; }
          const { error } = await supabase.from('sms_templates').insert(row);
          if (error) { Toast.error('추가 실패: ' + error.message); return; }
          Toast.success('템플릿 추가 완료');
          Modal.close();
          await loadSmsTemplates();
        });
      }
    });
  }

  function openEditTemplate(tpl) {
    Modal.open({
      type: 'center',
      title: '문자 템플릿 수정',
      size: 'md',
      html: buildTemplateForm(tpl),
      onOpen: (el) => {
        el.querySelector('#tpl-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const patch = {
            name: fd.get('name').trim(),
            category: fd.get('category'),
            msg: fd.get('msg').trim(),
            send_once: fd.get('send_once') === 'on',
            updated_at: new Date().toISOString(),
          };
          if (!patch.name || !patch.msg) { Toast.warning('이름·메시지 필수'); return; }
          const { error } = await supabase.from('sms_templates').update(patch).eq('id', tpl.id);
          if (error) { Toast.error('수정 실패: ' + error.message); return; }
          Toast.success('수정 완료');
          Modal.close();
          await loadSmsTemplates();
        });
      }
    });
  }

  async function moveSmsTemplate(tpl, dir) {
    const active = _smsTemplates.filter(t => t.is_active);
    const idx = active.findIndex(t => t.id === tpl.id);
    if (idx < 0) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= active.length) return;
    const a = active[idx], b = active[swapIdx];
    // swap sort_order via 임시값 회피 (UNIQUE 없지만 안전)
    const ao = a.sort_order, bo = b.sort_order;
    const r1 = await supabase.from('sms_templates').update({ sort_order: -1 }).eq('id', a.id);
    if (r1.error) { Toast.error('순서 변경 실패: ' + r1.error.message); return; }
    await supabase.from('sms_templates').update({ sort_order: ao }).eq('id', b.id);
    await supabase.from('sms_templates').update({ sort_order: bo }).eq('id', a.id);
    await loadSmsTemplates();
  }

  async function setSmsTemplateActive(tpl, active) {
    const { error } = await supabase.from('sms_templates').update({ is_active: active }).eq('id', tpl.id);
    if (error) { Toast.error('변경 실패: ' + error.message); return; }
    Toast.success(active ? '활성화됨' : '비활성화됨');
    await loadSmsTemplates();
  }

  function confirmDeleteTemplate(tpl) {
    Modal.open({
      type: 'center', title: '템플릿 삭제 확인', size: 'sm',
      html: `
        <p style="margin:0 0 12px;">"<strong>${escapeHtml(tpl.name)}</strong>" 을 완전 삭제하시겠습니까?</p>
        <p class="form-hint" style="color:var(--color-danger,#DC2626);">
          * 이 작업은 되돌릴 수 없습니다.<br>
          * 이미 발송된 sms_logs는 영향받지 않습니다 (template_id가 NULL이 됨).
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
          <button type="button" class="btn btn-danger" id="btn-tpl-confirm-del">완전 삭제</button>
        </div>
      `,
      onOpen: (el) => {
        el.querySelector('#btn-tpl-confirm-del').addEventListener('click', async () => {
          const { error } = await supabase.from('sms_templates').delete().eq('id', tpl.id);
          if (error) { Toast.error('삭제 실패: ' + error.message); return; }
          Toast.success('삭제됨');
          Modal.close();
          await loadSmsTemplates();
        });
      }
    });
  }

  return { init };
})();
