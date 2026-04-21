/**
 * SPT관리 탭 (membership-app) — v2 UX 개편
 *
 * v2 변경:
 *   - 진행률 바 / X/N 표기 제거
 *   - 좌측 여백 축소 (#tab-spt padding 0 8px)
 *   - 각 회원 행에 최신 코멘트 인라인 렌더 (2~3줄)
 *   - 행 클릭 시 아코디언 펼침 → 전체 코멘트 히스토리 + 세션 카드 + 설정 편집 + 재배정
 *   - 상세 모달 완전 제거 (인라인 확장 전환). [+SPT 신규] 모달만 유지.
 *
 * 설계 기준: _workspace/feature-plan_spt-sessions.md (v3)
 *
 * 핵심 불변식 (I1~I8) 준수:
 *   - I1: registrations 는 SELECT 전용. 회차 가감은 spt_session_add_one / remove_last RPC 만.
 *   - I2: 종결 상태 세션 삭제는 DB 트리거 차단. UI 는 마지막 pending 만 삭제 버튼 의미.
 *   - I3/I4: 재배정은 RPC — pending/in_progress 만 교체. notes/scheduled_at 불변.
 *   - I5: veragym-app schedules 와 완전 분리.
 *   - I6: 디자인 토큰 재사용. 신규 클래스는 spt-* 필요 최소.
 *   - I7: spt_member_comments.member_id 변경 금지. 재배정 시 코멘트 건드리지 않음.
 *   - I8: spt_member_comments.trainer_name 변경 금지. 코멘트 수정/추가 UI 노출 X (트레이너 영역).
 */
const SptTab = (() => {
  let allSummaries = [];              // spt_member_summary VIEW
  let activeTrainers = [];            // is_active=true AND role='trainer'
  const expandedMembers = new Set();  // 펼쳐진 회원 id 목록 (독립 토글)
  const expandedComments = new Set(); // 코멘트 영역 펼침 (최신 → 전체 히스토리)
  const commentsCache = new Map();    // memberId → comment rows
  const sessionsCache = new Map();    // memberId → session rows
  const memberDetailCache = new Map();// memberId → spt_members row

  let filter = {
    search: '',
    state: 'all',               // all | pending | in_progress | completed | rejected | unreachable | other
    slot: 'all',                // all | 오전 | 오후 | 전체
    trainerId: ''               // '' = 전체, '__unassigned__' = 미배정만, uuid = 특정 트레이너
  };

  // ─────────────── 초기화 ───────────────
  let _realtimeChannel = null;

  async function init() {
    await loadTrainers();
    renderToolbar();
    await loadSummaries();
    subscribeRealtime();
  }

  async function reload() {
    await loadSummaries();
  }

  // Supabase Realtime 구독 — 트레이너 앱이 spt_sessions/comments/members 변경 시 즉시 반영
  function subscribeRealtime() {
    if (_realtimeChannel) return;
    const debouncedReload = debounce(() => { loadSummaries(); }, 400);
    _realtimeChannel = supabase.channel('spt-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spt_sessions' }, debouncedReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spt_member_comments' }, debouncedReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spt_members' }, debouncedReload)
      .subscribe();
  }

  async function loadTrainers() {
    const { data, error } = await supabase
      .from('trainers')
      .select('id, name, is_active, role')
      .eq('role', 'trainer')
      .eq('is_active', true)
      .order('name');
    if (error) {
      Toast.error('트레이너 목록 로드 실패: ' + error.message);
      activeTrainers = [];
      return;
    }
    activeTrainers = data || [];
  }

  async function loadSummaries() {
    const listEl = document.getElementById('spt-list');
    if (listEl) listEl.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    // 1) spt_member_summary VIEW
    const { data, error } = await supabase
      .from('spt_member_summary')
      .select('*')
      .order('registered_at', { ascending: false });

    if (error) {
      Toast.error('SPT 회원 로드 실패: ' + error.message);
      if (listEl) listEl.innerHTML = '<div class="empty-state">데이터를 불러올 수 없습니다.</div>';
      return;
    }
    allSummaries = data || [];

    const memberIds = allSummaries.map(s => s.member_id).filter(Boolean);
    if (memberIds.length === 0) { renderList(); return; }

    // 2) 병렬 fetch: 코멘트 전체 (각 회원 최신 1건 + 총 건수) + session_number 1~2 데이터
    const [commentsRes, sessionsRes] = await Promise.all([
      supabase
        .from('spt_member_comments')
        .select('id, member_id, trainer_name, content, created_at, updated_at')
        .in('member_id', memberIds)
        .order('created_at', { ascending: false })
        .limit(2000),
      supabase
        .from('spt_sessions')
        .select('member_id, session_number, status, scheduled_at, completed_at')
        .in('member_id', memberIds)
        .in('session_number', [1, 2])
    ]);

    // 코멘트: 최신 1건 + 총 개수
    const latestByMember = new Map();
    const countByMember = new Map();
    if (!commentsRes.error && commentsRes.data) {
      commentsRes.data.forEach(c => {
        if (!latestByMember.has(c.member_id)) latestByMember.set(c.member_id, c);
        countByMember.set(c.member_id, (countByMember.get(c.member_id) || 0) + 1);
      });
    }

    // 세션 1/2
    const session1ByMember = new Map();
    const session2ByMember = new Map();
    if (!sessionsRes.error && sessionsRes.data) {
      sessionsRes.data.forEach(s => {
        if (s.session_number === 1) session1ByMember.set(s.member_id, s);
        else if (s.session_number === 2) session2ByMember.set(s.member_id, s);
      });
    }

    allSummaries.forEach(s => {
      s._latest_comment = latestByMember.get(s.member_id) || null;
      s._comment_count = countByMember.get(s.member_id) || 0;
      s._session1 = session1ByMember.get(s.member_id) || null;
      s._session2 = session2ByMember.get(s.member_id) || null;
    });

    renderList();
  }

  // ─────────────── 진행상태 / 세션날짜 포맷 ───────────────

  // 회원 전체 진행상태 — 우선순위 기반
  // in_progress > managing > pending > registered > completed > rejected > unreachable > other
  function deriveOverallStatus(r) {
    const ip  = Number(r.in_progress_sessions) || 0;
    const mn  = Number(r.managing_sessions)    || 0;
    const pd  = Number(r.pending_sessions)     || 0;
    const rg  = Number(r.registered_sessions)  || 0;
    const cp  = Number(r.completed_sessions)   || 0;
    const rj  = Number(r.rejected_sessions)    || 0;
    const un  = Number(r.unreachable_sessions) || 0;
    const ot  = Number(r.other_sessions)       || 0;
    if (ip > 0) return 'in_progress';
    if (mn > 0) return 'managing';
    if (pd > 0) return 'pending';
    if (rg > 0) return 'registered';
    if (cp > 0) return 'completed';
    if (rj > 0) return 'rejected';
    if (un > 0) return 'unreachable';
    if (ot > 0) return 'other';
    return 'pending';
  }

  // 세션 셀 라벨 (SPT1/SPT2 열 — 무조건 날짜만)
  function sessionCellLabel(s) {
    if (!s) return '—';
    const dt = s.scheduled_at || s.completed_at;
    return dt ? fmtMonthDay(dt) : '—';
  }
  // 세션 셀 status → CSS 변종(pending 은 muted)
  function sessionCellClass(s) {
    if (!s) return 'spt-cell-session spt-cell-muted';
    return `spt-cell-session spt-cell-${s.status.replace('_','-')}`;
  }

  // ─────────────── 툴바 (inquiry탭 디자인 규칙 동일: search + pills + dropdown + actions) ───────────────
  function renderToolbar() {
    const pane = document.getElementById('tab-spt');

    const slotChip = (val, label) =>
      `<button class="btn btn-chip${filter.slot === val ? ' active' : ''}" data-spt-slot="${escHtml(val)}">${escHtml(label)}</button>`;

    const trainerOpts = [
      `<option value=""${filter.trainerId === '' ? ' selected' : ''}>트레이너 전체</option>`,
      `<option value="__unassigned__"${filter.trainerId === '__unassigned__' ? ' selected' : ''}>미배정</option>`,
      ...activeTrainers.map(t =>
        `<option value="${escHtml(t.id)}"${filter.trainerId === t.id ? ' selected' : ''}>${escHtml(t.name)}</option>`)
    ].join('');

    const stateOpts = [
      ['all', '상태 전체'], ['pending', '진행전'], ['in_progress', '진행중'],
      ['managing', '관리중'], ['registered', '등록'],
      ['completed', '완료'], ['rejected', '거부'], ['unreachable', '연락안됨'], ['other', '기타']
    ].map(([v, l]) =>
      `<option value="${v}"${filter.state === v ? ' selected' : ''}>${l}</option>`
    ).join('');

    pane.innerHTML = `
      <div class="inquiry-toolbar spt-toolbar">
        <input type="text" class="search-box" id="spt-search" placeholder="이름 또는 번호 검색...">
        <div class="status-filter" role="group" aria-label="시간대 필터">
          ${slotChip('all', '전체')}
          ${slotChip('오전', '오전')}
          ${slotChip('오후', '오후')}
          ${slotChip('전체', '전체')}
        </div>
        <div class="manager-filter">
          <select class="filter-select" id="spt-filter-trainer">${trainerOpts}</select>
          <select class="filter-select" id="spt-filter-state">${stateOpts}</select>
        </div>
        <div class="inquiry-toolbar-actions">
          <button class="btn btn-primary btn-chip-sized" id="btn-spt-new">+ SPT 신규</button>
          <button class="btn btn-secondary btn-chip-sized" id="btn-spt-sync">동기화</button>
          <button class="btn btn-secondary btn-chip-sized" id="btn-spt-reset">초기화</button>
        </div>
      </div>
      <div id="spt-list"></div>
    `;

    pane.querySelector('#spt-search').addEventListener('input', debounce(e => {
      filter.search = e.target.value.trim();
      renderList();
    }, 250));

    pane.querySelector('.status-filter').addEventListener('click', e => {
      const btn = e.target.closest('[data-spt-slot]');
      if (!btn) return;
      filter.slot = btn.dataset.sptSlot;
      pane.querySelectorAll('.status-filter [data-spt-slot]').forEach(b =>
        b.classList.toggle('active', b.dataset.sptSlot === filter.slot)
      );
      renderList();
    });

    pane.querySelector('#spt-filter-trainer').addEventListener('change', e => {
      filter.trainerId = e.target.value;
      renderList();
    });

    pane.querySelector('#spt-filter-state').addEventListener('change', e => {
      filter.state = e.target.value;
      renderList();
    });

    pane.querySelector('#btn-spt-reset').addEventListener('click', () => {
      filter = { search: '', state: 'all', slot: 'all', trainerId: '' };
      pane.querySelector('#spt-search').value = '';
      pane.querySelectorAll('.status-filter [data-spt-slot]').forEach(b =>
        b.classList.toggle('active', b.dataset.sptSlot === 'all')
      );
      pane.querySelector('#spt-filter-trainer').value = '';
      pane.querySelector('#spt-filter-state').value = 'all';
      renderList();
    });

    pane.querySelector('#btn-spt-sync').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '동기화 중...';
      try {
        await loadSummaries();
        Toast.success('동기화 완료');
      } catch (err) {
        Toast.error('동기화 실패');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    pane.querySelector('#btn-spt-new').addEventListener('click', () => openCreateModal());
  }

  // ─────────────── 리스트 렌더 ───────────────

  // 현재 상태 배지 우선순위: in_progress > managing > pending > registered > completed > rejected > unreachable > other
  function deriveCurrentStatus(row) {
    if ((row.in_progress_sessions || 0) > 0) return 'in_progress';
    if ((row.managing_sessions    || 0) > 0) return 'managing';
    if ((row.pending_sessions     || 0) > 0) return 'pending';
    if ((row.registered_sessions  || 0) > 0) return 'registered';
    if ((row.completed_sessions   || 0) > 0) return 'completed';
    if ((row.rejected_sessions    || 0) > 0) return 'rejected';
    if ((row.unreachable_sessions || 0) > 0) return 'unreachable';
    if ((row.other_sessions       || 0) > 0) return 'other';
    return 'pending';
  }

  const STATUS_LABEL = {
    pending:     '진행전',
    in_progress: '진행중',
    completed:   '완료',
    rejected:    '거부',
    unreachable: '연락안됨',
    other:       '기타',
    managing:    '관리중',
    registered:  '등록',
  };

  function statusBadgeHtml(status) {
    const label = STATUS_LABEL[status] || status;
    return `<span class="spt-status-badge spt-status-${status.replace('_','-')}">${escHtml(label)}</span>`;
  }

  function fmtDate(s) {
    if (!s) return '-';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '-';
    const M = d.getMonth() + 1;
    const D = d.getDate();
    return `${d.getFullYear()}/${M}/${D}`;
  }

  function fmtMonthDay(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function applyFilters(rows) {
    return rows.filter(r => {
      if (filter.search) {
        const q = filter.search.toLowerCase();
        const inName = (r.member_name || '').toLowerCase().includes(q);
        const inPhone = (r.phone || '').includes(filter.search);
        if (!inName && !inPhone) return false;
      }
      if (filter.state !== 'all') {
        if (deriveCurrentStatus(r) !== filter.state) return false;
      }
      if (filter.slot !== 'all') {
        if ((r.preferred_time_slot || '전체') !== filter.slot) return false;
      }
      // 트레이너 필터 — __unassigned__ 는 미배정만, 특정 id 는 그 트레이너만
      if (filter.trainerId === '__unassigned__') {
        if (r.trainer_id) return false;
      } else if (filter.trainerId) {
        if (r.trainer_id !== filter.trainerId) return false;
      }
      return true;
    });
  }

  function renderList() {
    const listEl = document.getElementById('spt-list');
    if (!listEl) return;

    if (allSummaries.length === 0) {
      listEl.innerHTML = `<div class="empty-state">아직 SPT 회원이 없습니다. [+ SPT 신규]로 시작하세요.</div>`;
      return;
    }

    const filtered = applyFilters(allSummaries);
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">검색 결과 없음</div>`;
      return;
    }

    listEl.innerHTML = `<div class="spt-card-list">${renderListHeader()}${filtered.map(r => renderCard(r)).join('')}</div>`;

    // 카드 바인딩
    filtered.forEach(r => bindCard(r.member_id));
  }

  function renderFilterRow() {
    return '';
  }

  // 9-cell row 카드 HTML
  //   [이름][연락처][오전/오후][담당트레이너][진행상태][spt1][spt2][최신코멘트][+코멘트 N건 or 상세]
  // + 아래 영역: 코멘트 히스토리 아코디언, 상세 body 아코디언 (독립 토글)
  function renderCard(r) {
    const memberId = r.member_id;
    const overall = deriveOverallStatus(r);
    const trainerLabel = r.trainer_name ? escHtml(r.trainer_name) : '미배정';
    const slot = escHtml(r.preferred_time_slot || '전체');
    const isOpen = expandedMembers.has(memberId);
    const isCommentsOpen = expandedComments.has(memberId);

    // 연락처 포맷 (utils.js formatPhone)
    const phoneRaw = r.phone || '';
    const phoneFmt = phoneRaw ? (typeof formatPhone === 'function' ? formatPhone(phoneRaw) : phoneRaw) : '';

    // spt1 / spt2 셀
    const s1 = r._session1, s2 = r._session2;
    const s1Label = sessionCellLabel(s1);
    const s2Label = sessionCellLabel(s2);
    const s1Cls = sessionCellClass(s1);
    const s2Cls = sessionCellClass(s2);

    // 최신 코멘트 (한 줄, 말줄임)
    const latest = r._latest_comment;
    const cmtDateStr = latest?.created_at ? (() => {
      const d = new Date(latest.created_at);
      return isNaN(d) ? '' : `${d.getMonth()+1}/${d.getDate()}`;
    })() : '';
    const latestInner = latest
      ? `<span class="spt-cell-cmt-date">${escHtml(cmtDateStr)}</span>
         <span class="spt-cell-cmt-author">${escHtml(latest.trainer_name || '(탈퇴)')}</span>
         <span class="spt-cell-cmt-colon">:</span>
         <span class="spt-cell-cmt-body">${escHtml(latest.content || '')}</span>`
      : `<span class="spt-cell-cmt-empty">(아직 코멘트 없음)</span>`;

    // 추가 코멘트 개수 = 총건수 - 1 (최신 1건 제외). 0이면 버튼 숨김.
    const extraCount = Math.max(0, (r._comment_count || 0) - 1);
    const cmtBtnHtml = extraCount > 0
      ? `<button class="spt-comment-expand-btn" data-member-id="${escHtml(memberId)}" aria-expanded="${isCommentsOpen}">
           +코멘트 ${extraCount}건 ${isCommentsOpen ? '▲' : '▼'}
         </button>`
      : `<span class="spt-cell-action-placeholder">&nbsp;</span>`;

    // 수정 버튼 — .btn-action 디자인 토큰 재사용 (inquiry/pt 탭과 동일 패턴)
    // 동기화 버튼은 상단 툴바에만 유지 (행별 버튼 제거)
    const editBtnHtml = `<button class="btn-action spt-edit-btn" data-member-id="${escHtml(memberId)}" title="수정">수정</button>`;

    // 관리자 메모 셀 (담당트레이너 옆) — 클릭 시 전체 내용 펼침 (inquiry 탭 col-content 패턴)
    const memoRaw = (r.master_notes || '').toString();
    const memoCellHtml = memoRaw
      ? `<div class="spt-row-cell spt-cell-memo" data-member-id="${escHtml(memberId)}" title="${escHtml(memoRaw)}"><span class="spt-cell-memo-inline">${escHtml(memoRaw)}</span></div>`
      : `<div class="spt-row-cell spt-cell-memo spt-cell-memo-empty">—</div>`;

    const regDate = r.registered_at ? fmtDate(r.registered_at) : '—';
    return `
      <div class="spt-card${isCommentsOpen ? ' is-comments-open' : ''}" data-member-id="${escHtml(memberId)}">
        <div class="spt-row" data-member-id="${escHtml(memberId)}">
          <div class="spt-row-cell spt-cell-regdate">${escHtml(regDate)}</div>
          <div class="spt-row-cell spt-cell-name" title="${escHtml(r.member_name || '')}">${escHtml(r.member_name || '')}</div>
          <div class="spt-row-cell spt-cell-phone">${escHtml(phoneFmt)}</div>
          <div class="spt-row-cell spt-cell-slot"><span class="spt-slot-chip">${slot}</span></div>
          <div class="spt-row-cell spt-cell-trainer">${trainerLabel}</div>
          ${memoCellHtml}
          <div class="spt-row-cell spt-cell-overall">${statusBadgeHtml(overall)}</div>
          <div class="spt-row-cell ${s1Cls}" title="${escHtml(s1Label)}">${escHtml(s1Label)}</div>
          <div class="spt-row-cell ${s2Cls}" title="${escHtml(s2Label)}">${escHtml(s2Label)}</div>
          <div class="spt-row-cell spt-row-comment">
            <div class="spt-row-comment-text" title="${escHtml(latest ? (latest.trainer_name + ': ' + latest.content) : '(아직 코멘트 없음)')}">${latestInner}</div>
          </div>
          <div class="spt-row-cell spt-row-actions">
            ${cmtBtnHtml}
            ${editBtnHtml}
          </div>
        </div>

        <div class="spt-comments-full" data-member-id="${escHtml(memberId)}" style="${isCommentsOpen ? '' : 'display:none;'}">
          <div class="loading-center"><div class="spinner"></div></div>
        </div>
      </div>
    `;
  }

  function bindCard(memberId) {
    const card = document.querySelector(`.spt-card[data-member-id="${CSS.escape(memberId)}"]`);
    if (!card) return;

    // 수정 버튼 (모달 오픈)
    const editBtn = card.querySelector(`.spt-edit-btn[data-member-id="${CSS.escape(memberId)}"]`);
    if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(memberId); });

    // 관리자 메모 셀: 클릭 시 전체 내용 펼침 (inquiry 탭 col-content 패턴과 동일)
    const memoCell = card.querySelector(`.spt-cell-memo[data-member-id="${CSS.escape(memberId)}"]`);
    if (memoCell) {
      memoCell.addEventListener('click', (e) => {
        e.stopPropagation();
        memoCell.classList.toggle('expanded');
      });
    }

    // 코멘트 히스토리 확장 버튼
    const cmtBtn = card.querySelector(`.spt-comment-expand-btn[data-member-id="${CSS.escape(memberId)}"]`);
    if (cmtBtn) cmtBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleComments(memberId); });
  }

  function renderListHeader() {
    return `
      <div class="spt-row spt-row-header" aria-hidden="true">
        <div class="spt-row-cell">날짜</div>
        <div class="spt-row-cell">이름</div>
        <div class="spt-row-cell">연락처</div>
        <div class="spt-row-cell">시간대</div>
        <div class="spt-row-cell">담당T</div>
        <div class="spt-row-cell">관리자 메모</div>
        <div class="spt-row-cell">진행상태</div>
        <div class="spt-row-cell">SPT1</div>
        <div class="spt-row-cell">SPT2</div>
        <div class="spt-row-cell">최신 코멘트</div>
        <div class="spt-row-cell">&nbsp;</div>
      </div>
    `;
  }

  // ─────────────── 수정 모달 (4필드 + 1저장) ───────────────
  async function openEditModal(memberId) {
    const summary = allSummaries.find(s => s.member_id === memberId);
    if (!summary) { Toast.error('회원 정보를 찾을 수 없습니다'); return; }

    // 최신 spt_members 설정 로드 (캐시된 summary보다 신선)
    const { data: sm, error } = await supabase
      .from('spt_members')
      .select('preferred_time_slot, preferred_time_detail, master_notes')
      .eq('member_id', memberId)
      .maybeSingle();
    if (error) { Toast.error('설정 로드 실패: ' + error.message); return; }

    const s = sm || {};
    const slot = s.preferred_time_slot || summary.preferred_time_slot || '전체';
    const detail = s.preferred_time_detail || summary.preferred_time_detail || '';
    const masterNotes = s.master_notes || summary.master_notes || '';
    const currentTrainerId = summary.trainer_id || '';

    const trainerOptions = activeTrainers.map(t =>
      `<option value="${escHtml(t.id)}"${t.id === currentTrainerId ? ' selected' : ''}>${escHtml(t.name)}</option>`
    ).join('');

    Modal.open({
      type: 'center',
      title: `${escHtml(summary.member_name || '회원')} 수정`,
      html: `
        <form id="spt-edit-form">
          <div class="form-grid">
            <div class="form-group">
              <label>희망시간대</label>
              <select name="slot" class="form-select">
                <option value="전체"${slot === '전체' ? ' selected' : ''}>전체</option>
                <option value="오전"${slot === '오전' ? ' selected' : ''}>오전</option>
                <option value="오후"${slot === '오후' ? ' selected' : ''}>오후</option>
              </select>
            </div>
            <div class="form-group">
              <label>배정 트레이너</label>
              <select name="trainer_id" class="form-select">
                <option value="">미배정</option>
                ${trainerOptions}
              </select>
            </div>
            <div class="form-group full">
              <label>희망 상세</label>
              <input type="text" name="detail" value="${escHtml(detail)}" placeholder="예: 평일 오후 2시~4시">
            </div>
            <div class="form-group full">
              <label>관리자 메모</label>
              <textarea name="master_notes" rows="3" placeholder="관리 메모">${escHtml(masterNotes)}</textarea>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">저장</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        el.querySelector('#spt-edit-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await saveEditForm(memberId, e.target, currentTrainerId);
        });
      }
    });
  }

  async function saveEditForm(memberId, form, prevTrainerId) {
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const fd = new FormData(form);

    const newSlot = fd.get('slot');
    const newDetail = (fd.get('detail') || '').trim() || null;
    const newNotes = (fd.get('master_notes') || '').trim() || null;
    const newTrainerId = fd.get('trainer_id') || null;

    // 1) 설정(preferences) 저장
    const { data: prefs, error: prefErr } = await supabase.rpc('spt_member_update_preferences', {
      p_member_id: memberId,
      p_slot: newSlot,
      p_detail: newDetail,
      p_master_notes: newNotes
    });
    if (prefErr || !prefs?.ok) {
      Toast.error('저장 실패: ' + (prefErr?.message || prefs?.error || '알 수 없음'));
      submitBtn.disabled = false;
      return;
    }

    // 2) 트레이너 재배정(변경된 경우만, pending/in_progress 세션에만 적용)
    const normalizedPrev = prevTrainerId || null;
    if (newTrainerId !== normalizedPrev) {
      const { data: ra, error: raErr } = await supabase.rpc('spt_session_reassign_trainer', {
        p_member_id: memberId,
        p_new_trainer_id: newTrainerId
      });
      if (raErr || !ra?.ok) {
        Toast.warning('설정은 저장됐지만 트레이너 변경 실패: ' + (raErr?.message || ra?.error || '알 수 없음'));
        submitBtn.disabled = false;
        // preferences는 이미 저장됐으므로 UI는 새로고침
        Modal.close();
        await loadSummaries();
        return;
      }
    }

    Toast.success('저장 완료');
    Modal.close();
    await loadSummaries();
  }

  // ─────────────── 토글: 코멘트 히스토리 ───────────────
  async function toggleComments(memberId) {
    const card = document.querySelector(`.spt-card[data-member-id="${CSS.escape(memberId)}"]`);
    if (!card) return;
    const containerEl = card.querySelector(`.spt-comments-full[data-member-id="${CSS.escape(memberId)}"]`);
    const btn = card.querySelector(`.spt-comment-expand-btn[data-member-id="${CSS.escape(memberId)}"]`);
    const isOpen = expandedComments.has(memberId);

    const rebuildBtnLabel = (open) => {
      if (!btn) return;
      const raw = btn.textContent || '';
      const m = raw.match(/\+코멘트\s*(\d+)건/);
      const n = m ? m[1] : '';
      btn.textContent = `+코멘트 ${n}건 ${open ? '▲' : '▼'}`;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    if (isOpen) {
      expandedComments.delete(memberId);
      card.classList.remove('is-comments-open');
      containerEl.style.display = 'none';
      rebuildBtnLabel(false);
      return;
    }

    expandedComments.add(memberId);
    card.classList.add('is-comments-open');
    containerEl.style.display = '';
    rebuildBtnLabel(true);

    await loadAndRenderComments(containerEl, memberId);
  }

  // ─────────────── 카드 body: 세션 + 설정 + 재배정 ───────────────
  async function renderCardBody(bodyEl, memberId) {
    bodyEl.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

    // 병렬 fetch
    const [sessionsRes, memberRes] = await Promise.all([
      supabase
        .from('spt_sessions')
        .select('id, session_number, status, scheduled_at, completed_at, notes, trainer_id, registration_id, trainer:trainers(id, name)')
        .eq('member_id', memberId)
        .order('session_number', { ascending: true }),
      supabase
        .from('spt_members')
        .select('preferred_time_slot, preferred_time_detail, master_notes, registration_id')
        .eq('member_id', memberId)
        .maybeSingle()
    ]);

    if (sessionsRes.error) {
      bodyEl.innerHTML = `<div class="empty-state">세션 로드 실패: ${escHtml(sessionsRes.error.message)}</div>`;
      return;
    }
    const sessions = sessionsRes.data || [];
    const sptMember = memberRes.data || {};
    sessionsCache.set(memberId, sessions);
    memberDetailCache.set(memberId, sptMember);

    const summary = allSummaries.find(s => s.member_id === memberId) || {};
    const slot = sptMember.preferred_time_slot || summary.preferred_time_slot || '전체';
    const detailTxt = sptMember.preferred_time_detail || summary.preferred_time_detail || '';
    const masterNotes = sptMember.master_notes || summary.master_notes || '';
    const registrationId = sptMember.registration_id || null;

    bodyEl.innerHTML = `
      <div class="spt-body-grid">
        <div class="spt-body-settings">
          <div class="spt-body-meta">
            등록 경로: ${registrationId ? '문의 경로' : '직접 등록'}
          </div>
          <div class="form-grid spt-settings-grid">
            <div class="form-group">
              <label>희망시간대</label>
              <select class="form-select spt-slot" data-member-id="${escHtml(memberId)}">
                <option value="전체"${slot === '전체' ? ' selected' : ''}>전체</option>
                <option value="오전"${slot === '오전' ? ' selected' : ''}>오전</option>
                <option value="오후"${slot === '오후' ? ' selected' : ''}>오후</option>
              </select>
            </div>
            <div class="form-group">
              <label>희망 상세</label>
              <input type="text" class="spt-detail-text" data-member-id="${escHtml(memberId)}"
                value="${escHtml(detailTxt)}" placeholder="예: 평일 오후 2시~4시">
            </div>
            <div class="form-group">
              <label>배정 트레이너</label>
              <select class="form-select spt-trainer-select" data-member-id="${escHtml(memberId)}">
                <option value="">(미배정)</option>
                ${activeTrainers.map(t => `<option value="${escHtml(t.id)}"${summary.trainer_id === t.id ? ' selected' : ''}>${escHtml(t.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>&nbsp;</label>
              <div class="spt-actions-inline">
                <button class="btn btn-secondary btn-chip-sized btn-spt-save-prefs" data-member-id="${escHtml(memberId)}">설정 저장</button>
                <button class="btn btn-primary btn-chip-sized btn-spt-reassign" data-member-id="${escHtml(memberId)}">트레이너 변경</button>
              </div>
            </div>
            <div class="form-group full">
              <label>관리자 메모</label>
              <textarea class="spt-master-notes" data-member-id="${escHtml(memberId)}" rows="3" placeholder="관리자 메모">${escHtml(masterNotes)}</textarea>
            </div>
          </div>
        </div>

        <div class="spt-body-sessions">
          <div class="spt-sessions-head">
            <h4 style="margin:0; font-size:13px;">회차 (${sessions.length}개)</h4>
            <div class="spt-actions-inline">
              <button class="btn btn-secondary btn-chip-sized btn-spt-add-session" data-member-id="${escHtml(memberId)}">+ 회차</button>
              <button class="btn btn-secondary btn-chip-sized btn-spt-remove-last" data-member-id="${escHtml(memberId)}">− 마지막</button>
            </div>
          </div>
          <div class="spt-sessions-grid">
            ${sessions.map(s => renderSessionCard(s)).join('') || '<div class="empty-state" style="padding:12px;">회차 없음</div>'}
          </div>
          <p class="spt-hint">※ 수업 일정/노트는 트레이너 앱에서 입력. 관리자는 상태 오버라이드만.</p>
        </div>
      </div>
    `;

    bindCardBody(bodyEl, memberId);
  }

  function renderSessionCard(s) {
    const trainerName = s.trainer?.name || '미배정';
    const schedDate = s.scheduled_at ? fmtDate(s.scheduled_at) : '';
    const doneDate = s.completed_at ? fmtDate(s.completed_at) : '';
    const notesShort = (s.notes || '').slice(0, 140);
    const notesEllipsis = (s.notes || '').length > 140 ? '…' : '';

    return `
      <div class="spt-session-card" data-session-id="${escHtml(s.id)}">
        <div class="spt-session-head">
          <div class="spt-session-label">
            <strong>${s.session_number}회차</strong>
            ${statusBadgeHtml(s.status)}
          </div>
          <select class="spt-status-select form-select" data-session-id="${escHtml(s.id)}" data-current="${escHtml(s.status)}">
            <option value="pending"${s.status === 'pending' ? ' selected' : ''}>진행전</option>
            <option value="in_progress"${s.status === 'in_progress' ? ' selected' : ''}>진행중</option>
            <option value="completed"${s.status === 'completed' ? ' selected' : ''}>완료</option>
            <option value="rejected"${s.status === 'rejected' ? ' selected' : ''}>거부</option>
            <option value="unreachable"${s.status === 'unreachable' ? ' selected' : ''}>연락안됨</option>
            <option value="other"${s.status === 'other' ? ' selected' : ''}>기타</option>
          </select>
        </div>
        <div class="spt-session-meta">
          <span>· ${escHtml(trainerName)}</span>
          ${doneDate ? `<span>· 완료 ${escHtml(doneDate)}</span>` : (schedDate ? `<span>· 예정 ${escHtml(schedDate)}</span>` : '')}
        </div>
        ${notesShort ? `<div class="spt-session-notes" title="${escHtml(s.notes || '')}">${escHtml(notesShort)}${notesEllipsis}</div>` : ''}
      </div>
    `;
  }

  function bindCardBody(bodyEl, memberId) {
    // 설정 저장
    const savePrefsBtn = bodyEl.querySelector(`.btn-spt-save-prefs[data-member-id="${CSS.escape(memberId)}"]`);
    if (savePrefsBtn) savePrefsBtn.addEventListener('click', async () => {
      const slot = bodyEl.querySelector(`.spt-slot[data-member-id="${CSS.escape(memberId)}"]`).value;
      const detail = bodyEl.querySelector(`.spt-detail-text[data-member-id="${CSS.escape(memberId)}"]`).value.trim();
      const notes = bodyEl.querySelector(`.spt-master-notes[data-member-id="${CSS.escape(memberId)}"]`).value.trim();
      await updatePreferences(memberId, slot, detail, notes);
    });

    // 트레이너 재배정
    const reassignBtn = bodyEl.querySelector(`.btn-spt-reassign[data-member-id="${CSS.escape(memberId)}"]`);
    if (reassignBtn) reassignBtn.addEventListener('click', async () => {
      const newId = bodyEl.querySelector(`.spt-trainer-select[data-member-id="${CSS.escape(memberId)}"]`).value || null;
      await reassignTrainer(memberId, newId);
    });

    // 회차 추가/삭제
    const addBtn = bodyEl.querySelector(`.btn-spt-add-session[data-member-id="${CSS.escape(memberId)}"]`);
    if (addBtn) addBtn.addEventListener('click', () => addSession(memberId));
    const removeBtn = bodyEl.querySelector(`.btn-spt-remove-last[data-member-id="${CSS.escape(memberId)}"]`);
    if (removeBtn) removeBtn.addEventListener('click', () => removeLastSession(memberId));

    // 세션 status select
    bodyEl.querySelectorAll('.spt-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const sessionId = sel.dataset.sessionId;
        const prev = sel.dataset.current;
        const next = sel.value;
        if (prev === next) return;
        await updateSessionStatus(sessionId, next, memberId, () => { sel.value = prev; });
      });
    });
  }

  // ─────────────── 코멘트 전체 히스토리 로드/렌더 ───────────────
  async function loadAndRenderComments(containerEl, memberId) {
    containerEl.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

    const { data, error } = await supabase
      .from('spt_member_comments')
      .select('id, trainer_id, trainer_name, content, created_at, updated_at')
      .eq('member_id', memberId)
      .order('created_at', { ascending: false });

    if (error) {
      containerEl.innerHTML = `<div class="empty-state" style="padding:12px;">코멘트 로드 실패: ${escHtml(error.message)}</div>`;
      return;
    }

    commentsCache.set(memberId, data || []);

    if (!data || data.length === 0) {
      containerEl.innerHTML = `<div class="empty-state" style="padding:16px;">아직 코멘트가 없습니다.</div>`;
      return;
    }

    containerEl.innerHTML = `
      <div class="spt-comments-history">
        ${data.map(c => {
          const md = fmtMonthDay(c.created_at);
          const edited = c.updated_at && c.created_at !== c.updated_at
            ? ' <span class="spt-comment-edited">(수정됨)</span>' : '';
          return `
            <div class="spt-comment-item" data-id="${escHtml(c.id)}">
              <div class="spt-comment-line">
                <span class="spt-comment-date">${escHtml(md)}</span>
                <span class="spt-comment-author">${escHtml(c.trainer_name || '(탈퇴)')}</span>
                <span class="spt-comment-colon">:</span>
                <span class="spt-comment-content">${escHtml(c.content || '')}</span>
                ${edited}
              </div>
              <div class="spt-comment-actions">
                <button class="btn-action btn-spt-comment-del" data-id="${escHtml(c.id)}">삭제</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <p class="spt-hint">※ 추가/수정은 트레이너 앱에서만. 여기서는 열람 + [삭제](moderation).</p>
    `;

    containerEl.querySelectorAll('.btn-spt-comment-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteComment(btn.dataset.id, memberId, containerEl);
      });
    });
  }

  // ─────────────── + SPT 신규 모달 (유지) ───────────────
  function openCreateModal() {
    Modal.open({
      type: 'center',
      size: 'sm',
      title: 'SPT 신규 등록',
      html: `
        <form id="spt-create-form">
          <div class="form-grid">
            <div class="form-group full">
              <label>이름 *</label>
              <input type="text" name="name" required>
            </div>
            <div class="form-group full">
              <label>전화번호 *</label>
              <input type="tel" name="phone" placeholder="010-0000-0000" required>
            </div>
            <div class="form-group">
              <label>수업 수 *</label>
              <input type="number" name="session_count" min="1" max="5" value="2" required>
            </div>
            <div class="form-group">
              <label>희망시간대</label>
              <select name="preferred_slot" class="form-select">
                <option value="전체">전체</option>
                <option value="오전">오전</option>
                <option value="오후">오후</option>
              </select>
            </div>
            <div class="form-group full">
              <label>희망 상세 (선택)</label>
              <input type="text" name="preferred_detail" placeholder="예: 평일 오후 2시~4시">
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">등록</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        bindPhoneFormat(el.querySelector('input[name="phone"]'));
        el.querySelector('#spt-create-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await submitCreate(e.target);
        });
      }
    });
  }

  async function submitCreate(form) {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    const phone = (fd.get('phone') || '').trim();
    const count = parseInt(fd.get('session_count'));
    const slot = fd.get('preferred_slot') || '전체';
    const detail = (fd.get('preferred_detail') || '').trim() || null;

    if (!name) { Toast.warning('이름은 필수입니다.'); return; }
    if (!phone) { Toast.warning('전화번호는 필수입니다.'); return; }
    if (!count || count < 1) { Toast.warning('수업 수를 입력해주세요.'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const { data, error } = await supabase.rpc('spt_member_create', {
      p_name: name,
      p_phone: phone,
      p_session_count: count,
      p_preferred_slot: slot,
      p_preferred_detail: detail
    });

    if (error) {
      Toast.error('등록 실패: ' + error.message);
      submitBtn.disabled = false;
      return;
    }
    if (!data?.ok) {
      Toast.error('등록 실패: ' + (data?.error || '알 수 없는 오류'));
      submitBtn.disabled = false;
      return;
    }

    Toast.success('SPT 등록 완료');
    Modal.close();
    await loadSummaries();
  }

  // ─────────────── 액션 RPC 래퍼 ───────────────
  async function updatePreferences(memberId, slot, detail, masterNotes) {
    const { data, error } = await supabase.rpc('spt_member_update_preferences', {
      p_member_id: memberId,
      p_slot: slot || null,
      p_detail: detail || null,
      p_master_notes: masterNotes || null
    });
    if (error) { Toast.error('설정 저장 실패: ' + error.message); return; }
    if (!data?.ok) { Toast.error('설정 저장 실패: ' + (data?.error || '알 수 없음')); return; }
    Toast.success('설정이 저장되었습니다.');
    // 해당 회원 summary만 업데이트 — 펼침 상태를 유지하기 위해 리스트 전체 재렌더 후 body 복원
    await refreshAfterChange(memberId);
  }

  async function reassignTrainer(memberId, newTrainerId) {
    const { data, error } = await supabase.rpc('spt_session_reassign_trainer', {
      p_member_id: memberId,
      p_new_trainer_id: newTrainerId
    });
    if (error) { Toast.error('재배정 실패: ' + error.message); return; }
    if (!data?.ok) { Toast.error('재배정 실패: ' + (data?.error || '알 수 없음')); return; }
    Toast.success(`재배정 완료 (${data.updated || 0}개 세션 갱신)`);
    await refreshAfterChange(memberId);
  }

  async function updateSessionStatus(sessionId, newStatus, memberId, rollback) {
    const { data, error } = await supabase.rpc('spt_session_update_status', {
      p_session_id: sessionId,
      p_new_status: newStatus,
      p_scheduled_at: null
    });
    if (error) {
      Toast.error('상태 변경 실패: ' + error.message);
      if (rollback) rollback();
      return;
    }
    if (!data?.ok) {
      const code = data?.code;
      if (code === 'NO_TRAINER') {
        Toast.warning('진행중/완료 상태는 트레이너 배정 후 변경 가능합니다.');
      } else if (code === 'LOCKED') {
        Toast.warning('종결된 세션은 관리자만 변경 가능합니다.');
      } else {
        Toast.error('상태 변경 실패: ' + (data?.error || '알 수 없음'));
      }
      if (rollback) rollback();
      return;
    }
    Toast.success('상태가 변경되었습니다.');
    await refreshAfterChange(memberId);
  }

  async function addSession(memberId) {
    const { data, error } = await supabase.rpc('spt_session_add_one', { p_member_id: memberId });
    if (error) { Toast.error('회차 추가 실패: ' + error.message); return; }
    if (!data?.ok) { Toast.error('회차 추가 실패: ' + (data?.error || '알 수 없음')); return; }
    Toast.success(`${data.session_number}회차 추가됨`);
    await refreshAfterChange(memberId);
  }

  async function removeLastSession(memberId) {
    if (!confirm('마지막 회차를 삭제하시겠습니까? (pending 상태일 때만 삭제됩니다)')) return;
    const { data, error } = await supabase.rpc('spt_session_remove_last', { p_member_id: memberId });
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    if (!data?.ok) {
      const code = data?.code;
      if (code === 'NOT_PENDING') {
        Toast.warning(data.error || '마지막 회차가 진행/종결 상태라 삭제할 수 없습니다.');
      } else if (code === 'NO_SESSION') {
        Toast.warning('삭제할 세션이 없습니다.');
      } else {
        Toast.error('삭제 실패: ' + (data?.error || '알 수 없음'));
      }
      return;
    }
    Toast.success(`${data.removed_session_number}회차 삭제됨`);
    await refreshAfterChange(memberId);
  }

  async function deleteComment(commentId, memberId, containerEl) {
    if (!confirm('이 코멘트를 삭제하시겠습니까? 작성자가 작성한 내용이 영구 제거됩니다.')) return;
    const { data, error } = await supabase.rpc('spt_comment_delete', { p_comment_id: commentId });
    if (error) { Toast.error('삭제 실패: ' + error.message); return; }
    if (!data?.ok) { Toast.error('삭제 실패: ' + (data?.error || '알 수 없음')); return; }
    Toast.success('코멘트가 삭제되었습니다.');

    // in-place 제거
    const row = containerEl.querySelector(`.spt-comment-item[data-id="${CSS.escape(commentId)}"]`);
    if (row) row.remove();

    // summary 의 최신 코멘트 재계산을 위해 reload (펼침 상태 유지)
    await refreshAfterChange(memberId, { keepCommentsOpen: true });
  }

  // ─────────────── 상태 유지 리로드 ───────────────
  // summaries 재로드 후 펼침 상태 복원. body/comments 내부도 재렌더.
  async function refreshAfterChange(memberId, opts = {}) {
    await loadSummaries();
    // renderList() 가 이미 실행된 후 카드가 재생성됨 (펼침 상태는 Set 에 남아있어 카드 외관만 복원)
    // 하지만 body/comments 내부 DOM 은 새로 붙었으므로 재렌더 트리거
    const card = document.querySelector(`.spt-card[data-member-id="${CSS.escape(memberId)}"]`);
    if (!card) return;

    // v3: 상세 인라인 확장 제거. 수정은 모달에서 처리.
    if (expandedComments.has(memberId)) {
      const commentsEl = card.querySelector(`.spt-comments-full[data-member-id="${CSS.escape(memberId)}"]`);
      if (commentsEl) {
        commentsEl.style.display = '';
        await loadAndRenderComments(commentsEl, memberId);
      }
    }
  }

  return { init, reload };
})();
