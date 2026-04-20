/**
 * PT등록회원 탭
 * - PT등록 리스트 (sync_status 표시)
 * - [+PT등록] 모달 (회원 검색 → 폼 → INSERT → RPC 동기화)
 * - 미동기화/실패 배지 + 수동 재시도
 */
const PtTab = (() => {
  let allPtRegs = [];
  let trainers = [];

  async function init() {
    await loadTrainers();
    renderToolbar();
    await loadPtRegistrations();
  }

  async function loadTrainers() {
    // v10: role='admin' (admin/veragym 로그인 계정)은 매출담당 드롭다운에서 제외
    const { data } = await supabase
      .from('trainers')
      .select('id, name')
      .neq('role', 'admin')
      .order('name');
    trainers = data || [];
  }

  function renderToolbar() {
    const pane = document.getElementById('tab-pt');
    // v7: 문의관리 탭과 동일한 표준 툴바 구조 (search-box + toolbar-actions)
    pane.innerHTML = `
      <div class="inquiry-toolbar">
        <input type="text" class="search-box" placeholder="이름 또는 번호 검색...">
        <div class="inquiry-toolbar-actions">
          <span id="pt-sync-badge"></span>
          <button class="btn btn-secondary btn-chip-sized" id="btn-pt-excel-export">엑셀 내보내기</button>
          <button class="btn btn-secondary btn-chip-sized" id="btn-pt-excel-import">엑셀 업로드</button>
          <button class="btn btn-primary btn-chip-sized" id="btn-add-pt">+ PT등록</button>
        </div>
      </div>
      <div id="pt-list"></div>
    `;

    pane.querySelector('.search-box').addEventListener('input',
      debounce(e => renderList(e.target.value.trim()), 300)
    );
    pane.querySelector('#btn-add-pt').addEventListener('click', () => openPtForm());
    pane.querySelector('#btn-pt-excel-export').addEventListener('click', () => {
      if (typeof ExcelImport !== 'undefined') ExcelImport.openExport();
    });
    pane.querySelector('#btn-pt-excel-import').addEventListener('click', () => {
      if (typeof ExcelImport !== 'undefined') ExcelImport.open();
    });
  }

  async function loadPtRegistrations() {
    const listEl = document.getElementById('pt-list');
    listEl.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

    const { data, error } = await supabase
      .from('pt_registrations')
      .select('*, contract_trainer:trainers!pt_registrations_contract_trainer_id_fkey(name), assigned_trainer:trainers!pt_registrations_assigned_trainer_id_fkey(name)')
      .order('contract_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) {
      Toast.error('PT등록 로드 실패: ' + error.message);
      listEl.innerHTML = '<div class="empty-state">데이터를 불러올 수 없습니다.</div>';
      return;
    }

    allPtRegs = data || [];
    renderList('');
    renderSyncBadge();
  }

  function renderSyncBadge() {
    const badge = document.getElementById('pt-sync-badge');
    const pending = allPtRegs.filter(r => r.sync_status === 'pending').length;
    const failed = allPtRegs.filter(r => r.sync_status === 'failed').length;

    let html = '';
    if (failed > 0) {
      html += `<span class="sync-badge failed" id="btn-show-failed">동기화 실패 ${failed}건</span>`;
    }
    if (pending > 0) {
      html += `<span class="sync-badge pending">대기 ${pending}건</span>`;
    }
    badge.innerHTML = html;

    const failedBtn = badge.querySelector('#btn-show-failed');
    if (failedBtn) {
      failedBtn.style.cursor = 'pointer';
      failedBtn.addEventListener('click', () => openFailedPanel());
    }
  }

  function renderList(query) {
    const listEl = document.getElementById('pt-list');

    let filtered = allPtRegs;
    if (query) {
      const q = query.toLowerCase();
      filtered = allPtRegs.filter(r =>
        r.name.toLowerCase().includes(q) || r.phone.includes(q)
      );
    }

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-state">PT등록 내역이 없습니다.</div>';
      return;
    }

    // HTML escape 유틸
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const rowsHtml = filtered.map(r => {
      const syncClass = r.sync_status === 'synced' ? 'success'
                      : r.sync_status === 'failed' ? 'danger'
                      : r.sync_status === 'disabled' ? 'muted'
                      : 'warning';
      const syncLabel = r.sync_status === 'synced' ? '동기화 완료'
                      : r.sync_status === 'failed' ? '동기화 실패'
                      : r.sync_status === 'disabled' ? '미연동'
                      : '대기중';
      const contractTrainer = r.contract_trainer?.name || '-';
      const assignedTrainer = r.assigned_trainer?.name || '-';
      // v7: 리스트 총결제액은 contract_amount (세션단가 × 횟수 = 트레이너 매출 귀속).
      //      total_payment (VAT 포함) 은 총결제 영수증 용도. 운영 화면은 계약금액 기준.
      const amount = (r.contract_amount || 0).toLocaleString();
      // v10: 총결제금액 = 현금 + 카드 (DB 저장 실결제액 합계)
      const totalPayment = ((r.total_payment_cash || 0) + (r.total_payment_card || 0)).toLocaleString();
      const errorTooltip = r.sync_error ? ` title="${esc(r.sync_error)}"` : '';

      // v11: 이름 표기 통일 — 이름 끝이 이미 4자리 숫자면 그대로, 아니면 phone 뒷4 붙임
      const phoneTail4 = r.phone ? String(r.phone).replace(/\D/g, '').slice(-4) : '';
      const nameHasTail = /\d{4}$/.test(r.name || '');
      const nameLabel = (nameHasTail || !phoneTail4) ? (r.name || '') : `${r.name}${phoneTail4}`;

      return `
        <div class="inquiry-card pt-row">
          <div class="inquiry-card-main">
            <div class="col-date">${esc(r.contract_date || '')}</div>
            <div class="col-name">${esc(nameLabel)}</div>
            <div class="col-phone">${esc(r.phone)}</div>
            <div class="col-pt-count">${esc(r.pt_count)}회</div>
            <div class="col-amount">${amount}원</div>
            <div class="col-payment">${totalPayment}원</div>
            <div class="col-trainer">${esc(contractTrainer)}</div>
            <div class="col-trainer">${esc(assignedTrainer)}</div>
            <div class="col-actions inquiry-actions"${errorTooltip}>
              <button class="btn-action btn-retry" data-id="${r.id}">동기화</button>
              <button class="btn-action btn-edit" data-id="${r.id}">수정</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = `
      <div class="pt-table-header">
        <div>날짜</div>
        <div>이름</div>
        <div>전화번호</div>
        <div>횟수</div>
        <div>계약금액</div>
        <div>총결제금액</div>
        <div>계약T</div>
        <div>담당T</div>
        <div>액션</div>
      </div>
      <div class="pt-list-body">${rowsHtml}</div>
    `;

    // 재시도 버튼 바인딩
    listEl.querySelectorAll('.btn-retry').forEach(btn => {
      btn.addEventListener('click', () => retrySync(btn.dataset.id));
    });

    // v8: 수정 버튼 바인딩 — 해당 행 레코드를 edit 모드로 openPtForm 호출
    listEl.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = allPtRegs.find(r => r.id === btn.dataset.id);
        if (rec) openPtForm(null, rec);
      });
    });
  }

  async function retrySync(ptRegId) {
    Toast.info('동기화 시도 중...');

    const { data, error } = await supabase.rpc('pt_registration_force_retry', {
      p_pt_reg_id: ptRegId
    });

    if (error) {
      Toast.error('재시도 실패: ' + error.message);
      return;
    }

    // v12: 이미 동기화 / 중복 / 신규 성공 / 실패 4가지 분기
    if (data?.ok && data?.duplicate === true) {
      Toast.warning(data.note || 'VeraGym 에 이미 등록된 PT 입니다. 동기화를 생략했습니다.');
    } else if (data?.ok && data?.already === true) {
      Toast.info(data.note || '이미 동기화된 PT 등록입니다.');
    } else if (data?.ok) {
      Toast.success('동기화 성공');
    } else {
      Toast.warning('동기화 실패: ' + (data?.error || '알 수 없는 오류'));
    }

    await loadPtRegistrations();
  }

  // ────────── 실패 건 전용 패널 ──────────
  function openFailedPanel() {
    const failed = allPtRegs.filter(r => r.sync_status === 'failed');

    Modal.open({
      type: 'drawer',
      title: `동기화 실패 (${failed.length}건)`,
      html: failed.length === 0
        ? '<div class="empty-state">실패 건이 없습니다.</div>'
        : `
          <div style="margin-bottom:12px; font-size:13px; color:var(--color-text-secondary);">
            각 건의 [재시도] 버튼을 눌러 수동으로 동기화를 시도할 수 있습니다.
          </div>
          ${failed.map(r => `
            <div class="inquiry-card" style="margin-bottom:8px;">
              <div class="inquiry-card-main">
                <div class="inquiry-info">
                  <div class="name-phone">
                    <span>${r.name}</span>
                    <span class="phone">${r.phone}</span>
                  </div>
                  <div class="date">시도 ${r.sync_attempts}회 · ${r.sync_error || ''}</div>
                </div>
                <div class="inquiry-actions">
                  <button class="btn-action btn-retry-modal" data-id="${r.id}">재시도</button>
                </div>
              </div>
            </div>
          `).join('')}
        `,
      onOpen: (el) => {
        el.querySelectorAll('.btn-retry-modal').forEach(btn => {
          btn.addEventListener('click', async () => {
            await retrySync(btn.dataset.id);
            Modal.close();
          });
        });
      }
    });
  }

  // ────────── PT등록/수정 모달 ──────────
  // v8: editRecord 전달 시 수정 모드 — 회원 선택 UI 숨기고 기존값 prefill, UPDATE 경로 실행
  async function openPtForm(prefill, editRecord) {
    const isEdit = !!editRecord;

    // 외부 탭에서 호출되어 init()이 실행되지 않았을 경우 trainers 목록 먼저 로드
    if (trainers.length === 0) {
      await loadTrainers();
    }

    // 수정 모드 초기값 (숫자 필드는 빈 값 허용)
    const initCount = isEdit ? (editRecord.pt_count ?? '') : '';
    const initPrice = isEdit ? (editRecord.session_price ?? '') : '';
    const initCash  = isEdit ? (editRecord.total_payment_cash ?? '') : '';
    const initCard  = isEdit ? (editRecord.total_payment_card ?? '') : '';
    const initContract = isEdit ? Number(editRecord.contract_amount || 0) : 0;
    const initTotalPay = isEdit ? Math.round(initContract * 1.1) : 0;
    // v11: 수정 모달 회원 표기도 동일 규칙 — 끝이 4자리 숫자면 그대로, 아니면 phone 뒷4 붙임
    const editTail = isEdit && editRecord.phone ? String(editRecord.phone).replace(/\D/g, '').slice(-4) : '';
    const editHasTail = isEdit && /\d{4}$/.test(editRecord.name || '');
    const memberLabel = isEdit
      ? ((editHasTail || !editTail) ? (editRecord.name || '') : `${editRecord.name}${editTail}`)
      : '';

    Modal.open({
      type: 'center',
      title: isEdit ? 'PT 수정' : 'PT 등록',
      size: 'lg',
      html: `
        <form id="pt-form">
          ${isEdit ? `
            <!-- 수정 모드: 회원 고정 표시 -->
            <div class="form-group full" style="margin-bottom:16px;">
              <label>회원</label>
              <div class="pt-selected-member" style="display:flex;">
                <span>${memberLabel}</span>
              </div>
            </div>
          ` : `
            <!-- 회원 검색 -->
            <div class="form-group full" style="margin-bottom:16px; position:relative;">
              <label>회원 선택</label>
              <input type="text" id="pt-member-search" placeholder="이름 또는 번호로 검색..." autocomplete="off"
                value="${prefill ? prefill.name + ' ' + prefill.phone : ''}">
              <div id="pt-search-results" class="pt-search-results"></div>
              <input type="hidden" name="selected_name" value="${prefill?.name || ''}">
              <input type="hidden" name="selected_phone" value="${prefill?.phone || ''}">
            </div>

            <!-- 선택된 회원 표시 -->
            <div id="pt-selected-member" class="pt-selected-member" style="${prefill ? '' : 'display:none'}">
              <span id="pt-selected-label">${prefill ? prefill.name + ' ' + prefill.phone : ''}</span>
              <button type="button" id="pt-clear-member" class="btn-action" style="font-size:11px;">변경</button>
            </div>
          `}

          <div class="form-grid" style="margin-top:16px;">
            <div class="form-group">
              <label>횟수 *</label>
              <input type="number" name="pt_count" min="1" placeholder="예: 30" value="${initCount}" required>
            </div>
            <div class="form-group">
              <label>세션 단가 *</label>
              <input type="number" name="session_price" min="0" placeholder="예: 50000" value="${initPrice}" required>
            </div>
            <div class="form-group">
              <label>계약금액 (자동)</label>
              <input type="text" id="pt-contract-amount" readonly disabled value="${initContract.toLocaleString()}원" style="background:var(--color-bg-2); font-weight:600;">
            </div>
            <div class="form-group">
              <label>총결제액 (VAT 10%, 자동)</label>
              <input type="text" id="pt-total-payment" readonly disabled value="${initTotalPay.toLocaleString()}원" style="background:var(--color-bg-2); font-weight:600;">
            </div>
            <div class="form-group">
              <label>현금/계좌</label>
              <input type="number" name="total_payment_cash" id="pt-cash" min="0" placeholder="0" value="${initCash}">
            </div>
            <div class="form-group">
              <label>카드</label>
              <input type="number" name="total_payment_card" id="pt-card" min="0" placeholder="0" value="${initCard}">
            </div>
            <div class="form-group">
              <label>매출담당</label>
              <select name="assigned_trainer_id" class="form-select">
                <option value="">선택</option>
                ${trainers.map(t => `<option value="${t.id}"${isEdit && t.id === editRecord.assigned_trainer_id ? ' selected' : ''}>${t.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>계약담당</label>
              <select name="contract_trainer_id" class="form-select">
                <option value="">선택</option>
                ${trainers.map(t => `<option value="${t.id}"${isEdit && t.id === editRecord.contract_trainer_id ? ' selected' : ''}>${t.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        // v7: PT상품 드롭다운 제거 (횟수와 의미 중복 — 사용자 확정 2026-04-19)
        const ptCountInput = el.querySelector('input[name="pt_count"]');
        const sessionPriceInput = el.querySelector('input[name="session_price"]');
        const contractAmountEl = el.querySelector('#pt-contract-amount');
        const totalPaymentEl = el.querySelector('#pt-total-payment');
        const cashInput = el.querySelector('#pt-cash');
        const cardInput = el.querySelector('#pt-card');

        // 회원 검색 UI는 신규 등록 모드에서만 존재
        if (!isEdit) {
          const searchInput = el.querySelector('#pt-member-search');
          const resultsEl = el.querySelector('#pt-search-results');
          const selectedEl = el.querySelector('#pt-selected-member');
          const selectedLabel = el.querySelector('#pt-selected-label');
          const nameInput = el.querySelector('input[name="selected_name"]');
          const phoneInput = el.querySelector('input[name="selected_phone"]');

          // v11: 회원 검색 — members 마스터(veragym-app 통합 회원) 기준. inquiries에 없는 PT만 회원도 포함.
          searchInput.addEventListener('input', debounce(async () => {
            const raw = searchInput.value.trim();
            if (raw.length < 1) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; return; }
            const q = sanitizeSearch(raw);  // v12: LIKE 와일드카드 + or() 예약문자 방어
            if (!q) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; return; }

            const { data } = await supabase
              .from('members')
              .select('name, phone')
              .not('phone', 'is', null)
              .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
              .order('name')
              .limit(20);

            if (!data || data.length === 0) {
              resultsEl.innerHTML = '<div class="pt-search-item empty">검색 결과 없음. 문의관리에서 회원 등록 후 진행하세요.</div>';
              resultsEl.style.display = 'block';
              return;
            }

            // 중복 phone 제거
            const unique = [...new Map(data.map(d => [d.phone, d])).values()];

            // v12: XSS 방어 — DB name/phone 값 이스케이프 후 DOM 주입
            resultsEl.innerHTML = unique.map(d => {
              const n = escHtml(d.name), p = escHtml(d.phone);
              return `<div class="pt-search-item" data-name="${n}" data-phone="${p}">${n} <span style="color:var(--color-text-muted)">${p}</span></div>`;
            }).join('');
            resultsEl.style.display = 'block';

            resultsEl.querySelectorAll('.pt-search-item:not(.empty)').forEach(item => {
              item.addEventListener('click', () => {
                nameInput.value = item.dataset.name;
                phoneInput.value = item.dataset.phone;
                selectedLabel.textContent = `${item.dataset.name} ${item.dataset.phone}`;
                selectedEl.style.display = 'flex';
                searchInput.style.display = 'none';
                resultsEl.style.display = 'none';
              });
            });
          }, 300));

          // 회원 선택 변경
          el.querySelector('#pt-clear-member').addEventListener('click', () => {
            nameInput.value = '';
            phoneInput.value = '';
            selectedEl.style.display = 'none';
            searchInput.style.display = '';
            searchInput.value = '';
            searchInput.focus();
          });

          // 외부 클릭 시 검색 결과 닫기
          el.addEventListener('click', (e) => {
            if (!e.target.closest('#pt-member-search') && !e.target.closest('#pt-search-results')) {
              resultsEl.style.display = 'none';
            }
          });

          // prefill인 경우 검색 숨기기
          if (prefill) {
            searchInput.style.display = 'none';
          }
        }

        // v7: veragym-app 규칙 — 계약금액 = 횟수 × 세션단가, 총결제액 = 계약금액 × 1.1 (VAT 10%)
        let currentTotal = 0;
        function updateCalc() {
          const count = parseInt(ptCountInput.value) || 0;
          const price = parseInt(sessionPriceInput.value) || 0;
          const contract = count * price;
          currentTotal = Math.round(contract * 1.1);
          contractAmountEl.value = contract.toLocaleString() + '원';
          totalPaymentEl.value = currentTotal.toLocaleString() + '원';
          // 현금/계좌, 카드 placeholder 에 총결제액 표시 (둘 다 비어있을 때 기준)
          const placeholderText = currentTotal > 0 ? currentTotal.toLocaleString() : '0';
          cashInput.placeholder = placeholderText;
          cardInput.placeholder = placeholderText;
        }
        ptCountInput.addEventListener('input', updateCalc);
        sessionPriceInput.addEventListener('input', updateCalc);
        updateCalc();

        // v7: 한쪽 입력하면 다른쪽 자동 = 총결제액 - 입력값 (무한 루프 방지용 guard)
        let autoFilling = false;
        cashInput.addEventListener('input', () => {
          if (autoFilling) return;
          const cash = parseInt(cashInput.value);
          if (isNaN(cash) || currentTotal <= 0) return;
          autoFilling = true;
          cardInput.value = Math.max(0, currentTotal - cash);
          autoFilling = false;
        });
        cardInput.addEventListener('input', () => {
          if (autoFilling) return;
          const card = parseInt(cardInput.value);
          if (isNaN(card) || currentTotal <= 0) return;
          autoFilling = true;
          cashInput.value = Math.max(0, currentTotal - card);
          autoFilling = false;
        });

        // 폼 제출
        el.querySelector('#pt-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await savePtRegistration(e.target, editRecord);
        });
      }
    });
  }

  async function savePtRegistration(form, editRecord) {
    const isEdit = !!editRecord;
    const fd = new FormData(form);

    // 수정 모드는 기존 레코드의 name/phone 유지, 신규 모드는 폼 hidden input에서 취득
    const name = isEdit ? editRecord.name : fd.get('selected_name')?.trim();
    const phone = isEdit ? editRecord.phone : fd.get('selected_phone')?.trim();
    const ptCount = parseInt(fd.get('pt_count'));
    const sessionPrice = parseInt(fd.get('session_price'));
    const contractTrainerId = fd.get('contract_trainer_id') || null;
    const assignedTrainerId = fd.get('assigned_trainer_id') || null;
    if (!name || !phone) { Toast.warning('회원을 선택해주세요.'); return; }
    if (!ptCount || ptCount < 1) { Toast.warning('횟수를 입력해주세요.'); return; }
    if (isNaN(sessionPrice) || sessionPrice < 0) { Toast.warning('세션 단가를 입력해주세요.'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    const submitLabel = isEdit ? '수정' : '등록';
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> ${submitLabel} 중...`;

    // v7: veragym-app 규칙 — pt_count + session_price 만 저장.
    //      contract_amount / total_payment 은 DB GENERATED 컬럼이 자동 계산.
    //      product 컬럼은 더 이상 저장하지 않음 (횟수와 의미 중복 — 사용자 확정 2026-04-19).

    // v7: 현금/카드 분할 — 빈 값이면 0 처리. 둘 다 빈 값이면 전액 카드로 default.
    const totalPay = Math.round(ptCount * sessionPrice * 1.1);
    let cash = parseInt(fd.get('total_payment_cash')) || 0;
    let card = parseInt(fd.get('total_payment_card')) || 0;
    if (cash === 0 && card === 0 && totalPay > 0) {
      card = totalPay;  // 기본값: 전액 카드
    }

    const payload = {
      pt_count: ptCount,
      session_price: sessionPrice,
      total_payment_cash: cash,
      total_payment_card: card,
      contract_trainer_id: contractTrainerId,
      assigned_trainer_id: assignedTrainerId,
    };

    // v8: 수정 모드 UPDATE / 신규 모드 INSERT 분기
    let error;
    if (isEdit) {
      ({ error } = await supabase
        .from('pt_registrations')
        .update(payload)
        .eq('id', editRecord.id));
    } else {
      payload.name = name;
      payload.phone = phone;
      // v11: 신규 등록 시 contract_date 기본값 = 오늘 (누락 시 리스트 정렬 맨 뒤로 밀리는 이슈 방지)
      payload.contract_date = new Date().toISOString().slice(0, 10);
      ({ error } = await supabase
        .from('pt_registrations')
        .insert(payload)
        .select('id')
        .single());
    }

    if (error) {
      Toast.error(`PT${submitLabel} 실패: ` + error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
      return;
    }

    // v7: VeraGym 자동 동기화 비활성 (두 앱 분리 운영). 재활성 시 pg_cron + 폼 sync 둘 다 켜야 함.
    Toast.success(`PT${submitLabel} 저장 완료`);

    Modal.close();
    await loadPtRegistrations();
  }

  return { init, openPtForm };
})();
