/**
 * 커스텀 드롭다운 (+ 새 항목 추가 인라인)
 *
 * 사용:
 *   Dropdown.create({
 *     container: el,         // 드롭다운을 넣을 부모 요소
 *     category: '유입경로',   // dropdown_options 카테고리
 *     name: 'inflow_channel', // form name
 *     placeholder: '선택',
 *     value: '',              // 초기값
 *     onChange: (val) => {}
 *   });
 */
const Dropdown = (() => {
  // 카테고리별 옵션 캐시 (값 배열)
  const cache = {};
  // 전체 필드 캐시 ({value, color, sort_order} 배열) — 업무카테고리 등 색상 필요한 곳용
  const fullCache = {};

  async function fetchOptions(category) {
    if (cache[category]) return cache[category];

    const { data, error } = await supabase
      .from('dropdown_options')
      .select('value, sort_order, color')
      .eq('category', category)
      .eq('is_active', true)
      .order('sort_order');

    if (error) {
      Toast.error('드롭다운 로드 실패: ' + error.message);
      return [];
    }

    cache[category]     = data.map(d => d.value);
    fullCache[category] = data.map(d => ({ value: d.value, color: d.color, sort_order: d.sort_order }));
    return cache[category];
  }

  // 색상 등 전체 필드가 필요한 경우 (ex. 업무카테고리)
  async function fetchFull(category) {
    if (!fullCache[category]) await fetchOptions(category);
    return fullCache[category] || [];
  }

  function clearCache(category) {
    if (category) { delete cache[category]; delete fullCache[category]; }
    else { Object.keys(cache).forEach(k => delete cache[k]); Object.keys(fullCache).forEach(k => delete fullCache[k]); }
  }

  async function create(opts) {
    const { container, category, name, placeholder = '선택', value = '', onChange } = opts;

    const options = await fetchOptions(category);

    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown-wrapper';
    wrapper.innerHTML = `
      <input type="hidden" name="${name}" value="${value}">
      <button type="button" class="dropdown-toggle">
        <span class="dropdown-label">${value || placeholder}</span>
        <span class="dropdown-arrow">&#9662;</span>
      </button>
      <div class="dropdown-menu"></div>
    `;

    const hiddenInput = wrapper.querySelector('input[type="hidden"]');
    const toggle = wrapper.querySelector('.dropdown-toggle');
    const label = wrapper.querySelector('.dropdown-label');
    const menu = wrapper.querySelector('.dropdown-menu');

    function renderMenu() {
      const currentOptions = cache[category] || [];
      menu.innerHTML = '';

      currentOptions.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'dropdown-item' + (opt === hiddenInput.value ? ' selected' : '');
        item.textContent = opt;
        item.addEventListener('click', () => select(opt));
        menu.appendChild(item);
      });

      // + 새 항목 추가
      const addItem = document.createElement('div');
      addItem.className = 'dropdown-item dropdown-add';
      addItem.innerHTML = '<span>+ 새 항목 추가</span>';
      addItem.addEventListener('click', (e) => {
        e.stopPropagation();
        showAddInput();
      });
      menu.appendChild(addItem);
    }

    function select(val) {
      hiddenInput.value = val;
      label.textContent = val;
      label.classList.remove('placeholder');
      closeMenu();
      if (onChange) onChange(val);
    }

    function showAddInput() {
      const addItem = menu.querySelector('.dropdown-add');
      addItem.innerHTML = `
        <input type="text" class="dropdown-add-input" placeholder="새 항목 입력" autofocus>
        <button type="button" class="dropdown-add-btn">추가</button>
      `;

      const input = addItem.querySelector('.dropdown-add-input');
      const btn = addItem.querySelector('.dropdown-add-btn');

      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addNewOption(input.value.trim()); }
        if (e.key === 'Escape') renderMenu();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addNewOption(input.value.trim());
      });

      input.focus();
    }

    async function addNewOption(val) {
      if (!val) return;

      const nextOrder = (cache[category]?.length || 0) + 1;
      const { error } = await supabase
        .from('dropdown_options')
        .insert({ category, value: val, sort_order: nextOrder });

      if (error) {
        if (error.code === '23505') {
          Toast.warning('이미 존재하는 항목입니다.');
        } else {
          Toast.error('항목 추가 실패: ' + error.message);
        }
        return;
      }

      // 캐시 갱신
      if (!cache[category]) cache[category] = [];
      cache[category].push(val);

      renderMenu();
      select(val);
      Toast.success(`"${val}" 추가됨`);
    }

    function openMenu() {
      renderMenu();
      wrapper.classList.add('open');
    }

    function closeMenu() {
      wrapper.classList.remove('open');
    }

    toggle.addEventListener('click', () => {
      wrapper.classList.contains('open') ? closeMenu() : openMenu();
    });

    // v3: 외부 클릭 시 닫기 — wrapper 제거(모달 close) 시 document 리스너 자동 해제
    const onDocClick = (e) => {
      if (!document.body.contains(wrapper)) {
        document.removeEventListener('click', onDocClick);
        return;
      }
      if (!wrapper.contains(e.target)) closeMenu();
    };
    document.addEventListener('click', onDocClick);

    if (!value) label.classList.add('placeholder');

    container.appendChild(wrapper);
    return { select, getValue: () => hiddenInput.value, wrapper, dispose: () => document.removeEventListener('click', onDocClick) };
  }

  return { create, fetchOptions, fetchFull, clearCache };
})();
