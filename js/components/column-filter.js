/**
 * ColumnFilter — 엑셀 스타일 컬럼별 필터 컴포넌트 (v1, 2026-04-29)
 *
 * 헤더 셀에 ▼ 아이콘을 추가하고, 클릭 시 팝오버로:
 *   · enum: 체크박스 + 검색 (다중 선택 OR)
 *   · date_range: 시작일/종료일 (포함)
 *   · number_range: 최소/최대 (포함)
 *
 * 여러 컬럼 동시 적용 = AND 조합.
 *
 * 사용:
 *   ColumnFilter.attach(headerEl, {
 *     tab: 'inquiry',
 *     key: 'status',
 *     type: 'enum',
 *     label: '상태',
 *     getOptions: (rows) => [{value:'unregistered',label:'미등록',count:N}, ...],
 *     onChange: () => rerender(),
 *   });
 *
 *   const filtered = ColumnFilter.apply('inquiry', allRows, columnsConfig);
 *
 * 상태 (메모리):
 *   _filters[tab][key] = { values: Set<string> }  // enum
 *                      | { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }  // date_range
 *                      | { min: number, max: number }  // number_range
 */
window.ColumnFilter = (() => {
  const _filters = {};   // { tab: { key: state } }
  let _activePopover = null;

  function _getState(tab, key) {
    return _filters[tab]?.[key];
  }

  function _setState(tab, key, state) {
    if (!_filters[tab]) _filters[tab] = {};
    if (!state || _isEmpty(state)) {
      delete _filters[tab][key];
    } else {
      _filters[tab][key] = state;
    }
  }

  function _isEmpty(state) {
    if (!state) return true;
    if (state.values instanceof Set) return state.values.size === 0;
    if ('from' in state || 'to' in state) return !state.from && !state.to;
    if ('min' in state || 'max' in state) return state.min == null && state.max == null;
    return false;
  }

  function _hasFilter(tab, key) {
    const s = _getState(tab, key);
    return s !== undefined && !_isEmpty(s);
  }

  function _closeActivePopover() {
    if (_activePopover) {
      _activePopover.remove();
      _activePopover = null;
      document.removeEventListener('click', _onDocClick, true);
    }
  }

  function _onDocClick(e) {
    if (_activePopover && !_activePopover.contains(e.target) &&
        !e.target.closest('.col-filter-icon')) {
      _closeActivePopover();
    }
  }

  // ─── 팝오버 렌더링 ───────────────────────────────────────
  function _openPopover(iconEl, opts) {
    _closeActivePopover();
    const { tab, key, type, label, getOptions, onChange } = opts;
    const state = _getState(tab, key);

    const pop = document.createElement('div');
    pop.className = 'col-filter-popover';
    pop.addEventListener('click', e => e.stopPropagation());

    if (type === 'enum') {
      const options = getOptions ? getOptions() : [];
      const selected = state?.values instanceof Set ? state.values : new Set();

      pop.innerHTML = `
        <div class="cf-pop-header">${_esc(label)}</div>
        <div class="cf-pop-search-wrap">
          <input type="text" class="cf-pop-search" placeholder="검색...">
        </div>
        <div class="cf-pop-list-wrap">
          <label class="cf-pop-row cf-pop-row-all">
            <input type="checkbox" class="cf-all-check"
              ${selected.size === 0 || selected.size === options.length ? 'checked' : ''}>
            <span><strong>전체 선택</strong></span>
          </label>
          <div class="cf-pop-list"></div>
        </div>
        <div class="cf-pop-actions">
          <button type="button" class="cf-btn cf-btn-clear">초기화</button>
          <button type="button" class="cf-btn cf-btn-primary cf-btn-apply">적용</button>
        </div>
      `;

      const listEl = pop.querySelector('.cf-pop-list');
      const renderList = (filterText = '') => {
        const f = filterText.trim().toLowerCase();
        listEl.innerHTML = options
          .filter(o => !f || String(o.label).toLowerCase().includes(f))
          .map(o => `
            <label class="cf-pop-row">
              <input type="checkbox" class="cf-opt" data-value="${_esc(o.value)}"
                ${selected.has(o.value) || selected.size === 0 ? 'checked' : ''}>
              <span class="cf-opt-label">${_esc(o.label)}</span>
              ${o.count != null ? `<span class="cf-opt-count">${o.count}</span>` : ''}
            </label>
          `).join('');
      };
      renderList();

      pop.querySelector('.cf-pop-search').addEventListener('input', e => renderList(e.target.value));

      const allCheck = pop.querySelector('.cf-all-check');
      allCheck.addEventListener('change', () => {
        const checked = allCheck.checked;
        listEl.querySelectorAll('.cf-opt').forEach(c => c.checked = checked);
      });

      pop.querySelector('.cf-btn-apply').addEventListener('click', () => {
        const checks = pop.querySelectorAll('.cf-opt:checked');
        const allChecks = pop.querySelectorAll('.cf-opt');
        const newValues = new Set(Array.from(checks).map(c => c.dataset.value));
        // 전체 선택 = 필터 없음
        if (newValues.size === allChecks.length || newValues.size === 0) {
          _setState(tab, key, null);
        } else {
          _setState(tab, key, { values: newValues });
        }
        _closeActivePopover();
        _updateIconState(iconEl, _hasFilter(tab, key));
        if (onChange) onChange();
      });

      pop.querySelector('.cf-btn-clear').addEventListener('click', () => {
        _setState(tab, key, null);
        _closeActivePopover();
        _updateIconState(iconEl, false);
        if (onChange) onChange();
      });
    } else if (type === 'date_range') {
      const from = state?.from || '';
      const to = state?.to || '';
      pop.innerHTML = `
        <div class="cf-pop-header">${_esc(label)}</div>
        <div class="cf-pop-range-wrap">
          <label class="cf-range-label">시작일
            <input type="date" class="cf-range-from" value="${from}">
          </label>
          <label class="cf-range-label">종료일
            <input type="date" class="cf-range-to" value="${to}">
          </label>
        </div>
        <div class="cf-pop-actions">
          <button type="button" class="cf-btn cf-btn-clear">초기화</button>
          <button type="button" class="cf-btn cf-btn-primary cf-btn-apply">적용</button>
        </div>
      `;
      pop.querySelector('.cf-btn-apply').addEventListener('click', () => {
        const from = pop.querySelector('.cf-range-from').value;
        const to = pop.querySelector('.cf-range-to').value;
        if (!from && !to) {
          _setState(tab, key, null);
        } else {
          _setState(tab, key, { from, to });
        }
        _closeActivePopover();
        _updateIconState(iconEl, _hasFilter(tab, key));
        if (onChange) onChange();
      });
      pop.querySelector('.cf-btn-clear').addEventListener('click', () => {
        _setState(tab, key, null);
        _closeActivePopover();
        _updateIconState(iconEl, false);
        if (onChange) onChange();
      });
    } else if (type === 'number_range') {
      const min = state?.min ?? '';
      const max = state?.max ?? '';
      pop.innerHTML = `
        <div class="cf-pop-header">${_esc(label)}</div>
        <div class="cf-pop-range-wrap">
          <label class="cf-range-label">최소
            <input type="number" class="cf-range-min" value="${min}" placeholder="0">
          </label>
          <label class="cf-range-label">최대
            <input type="number" class="cf-range-max" value="${max}" placeholder="">
          </label>
        </div>
        <div class="cf-pop-actions">
          <button type="button" class="cf-btn cf-btn-clear">초기화</button>
          <button type="button" class="cf-btn cf-btn-primary cf-btn-apply">적용</button>
        </div>
      `;
      pop.querySelector('.cf-btn-apply').addEventListener('click', () => {
        const minV = pop.querySelector('.cf-range-min').value;
        const maxV = pop.querySelector('.cf-range-max').value;
        const min = minV === '' ? null : Number(minV);
        const max = maxV === '' ? null : Number(maxV);
        if (min == null && max == null) {
          _setState(tab, key, null);
        } else {
          _setState(tab, key, { min, max });
        }
        _closeActivePopover();
        _updateIconState(iconEl, _hasFilter(tab, key));
        if (onChange) onChange();
      });
      pop.querySelector('.cf-btn-clear').addEventListener('click', () => {
        _setState(tab, key, null);
        _closeActivePopover();
        _updateIconState(iconEl, false);
        if (onChange) onChange();
      });
    }

    document.body.appendChild(pop);
    _activePopover = pop;

    // 위치 정렬 — 아이콘 좌측 하단
    const rect = iconEl.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = rect.left;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
    let top = rect.bottom + 4;
    if (top + popH > window.innerHeight - 12) top = rect.top - popH - 4;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;

    // 외부 클릭 시 닫기
    setTimeout(() => document.addEventListener('click', _onDocClick, true), 0);

    // 검색 자동 포커스 (enum 일 때)
    pop.querySelector('.cf-pop-search')?.focus();
  }

  function _updateIconState(headerEl, hasFilter) {
    // v2: 헤더 셀에 .has-active-filter 클래스 토글 (▼ 아이콘 대신)
    if (hasFilter) headerEl.classList.add('has-active-filter');
    else headerEl.classList.remove('has-active-filter');
  }

  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── Public API ───────────────────────────────────────
  // v2 (2026-04-29): ▼ 아이콘 제거 — 헤더 셀 자체를 클릭하면 팝오버.
  // 활성 필터 표시는 헤더에 .has-active-filter 클래스 부착 (CSS 측에서 주황 밑줄).
  function attach(headerEl, opts) {
    if (!headerEl || headerEl.dataset.cfBound === '1') return;
    headerEl.dataset.cfBound = '1';
    headerEl.classList.add('cf-clickable');
    if (_hasFilter(opts.tab, opts.key)) headerEl.classList.add('has-active-filter');

    headerEl.addEventListener('click', e => {
      e.stopPropagation();
      if (_activePopover) {
        const wasMine = _activePopover.dataset.tab === opts.tab && _activePopover.dataset.key === opts.key;
        _closeActivePopover();
        if (wasMine) return;
      }
      _openPopover(headerEl, opts);
      if (_activePopover) {
        _activePopover.dataset.tab = opts.tab;
        _activePopover.dataset.key = opts.key;
      }
    });
  }

  function get(tab, key) {
    return _getState(tab, key);
  }

  function set(tab, key, state) {
    _setState(tab, key, state);
  }

  function clearAll(tab) {
    _filters[tab] = {};
  }

  function activeCount(tab) {
    if (!_filters[tab]) return 0;
    return Object.keys(_filters[tab]).filter(k => _hasFilter(tab, k)).length;
  }

  /**
   * apply — rows 에 현재 활성 필터를 모두 통과한 것만 리턴 (AND)
   * columnsConfig: { key: { type, getValue: (row) => value } }
   */
  function apply(tab, rows, columnsConfig) {
    const tabFilters = _filters[tab] || {};
    const activeKeys = Object.keys(tabFilters).filter(k => _hasFilter(tab, k));
    if (activeKeys.length === 0) return rows;

    return rows.filter(row => {
      for (const key of activeKeys) {
        const cfg = columnsConfig[key];
        if (!cfg) continue;
        const state = tabFilters[key];
        const value = cfg.getValue(row);

        if (cfg.type === 'enum') {
          // value 가 배열일 수도 있음 (예: 다중 태그) — 단순 매칭
          if (Array.isArray(value)) {
            if (!value.some(v => state.values.has(String(v)))) return false;
          } else {
            if (!state.values.has(String(value ?? ''))) return false;
          }
        } else if (cfg.type === 'date_range') {
          const v = value || '';
          if (state.from && v < state.from) return false;
          if (state.to && v > state.to) return false;
        } else if (cfg.type === 'number_range') {
          const v = Number(value) || 0;
          if (state.min != null && v < state.min) return false;
          if (state.max != null && v > state.max) return false;
        }
      }
      return true;
    });
  }

  return { attach, get, set, clearAll, activeCount, apply };
})();
