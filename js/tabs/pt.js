/**
 * PT등록회원 탭
 * - PT등록 리스트 (sync_status 표시)
 * - [+PT등록] 모달 (회원 검색 → 폼 → INSERT → RPC 동기화)
 * - 미동기화/실패 배지 + 수동 재시도
 */
const PtTab = (() => {
  let allPtRegs = [];
  let trainers = [];
  // v13: DOM 렌더 페이지네이션 — 846행 한 번에 그리면 버벅거림
  const PAGE_SIZE = 100;
  let displayLimit = PAGE_SIZE;

  async function init() {
    await loadTrainers();
    renderToolbar();
    await loadPtRegistrations();
  }

  async function loadTrainers() {
    // v10: role='admin' (admin/veragym 로그인 계정)은 매출담당 드롭다운에서 제외
    // is_active도 로드 — 신규 등록은 활성자만, 수정 모드는 기존 선택된 비활성자 유지용
    const { data } = await supabase
      .from('trainers')
      .select('id, name, is_active')
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
        (r.name || '').toLowerCase().includes(q) || (r.phone || '').includes(q)
      );
    }

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-state">PT등록 내역이 없습니다.</div>';
      return;
    }

    // v13: 검색 없을 땐 DOM 렌더 페이지네이션 (초기 100건)
    const totalCount = filtered.length;
    const isPaged = !query;
    if (isPaged) filtered = filtered.slice(0, displayLimit);

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

      // v14: 업그레이드 배지 — pt_upgrade RPC 로 INSERT 된 행 식별
      const upgradeBadge = r.is_upgrade
        ? `<span class="pt-upgrade-badge" title="업그레이드 행">UP</span>` : '';

      return `
        <div class="inquiry-card pt-row${r.is_upgrade ? ' pt-row-upgrade' : ''}">
          <div class="inquiry-card-main">
            <div class="col-date">${esc(r.contract_date || '')}</div>
            <div class="col-name">${upgradeBadge}${esc(nameLabel)}</div>
            <div class="col-phone">${esc(r.phone)}</div>
            <div class="col-pt-count">${esc(r.pt_count)}회</div>
            <div class="col-amount">${amount}원</div>
            <div class="col-payment">${totalPayment}원</div>
            <div class="col-trainer">${esc(contractTrainer)}</div>
            <div class="col-trainer">${esc(assignedTrainer)}</div>
            <div class="col-actions inquiry-actions"${errorTooltip}>
              ${r.sync_status === 'synced' || r.sync_status === 'duplicate'
                ? `<button class="btn-action btn-sync-done" data-id="${r.id}" title="이미 동기화됨">동기화 완료</button>`
                : `<button class="btn-action btn-retry" data-id="${r.id}">동기화</button>`}
              <button class="btn-action btn-edit" data-id="${r.id}">수정</button>
              <button class="btn-action btn-upgrade" data-id="${r.id}" title="회수 추가 / 단가 변경 / 트레이너 변경">업그레이드</button>
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
      ${isPaged && totalCount > displayLimit ? `
        <div style="text-align:center; padding:16px;">
          <button class="btn btn-secondary" id="pt-load-more">
            ${Math.min(PAGE_SIZE, totalCount - displayLimit)}건 더 보기 (${displayLimit}/${totalCount})
          </button>
        </div>
      ` : ''}
    `;

    // v13: 더 보기
    const moreBtn = listEl.querySelector('#pt-load-more');
    if (moreBtn) moreBtn.addEventListener('click', () => {
      displayLimit += PAGE_SIZE;
      renderList(document.querySelector('#tab-pt .search-box')?.value.trim() || '');
    });

    // v12: 동기화/완료 버튼 둘 다 같은 핸들러 (완료 버튼은 info 토스트로 안내)
    listEl.querySelectorAll('.btn-retry, .btn-sync-done').forEach(btn => {
      btn.addEventListener('click', () => retrySync(btn.dataset.id));
    });

    // v8: 수정 버튼 바인딩 — 해당 행 레코드를 edit 모드로 openPtForm 호출
    listEl.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = allPtRegs.find(r => r.id === btn.dataset.id);
        if (rec) openPtForm(null, rec);
      });
    });

    // v14: 업그레이드 버튼 바인딩 — 회수 추가/단가 변경/트레이너 변경
    listEl.querySelectorAll('.btn-upgrade').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = allPtRegs.find(r => r.id === btn.dataset.id);
        if (rec) openPtUpgradeForm(rec);
      });
    });
  }

  // ────────── PT 업그레이드 모달 (v14) ──────────
  // 회수 추가 + 단가 변경 + 트레이너 변경을 한 트랜잭션으로 처리
  // pt_upgrade RPC 가 pt_registrations / pt_products / payment_records / pt_upgrade_history 4개 테이블 갱신
  async function openPtUpgradeForm(rec) {
    if (trainers.length === 0) await loadTrainers();

    const phoneTail = rec.phone ? String(rec.phone).replace(/\D/g, '').slice(-4) : '';
    const nameHasTail = /\d{4}$/.test(rec.name || '');
    const nameLabel = (nameHasTail || !phoneTail) ? (rec.name || '') : `${rec.name}${phoneTail}`;

    const prevPrice = rec.session_price || 0;
    const prevCount = rec.pt_count || 0;
    const prevAmount = (rec.contract_amount || prevPrice * prevCount).toLocaleString();

    Modal.open({
      type: 'center',
      title: 'PT 업그레이드',
      size: 'lg',
      html: `
        <form id="pt-upgrade-form">
          <div class="pt-upgrade-info" style="padding:12px 14px; background:var(--color-bg-1); border-radius:8px; margin-bottom:14px; font-size:13px; line-height:1.7;">
            <div><strong>회원</strong> ${escHtml(nameLabel)} · ${escHtml(rec.phone || '')}</div>
            <div><strong>원본 계약</strong> ${escHtml(rec.contract_date || '')} · ${prevCount}회 · ${prevPrice.toLocaleString()}원/회 · ${prevAmount}원</div>
          </div>

          <div class="form-grid" style="margin-bottom:14px;">
            <div class="form-group">
              <label>추가 회수 *</label>
              <input type="number" name="add_count" id="upg-add-count" min="1" placeholder="예: 12" required>
            </div>
            <div class="form-group">
              <label>새 패키지 단가 (참고) <span style="font-weight:400;color:var(--color-text-muted);font-size:11px;">— 안내가, VAT 제외</span></label>
              <input type="number" name="new_package_price" id="upg-new-pkg-price" min="0" placeholder="예: 54000">
              <div class="form-hint" style="font-size:11px; color:var(--color-text-muted); margin-top:4px;">회원에게 안내한 합산 후 회당 단가 (DB 저장 X · 검증용)</div>
            </div>
            <div class="form-group full">
              <label>차액 결제 — 현금/계좌</label>
              <input type="number" name="paid_cash" id="upg-cash" min="0" placeholder="0">
            </div>
            <div class="form-group full">
              <label>차액 결제 — 카드</label>
              <input type="number" name="paid_card" id="upg-card" min="0" placeholder="0">
            </div>
          </div>

          <div id="upg-calc-box" style="padding:12px 14px; background:var(--color-bg-0); border-radius:8px; margin-bottom:14px; font-size:13px; line-height:1.9;">
            <div style="font-weight:600; color:var(--color-text-secondary); margin-bottom:6px;">자동 계산 (VAT 제외 기준)</div>
            <div>· 차액 결제(VAT 제외): <strong id="upg-net-calc">0원</strong> <span style="color:var(--color-text-muted);font-size:11px;">(VAT 포함 결제 ÷ 1.1)</span></div>
            <div>· 차액 회당 단가 (DB 저장): <strong id="upg-eff-price">0원</strong> <span style="color:var(--color-text-muted);font-size:11px;">(차액 ÷ 추가회수)</span></div>
            <div>· 합산 가중평균 단가: <strong id="upg-weighted-avg" style="color:#1E40AF;">0원</strong> <span style="color:var(--color-text-muted);font-size:11px;">— 안내가와 일치해야 정확</span></div>
            <div id="upg-warn" style="margin-top:6px; color:#B91C1C; font-size:12px; display:none;">⚠ 합산 가중평균이 안내가와 다릅니다. 결제 금액을 확인하세요.</div>
          </div>

          <div class="form-grid" style="margin-bottom:14px;">
            <div class="form-group">
              <label>매출담당 (변경 시 선택)</label>
              <select name="assigned_trainer_id" class="form-select">
                <option value="">기존 유지${rec.assigned_trainer?.name ? ' — ' + rec.assigned_trainer.name : ''}</option>
                ${trainers.filter(t => t.is_active).map(t =>
                  `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>계약담당 (변경 시 선택)</label>
              <select name="contract_trainer_id" class="form-select">
                <option value="">기존 유지${rec.contract_trainer?.name ? ' — ' + rec.contract_trainer.name : ''}</option>
                ${trainers.filter(t => t.is_active).map(t =>
                  `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group full">
              <label>메모 (업그레이드 사유 / 안내 단가 등)</label>
              <input type="text" name="note" placeholder="예: 24→36회 패키지 전환 (54,000원/회 안내)" maxlength="500">
            </div>
          </div>

          <div class="form-hint" style="font-size:12px; color:var(--color-text-secondary); margin:8px 0 12px; padding:10px 12px; background:var(--color-bg-0); border-radius:6px;">
            · 원본 PT 계약은 그대로 유지되며, <strong>오늘 날짜로 신규 PT 행이 추가</strong>됩니다.<br>
            · 매출 = 회원 실 결제액 (1:1 일치). 차액 단가가 자동 계산되며, <strong>합산 가중평균이 회원 안내가와 일치</strong>합니다.<br>
            · PT관리앱(잔여횟수/매출/가중평균)도 자동으로 동기화됩니다.
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="submit" class="btn btn-primary">업그레이드 실행</button>
          </div>
        </form>
      `,
      onOpen: (el) => {
        const addCountInput = el.querySelector('#upg-add-count');
        const newPkgPriceInput = el.querySelector('#upg-new-pkg-price');
        const cashInput = el.querySelector('#upg-cash');
        const cardInput = el.querySelector('#upg-card');
        const netCalcEl = el.querySelector('#upg-net-calc');
        const effPriceEl = el.querySelector('#upg-eff-price');
        const weightedAvgEl = el.querySelector('#upg-weighted-avg');
        const warnEl = el.querySelector('#upg-warn');

        function updateCalc() {
          const addCount = parseInt(addCountInput.value) || 0;
          const cash = parseInt(cashInput.value) || 0;
          const card = parseInt(cardInput.value) || 0;
          const paidVatIncl = cash + card;                           // VAT 포함 결제 (회원이 실제 낸 돈)
          const paidNet = paidVatIncl > 0 ? Math.round(paidVatIncl / 1.1) : 0;  // VAT 제외 차액
          const effPrice = (addCount > 0 && paidNet > 0) ? Math.round(paidNet / addCount) : 0;

          // 합산 가중평균 (VAT 제외) = (원본 결제 net + 차액 net) / (원본 회수 + 추가 회수)
          //   원본 결제 net = prevPrice × prevCount (= contract_amount)
          const prevNet = prevPrice * prevCount;
          const totalNet = prevNet + paidNet;
          const totalCount = prevCount + addCount;
          const weightedAvg = totalCount > 0 ? Math.round(totalNet / totalCount) : 0;

          netCalcEl.textContent = paidNet.toLocaleString() + '원';
          effPriceEl.textContent = effPrice.toLocaleString() + '원';
          weightedAvgEl.textContent = weightedAvg.toLocaleString() + '원';

          // 안내가(new_package_price) 입력 시 비교 경고
          const pkgPrice = parseInt(newPkgPriceInput.value) || 0;
          if (pkgPrice > 0 && weightedAvg > 0 && Math.abs(pkgPrice - weightedAvg) > 100) {
            warnEl.style.display = '';
            warnEl.textContent = `⚠ 합산 가중평균(${weightedAvg.toLocaleString()}원)이 안내가(${pkgPrice.toLocaleString()}원)와 다릅니다. 결제 금액을 확인하세요.`;
          } else {
            warnEl.style.display = 'none';
          }
        }

        addCountInput.addEventListener('input', updateCalc);
        newPkgPriceInput.addEventListener('input', updateCalc);
        cashInput.addEventListener('input', updateCalc);
        cardInput.addEventListener('input', updateCalc);
        updateCalc();

        // 폼 제출
        el.querySelector('#pt-upgrade-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await submitPtUpgrade(e.target, rec);
        });

        addCountInput.focus();
      }
    });
  }

  async function submitPtUpgrade(form, rec) {
    const fd = new FormData(form);
    const addCount = parseInt(fd.get('add_count'));
    if (!addCount || addCount < 1) { Toast.warning('추가 회수를 입력해주세요.'); return; }

    let cash = parseInt(fd.get('paid_cash')) || 0;
    let card = parseInt(fd.get('paid_card')) || 0;
    const paidVatIncl = cash + card;
    if (paidVatIncl <= 0) { Toast.warning('차액 결제 금액을 입력해주세요 (현금 또는 카드).'); return; }

    // 옵션 A: 차액 자동 계산 단가
    //   세션 단가 (VAT 제외) = (결제 / 1.1) / 회수
    //   contract_amount = pt_count × session_price = 차액(VAT 제외) ✓ 결제와 일치
    //   가중평균 = (원본 + 차액) / 총회수 = 회원 안내 패키지 단가
    const paidNet = Math.round(paidVatIncl / 1.1);
    const effSessionPrice = Math.round(paidNet / addCount);

    const assignedTrainerId = fd.get('assigned_trainer_id') || null;
    const contractTrainerId = fd.get('contract_trainer_id') || null;
    const note = (fd.get('note') || '').trim() || null;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> 업그레이드 처리 중...';

    const { data, error } = await supabase.rpc('pt_upgrade', {
      p_prev_pt_registration_id: rec.id,
      p_add_count: addCount,
      p_new_session_price: effSessionPrice,  // 옵션 A: 차액 자동 계산 단가
      p_paid_cash: cash,
      p_paid_card: card,
      p_assigned_trainer_id: assignedTrainerId,
      p_contract_trainer_id: contractTrainerId,
      p_note: note,
    });

    if (error) {
      Toast.error('업그레이드 실패: ' + error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = '업그레이드 실행';
      return;
    }
    if (!data?.ok) {
      Toast.error('업그레이드 실패: ' + (data?.error || 'unknown'));
      submitBtn.disabled = false;
      submitBtn.textContent = '업그레이드 실행';
      return;
    }

    if (data.member_matched) {
      Toast.success(`업그레이드 완료 — PT관리앱 동기화 ${data.member_matched ? '✓' : '○'}`);
    } else {
      Toast.warning('업그레이드 저장됨. 단, members 매칭 실패로 PT관리앱(잔여횟수/매출)에는 반영되지 않았습니다.');
    }

    // 업그레이드는 자동 SMS 스킵 — pt_upgrade RPC 가 직접 INSERT 하며 autoScheduleSmsForRegistration 호출 안 함
    Modal.close();
    await loadPtRegistrations();
  }

  // ────────── PT 등록 삭제 ──────────
  async function deletePt(rec) {
    const label = `${rec.name || ''} / ${rec.phone || ''} / ${rec.pt_count || 0}회`;
    if (!confirm(`[확인] PT 등록을 삭제합니다.\n\n${label}\n\n이 작업은 되돌릴 수 없습니다.\n정말 삭제하시겠습니까?`)) return;

    const { data, error } = await supabase.rpc('admin_delete_pt_registration', {
      p_pt_id: rec.id
    });
    if (error) {
      Toast.error('삭제 실패: ' + error.message);
      return;
    }
    if (!data || data.ok !== true) {
      Toast.error('삭제 실패: ' + (data?.error || 'unknown'));
      return;
    }
    Toast.success('PT 등록 삭제됨');
    Modal.close();
    await loadPtRegistrations();
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
    // v14: 중복/이미동기화 케이스를 info(파란색)으로 통일 — '실패'로 오인되지 않게
    if (data?.ok && data?.duplicate === true) {
      Toast.info('이미 PT관리앱에 등록되어 있습니다 (중복 방지로 스킵). [동기화 완료] 상태로 변경되어 더 이상 동기화 시도하지 않습니다.');
    } else if (data?.ok && data?.already === true) {
      Toast.info('이미 동기화 처리된 PT 등록입니다.');
    } else if (data?.ok) {
      Toast.success('동기화 성공 — PT관리앱에 등록되었습니다');
    } else {
      Toast.error('동기화 실패: ' + (data?.error || '알 수 없는 오류'));
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
              <label>PT등록날짜 *</label>
              <input type="date" name="contract_date" value="${isEdit ? (editRecord.contract_date || '') : new Date().toISOString().slice(0, 10)}" required>
            </div>
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
                ${trainers
                  .filter(t => t.is_active || (isEdit && t.id === editRecord.assigned_trainer_id))
                  .map(t => `<option value="${t.id}"${isEdit && t.id === editRecord.assigned_trainer_id ? ' selected' : ''}>${t.name}${t.is_active ? '' : ' (퇴직)'}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>계약담당</label>
              <select name="contract_trainer_id" class="form-select">
                <option value="">선택</option>
                ${trainers
                  .filter(t => t.is_active || (isEdit && t.id === editRecord.contract_trainer_id))
                  .map(t => `<option value="${t.id}"${isEdit && t.id === editRecord.contract_trainer_id ? ' selected' : ''}>${t.name}${t.is_active ? '' : ' (퇴직)'}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-actions${isEdit ? ' spt-edit-actions' : ''}">
            ${isEdit ? '<button type="button" class="btn btn-danger pt-delete-btn">PT 삭제</button>' : ''}
            <div${isEdit ? ' class="spt-edit-actions-right"' : ''}>
              <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
              <button type="submit" class="btn btn-primary">${isEdit ? '수정' : '등록'}</button>
            </div>
          </div>
        </form>
      `,
      onOpen: (el) => {
        // 수정 모드: PT 삭제 버튼 바인딩 (SPT 패턴과 동일)
        if (isEdit) {
          const delBtn = el.querySelector('.pt-delete-btn');
          if (delBtn) delBtn.addEventListener('click', () => deletePt(editRecord));
        }
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
      // PT등록날짜 — 신규/수정 모두 폼 값 우선. 빈 값이면 오늘 default (신규 때 정렬 이슈 방지).
      contract_date: fd.get('contract_date') || new Date().toISOString().slice(0, 10),
    };

    // v8: 수정 모드 UPDATE / 신규 모드 INSERT 분기
    let error;
    let newPtId = null;
    if (isEdit) {
      ({ error } = await supabase
        .from('pt_registrations')
        .update(payload)
        .eq('id', editRecord.id));
    } else {
      payload.name = name;
      payload.phone = phone;
      const insertResp = await supabase
        .from('pt_registrations')
        .insert(payload)
        .select('id')
        .single();
      error = insertResp.error;
      newPtId = insertResp.data?.id;
    }

    if (error) {
      Toast.error(`PT${submitLabel} 실패: ` + error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
      return;
    }

    // v7: VeraGym 자동 동기화 비활성 (두 앱 분리 운영). 재활성 시 pg_cron + 폼 sync 둘 다 켜야 함.
    Toast.success(`PT${submitLabel} 저장 완료`);

    // 신규 PT 등록 시 자동 SMS 예약 (PT 카테고리 + auto_send=true 매칭 템플릿)
    // v15: category 전달 — 신규/재등록 sub-filter 매칭
    if (!isEdit && newPtId) {
      autoScheduleSmsForRegistration({
        id: newPtId,
        name,
        phone,
        contract_date: payload.contract_date,
        pt_count: payload.pt_count,
        product: payload.product || null,
        category: fd.get('category') || null,
      }, 'pt', 'pt_registrations');
    }

    Modal.close();
    await loadPtRegistrations();
  }

  return { init, openPtForm };
})();
