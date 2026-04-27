/**
 * 문의관리 탭
 * - 문의 리스트 (phone 그룹핑, 최신 우선)
 * - [+문의추가] 센터 모달
 * - [수정] 센터 모달
 * - [+등록] 센터 모달 (registrations INSERT → status='registered')
 * - [TM내용] 드로어 (tm_logs 리스트 + 추가)
 */
const InquiryTab = (() => {
  let allInquiries = [];
  let searchQuery = '';
  let statusFilter = 'all';   // 'all' | 'registered' | 'unregistered'
  // v6.1: 담당자 필터 단일화 — 타입(계약/매출) + 이름 1개로 통합
  let managerFilterType = 'contract'; // 'contract' | 'sales'
  let managerFilterName = '';
  // v7: 페이지네이션 — 필터 없을 때 초기 30건, "더보기"로 +30씩 증가
  const PAGE_SIZE = 30;
  let displayLimit = PAGE_SIZE;
  let totalCount = 0;            // 전체 행수 (count: 'exact')
  let isLoading = false;

  // "2026-04-17" / "2026/4/7" → "26/4/17" (리스트 표시 전용 축약 포맷)
  function fmtDateShort(s) {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return s;
    return `${m[1].slice(2)}/${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  }

  async function init() {
    renderToolbar();
    await loadInquiries();
  }

  function renderToolbar() {
    const pane = document.getElementById('tab-inquiry');
    pane.innerHTML = `
      <div class="inquiry-toolbar">
        <input type="text" class="search-box" placeholder="이름 또는 번호 검색...">
        <div class="status-filter" role="group" aria-label="등록 상태 필터">
          <button class="btn btn-chip active" data-status="all">전체</button>
          <button class="btn btn-chip" data-status="unregistered">미등록</button>
          <button class="btn btn-chip" data-status="registered">등록</button>
        </div>
        <div class="manager-filter">
          <select id="filter-manager-type" class="filter-select">
            <option value="contract">계약담당</option>
            <option value="sales">매출담당</option>
          </select>
          <input type="text" class="filter-input" id="filter-manager-name" placeholder="담당자 이름">
        </div>
        <div class="inquiry-toolbar-actions">
          <button class="btn btn-secondary btn-chip-sized" id="btn-excel-export">엑셀 내보내기</button>
          <button class="btn btn-secondary btn-chip-sized" id="btn-excel-import">엑셀 업로드</button>
          <button class="btn btn-primary btn-chip-sized" id="btn-add-inquiry">+ 문의추가</button>
        </div>
      </div>
      <div id="inquiry-list"></div>
    `;

    pane.querySelector('.search-box').addEventListener('input',
      debounce(e => {
        searchQuery = e.target.value.trim();
        displayLimit = PAGE_SIZE;  // 필터 변경 시 페이지 리셋
        loadInquiries();
      }, 300)
    );

    // v6.1: 통합 담당자 필터 — 타입 드롭다운 + 이름 input
    pane.querySelector('#filter-manager-type').addEventListener('change', e => {
      managerFilterType = e.target.value;
      if (managerFilterName) {
        displayLimit = PAGE_SIZE;
        loadInquiries();
      }
    });
    pane.querySelector('#filter-manager-name').addEventListener('input',
      debounce(e => {
        managerFilterName = e.target.value.trim();
        displayLimit = PAGE_SIZE;
        loadInquiries();
      }, 300)
    );

    // 등록/미등록 필터 칩
    pane.querySelectorAll('.status-filter .btn-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        pane.querySelectorAll('.status-filter .btn-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        statusFilter = btn.dataset.status;
        displayLimit = PAGE_SIZE;
        loadInquiries();
      });
    });

    pane.querySelector('#btn-excel-import').addEventListener('click', () => {
      if (typeof ExcelImport !== 'undefined') ExcelImport.open();
    });
    pane.querySelector('#btn-excel-export').addEventListener('click', () => {
      if (typeof ExcelImport !== 'undefined') ExcelImport.openExport();
    });
    pane.querySelector('#btn-add-inquiry').addEventListener('click', () => openInquiryForm());
  }

  async function loadInquiries() {
    if (isLoading) return;
    isLoading = true;
    const listEl = document.getElementById('inquiry-list');
    listEl.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    const hasSearch = searchQuery.length > 0;
    const hasStatusFilter = statusFilter !== 'all';
    const hasManagerFilter = managerFilterName.length > 0;
    const hasAnyFilter = hasSearch || hasStatusFilter || hasManagerFilter;

    // v7: registration join — manager 필터는 inner join 필요 (필터 걸면 등록 있는 행만)
    const regJoinType = hasManagerFilter ? 'registrations!inner' : 'registrations';
    const selectStr = `
      *,
      registration:${regJoinType}(
        registered_date, product,
        total_payment_cash, total_payment_card, total_payment,
        contract_manager, sales_manager, spt_count, spt_preferred_time
      )
    `;

    let query = supabase
      .from('inquiries')
      .select(selectStr, { count: 'exact' })
      .order('inquiry_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (hasSearch) {
      // v25: 이름/전화번호 OR 검색 — sanitizeSearch 로 %_, 일부 문자 이스케이프
      const q = sanitizeSearch(searchQuery);
      if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    if (hasStatusFilter) {
      query = query.eq('status', statusFilter);
    }
    if (hasManagerFilter) {
      const col = managerFilterType === 'contract' ? 'contract_manager' : 'sales_manager';
      const m = sanitizeSearch(managerFilterName);  // v25: % 이스케이프 누락 수정
      if (m) query = query.ilike(`registrations.${col}`, `%${m}%`);
    }

    // 페이지네이션: 필터 있어도 LIMIT 적용 (검색 결과도 페이지네이션)
    query = query.range(0, displayLimit - 1);

    const { data, error, count } = await query;

    isLoading = false;
    if (error) {
      Toast.error('문의 로드 실패: ' + error.message);
      listEl.innerHTML = '<div class="empty-state">데이터를 불러올 수 없습니다.</div>';
      return;
    }

    // v7.1: 현재 페이지에 등장한 phone 의 "과거 문의" 까지 추가 로드 → 클라이언트 그룹핑 보장
    //   - 페이지네이션(30건) 때문에 같은 phone 의 이력이 다른 페이지로 밀리면 아코디언이 사라지는 문제 해결
    //   - status 필터는 과거 건에도 계승 (필터 의미 유지), manager/이름 필터는 계승 X (그룹 전체 보여야 함)
    let merged = data || [];
    const phonesOnPage = [...new Set(merged.filter(r => r.phone && r.phone.trim()).map(r => r.phone))];
    if (phonesOnPage.length > 0) {
      // v26: 성능 — 2차 fetch 에 전체 limit 적용 (phone × 과거 이력 폭증 방지)
      let pastQuery = supabase
        .from('inquiries')
        .select(selectStr)
        .in('phone', phonesOnPage)
        .order('inquiry_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(300);
      if (hasStatusFilter) pastQuery = pastQuery.eq('status', statusFilter);
      const { data: pastData } = await pastQuery;
      if (pastData && pastData.length) {
        const seen = new Map(merged.map(r => [r.id, r]));
        pastData.forEach(r => { if (!seen.has(r.id)) seen.set(r.id, r); });
        merged = Array.from(seen.values()).sort((a, b) => {
          const da = a.inquiry_date || '', db = b.inquiry_date || '';
          if (da !== db) return db.localeCompare(da);
          return (b.created_at || '').localeCompare(a.created_at || '');
        });
      }
    }
    allInquiries = merged;
    totalCount = count || 0;
    renderList();
  }

  function renderList() {
    const listEl = document.getElementById('inquiry-list');

    // v7: 필터는 서버에서 처리됨 — 클라이언트는 phone 그룹핑만 수행
    //    phone이 null/빈값인 행은 id를 키로 사용해 개별 그룹 처리
    const groups = new Map();
    allInquiries.forEach(inq => {
      const key = inq.phone && inq.phone.trim() !== '' ? inq.phone : `__no_phone__${inq.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inq);
    });

    const loadedRows = allInquiries.length;

    if (groups.size === 0) {
      const emptyMsg = statusFilter !== 'all'
        ? `${statusFilter === 'registered' ? '등록' : '미등록'} 상태의 문의가 없습니다.`
        : '문의 내역이 없습니다.';
      listEl.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }

    // PC 테이블 헤더 (1024px 초과에서만 보임) + 카드 컨테이너
    // 스펙 35행: 액션 버튼 옆에 등록 6필드 병치 (미등록이면 "-")
    listEl.innerHTML = `
      <div class="inquiry-table-header">
        <div class="col-date">문의일</div>
        <div class="col-name">이름</div>
        <div class="col-phone">전화번호</div>
        <div class="col-status">상태</div>
        <div class="col-tag">신/재</div>
        <div class="col-tag">상담유형</div>
        <div class="col-tag">유입</div>
        <div class="col-tag">목적</div>
        <div class="col-residence">거주지</div>
        <div class="col-content">내용</div>
        <div class="col-actions">액션</div>
        <div class="col-reg-product">등록상품</div>
        <div class="col-reg-payment">총결제액</div>
        <div class="col-reg-contract">계약직원</div>
        <div class="col-reg-manager">매출담당</div>
        <div class="col-reg-spt" title="SPT횟수">SPT</div>
        <div class="col-reg-time" title="SPT희망시간">희망시간</div>
      </div>
      <div class="inquiry-list-body"></div>
    `;
    const bodyEl = listEl.querySelector('.inquiry-list-body');

    // v7: DocumentFragment 로 배치 append (개별 appendChild reflow 제거)
    const frag = document.createDocumentFragment();
    groups.forEach((inquiries, phone) => {
      const latest = inquiries[0];
      const past = inquiries.slice(1);

      const card = document.createElement('div');
      card.className = 'inquiry-card';

      // 대표 문의 행 (등록 정보는 같은 행 끝에 6셀로 인라인)
      card.appendChild(createInquiryRow(latest, false));

      // 과거 문의 accordion — v7: lazy render (클릭 시점에 DOM 생성)
      if (past.length > 0) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'inquiry-accordion-toggle';
        toggleBtn.innerHTML = `<span class="arrow">&#9654;</span> 과거 문의 ${past.length}건`;
        card.appendChild(toggleBtn);

        const body = document.createElement('div');
        body.className = 'inquiry-accordion-body';
        card.appendChild(body);

        let rendered = false;
        toggleBtn.addEventListener('click', () => {
          if (!rendered) {
            const pastFrag = document.createDocumentFragment();
            past.forEach(inq => pastFrag.appendChild(createInquiryRow(inq, true)));
            body.appendChild(pastFrag);
            rendered = true;
          }
          toggleBtn.classList.toggle('open');
          body.classList.toggle('open');
        });
      }

      frag.appendChild(card);
    });
    bodyEl.appendChild(frag);

    // v7: 더보기 (+30) — 필터 없을 때만 노출. 필터 중이면 LIMIT 증가만 가능
    if (loadedRows < totalCount) {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'inquiry-more-wrap';
      moreWrap.style.cssText = 'text-align:center; padding:16px 0;';
      const moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-secondary';
      const remaining = totalCount - loadedRows;
      const next = Math.min(PAGE_SIZE, remaining);
      moreBtn.textContent = `더보기 (+${next}건, 남은 ${remaining.toLocaleString()}건)`;
      moreBtn.addEventListener('click', () => {
        displayLimit += PAGE_SIZE;
        loadInquiries();
      });
      moreWrap.appendChild(moreBtn);
      listEl.appendChild(moreWrap);
    }
  }

  function createInquiryRow(inq, isPast) {
    const row = document.createElement('div');
    row.className = 'inquiry-card-main' + (isPast ? ' is-past' : '');

    const statusClass = inq.status === 'registered' ? 'registered' : 'unregistered';
    const statusLabel = inq.status === 'registered' ? '등록' : '미등록';

    // HTML escape 유틸 (tooltip 주입 방어)
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const contentRaw = inq.content || '';
    const contentHtml = contentRaw
      ? `<div class="col-content" title="${esc(contentRaw)}"><span class="content-preview-inline">${esc(contentRaw)}</span></div>`
      : `<div class="col-content"></div>`;

    // 과거 문의(accordion 내부)는 액션 버튼 없음 — 이력 조회 전용
    const actionsHtml = isPast
      ? `<div class="col-actions"></div>`
      : `<div class="col-actions inquiry-actions">
          <button class="btn-action btn-edit">수정</button>
          <button class="btn-action btn-tm">TM</button>
          ${inq.status === 'unregistered' ? '<button class="btn-action btn-register">+등록</button>' : ''}
          ${inq.status === 'registered' ? '<button class="btn-action btn-pt">+PT</button>' : ''}
          <button class="btn-action btn-sms">문자</button>
        </div>`;

    // 등록 정보 6셀 — 미등록이면 모두 "-"
    const fmt = (n) => (Number(n) || 0).toLocaleString();
    const reg = inq.registration;
    const hasReg = reg && inq.status === 'registered';

    const regProductCell  = hasReg ? esc(reg.product || '-') : '-';
    const regPaymentCell  = hasReg
      ? `<div class="pay-total">${fmt(reg.total_payment || (reg.total_payment_cash + reg.total_payment_card))}원</div>
         <div class="pay-split">현금 ${fmt(reg.total_payment_cash)} / 카드 ${fmt(reg.total_payment_card)}</div>`
      : '-';
    const regContractCell = hasReg ? esc(reg.contract_manager || '-') : '-';
    const regManagerCell  = hasReg ? esc(reg.sales_manager || '-') : '-';
    const regSptCell      = hasReg && reg.spt_count ? `${esc(reg.spt_count)}회` : '-';
    const regTimeRaw      = hasReg ? (reg.spt_preferred_time || '') : '';
    const regTimeCell     = regTimeRaw
      ? `<span class="content-preview-inline">${esc(regTimeRaw)}</span>`
      : '-';

    row.innerHTML = `
      <div class="col-date" title="${esc(inq.inquiry_date || '')}">${esc(fmtDateShort(inq.inquiry_date))}</div>
      <div class="col-name">${esc(inq.name || '')}</div>
      <div class="col-phone">${esc(inq.phone || '')}</div>
      <div class="col-status"><span class="chip-status ${statusClass}">${statusLabel}</span></div>
      <div class="col-tag">${inq.category ? `<span class="meta-tag">${esc(inq.category)}</span>` : ''}</div>
      <div class="col-tag">${inq.consultation_type ? `<span class="meta-tag">${esc(inq.consultation_type)}</span>` : ''}</div>
      <div class="col-tag">${inq.inflow_channel ? `<span class="meta-tag">${esc(inq.inflow_channel)}</span>` : ''}</div>
      <div class="col-tag">${inq.consultation_purpose ? `<span class="meta-tag">${esc(inq.consultation_purpose)}</span>` : ''}</div>
      <div class="col-residence">${esc(inq.residence || '')}</div>
      ${contentHtml}
      ${actionsHtml}
      <div class="col-reg-product ${hasReg ? '' : 'is-empty'}">${regProductCell}</div>
      <div class="col-reg-payment ${hasReg ? '' : 'is-empty'}">${regPaymentCell}</div>
      <div class="col-reg-contract ${hasReg ? '' : 'is-empty'}">${regContractCell}</div>
      <div class="col-reg-manager ${hasReg ? '' : 'is-empty'}">${regManagerCell}</div>
      <div class="col-reg-spt ${hasReg ? '' : 'is-empty'}">${regSptCell}</div>
      <div class="col-reg-time ${hasReg ? '' : 'is-empty'}"${regTimeRaw ? ` title="${esc(regTimeRaw)}"` : ''}>${regTimeCell}</div>
    `;

    if (!isPast) {
      row.querySelector('.btn-edit').addEventListener('click', () => openInquiryForm(inq));
      row.querySelector('.btn-tm').addEventListener('click', () => openTmDrawer(inq));
      const regBtn = row.querySelector('.btn-register');
      if (regBtn) regBtn.addEventListener('click', () => openRegistrationForm(inq));
      const ptBtn = row.querySelector('.btn-pt');
      if (ptBtn) ptBtn.addEventListener('click', () => {
        if (typeof PtTab !== 'undefined') PtTab.openPtForm({ name: inq.name, phone: inq.phone });
      });
      const smsBtn = row.querySelector('.btn-sms');
      if (smsBtn) smsBtn.addEventListener('click', () => openSmsModal(inq));
    }

    // 내용 셀 클릭 → 전체 내용 펼치기 토글 (과거 문의 행에도 적용)
    const contentCell = row.querySelector('.col-content');
    if (contentCell && contentRaw) {
      contentCell.addEventListener('click', (e) => {
        // 액션 버튼 등 다른 셀 클릭은 무시
        if (e.target.closest('.col-actions')) return;
        contentCell.classList.toggle('expanded');
      });
    }

    // 희망시간 셀 클릭 → 전체 내용 펼치기 토글 (col-content 와 동일 패턴)
    const regTimeEl = row.querySelector('.col-reg-time');
    if (regTimeEl && regTimeRaw) {
      regTimeEl.addEventListener('click', () => {
        regTimeEl.classList.toggle('expanded');
      });
    }

    return row;
  }

  // ────────── 문자 발송 모달 ──────────
  // 변수 치환 컨텍스트 생성 (inq 행 기준)
  function buildSmsContext(inq) {
    const reg = inq.registration || {};
    return {
      이름: inq.name || '',
      전화번호: inq.phone || '',
      등록일: reg.registered_date || '',
      등록상품: reg.product || '',
      회수: reg.spt_count != null ? String(reg.spt_count) : '',
      잔여횟수: reg.spt_count != null ? String(reg.spt_count) : '',
      거주지: inq.residence || '',
    };
  }

  function applySmsVars(template, ctx) {
    return String(template || '').replace(/\{([^{}]+)\}/g, (m, key) => {
      const k = String(key).trim();
      return ctx[k] != null ? ctx[k] : m;  // 매칭 안 되면 원형 유지
    });
  }

  function smsByteLength(s) {
    // 한글 2byte, 영문/숫자/공백 1byte (알리고 단/장문 분기 기준 근사치)
    let n = 0;
    for (const ch of String(s)) n += ch.charCodeAt(0) > 127 ? 2 : 1;
    return n;
  }

  async function openSmsModal(inq) {
    if (!inq.phone) {
      Toast.warning('전화번호가 없는 문의입니다.');
      return;
    }

    const ctx = buildSmsContext(inq);

    // 템플릿 로드 (send_once 포함)
    const { data: templates } = await supabase
      .from('sms_templates')
      .select('id, name, msg, msg_type, title, category, send_once')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    // 이 회원 대상 발송 이력 (최근 10건)
    const { data: priorLogs } = await supabase
      .from('sms_logs')
      .select('id, template_id, sent_at, result_code, msg, sms_templates(name, send_once)')
      .eq('related_table', 'inquiries')
      .eq('related_id', inq.id)
      .order('sent_at', { ascending: false })
      .limit(10);

    // 성공 발송 + send_once 템플릿 → "이미 발송됨" 마커 Set
    const successOnceSent = new Set(
      (priorLogs || [])
        .filter(l => l.result_code > 0 && l.sms_templates?.send_once)
        .map(l => l.template_id)
    );

    const tplOptions = (templates || [])
      .map(t => {
        const sentMark = successOnceSent.has(t.id) ? ' ✓ (발송완료)' : '';
        const onceMark = t.send_once && !successOnceSent.has(t.id) ? ' ⚠ (1회 한정)' : '';
        return `<option value="${t.id}">${escHtml(t.name)}${sentMark}${onceMark}</option>`;
      })
      .join('');

    const phoneFmt = (inq.phone || '').replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');

    // 발신번호 조회 (app_secrets — authenticated SELECT 허용된 ALIGO_SENDER만)
    let senderPhoneRaw = '';
    try {
      const { data: senderRow } = await supabase
        .from('app_secrets')
        .select('value')
        .eq('key', 'ALIGO_SENDER')
        .maybeSingle();
      senderPhoneRaw = senderRow?.value || '';
    } catch (e) { /* RLS 차단 등은 무시 */ }
    const senderPhoneFmt = senderPhoneRaw
      ? senderPhoneRaw.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')
      : '미설정';
    const senderApproved = senderPhoneRaw && senderPhoneRaw !== '01000000000';

    const fmtSentAt = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };

    const priorSection = (priorLogs || []).length === 0
      ? `<div style="padding:8px 12px; background:var(--color-bg-0); border-radius:6px; font-size:12px; color:var(--color-text-muted);">이 회원 대상 발송 이력 없음</div>`
      : `<div style="padding:8px 12px; background:var(--color-bg-0); border-radius:6px; font-size:12px;">
          ${(priorLogs || []).map(l => {
            const ok = l.result_code > 0;
            const tplName = l.sms_templates?.name || '직접입력';
            const okMark = ok ? '<span style="color:var(--color-success,#10B981);">✓</span>' : '<span style="color:var(--color-danger,#DC2626);">✗</span>';
            return `<div style="margin-bottom:3px;">${okMark} ${fmtSentAt(l.sent_at)} <strong>[${escHtml(tplName)}]</strong></div>`;
          }).join('')}
        </div>`;

    Modal.open({
      type: 'center',
      title: '문자 발송',
      size: 'lg',
      html: `
        <form id="sms-send-form">
          <div class="sms-modal-grid">
            <!-- 좌측: 수신자 정보 + 발송 이력 -->
            <div class="sms-modal-col">
              <div class="form-group">
                <label>보내는 번호</label>
                <div class="sms-receiver-info" style="display:flex; align-items:center; gap:8px; ${senderApproved ? '' : 'background:#FEF3C7; border:1px solid #FCD34D;'}">
                  <span style="font-size:13px;">📱</span>
                  <strong style="font-size:14px;">${escHtml(senderPhoneFmt)}</strong>
                  ${senderApproved
                    ? '<span style="color:var(--color-success,#10B981); font-size:11px; margin-left:auto;">✓ 등록됨</span>'
                    : '<span style="color:#92400E; font-size:11px; margin-left:auto;">⚠ 발신번호 미등록 (테스트 불가)</span>'}
                </div>
              </div>

              <div class="form-group">
                <label>받는 사람</label>
                <div class="sms-receiver-info">
                  <strong>${escHtml(inq.name || '')}</strong>
                  <span style="color:var(--color-text-muted); margin-left:8px;">${escHtml(phoneFmt)}</span>
                </div>
              </div>

              <div class="form-group" style="flex:1; display:flex; flex-direction:column; min-height:0;">
                <label>📋 이 회원 발송 이력 (최근 10건)</label>
                <div style="flex:1; overflow-y:auto; min-height:0;">
                  ${priorSection}
                </div>
              </div>
            </div>

            <!-- 우측: 템플릿 + 메시지 + 미리보기 -->
            <div class="sms-modal-col">
              <div class="form-group">
                <label style="display:flex; align-items:center; justify-content:space-between;">
                  <span>템플릿 선택 (선택)</span>
                  <button type="button" id="sms-tpl-manage" class="sms-tpl-manage-btn">
                    ⚙️ 템플릿 관리
                  </button>
                </label>
                <select id="sms-template-sel" class="form-control">
                  <option value="">-- 직접 입력 --</option>
                  ${tplOptions}
                </select>
              </div>

              <div class="form-group">
                <label>메시지 <span id="sms-byte-info" style="color:var(--color-text-muted); font-weight:normal; font-size:12px;">0byte / 단문</span></label>
                <textarea name="msg" id="sms-msg-input" rows="6" required
                  placeholder="여기에 메시지를 입력하세요."
                  style="resize:vertical; font-family:inherit; font-size:14px; min-height:140px;"></textarea>
              </div>

              <div class="form-group">
                <label>미리보기</label>
                <div id="sms-preview" class="sms-preview-box"></div>
              </div>
            </div>
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary" id="sms-send-btn">발송하기</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        const tplSel = el.querySelector('#sms-template-sel');
        const msgInput = el.querySelector('#sms-msg-input');
        const preview = el.querySelector('#sms-preview');
        const byteInfo = el.querySelector('#sms-byte-info');

        // 템플릿 수정 버튼 → 모달 닫고 설정 탭의 '문자 템플릿' 으로 이동
        const tplMgrBtn = el.querySelector('#sms-tpl-manage');
        if (tplMgrBtn) {
          tplMgrBtn.addEventListener('click', () => {
            Modal.close();
            const settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
            if (settingsTabBtn) {
              settingsTabBtn.click();
              // 설정 탭이 렌더링된 후 '문자 템플릿' 카테고리 선택
              setTimeout(() => {
                const tplCat = document.querySelector('.settings-category-item[data-category="문자 템플릿"]');
                if (tplCat) tplCat.click();
              }, 150);
            }
          });
        }

        function updatePreview() {
          const raw = msgInput.value;
          const replaced = applySmsVars(raw, ctx);
          preview.textContent = replaced || '(메시지 미입력)';
          const b = smsByteLength(replaced);
          const kind = b > 90 ? `장문 (LMS)` : `단문 (SMS)`;
          byteInfo.textContent = `${b}byte / ${kind}`;
        }

        tplSel.addEventListener('change', () => {
          const tplId = tplSel.value;
          if (!tplId) return;
          const tpl = (templates || []).find(t => t.id === tplId);
          if (tpl) {
            msgInput.value = tpl.msg;
            updatePreview();
          }
        });
        msgInput.addEventListener('input', updatePreview);
        updatePreview();

        el.querySelector('#sms-send-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const sendBtn = el.querySelector('#sms-send-btn');
          const rawMsg = msgInput.value.trim();
          if (!rawMsg) { Toast.warning('메시지를 입력해주세요.'); return; }
          const finalMsg = applySmsVars(rawMsg, ctx);

          const tplId = tplSel.value;
          const tpl = tplId ? (templates || []).find(t => t.id === tplId) : null;

          // 1회 한정 템플릿 + 이미 발송 → 경고 다이얼로그
          if (tpl?.send_once && successOnceSent.has(tpl.id)) {
            const priorLog = (priorLogs || []).find(
              l => l.template_id === tpl.id && l.result_code > 0
            );
            const sentTime = priorLog ? fmtSentAt(priorLog.sent_at) : '이전';
            const proceed = confirm(
              `⚠️ 이미 발송된 1회 한정 템플릿입니다\n\n` +
              `"${tpl.name}"을(를) ${sentTime}에 이미 발송하셨습니다.\n\n` +
              `그래도 다시 발송하시겠습니까?`
            );
            if (!proceed) return;
          }

          if (!confirm(`아래 내용으로 발송하시겠습니까?\n\n받는 사람: ${inq.name} (${phoneFmt})\n${'─'.repeat(20)}\n${finalMsg}`)) return;

          sendBtn.disabled = true;
          sendBtn.textContent = '발송 중...';

          try {
            const { data: session } = await supabase.auth.getSession();
            const jwt = session?.session?.access_token;
            if (!jwt) throw new Error('로그인 세션이 없습니다');

            const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${jwt}`,
                'apikey': SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                receiver: inq.phone,
                receiver_name: inq.name,
                msg: finalMsg,
                msg_type: tpl?.msg_type && tpl.msg_type !== 'auto' ? tpl.msg_type : 'auto',
                title: tpl?.title || null,
                template_id: tpl?.id || null,
                related_table: 'inquiries',
                related_id: inq.id,
              }),
            });
            const json = await res.json();

            if (json.ok) {
              Toast.success('문자 발송 성공');
              Modal.close();
            } else {
              Toast.error('발송 실패: ' + (json.error || json.message || `HTTP ${res.status}`));
            }
          } catch (err) {
            console.error('[sms] 발송 실패:', err);
            Toast.error('발송 실패: ' + (err.message || err));
          } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '발송하기';
          }
        });
      }
    });
  }

  // ────────── 문의 추가 시 자동완성 (inquiries 테이블 — 읽기만) ──────────
  function bindInquiryAutocomplete(el) {
    const nameInput  = el.querySelector('input[name="name"]');
    const phoneInput = el.querySelector('input[name="phone"]');
    const nameBox    = el.querySelector('.resv-suggest[data-for="name"]');
    const phoneBox   = el.querySelector('.resv-suggest[data-for="phone"]');
    if (!nameInput || !phoneInput || !nameBox || !phoneBox) return;

    let timer = null;

    const renderItems = (box, items) => {
      if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = items.map(r =>
        `<div class="resv-suggest-item" data-name="${escHtml(r.name||'')}" data-phone="${escHtml(r.phone||'')}">
          <span class="s-name">${escHtml(r.name || '-')}</span>
          <span class="s-phone">${escHtml(r.phone || '')}</span>
        </div>`
      ).join('');
      box.style.display = 'block';
      box.querySelectorAll('.resv-suggest-item').forEach(it => {
        it.addEventListener('mousedown', (e) => {
          e.preventDefault();
          nameInput.value  = it.dataset.name;
          phoneInput.value = formatPhone(it.dataset.phone);
          nameBox.style.display  = 'none';
          phoneBox.style.display = 'none';
        });
      });
    };

    const fetchAndShow = async (field, rawQ, box) => {
      const col = field === 'name' ? 'name' : 'phone';
      const pattern = field === 'phone' ? rawQ.replace(/[^0-9]/g, '') : rawQ.trim();
      if (!pattern) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const { data, error } = await supabase
        .from('inquiries')
        .select('id, name, phone')
        .ilike(col, `${pattern}%`)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) return;
      const seen = new Set(), uniq = [];
      (data || []).forEach(r => {
        const key = `${r.name||''}|${r.phone||''}`;
        if (!seen.has(key)) { seen.add(key); uniq.push(r); }
      });
      renderItems(box, uniq.slice(0, 6));
    };

    const trigger = (field, input, box) => {
      if (timer) clearTimeout(timer);
      const q = input.value || '';
      if (!q.trim()) { box.style.display = 'none'; box.innerHTML = ''; return; }
      timer = setTimeout(() => fetchAndShow(field, q, box), 220);
    };

    nameInput.addEventListener('input',  () => trigger('name',  nameInput,  nameBox));
    phoneInput.addEventListener('input', () => trigger('phone', phoneInput, phoneBox));
    nameInput.addEventListener('blur',  () => setTimeout(() => { nameBox.style.display  = 'none'; }, 200));
    phoneInput.addEventListener('blur', () => setTimeout(() => { phoneBox.style.display = 'none'; }, 200));
  }

  // ────────── 문의 추가/수정 모달 ──────────
  function openInquiryForm(existing) {
    const isEdit = !!existing;

    Modal.open({
      type: 'center',
      title: isEdit ? '문의 수정' : '문의 추가',
      html: `
        <form id="inquiry-form">
          <div class="form-grid">
            <div class="form-group" style="position:relative">
              <label>이름 *</label>
              <input type="text" name="name" value="${existing?.name || ''}" autocomplete="off" required>
              ${!isEdit ? '<div class="resv-suggest" data-for="name"></div>' : ''}
            </div>
            <div class="form-group" style="position:relative">
              <label>전화번호 *</label>
              <input type="tel" name="phone" value="${existing?.phone || ''}" placeholder="010-0000-0000" autocomplete="off" required>
              ${!isEdit ? '<div class="resv-suggest" data-for="phone"></div>' : ''}
            </div>
            <div class="form-group">
              <label>문의일자</label>
              <input type="date" name="inquiry_date" value="${existing?.inquiry_date || new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="form-group">
              <label>구분</label>
              <div id="dd-category"></div>
            </div>
            <div class="form-group">
              <label>상담형식</label>
              <div id="dd-consultation-type"></div>
            </div>
            <div class="form-group">
              <label>유입경로</label>
              <div id="dd-inflow-channel"></div>
            </div>
            <div class="form-group">
              <label>상담목적</label>
              <div id="dd-consultation-purpose"></div>
            </div>
            <div class="form-group">
              <label>거주지</label>
              <div id="dd-residence"></div>
            </div>
            ${isEdit && existing?.status === 'registered' ? `
            <div class="form-group">
              <label>계약직원</label>
              <div id="dd-inq-contract-manager"></div>
            </div>
            <div class="form-group">
              <label>매출담당직원</label>
              <div id="dd-inq-sales-manager"></div>
            </div>
            <div class="form-group">
              <label>현금/계좌</label>
              <input type="number" name="total_payment_cash" value="${existing?.registration?.total_payment_cash ?? 0}" min="0">
            </div>
            <div class="form-group">
              <label>카드</label>
              <input type="number" name="total_payment_card" value="${existing?.registration?.total_payment_card ?? 0}" min="0">
            </div>
            <div class="form-group full">
              <label>총결제액 (원) — 수정 시 카드 자동 조정</label>
              <input type="number" id="inq-edit-total-payment" value="${(existing?.registration?.total_payment_cash ?? 0) + (existing?.registration?.total_payment_card ?? 0)}" min="0">
            </div>` : ''}
            <!-- v25: 미등록자 수정 모드에선 담당자 필드 숨김 (입력해도 저장 불가였던 유실 이슈 해결). 등록 시 [+등록] 모달에서 입력. -->
            <div class="form-group full">
              <label>상담내용</label>
              <textarea name="content" placeholder="상담 내용을 자유롭게 입력하세요">${existing?.content || ''}</textarea>
            </div>
          </div>

          <!-- v7: 등록 여부 토글 + 조건부 결제 섹션 -->
          ${!isEdit ? `
          <label class="reg-toggle-row">
            <span class="reg-toggle-text">
              <strong>회원권 등록 동시 진행</strong>
              <small>체크 시 등록상품/결제액 입력칸이 열립니다</small>
            </span>
            <span class="ios-switch">
              <input type="checkbox" id="inq-is-registered" name="is_registered">
              <span class="ios-switch-track"></span>
            </span>
          </label>
          <div id="inq-reg-section" style="display:none; border:1px solid var(--color-border); border-radius:8px; padding:16px; margin-bottom:12px;">
            <h4 style="margin:0 0 12px; font-size:14px;">회원권 등록 정보</h4>
            <div class="form-grid">
              <div class="form-group">
                <label>등록상품 *</label>
                <div id="dd-inq-reg-product"></div>
              </div>
              <div class="form-group">
                <label>등록일자</label>
                <input type="date" name="registered_date" value="${new Date().toISOString().slice(0, 10)}">
              </div>
              <div class="form-group">
                <label>계약직원</label>
                <div id="dd-inq-reg-contract-manager"></div>
              </div>
              <div class="form-group">
                <label>매출담당직원</label>
                <div id="dd-inq-reg-sales-manager"></div>
              </div>
              <div class="form-group">
                <label>현금/계좌</label>
                <input type="number" name="total_payment_cash" value="0" min="0">
              </div>
              <div class="form-group">
                <label>카드</label>
                <input type="number" name="total_payment_card" value="0" min="0">
              </div>
              <div class="form-group full">
                <label>총결제액 (원) — 수정 시 카드 자동 조정</label>
                <input type="number" id="inq-total-payment" value="0" min="0" placeholder="총액 입력 시 카드가 총액-현금으로 자동 세팅">
              </div>
              <div class="form-group">
                <label>SPT 횟수</label>
                <input type="number" name="spt_count" min="0" placeholder="0">
              </div>
              <div class="form-group full">
                <label>SPT 희망 시간대</label>
                <input type="text" name="spt_preferred_time" placeholder="예: 오후 2시~4시">
              </div>
            </div>
          </div>
          ` : ''}
          ${isEdit && existing?.status !== 'registered' ? `
          <p style="font-size:11px; color:var(--color-text-muted); margin-top:-8px; margin-bottom:12px;">
            * 담당자 정보는 회원권 등록 시([+등록] 버튼) 함께 저장됩니다. 미등록 문의에는 반영되지 않습니다.
          </p>` : ''}
          <div class="form-actions${isEdit ? ' spt-edit-actions' : ''}">
            ${isEdit ? '<button type="button" class="btn btn-danger inquiry-delete-btn">문의 삭제</button>' : ''}
            <div${isEdit ? ' class="spt-edit-actions-right"' : ''}>
              <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
              <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '저장'}</button>
            </div>
          </div>
        </form>
      `,
      onOpen: (el) => {
        // 전화번호 자동 포맷
        bindPhoneFormat(el.querySelector('input[name="phone"]'));

        // 수정 모드: 삭제 버튼 바인딩 (SPT와 동일 패턴)
        if (isEdit) {
          const delBtn = el.querySelector('.inquiry-delete-btn');
          if (delBtn) delBtn.addEventListener('click', () => deleteInquiry(existing));
        }

        // 신규 추가 모드: 이름/전화번호 자동완성 (inquiries 테이블 기존 기록 검색)
        if (!isEdit) bindInquiryAutocomplete(el);

        // 드롭다운 생성
        Dropdown.create({ container: el.querySelector('#dd-category'), category: '구분', name: 'category', value: existing?.category || '' });
        Dropdown.create({ container: el.querySelector('#dd-consultation-type'), category: '상담형식', name: 'consultation_type', value: existing?.consultation_type || '' });
        Dropdown.create({ container: el.querySelector('#dd-inflow-channel'), category: '유입경로', name: 'inflow_channel', value: existing?.inflow_channel || '' });
        Dropdown.create({ container: el.querySelector('#dd-consultation-purpose'), category: '상담목적', name: 'consultation_purpose', value: existing?.consultation_purpose || '' });
        Dropdown.create({ container: el.querySelector('#dd-residence'), category: '거주지', name: 'residence', value: existing?.residence || '' });
        // v25: 담당자 드롭다운은 "수정+등록자" 모드에만 초기화 (미등록자는 필드 자체 없음)
        if (isEdit && existing?.status === 'registered') {
          Dropdown.create({ container: el.querySelector('#dd-inq-contract-manager'), category: '매출담당자', name: 'contract_manager', value: existing?.registration?.contract_manager || '' });
          Dropdown.create({ container: el.querySelector('#dd-inq-sales-manager'), category: '매출담당자', name: 'sales_manager', value: existing?.registration?.sales_manager || '' });

          // 결제액: cash/card 변경 → 총액 재계산, 총액 변경 → 카드 자동 조정
          // total_payment는 DB GENERATED 컬럼이라 cash/card만 저장하면 자동 합산됨
          const editCashInput = el.querySelector('input[name="total_payment_cash"]');
          const editCardInput = el.querySelector('input[name="total_payment_card"]');
          const editTotalEl = el.querySelector('#inq-edit-total-payment');
          const editSyncTotalFromParts = () => {
            editTotalEl.value = (parseInt(editCashInput.value) || 0) + (parseInt(editCardInput.value) || 0);
          };
          editCashInput.addEventListener('input', editSyncTotalFromParts);
          editCardInput.addEventListener('input', editSyncTotalFromParts);
          editTotalEl.addEventListener('input', () => {
            const total = parseInt(editTotalEl.value) || 0;
            const cash = parseInt(editCashInput.value) || 0;
            if (total >= cash) {
              editCardInput.value = total - cash;
            } else {
              editCashInput.value = total;
              editCardInput.value = 0;
            }
          });
        }

        // v7: 신규 문의일 때만 등록 토글 + 결제 섹션 (매출담당도 여기에 포함)
        if (!isEdit) {
          const regToggle = el.querySelector('#inq-is-registered');
          const regSection = el.querySelector('#inq-reg-section');
          const productContainer = el.querySelector('#dd-inq-reg-product');
          const regContractContainer = el.querySelector('#dd-inq-reg-contract-manager');
          const regSalesContainer = el.querySelector('#dd-inq-reg-sales-manager');
          let regDropdownsCreated = false;

          regToggle.addEventListener('change', () => {
            regSection.style.display = regToggle.checked ? '' : 'none';
            if (regToggle.checked && !regDropdownsCreated) {
              Dropdown.create({ container: productContainer, category: '회원권상품', name: 'reg_product', value: '' });
              Dropdown.create({ container: regContractContainer, category: '매출담당자', name: 'reg_contract_manager', value: '' });
              Dropdown.create({ container: regSalesContainer, category: '매출담당자', name: 'reg_sales_manager', value: '' });
              regDropdownsCreated = true;
            }
          });

          const cashInput = el.querySelector('input[name="total_payment_cash"]');
          const cardInput = el.querySelector('input[name="total_payment_card"]');
          const totalEl = el.querySelector('#inq-total-payment');
          // cash/card 변경 → 총액 재계산 (DB는 generated 컬럼이라 어차피 서버에서 cash+card로 저장)
          const syncTotalFromParts = () => {
            totalEl.value = (parseInt(cashInput.value) || 0) + (parseInt(cardInput.value) || 0);
          };
          cashInput.addEventListener('input', syncTotalFromParts);
          cardInput.addEventListener('input', syncTotalFromParts);
          // 총액 직접 수정 → 카드 자동 조정 (total - cash). 음수면 cash를 total로 낮추고 card=0.
          totalEl.addEventListener('input', () => {
            const total = parseInt(totalEl.value) || 0;
            const cash = parseInt(cashInput.value) || 0;
            if (total >= cash) {
              cardInput.value = total - cash;
            } else {
              cashInput.value = total;
              cardInput.value = 0;
            }
          });
        }

        // 폼 제출
        el.querySelector('#inquiry-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await saveInquiry(e.target, existing);
        });
      }
    });
  }

  async function saveInquiry(form, existing) {
    const fd = new FormData(form);
    const isRegistered = !existing && fd.get('is_registered') === 'on';
    const payload = {
      name: fd.get('name')?.trim(),
      phone: fd.get('phone')?.trim(),
      inquiry_date: fd.get('inquiry_date'),
      category: fd.get('category') || null,
      consultation_type: fd.get('consultation_type') || null,
      inflow_channel: fd.get('inflow_channel') || null,
      consultation_purpose: fd.get('consultation_purpose') || null,
      residence: fd.get('residence') || null,
      content: fd.get('content')?.trim() || null,
    };
    // v7: 등록 동시 진행이면 status='registered' 로 INSERT
    if (isRegistered) payload.status = 'registered';

    if (!payload.name || !payload.phone) {
      Toast.warning('이름과 전화번호는 필수입니다.');
      return;
    }

    // v7: 등록 동시 진행 시 등록상품 필수 검증
    const regProduct = fd.get('reg_product')?.trim() || null;
    if (isRegistered && !regProduct) {
      Toast.warning('등록상품을 선택해주세요.');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    let error, newInquiryId = null;
    if (existing) {
      ({ error } = await supabase.from('inquiries').update(payload).eq('id', existing.id));
    } else {
      const { data, error: insErr } = await supabase.from('inquiries').insert(payload).select('id').single();
      error = insErr;
      newInquiryId = data?.id;
    }

    if (error) {
      Toast.error('저장 실패: ' + error.message);
      submitBtn.disabled = false;
      return;
    }

    // v7: 등록 동시 진행이면 registrations INSERT
    if (isRegistered && newInquiryId) {
      // SPT 횟수: 빈 값 / 비숫자는 null. 0 허용.
      const sptCountRaw = fd.get('spt_count');
      const sptCount = (sptCountRaw === '' || sptCountRaw == null)
        ? null
        : (Number.isFinite(parseInt(sptCountRaw)) ? parseInt(sptCountRaw) : null);
      const sptTime = fd.get('spt_preferred_time')?.trim() || null;

      const regPayload = {
        inquiry_id: newInquiryId,
        registered_date: fd.get('registered_date') || new Date().toISOString().slice(0, 10),
        product: regProduct,
        total_payment_cash: parseInt(fd.get('total_payment_cash')) || 0,
        total_payment_card: parseInt(fd.get('total_payment_card')) || 0,
        // total_payment은 DB GENERATED 컬럼이라 payload에 포함 금지
        // v7.1: 추가 모드에서는 등록 섹션의 reg_contract_manager / reg_sales_manager 사용
        contract_manager: fd.get('reg_contract_manager')?.trim() || null,
        sales_manager: fd.get('reg_sales_manager')?.trim() || null,
        // v26: SPT 필드 누락 fix — 문의추가+등록 동시진행 시 spt_count/spt_preferred_time 저장
        spt_count: sptCount,
        spt_preferred_time: sptTime,
      };
      const { error: regError } = await supabase.from('registrations').insert(regPayload);
      if (regError) {
        Toast.warning('문의는 저장됐으나 등록 실패: ' + regError.message);
        Modal.close();
        await loadInquiries();
        return;
      }
      Toast.success('문의 + 회원권 등록 완료');
      Modal.close();
      await loadInquiries();
      return;
    }

    // v6.1 / 수정+등록자 모드: 담당자 + 결제액 필드 함께 UPDATE
    const contractManager = fd.get('contract_manager')?.trim() || null;
    const salesManager = fd.get('sales_manager')?.trim() || null;

    if (existing && existing.status === 'registered' && existing.registration) {
      const regUpdate = {};
      if (contractManager !== null) regUpdate.contract_manager = contractManager;
      if (salesManager !== null) regUpdate.sales_manager = salesManager;

      // 결제액 cash/card만 UPDATE (total_payment은 DB GENERATED 컬럼 — 저장 금지)
      if (fd.has('total_payment_cash')) {
        const cashVal = parseInt(fd.get('total_payment_cash'));
        if (Number.isFinite(cashVal)) regUpdate.total_payment_cash = cashVal;
      }
      if (fd.has('total_payment_card')) {
        const cardVal = parseInt(fd.get('total_payment_card'));
        if (Number.isFinite(cardVal)) regUpdate.total_payment_card = cardVal;
      }

      if (Object.keys(regUpdate).length > 0) {
        const { error: regErr } = await supabase
          .from('registrations')
          .update(regUpdate)
          .eq('inquiry_id', existing.id);
        if (regErr) {
          Toast.warning('문의는 저장됐지만 등록 정보 갱신 실패: ' + regErr.message);
        }
      }
    }
    // v25: 미등록자 수정 모드에선 담당자 필드가 UI에서 제거됨 → Toast.info 분기 불필요

    Toast.success(existing ? '문의가 수정되었습니다.' : '문의가 추가되었습니다.');
    Modal.close();
    await loadInquiries();
  }

  // ────────── 회원권 등록 모달 ──────────
  function openRegistrationForm(inquiry) {
    Modal.open({
      type: 'center',
      title: '회원권 등록',
      html: `
        <form id="registration-form">
          <div style="margin-bottom: 16px; padding: 12px; background: var(--color-primary-bg); border-radius: var(--radius-xs);">
            <strong>${inquiry.name}</strong> <span style="color: var(--color-text-secondary)">${inquiry.phone}</span>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>등록일자</label>
              <input type="date" name="registered_date" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="form-group">
              <label>등록상품 *</label>
              <div id="dd-reg-product"></div>
            </div>
            <div class="form-group">
              <label>현금/계좌</label>
              <input type="number" name="total_payment_cash" value="0" min="0">
            </div>
            <div class="form-group">
              <label>카드</label>
              <input type="number" name="total_payment_card" value="0" min="0">
            </div>
            <div class="form-group full">
              <label>총결제액 (원) — 수정 시 카드 자동 조정</label>
              <input type="number" id="reg-total-payment" value="0" min="0" placeholder="총액 입력 시 카드가 총액-현금으로 자동 세팅">
            </div>
            <div class="form-group">
              <label>계약직원</label>
              <div id="dd-reg-contract-manager"></div>
            </div>
            <div class="form-group">
              <label>매출담당직원</label>
              <div id="dd-reg-sales-manager"></div>
            </div>
            <div class="form-group">
              <label>SPT 횟수</label>
              <input type="number" name="spt_count" min="0" placeholder="0">
            </div>
            <div class="form-group full">
              <label>SPT 희망 시간대</label>
              <input type="text" name="spt_preferred_time" placeholder="예: 오후 2시~4시">
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">등록</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        // 드롭다운: 등록상품(회원권상품), 계약직원/매출담당직원 (Q1-A: 같은 '매출담당자' 카테고리 공유)
        Dropdown.create({ container: el.querySelector('#dd-reg-product'), category: '회원권상품', name: 'product', value: '' });
        Dropdown.create({ container: el.querySelector('#dd-reg-contract-manager'), category: '매출담당자', name: 'contract_manager', value: '' });
        Dropdown.create({ container: el.querySelector('#dd-reg-sales-manager'), category: '매출담당자', name: 'sales_manager', value: '' });

        // 결제액: cash/card → 총액 자동 합산, 총액 → 카드 자동 조정 (DB GENERATED 컬럼 대응)
        const cashInput = el.querySelector('input[name="total_payment_cash"]');
        const cardInput = el.querySelector('input[name="total_payment_card"]');
        const totalEl = el.querySelector('#reg-total-payment');
        const syncTotalFromParts = () => {
          totalEl.value = (parseInt(cashInput.value) || 0) + (parseInt(cardInput.value) || 0);
        };
        cashInput.addEventListener('input', syncTotalFromParts);
        cardInput.addEventListener('input', syncTotalFromParts);
        totalEl.addEventListener('input', () => {
          const total = parseInt(totalEl.value) || 0;
          const cash = parseInt(cashInput.value) || 0;
          if (total >= cash) {
            cardInput.value = total - cash;
          } else {
            cashInput.value = total;
            cardInput.value = 0;
          }
        });

        el.querySelector('#registration-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await saveRegistration(e.target, inquiry);
        });
      }
    });
  }

  async function saveRegistration(form, inquiry) {
    const fd = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const payload = {
      inquiry_id: inquiry.id,
      registered_date: fd.get('registered_date'),
      product: fd.get('product')?.trim(),
      total_payment_cash: (() => { const v = fd.get('total_payment_cash'); return v === '' || v == null ? 0 : (parseInt(v) || 0); })(),
      total_payment_card: (() => { const v = fd.get('total_payment_card'); return v === '' || v == null ? 0 : (parseInt(v) || 0); })(),
      // total_payment은 DB GENERATED 컬럼이라 payload에 포함 금지 (cash+card 자동 계산)
      contract_manager: fd.get('contract_manager')?.trim() || null,  // v6: 계약직원
      sales_manager: fd.get('sales_manager')?.trim() || null,        // v6: 매출담당직원
      // v25: 빈 값이면 null, '0'이면 0 유지 (의도적 0회 입력 보존)
      spt_count: (() => { const v = fd.get('spt_count'); return v === '' || v == null ? null : (Number.isFinite(parseInt(v)) ? parseInt(v) : null); })(),
      spt_preferred_time: fd.get('spt_preferred_time')?.trim() || null,
    };

    if (!payload.product) {
      Toast.warning('등록상품은 필수입니다.');
      submitBtn.disabled = false;
      return;
    }

    // v25: RPC 단일 트랜잭션 — registrations INSERT + inquiries.status UPDATE 원자성 보장
    const { data, error } = await supabase.rpc('register_inquiry', {
      p_inquiry_id: inquiry.id,
      p_registered_date: payload.registered_date,
      p_product: payload.product,
      p_total_payment_cash: payload.total_payment_cash,
      p_total_payment_card: payload.total_payment_card,
      p_contract_manager: payload.contract_manager,
      p_sales_manager: payload.sales_manager,
      p_spt_count: payload.spt_count,
      p_spt_preferred_time: payload.spt_preferred_time,
    });

    if (error || !data?.ok) {
      const code = data?.code;
      const msg = data?.error || error?.message || '알 수 없는 오류';
      if (code === 'DUPLICATE') {
        Toast.error('이 문의에 이미 등록이 존재합니다.');
      } else {
        Toast.error('등록 실패: ' + msg);
      }
      submitBtn.disabled = false;
      return;
    }

    // total_payment은 DB GENERATED 컬럼이라 override 불가 — cash/card가 이미 RPC로 저장됐으므로 자동 합산됨
    Toast.success('회원권 등록 완료');
    Modal.close();
    await loadInquiries();
  }

  // ────────── 문의 삭제 (cascade) ──────────
  // RPC admin_delete_inquiry_cascade: pt_registrations → registrations → inquiries 순 삭제 (트랜잭션)
  // tm_logs는 FK CASCADE로 자동 삭제
  async function deleteInquiry(inq) {
    const hasReg = inq.registration && inq.status === 'registered';
    const warn = hasReg
      ? `[경고] 이 문의에는 회원권 등록 정보가 있습니다.\n\n- 문의\n- 등록(결제) 내역\n- 이 등록에 딸린 PT 레코드\n- TM 로그\n\n위 항목이 모두 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.\n\n정말 삭제하시겠습니까? (${inq.name || ''})`
      : `[확인] 이 문의를 삭제합니다.\n\n- 문의\n- TM 로그\n\n이 작업은 되돌릴 수 없습니다.\n\n정말 삭제하시겠습니까? (${inq.name || ''})`;

    if (!confirm(warn)) return;

    // 한 번 더 확인 (등록된 문의에 한해)
    if (hasReg) {
      const name = inq.name || '';
      const typed = prompt(`최종 확인: 삭제를 진행하려면 회원 이름 "${name}"을 정확히 입력하세요.`);
      if (typed !== name) {
        Toast.info('이름이 일치하지 않아 취소되었습니다.');
        return;
      }
    }

    const { data, error } = await supabase.rpc('admin_delete_inquiry_cascade', {
      p_inquiry_id: inq.id
    });
    if (error) {
      Toast.error('삭제 실패: ' + error.message);
      return;
    }
    if (!data || data.ok !== true) {
      const msg = data?.error || 'unknown';
      Toast.error('삭제 실패: ' + msg);
      return;
    }
    const ptDel = data.pt_deleted || 0;
    Toast.success(
      data.had_registration
        ? `문의 삭제됨 (등록 정보${ptDel ? ` + PT ${ptDel}건` : ''} 함께 삭제)`
        : '문의 삭제됨'
    );
    Modal.close();
    await loadInquiries();
  }

  // ────────── TM 드로어 ──────────
  function openTmDrawer(inquiry) {
    Modal.open({
      type: 'drawer',
      title: `TM 내용 — ${inquiry.name}`,
      html: `
        <div id="tm-log-list"><div class="loading-center"><div class="spinner"></div></div></div>
        <div class="tm-add-form">
          <textarea id="tm-new-content" placeholder="TM 내용 입력..."></textarea>
          <button class="btn btn-primary" id="btn-tm-add" style="align-self: flex-end; height: 40px;">추가</button>
        </div>
      `,
      onOpen: async (el) => {
        await loadTmLogs(inquiry.id, el);

        el.querySelector('#btn-tm-add').addEventListener('click', async () => {
          const textarea = el.querySelector('#tm-new-content');
          const content = textarea.value.trim();
          if (!content) { Toast.warning('TM 내용을 입력해주세요.'); return; }

          const { error } = await supabase.from('tm_logs').insert({
            inquiry_id: inquiry.id,
            tm_date: new Date().toISOString().slice(0, 10),
            tm_content: content,
          });

          if (error) { Toast.error('TM 저장 실패: ' + error.message); return; }

          textarea.value = '';
          Toast.success('TM 기록 추가됨');
          await loadTmLogs(inquiry.id, el);
        });
      }
    });
  }

  async function loadTmLogs(inquiryId, modalEl) {
    const listEl = modalEl.querySelector('#tm-log-list');

    const { data, error } = await supabase
      .from('tm_logs')
      .select('*')
      .eq('inquiry_id', inquiryId)
      .order('tm_date', { ascending: true })
      .order('created_at', { ascending: true })
      .order('sequence_no', { ascending: true });   // BIGSERIAL 보조키 — 동일 timestamp에서도 삽입 순서 보장

    if (error) {
      listEl.innerHTML = '<div class="empty-state">TM 기록 로드 실패</div>';
      return;
    }

    if (!data || data.length === 0) {
      listEl.innerHTML = '<div class="empty-state">TM 기록이 없습니다.</div>';
      return;
    }

    // v25: XSS 방어 — tm_date/tm_content 이스케이프 후 주입
    listEl.innerHTML = data.map(log => `
      <div class="tm-log-item">
        <div class="tm-date">${escHtml(log.tm_date)}</div>
        <div class="tm-content">${escHtml(log.tm_content)}</div>
      </div>
    `).join('');
  }

  return { init };
})();
