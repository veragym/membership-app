/**
 * 엑셀 가져오기/내보내기 — DESIGN_SPEC 5.5 고정 형식 준수
 *
 * ┌────────────────────────────────────────────────────────┐
 * │ 시트 매핑                                               │
 * │   FC     : inquiries + registrations (v6: 19컬럼)      │
 * │   PT     : pt_registrations         (v7: 10컬럼)       │
 * │ 헤더 위치: R1 공백, R2 헤더, R3~ 데이터                │
 * └────────────────────────────────────────────────────────┘
 *
 * 공개 API:
 *   ExcelImport.open()       - 가져오기 플로우
 *   ExcelImport.openExport() - 내보내기 플로우
 */
const ExcelImport = (() => {
  // ─────────────────────────────────────────────────────────
  //  고정 헤더 (DESIGN_SPEC 5.5.3 / 5.5.4 — 한 글자도 변경 금지)
  //  2026-04-18 v4: Round-trip 불변성 위해 맨 끝에 'id' 컬럼 추가
  //                  (FC 17→18, PT 10→11)
  //  id 컬럼 규약:
  //   - Export: 각 행에 DB 의 uuid 포함
  //   - Import: id 있으면 UPSERT(UPDATE), 빈칸이면 새 INSERT (uuid 자동 생성)
  //   - 사용자 수동 편집 시 id 열을 건드리지 말 것 (잘못된 UUID 는 Import 에서 거부)
  // ─────────────────────────────────────────────────────────
  const FC_HEADERS = [
    '상담 일시', '고객명', '연락처', '거주지', '신/재 구분',
    '상담 형식', '유입 경로', '상담 목적', '상담 내용', '등록 여부',
    '등록 상품', '총 결제액', '현금/계좌', '카드',
    '계약직원',                                  // ← 15번째 (v6 신규, contract_manager)
    '매출담당직원',                              // ← 16번째 (v6 rename, was '회원권 담당자', DB=sales_manager)
    'SPT 횟수', ' SPT 희망 시간대 및 비고',   // ← 18번째 선행 공백 유지
    'id'                                         // ← 19번째 (v4 신규, 시스템 관리)
  ];
  // v7: PT 스펙 10컬럼 — 사용자 역사 양식 기반 (매출/계약 트레이너 분리)
  //   col1 날짜      → contract_date
  //   col2 이름      → name
  //   col3 구분      → category (신규/재등록)
  //   col4 등록종목  → product (+ pt_count 파싱, "PT 30회" 형식)
  //   col5 총결제액  → 표시용 (DB 저장은 cash+card 로 파생)
  //   col6 계좌이체  → total_payment_cash
  //   col7 카드      → total_payment_card
  //   col8 매출담당  → assigned_trainer_id (trainers.name lookup)
  //   col9 계약담당  → contract_trainer_id (trainers.name lookup)
  //   col10 id       → id (시스템 관리, 신규는 공란)
  const PT_HEADERS = [
    '날짜', '이름', '구분', '등록종목', '총결제액',
    '계좌이체', '카드', '매출담당', '계약담당',
    'id'                                        // ← 10번째 (v7, 시스템 관리)
  ];
  const VALID_CATEGORIES = ['신규', '재등록'];

  // UUID v4 유효성 검증 정규식 (Postgres gen_random_uuid() 포맷)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let state = null;

  // ═════════════════════════════════════════════════════════
  //                    Import (가져오기)
  // ═════════════════════════════════════════════════════════
  function open() {
    state = {
      mode: 'import', sheetType: null, headers: null,
      rawDataRows: [], parsedRows: [], issues: [], warnings: [],
      trainers: [], isHistorical: true,
    };

    Modal.open({
      type: 'center',
      title: '엑셀 가져오기',
      size: 'lg',
      html: `
        <div id="imp-step-upload" class="import-step">
          <div class="import-upload-area" id="imp-drop">
            <div class="import-upload-icon">📂</div>
            <p>엑셀 파일(.xlsx, .xls)을 드래그하거나 클릭하여 선택</p>
            <p style="font-size:12px; color:var(--color-text-muted); margin-top:10px; line-height:1.6;">
              <strong>고정 형식:</strong> FC 시트 19컬럼 / PT 시트 10컬럼 (맨 끝 id)<br>
              (R1 빈 행, R2 헤더, R3부터 데이터)<br>
              <strong>25년PT 시트는 건너뜁니다.</strong><br>
              <strong>id 열</strong>: 기존 행은 건드리지 말고, 신규 행은 비워두세요.
            </p>
            <input type="file" id="imp-file" accept=".xlsx,.xls" style="display:none">
          </div>
        </div>
        <div id="imp-step-report" class="import-step" style="display:none"></div>
        <div id="imp-step-progress" class="import-step" style="display:none"></div>
        <div id="imp-step-done" class="import-step" style="display:none"></div>
      `,
      onOpen: (el) => {
        const drop = el.querySelector('#imp-drop');
        const file = el.querySelector('#imp-file');
        drop.addEventListener('click', () => file.click());
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
        drop.addEventListener('drop', (e) => {
          e.preventDefault(); drop.classList.remove('dragover');
          if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });
        file.addEventListener('change', () => { if (file.files[0]) handleFile(file.files[0]); });
      }
    });
  }

  async function handleFile(f) {
    if (typeof XLSX === 'undefined') {
      Toast.error('SheetJS 라이브러리 미로드 — 페이지를 새로고침 해주세요.');
      return;
    }

    Toast.info('파일 파싱 중...');

    let wb;
    try {
      const buf = await f.arrayBuffer();
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
    } catch (err) {
      Toast.error('파일 파싱 실패: ' + err.message);
      return;
    }

    // 시트 감지 — 대문자 FC / PT 우선
    const sheetNames = wb.SheetNames || [];
    let targetSheet = null, sheetType = null;

    if (sheetNames.includes('FC')) { targetSheet = 'FC'; sheetType = 'FC'; }
    else if (sheetNames.includes('PT')) { targetSheet = 'PT'; sheetType = 'PT'; }
    else {
      Toast.error(
        'FC 또는 PT 시트를 찾을 수 없습니다. 시트명은 반드시 대문자 "FC" 또는 "PT" 여야 합니다.\n발견된 시트: ' +
        sheetNames.join(', ')
      );
      return;
    }

    const ws = wb.Sheets[targetSheet];

    // R1 공백 → R2 헤더 → R3 데이터 구조
    const rawArr = XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: null, raw: true, blankrows: false
    });

    if (rawArr.length < 2) {
      Toast.error('시트에 데이터가 없습니다.');
      return;
    }

    // 첫 번째 non-empty 행을 헤더로 (R1 공백 케이스 대응)
    let hIdx = 0;
    while (hIdx < rawArr.length) {
      const row = rawArr[hIdx];
      if (row && row.some(c => c != null && String(c).trim() !== '')) break;
      hIdx++;
    }
    if (hIdx >= rawArr.length) {
      Toast.error('헤더 행을 찾을 수 없습니다.');
      return;
    }

    const headers = (rawArr[hIdx] || []).map(h => h == null ? '' : String(h));
    const dataRows = rawArr.slice(hIdx + 1)
      .filter(r => r && r.some(c => c != null && String(c).trim() !== ''));

    // 헤더 검증
    const expected = sheetType === 'FC' ? FC_HEADERS : PT_HEADERS;
    const headerErrors = validateHeaders(headers, expected);
    if (headerErrors.length > 0) {
      Toast.error('헤더 불일치 — DESIGN_SPEC 5.5 고정 형식 위반');
      console.error('[ExcelImport] 헤더 불일치 상세:\n' + headerErrors.join('\n'));
      showHeaderMismatchReport(sheetType, headers, expected, headerErrors);
      return;
    }

    state.sheetType = sheetType;
    state.headers = headers;
    state.rawDataRows = dataRows;

    // PT 시트면 트레이너 목록 로드 (이름 lookup용)
    if (sheetType === 'PT') {
      // v11: role='admin' 제외 — 매출담당 이름 매핑에 admin/veragym 섞이지 않도록
      const { data, error } = await supabase.from('trainers').select('id, name').neq('role', 'admin');
      if (error) {
        Toast.error('트레이너 목록 조회 실패: ' + error.message);
        return;
      }
      state.trainers = data || [];
    }

    analyzeRows();
    showReportStep();
  }

  function validateHeaders(actual, expected) {
    const errors = [];
    if (actual.length < expected.length) {
      errors.push(`컬럼 수 부족: 기대 ${expected.length}개, 실제 ${actual.length}개`);
    }
    expected.forEach((h, i) => {
      const a = actual[i] != null ? actual[i] : '';
      if (a !== h) {
        errors.push(
          `  컬럼 ${i + 1}: 기대 "${h}" (len=${h.length})  /  실제 "${a}" (len=${a.length})`
        );
      }
    });
    return errors;
  }

  function showHeaderMismatchReport(sheetType, actual, expected, errors) {
    document.getElementById('imp-step-upload').style.display = 'none';
    const step = document.getElementById('imp-step-report');
    step.style.display = 'block';
    step.innerHTML = `
      <h3 style="color:var(--color-danger); margin-bottom:12px;">⚠️ 헤더 형식 불일치</h3>
      <p style="font-size:13px; margin-bottom:12px;">
        ${sheetType} 시트의 R2 헤더가 DESIGN_SPEC 5.5 고정 형식과 다릅니다.
        <strong>한 글자도 변경하지 말아야 합니다.</strong>
      </p>
      <div style="background:var(--color-bg-2); padding:12px; border-radius:var(--radius-xs); font-family:monospace; font-size:12px; white-space:pre-wrap; max-height:300px; overflow-y:auto;">
${errors.join('\n')}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="Modal.close()">닫기</button>
      </div>
    `;
  }

  function analyzeRows() {
    const { sheetType, rawDataRows, trainers } = state;
    const parsed = [];
    const issues = [];
    const warnings = [];

    rawDataRows.forEach((row, idx) => {
      const rowNum = idx + 3;  // R3부터 데이터
      const rowIssues = [];
      const rowWarnings = [];

      if (sheetType === 'FC') {
        // v6: 19컬럼. row[18] = id
        const idRaw = toStr(row[18]);
        let id = null;
        if (idRaw) {
          if (UUID_RE.test(idRaw)) {
            id = idRaw.toLowerCase();
          } else {
            rowIssues.push(`id 형식 오류 "${idRaw}" — UUID 형식 아님. 신규 행이면 이 칸을 비워두세요.`);
          }
        }

        const r = {
          _rowNum: rowNum,
          _isUpdate: id != null,              // true → UPDATE, false → INSERT
          id,                                  // null 이면 DB 가 uuid 자동 생성
          inquiry_date: toDateStr(row[0]),
          name: toStr(row[1]),
          phone: row[2] ? normalizePhone(String(row[2])) : null,
          residence: toStr(row[3]),
          category: toStr(row[4]),
          consultation_type: toStr(row[5]),
          inflow_channel: toStr(row[6]),
          consultation_purpose: toStr(row[7]),
          content: toStr(row[8]),
          status_raw: toStr(row[9]),
          product: toStr(row[10]),
          // row[11] = 총 결제액 (GENERATED, INSERT 안 함 — 참고만)
          total_payment_cash: toInt(row[12]),
          total_payment_card: toInt(row[13]),
          contract_manager: toStr(row[14]),    // v6: 15번째 '계약직원'
          sales_manager: toStr(row[15]),       // v6: 16번째 '매출담당직원' (기존 '회원권 담당자' rename)
          spt_count: toInt(row[16]),           // v6: 17번째 (기존 15번째)
          spt_preferred_time: toStr(row[17]),  // v6: 18번째 (기존 16번째)
        };
        r.status = r.status_raw === '등록' ? 'registered' : 'unregistered';

        // v4: UPDATE (id 있는 기존 행) 은 round-trip 불변성 위해 content validation 완화
        //     — DB 에 이미 있는 상태이므로 빈 값이어도 "그대로 유지" 가 정답
        // INSERT (신규) 는 엄격 validation 유지
        if (r._isUpdate) {
          if (r.phone && !/^010-\d{4}-\d{4}$/.test(r.phone)) rowWarnings.push(`연락처 형식 이상 "${r.phone}"`);
        } else {
          if (!r.name) rowIssues.push('고객명 누락');
          if (!r.inquiry_date) rowIssues.push('상담 일시 누락/형식 오류');
          if (r.phone && !/^010-\d{4}-\d{4}$/.test(r.phone)) rowWarnings.push(`연락처 형식 이상 "${r.phone}"`);
          if (r.status === 'registered' && !r.product) rowWarnings.push('등록 행인데 등록 상품 누락 — 문의만 INSERT됨');
        }

        if (rowIssues.length) issues.push({ rowNum, name: r.name, issues: rowIssues });
        if (rowWarnings.length) warnings.push({ rowNum, name: r.name, warnings: rowWarnings });
        parsed.push(r);
      } else {
        // PT 시트 — v7 스펙 10컬럼 (매출/계약 트레이너 분리)
        const productRaw = toStr(row[3]);
        const ptMatch = productRaw ? productRaw.match(/(\d+)\s*회/i) : null;
        const ptCount = ptMatch ? parseInt(ptMatch[1]) : null;

        // col8 매출담당 → assigned_trainer_id / col9 계약담당 → contract_trainer_id
        const salesTrainerName = toStr(row[7]);
        const contractTrainerName = toStr(row[8]);
        const salesTrainer = salesTrainerName ? trainers.find(t => t.name === salesTrainerName) : null;
        const contractTrainer = contractTrainerName ? trainers.find(t => t.name === contractTrainerName) : null;

        const cashRaw = toInt(row[5]);   // 계좌이체
        const cardRaw = toInt(row[6]);   // 카드
        const cash = cashRaw || 0;
        const card = cardRaw || 0;
        const totalPay = cash + card;   // 엑셀 "총결제액" (VAT 10% 포함)
        // v7: veragym-app 규칙. 엑셀의 총결제액은 VAT 포함 → /1.1 → /pt_count = 순 세션단가
        //      (이전 v4: /pt_count 만 해서 session_price 에 VAT 이중 적용되는 버그 있었음)
        const sessionPrice = (ptCount && ptCount > 0 && totalPay > 0)
          ? Math.round(totalPay / 1.1 / ptCount)
          : null;
        const cashForPayload = (cashRaw != null && cashRaw !== '') ? cashRaw : null;
        const cardForPayload = (cardRaw != null && cardRaw !== '') ? cardRaw : null;

        const categoryRaw = toStr(row[2]);
        const category = VALID_CATEGORIES.includes(categoryRaw) ? categoryRaw : null;

        // v7: row[9] = id (이전 v4 row[10] → 워크인순번/비고 컬럼 제거로 shift)
        const idRaw = toStr(row[9]);
        let id = null;
        if (idRaw) {
          if (UUID_RE.test(idRaw)) {
            id = idRaw.toLowerCase();
          } else {
            rowIssues.push(`id 형식 오류 "${idRaw}" — UUID 형식 아님. 신규 행이면 이 칸을 비워두세요.`);
          }
        }

        const r = {
          _rowNum: rowNum,
          _isUpdate: id != null,
          id,
          contract_date: toDateStr(row[0]),
          name: toStr(row[1]),
          category,
          _categoryRaw: categoryRaw,
          product: productRaw || null,
          pt_count: ptCount,
          total_payment_cash: cashForPayload,
          total_payment_card: cardForPayload,
          session_price: sessionPrice,
          _salesTrainerNameRaw: salesTrainerName,
          _contractTrainerNameRaw: contractTrainerName,
          assigned_trainer_id: salesTrainer ? salesTrainer.id : null,
          contract_trainer_id: contractTrainer ? contractTrainer.id : null,
          gym_location: '미사점',
          phone: null,
        };

        // v4: UPDATE 는 validation 완화 (round-trip 불변성)
        if (r._isUpdate) {
          if (categoryRaw && !category) rowWarnings.push(`구분 "${categoryRaw}" 허용값 아님 → NULL 저장`);
          if (salesTrainerName && !salesTrainer) rowWarnings.push(`매출담당 "${salesTrainerName}" trainers 테이블에 없음 → NULL 저장`);
          if (contractTrainerName && !contractTrainer) rowWarnings.push(`계약담당 "${contractTrainerName}" trainers 테이블에 없음 → NULL 저장`);
        } else {
          if (!r.name) rowIssues.push('이름 누락');
          if (!r.contract_date) rowIssues.push('날짜 누락/형식 오류');
          if (!r.product) rowIssues.push('등록종목 누락');
          if (r.product && !ptCount) rowIssues.push(`PT 횟수 파싱 실패 (원본: "${productRaw}" — 예: "PT 30회" 형식 필요)`);
          if (categoryRaw && !category) rowWarnings.push(`구분 "${categoryRaw}" 허용값 아님 → NULL 저장`);
          if (salesTrainerName && !salesTrainer) rowWarnings.push(`매출담당 "${salesTrainerName}" trainers 테이블에 없음 → NULL 저장`);
          if (contractTrainerName && !contractTrainer) rowWarnings.push(`계약담당 "${contractTrainerName}" trainers 테이블에 없음 → NULL 저장`);
        }

        if (rowIssues.length) issues.push({ rowNum, name: r.name, issues: rowIssues });
        if (rowWarnings.length) warnings.push({ rowNum, name: r.name, warnings: rowWarnings });
        parsed.push(r);
      }
    });

    state.parsedRows = parsed;
    state.issues = issues;
    state.warnings = warnings;
  }

  function showReportStep() {
    document.getElementById('imp-step-upload').style.display = 'none';
    const step = document.getElementById('imp-step-report');
    step.style.display = 'block';

    const { sheetType, parsedRows, issues, warnings } = state;
    const errorRowNums = new Set(issues.map(i => i.rowNum));
    const validRows = parsedRows.filter(r => !errorRowNums.has(r._rowNum));

    step.innerHTML = `
      <div style="margin-bottom:12px;">
        <span class="chip-sync success" style="margin-right:6px;">${sheetType} 시트 감지됨</span>
        <span style="font-size:13px; color:var(--color-text-secondary);">
          총 <strong>${parsedRows.length}건</strong>
          · 정상 <strong>${validRows.length}건</strong>
          · 경고 <strong>${warnings.length}건</strong>
          · 오류 <strong>${issues.length}건</strong>
        </span>
      </div>

      <div class="import-report-cards">
        <div class="import-report-card success">
          <div class="import-report-num">${validRows.length}</div>
          <div class="import-report-label">Import 예정</div>
        </div>
        <div class="import-report-card warning">
          <div class="import-report-num">${warnings.length}</div>
          <div class="import-report-label">경고 (저장됨)</div>
        </div>
        <div class="import-report-card danger">
          <div class="import-report-num">${issues.length}</div>
          <div class="import-report-label">오류 (제외됨)</div>
        </div>
      </div>

      ${issues.length > 0 ? `
        <div class="import-section">
          <h4>오류 — Import 제외</h4>
          <div class="import-error-list">
            ${issues.slice(0, 30).map(i =>
              `<div class="import-error-item">R${i.rowNum}: ${escapeHtml(i.name || '(이름없음)')} — ${escapeHtml(i.issues.join(', '))}</div>`
            ).join('')}
            ${issues.length > 30 ? `<div class="import-error-item">... 외 ${issues.length - 30}건</div>` : ''}
          </div>
        </div>
      ` : ''}

      ${warnings.length > 0 ? `
        <div class="import-section">
          <h4>경고 — Import 되지만 확인 필요</h4>
          <div class="import-error-list" style="max-height:180px; overflow-y:auto;">
            ${warnings.slice(0, 30).map(w =>
              `<div class="import-error-item" style="color:#b45309;">R${w.rowNum}: ${escapeHtml(w.name || '')} — ${escapeHtml(w.warnings.join(', '))}</div>`
            ).join('')}
            ${warnings.length > 30 ? `<div class="import-error-item">... 외 ${warnings.length - 30}건</div>` : ''}
          </div>
        </div>
      ` : ''}

      <div class="import-section">
        <h4>데이터 구분</h4>
        <div style="display:flex; gap:16px; padding:12px; background:var(--color-bg-2); border-radius:var(--radius-xs); flex-wrap:wrap;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="imp-history" value="true" checked>
            <span><strong>과거 데이터</strong>${sheetType === 'PT' ? ' (VeraGym 동기화 생략)' : ''}</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="imp-history" value="false">
            <span><strong>현재 데이터</strong>${sheetType === 'PT' ? ' (VeraGym 즉시 동기화)' : ''}</span>
          </label>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
        <button type="button" class="btn btn-primary" id="btn-execute-import"
          ${validRows.length === 0 ? 'disabled' : ''}>
          Import 실행 (${validRows.length}건)
        </button>
      </div>
    `;

    step.querySelector('#btn-execute-import').addEventListener('click', executeImport);
  }

  async function executeImport() {
    const historyInput = document.querySelector('input[name="imp-history"]:checked');
    const isHistorical = historyInput ? historyInput.value === 'true' : true;
    state.isHistorical = isHistorical;

    const { sheetType, parsedRows, issues } = state;
    const errorRowNums = new Set(issues.map(i => i.rowNum));
    const toProcess = parsedRows.filter(r => !errorRowNums.has(r._rowNum));

    if (toProcess.length === 0) {
      Toast.warning('Import할 건이 없습니다.');
      return;
    }

    // ─────────────────────────────────────────────────────────
    // v4 Round-trip 불변성 핵심 로직
    // ─────────────────────────────────────────────────────────
    // 1) 이번 import 세션 고유 UUID → 모든 행에 태깅 (롤백용)
    // 2) 신규 행(id 없는)에 클라이언트에서 UUID 미리 발급 → 순서 의존 제거
    //    + registrations.inquiry_id 매핑 안전 확보
    // 3) 500건씩 batch UPSERT (onConflict: 'id')
    //    - 기존 id → UPDATE (변화 없으면 값 동일 / updated_at 은 payload에 없으므로 DB 기본동작)
    //    - 신규 id → INSERT
    // 4) 실패 시 importBatchId 로 DELETE 한 줄 롤백 가능
    const importBatchId = (crypto.randomUUID ? crypto.randomUUID() : uuidFallback());

    toProcess.forEach(r => {
      if (!r.id) r.id = (crypto.randomUUID ? crypto.randomUUID() : uuidFallback());
    });

    const updateCount = toProcess.filter(r => r._isUpdate).length;
    const insertCount = toProcess.length - updateCount;

    document.getElementById('imp-step-report').style.display = 'none';
    const step = document.getElementById('imp-step-progress');
    step.style.display = 'block';
    step.innerHTML = `
      <div style="text-align:center; padding:20px;">
        <div class="spinner" style="margin:0 auto 16px;"></div>
        <p id="imp-progress-text">0 / ${toProcess.length} 처리 중...</p>
        <p style="font-size:11px; color:var(--color-text-muted); margin-top:4px;">
          신규 ${insertCount} · 기존 갱신 ${updateCount} · batch_id ${importBatchId.slice(0, 8)}…
        </p>
        <div class="import-progress-bar" style="margin-top:12px; height:8px; background:var(--color-bg-2); border-radius:4px; overflow:hidden;">
          <div class="import-progress-fill" id="imp-progress-fill" style="width:0%; height:100%; background:var(--color-primary); transition:width 0.2s;"></div>
        </div>
      </div>
    `;
    const pText = step.querySelector('#imp-progress-text');
    const pFill = step.querySelector('#imp-progress-fill');

    const failMsgs = [];
    let ok = 0, fail = 0;
    let done = 0;

    const updateProgress = () => {
      pText.textContent = `${done} / ${toProcess.length} 처리 중...`;
      pFill.style.width = Math.round(done / toProcess.length * 100) + '%';
    };

    const BATCH_SIZE = 500;
    const chunk = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    try {
      if (sheetType === 'FC') {
        // ── FC: inquiries UPSERT → registrations UPSERT (onConflict: inquiry_id) ──
        for (const batch of chunk(toProcess, BATCH_SIZE)) {
          // v4: Round-trip 불변성 핵심 로직
          // Supabase upsert 는 PostgREST 가 INSERT 로 취급해 NOT NULL 제약을 먼저 체크
          // → UPDATE 대상 id 들의 기존 DB 값을 선조회해서 엑셀에 없는 필드를 채움
          const updateIds = batch.filter(r => r._isUpdate).map(r => r.id);
          const existingMap = new Map();
          if (updateIds.length > 0) {
            const { data: existing, error: fetchErr } = await supabase
              .from('inquiries').select('*').in('id', updateIds);
            if (fetchErr) {
              fail += batch.length;
              failMsgs.push(`FC batch ${done + 1}~${done + batch.length}: 기존 데이터 조회 실패 — ${fetchErr.message}`);
              done += batch.length;
              updateProgress();
              continue;
            }
            (existing || []).forEach(e => existingMap.set(e.id, e));
          }

          const inqPayloads = batch.map(r => {
            const db = r._isUpdate ? existingMap.get(r.id) : null;
            // 엑셀 값 우선, null/빈값이면 DB 기존값, DB 값도 없으면 null
            const pick = (xl, dbKey) => (xl != null && xl !== '') ? xl : (db ? db[dbKey] : null);
            return {
              id: r.id,
              inquiry_date: pick(r.inquiry_date, 'inquiry_date'),
              name: pick(r.name, 'name'),
              phone: pick(r.phone, 'phone'),
              residence: pick(r.residence, 'residence'),
              category: pick(r.category, 'category'),
              consultation_type: pick(r.consultation_type, 'consultation_type'),
              inflow_channel: pick(r.inflow_channel, 'inflow_channel'),
              consultation_purpose: pick(r.consultation_purpose, 'consultation_purpose'),
              content: pick(r.content, 'content'),
              status: r.status || (db && db.status) || 'unregistered',
              import_batch_id: importBatchId,
            };
          });

          const { error: inqErr } = await supabase
            .from('inquiries')
            .upsert(inqPayloads, { onConflict: 'id' });

          if (inqErr) {
            fail += batch.length;
            failMsgs.push(`FC batch ${done + 1}~${done + batch.length}: inquiries upsert 실패 — ${inqErr.message}`);
            done += batch.length;
            updateProgress();
            continue;
          }

          // registrations UPSERT (등록 행 + 등록 상품 있는 것만)
          // v4 round-trip: UPDATE 는 null 필드 제외(DB 유지), INSERT 는 NOT NULL 기본값 채움
          const regPayloads = batch
            .filter(r => r.status === 'registered' && r.product)
            .map(r => {
              const p = {
                inquiry_id: r.id,
                registered_date: r.inquiry_date,
                product: r.product,
                total_payment_cash: r.total_payment_cash,
                total_payment_card: r.total_payment_card,
                contract_manager: r.contract_manager,   // v6: 계약직원
                sales_manager: r.sales_manager,          // v6: 매출담당직원
                spt_count: (r.spt_count != null && r.spt_count >= 0) ? r.spt_count : null,
                spt_preferred_time: r.spt_preferred_time,
                import_batch_id: importBatchId,
              };
              if (r._isUpdate) {
                pruneNullFields(p, ['inquiry_id', 'import_batch_id']);
              } else {
                // INSERT: NOT NULL 기본값 채움
                p.total_payment_cash = p.total_payment_cash ?? 0;
                p.total_payment_card = p.total_payment_card ?? 0;
              }
              return p;
            });

          if (regPayloads.length > 0) {
            const { error: regErr } = await supabase
              .from('registrations')
              .upsert(regPayloads, { onConflict: 'inquiry_id' });
            if (regErr) {
              failMsgs.push(`FC batch registrations 부분 실패 — ${regErr.message}`);
            }
          }

          ok += batch.length;
          done += batch.length;
          updateProgress();
        }
      } else {
        // ── PT: pt_registrations UPSERT ──
        for (const batch of chunk(toProcess, BATCH_SIZE)) {
          // v4: Round-trip 불변성 — UPDATE 는 DB 기존값 + 엑셀값 병합
          const updateIds = batch.filter(r => r._isUpdate).map(r => r.id);
          const existingMap = new Map();
          if (updateIds.length > 0) {
            const { data: existing, error: fetchErr } = await supabase
              .from('pt_registrations').select('*').in('id', updateIds);
            if (fetchErr) {
              fail += batch.length;
              failMsgs.push(`PT batch ${done + 1}~${done + batch.length}: 기존 데이터 조회 실패 — ${fetchErr.message}`);
              done += batch.length;
              updateProgress();
              continue;
            }
            (existing || []).forEach(e => existingMap.set(e.id, e));
          }

          const payloads = batch.map(r => {
            const db = r._isUpdate ? existingMap.get(r.id) : null;
            const pick = (xl, dbKey) => (xl != null && xl !== '') ? xl : (db ? db[dbKey] : null);
            const pickNum = (xl, dbKey, fallback) => {
              if (xl != null && xl !== '') return xl;
              if (db && db[dbKey] != null) return db[dbKey];
              return fallback;
            };
            return {
              id: r.id,
              name: pick(r.name, 'name'),
              contract_date: pick(r.contract_date, 'contract_date'),
              category: pick(r.category, 'category'),
              // v7: product 저장 안 함 (횟수와 의미 중복, 2026-04-19 사용자 확정)
              pt_count: pickNum(r.pt_count, 'pt_count', null),
              total_payment_cash: pickNum(r.total_payment_cash, 'total_payment_cash', 0),
              total_payment_card: pickNum(r.total_payment_card, 'total_payment_card', 0),
              session_price: pickNum(r.session_price, 'session_price', 0),
              contract_trainer_id: pick(r.contract_trainer_id, 'contract_trainer_id'),
              assigned_trainer_id: pick(r.assigned_trainer_id, 'assigned_trainer_id'),
              gym_location: pick(r.gym_location, 'gym_location') || '미사점',
              // v7: 두 앱 분리 운영 중 — 자동 동기화 꺼둠. 'disabled' 상태로 저장하여 pg_cron 재활성돼도 스킵됨.
              sync_status: r._isUpdate ? (db?.sync_status || 'disabled') : 'disabled',
              import_batch_id: importBatchId,
            };
          });

          const { error: ptErr } = await supabase
            .from('pt_registrations')
            .upsert(payloads, { onConflict: 'id' });

          if (ptErr) {
            fail += batch.length;
            failMsgs.push(`PT batch ${done + 1}~${done + batch.length}: upsert 실패 — ${ptErr.message}`);
            done += batch.length;
            updateProgress();
            continue;
          }

          ok += batch.length;
          done += batch.length;
          updateProgress();

          // 신규 INSERT + 현재데이터면 VeraGym 동기화 RPC 호출
          if (!isHistorical) {
            for (const r of batch) {
              if (r._isUpdate) continue;  // 기존 행은 sync 스킵
              try {
                const { data: syncRes, error: syncErr } = await supabase.rpc('pt_registration_sync', {
                  p_pt_reg_id: r.id
                });
                if (syncErr || (syncRes && syncRes.ok === false)) {
                  failMsgs.push(`R${r._rowNum} 동기화 실패 (자동 재시도 예정): ${syncErr?.message || syncRes?.error || ''}`);
                }
              } catch (e) {
                failMsgs.push(`R${r._rowNum} sync rpc 예외: ${e.message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      const remain = toProcess.length - ok;
      fail += remain;
      failMsgs.push(`치명 예외: ${err.message}`);
    }

    // 완료
    step.style.display = 'none';
    const doneEl = document.getElementById('imp-step-done');
    doneEl.style.display = 'block';
    doneEl.innerHTML = `
      <div style="text-align:center; padding:20px;">
        <div style="font-size:48px; margin-bottom:12px;">${fail === 0 ? '✅' : '⚠️'}</div>
        <h3>Import 완료</h3>
        <p style="margin-top:8px; color:var(--color-text-secondary);">
          성공 <strong>${ok}</strong>건${fail > 0 ? ` · 실패 <strong style="color:var(--color-danger)">${fail}</strong>건` : ''}
          <br><span style="font-size:12px;">신규 <strong>${insertCount}</strong>건 · 갱신 <strong>${updateCount}</strong>건</span>
        </p>
        <p style="margin-top:10px; font-size:11px; color:var(--color-text-muted); font-family:monospace; word-break:break-all;">
          batch_id: ${importBatchId}
          <br><span>사고 시 DELETE WHERE import_batch_id='${importBatchId}' 로 일괄 롤백 가능</span>
        </p>
        ${failMsgs.length > 0 ? `
          <details style="margin-top:16px; text-align:left;">
            <summary style="cursor:pointer; font-size:13px;">상세 로그 (${failMsgs.length}건)</summary>
            <div style="max-height:200px; overflow-y:auto; font-size:12px; font-family:monospace; padding:8px; background:var(--color-bg-2); border-radius:var(--radius-xs); margin-top:8px;">
              ${failMsgs.slice(0, 80).map(m => `<div>${escapeHtml(m)}</div>`).join('')}
              ${failMsgs.length > 80 ? `<div>... 외 ${failMsgs.length - 80}건</div>` : ''}
            </div>
          </details>
        ` : ''}
        <button class="btn btn-primary" style="margin-top:20px;" onclick="Modal.close()">확인</button>
      </div>
    `;

    // 해당 탭 새로고침
    setTimeout(() => {
      if (sheetType === 'FC' && typeof InquiryTab !== 'undefined') {
        const pane = document.getElementById('tab-inquiry');
        if (pane && pane.querySelector('#inquiry-list')) InquiryTab.init();
      } else if (sheetType === 'PT' && typeof PtTab !== 'undefined') {
        const pane = document.getElementById('tab-pt');
        if (pane && pane.querySelector('#pt-list')) PtTab.init();
      }
    }, 400);
  }

  // ═════════════════════════════════════════════════════════
  //                    Export (내보내기)
  // ═════════════════════════════════════════════════════════
  function openExport() {
    state = { mode: 'export' };

    Modal.open({
      type: 'center',
      title: '엑셀 내보내기',
      size: 'lg',
      html: `
        <div id="exp-config">
          <div class="form-grid">
            <div class="form-group full">
              <label>시트</label>
              <div class="sheet-toggle" role="tablist" aria-label="시트 선택">
                <button type="button" class="sheet-toggle-btn active" data-sheet="FC" role="tab">FC 상담</button>
                <button type="button" class="sheet-toggle-btn" data-sheet="PT" role="tab">PT 등록</button>
              </div>
            </div>

            <div class="form-group">
              <label>기간 시작 (선택)</label>
              <input type="date" id="exp-date-from">
            </div>
            <div class="form-group">
              <label>기간 종료 (선택)</label>
              <input type="date" id="exp-date-to">
            </div>

            <div class="form-group" id="exp-status-group">
              <label>상태 (FC 전용)</label>
              <select id="exp-status" class="form-select">
                <option value="all">전체</option>
                <option value="registered">등록</option>
                <option value="unregistered">미등록</option>
              </select>
            </div>

            <div class="form-group" id="exp-contract-group">
              <label>계약직원 (선택)</label>
              <input type="text" id="exp-contract" placeholder="비우면 전체 / 이름 정확히 일치">
            </div>

            <div class="form-group">
              <label>매출담당직원 (선택)</label>
              <input type="text" id="exp-sales" placeholder="비우면 전체 / 이름 정확히 일치">
            </div>
          </div>

          <p style="font-size:12px; color:var(--color-text-muted); margin-top:12px;">
            * 비어있는 필터는 '전체'로 적용됩니다. 기간은 FC=상담 일시 / PT=날짜(contract_date) 기준.<br>
            * PT 시트 선택 시 '매출담당직원' 필터는 매출담당/계약담당 트레이너 이름으로 작동합니다.
          </p>

          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="Modal.close()">취소</button>
            <button type="button" class="btn btn-primary" id="btn-export-run">내보내기</button>
          </div>
        </div>
      `,
      onOpen: (el) => {
        // 토글 버튼: FC/PT 전환
        const applyToggle = (sheet) => {
          el.querySelectorAll('.sheet-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.sheet === sheet);
          });
          // FC 전용 필드 표시/숨김
          const isFC = sheet === 'FC';
          el.querySelector('#exp-status-group').style.display = isFC ? '' : 'none';
          el.querySelector('#exp-contract-group').style.display = isFC ? '' : 'none';
        };
        el.querySelectorAll('.sheet-toggle-btn').forEach(b =>
          b.addEventListener('click', () => applyToggle(b.dataset.sheet))
        );
        el.querySelector('#btn-export-run').addEventListener('click', runExport);
      }
    });
  }

  async function runExport() {
    // v6: 토글 버튼에서 active 클래스로 시트 판정
    const activeToggle = document.querySelector('.sheet-toggle-btn.active');
    const sheetType = activeToggle ? activeToggle.dataset.sheet : 'FC';
    const dateFrom = document.getElementById('exp-date-from').value || null;
    const dateTo = document.getElementById('exp-date-to').value || null;
    const statusFilter = document.getElementById('exp-status').value;
    const contractFilter = document.getElementById('exp-contract')?.value.trim() || '';
    const salesFilter = document.getElementById('exp-sales').value.trim();

    const btn = document.getElementById('btn-export-run');
    btn.disabled = true;
    btn.textContent = '조회 중...';

    let rows = [];
    try {
      if (sheetType === 'FC') {
        rows = await exportFCQuery({
          dateFrom, dateTo, status: statusFilter,
          contractManager: contractFilter || null,
          salesManager: salesFilter || null
        });
      } else {
        // PT 는 contract_trainer 이름 필터 (기존 매출담당 필터 자리에 매핑)
        rows = await exportPTQuery({ dateFrom, dateTo, manager: salesFilter });
      }
    } catch (err) {
      Toast.error('조회 실패: ' + err.message);
      btn.disabled = false;
      btn.textContent = '내보내기';
      return;
    }

    // v6.3: rows.length === 0 이어도 헤더만 포함된 빈 템플릿 생성 진행 (신규 데이터 최초 투입용)
    if (rows.length === 0) {
      Toast.info('데이터 0건 — 헤더만 포함된 빈 템플릿으로 내보냅니다.');
    }

    // 엑셀 빌드: R1 공백 / R2 헤더 / R3~ 데이터
    const headers = sheetType === 'FC' ? FC_HEADERS : PT_HEADERS;
    const sheetData = [
      new Array(headers.length).fill(''),
      headers,
      ...rows,
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData, { cellDates: true });

    // ── v4: id 컬럼 (맨 끝) 숨김 + 헤더 주석 ──
    // SheetJS CE 는 cell styles (.s) 공식 미지원이고 적용하면 !cols.hidden 이 drop 됨.
    // → cell styles 제거, 컬럼 숨김 (hidden:true + wch:0.1 2중 방어) + 헤더 셀 주석만 유지
    const idColIdx = headers.length - 1;

    // id 헤더 셀에 주석 (엑셀에서 hover 시 표시)
    const hdrAddr = XLSX.utils.encode_cell({ r: 1, c: idColIdx });
    if (ws[hdrAddr]) {
      ws[hdrAddr].c = [{ a: 'System', t: '시스템 관리 컬럼 — 수정 금지.\n기존 행은 그대로 두고, 신규 행은 빈 칸으로 두세요.' }];
    }

    // v6.4: 시트 보호 제거 — SheetJS CE 가 cell-level locked=false 를 반영 못 해
    //        전체 셀이 잠기는 이슈 → 사용자 편집 불가. id 열은 hidden + JSZip 주입으로만 보호.

    // 컬럼 폭 + id 열 숨김 (이중 방어)
    // - hidden: true — 엑셀에서 열 자체 숨김
    // - wch: 0.1     — 혹시 hidden 이 무시되더라도 사실상 보이지 않는 폭
    // - customWidth: 1 — SheetJS CE 가 !cols 를 xml 에 출력하는 필수 플래그
    ws['!cols'] = headers.map((_, i) =>
      i === idColIdx
        ? { wch: 0.1, hidden: true, customWidth: 1 }
        : { wch: 14, customWidth: 1 }
    );

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetType);

    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `${sheetType}_내보내기_${yyyymmdd}.xlsx`;

    // v4: SheetJS CE 의 !cols.hidden drop 이슈 회피 → XLSX.write 후 JSZip 으로 sheet1.xml 직접 수정
    const binOriginal = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    let finalBin;
    try {
      const zip = await JSZip.loadAsync(binOriginal);
      const sheetXmlFile = zip.file('xl/worksheets/sheet1.xml');
      if (sheetXmlFile) {
        let sheetXml = await sheetXmlFile.async('string');
        const colNum = idColIdx + 1;  // xlsx 는 1-based
        // <col min="N" max="N" ... /> 찾아서 hidden="true" 속성 주입 (중복 방지)
        const colRe = new RegExp(`(<col\\s+min="${colNum}"\\s+max="${colNum}"[^/]*?)(?:\\s+hidden="true")?(\\s*/>)`, 'g');
        sheetXml = sheetXml.replace(colRe, '$1 hidden="true"$2');
        zip.file('xl/worksheets/sheet1.xml', sheetXml);
        finalBin = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      } else {
        finalBin = binOriginal;
      }
    } catch (zerr) {
      console.warn('[Export] JSZip 후처리 실패 — 원본 파일 사용:', zerr);
      finalBin = binOriginal;
    }

    const blob = new Blob([finalBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    Toast.success(`${rows.length}건 내보내기 완료 — ${filename} (id 열 숨김 처리됨)`);
    Modal.close();
  }

  async function exportFCQuery({ dateFrom, dateTo, status, contractManager, salesManager }) {
    let q = supabase
      .from('inquiries')
      .select('id, inquiry_date, name, phone, residence, category, consultation_type, inflow_channel, consultation_purpose, content, status, registrations(product, total_payment, total_payment_cash, total_payment_card, contract_manager, sales_manager, spt_count, spt_preferred_time)')
      .order('inquiry_date', { ascending: true });

    if (dateFrom) q = q.gte('inquiry_date', dateFrom);
    if (dateTo) q = q.lte('inquiry_date', dateTo);
    if (status && status !== 'all') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let filtered = data || [];
    // v6: 계약직원 / 매출담당직원 각각 필터
    if (contractManager) {
      filtered = filtered.filter(d => d.registrations?.contract_manager === contractManager);
    }
    if (salesManager) {
      filtered = filtered.filter(d => d.registrations?.sales_manager === salesManager);
    }

    return filtered.map(d => {
      const reg = d.registrations;
      return [
        d.inquiry_date ? new Date(d.inquiry_date) : '',
        d.name || '',
        d.phone || '',
        d.residence || '',
        d.category || '',
        d.consultation_type || '',
        d.inflow_channel || '',
        d.consultation_purpose || '',
        d.content || '',
        d.status === 'registered' ? '등록' : '미등록',
        reg ? (reg.product || '') : '',
        reg ? (reg.total_payment || 0) : '',
        reg ? (reg.total_payment_cash || 0) : '',
        reg ? (reg.total_payment_card || 0) : '',
        reg ? (reg.contract_manager || '') : '',  // v6: 15번째 계약직원
        reg ? (reg.sales_manager || '') : '',      // v6: 16번째 매출담당직원
        reg && reg.spt_count != null ? reg.spt_count : '',  // 17
        reg ? (reg.spt_preferred_time || '') : '',           // 18
        d.id || '',                                          // 19 id
      ];
    });
  }

  async function exportPTQuery({ dateFrom, dateTo, manager }) {
    // v7: 매출담당(assigned) + 계약담당(contract) 두 트레이너 조회
    let q = supabase
      .from('pt_registrations')
      .select(`
        id, contract_date, name, category, product, pt_count,
        total_payment, total_payment_cash, total_payment_card,
        contract_trainer:trainers!pt_registrations_contract_trainer_id_fkey(name),
        assigned_trainer:trainers!pt_registrations_assigned_trainer_id_fkey(name)
      `)
      .order('contract_date', { ascending: true });

    if (dateFrom) q = q.gte('contract_date', dateFrom);
    if (dateTo) q = q.lte('contract_date', dateTo);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let filtered = data || [];
    // 매출담당 기준 필터 (assigned_trainer) — 기존 manager 파라미터 재활용
    if (manager) {
      filtered = filtered.filter(d =>
        d.assigned_trainer?.name === manager || d.contract_trainer?.name === manager
      );
    }

    // v7 10컬럼: 날짜|이름|구분|등록종목|총결제액|계좌이체|카드|매출담당|계약담당|id
    // product 컬럼은 DB 저장 안 하지만, round-trip 위해 pt_count 에서 "PT N회" 형식으로 파생 생성
    return filtered.map(d => [
      d.contract_date ? new Date(d.contract_date) : '',
      d.name || '',
      d.category || '',
      d.pt_count ? `PT ${d.pt_count}회` : '',   // col4 등록종목 — pt_count 파생
      d.total_payment || ((d.total_payment_cash || 0) + (d.total_payment_card || 0)),
      d.total_payment_cash || 0,
      d.total_payment_card || 0,
      d.assigned_trainer?.name || '',         // col8 매출담당
      d.contract_trainer?.name || '',         // col9 계약담당
      d.id || '',                             // col10 id
    ]);
  }

  // ═════════════════════════════════════════════════════════
  //                    Helpers
  // ═════════════════════════════════════════════════════════
  function toStr(v) {
    if (v == null) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    return String(v).trim();
  }

  function toInt(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.trunc(v);
    const s = String(v).replace(/[^0-9\-]/g, '');
    if (!s || s === '-') return null;
    const n = parseInt(s);
    return isNaN(n) ? null : n;
  }

  function toDateStr(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : toYMD(v);
    const s = String(v).trim();
    // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
    const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) {
      const mo = m[2].padStart(2, '0');
      const d = m[3].padStart(2, '0');
      return `${m[1]}-${mo}-${d}`;
    }
    const parsed = new Date(s);
    return isNaN(parsed.getTime()) ? null : toYMD(parsed);
  }

  function toYMD(d) {
    // 로컬 타임존 기준 YYYY-MM-DD (UTC 변환 시 하루 어긋나는 이슈 방지)
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('010')) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    }
    // 포맷 불일치 → 숫자만 형태로 반환 (경고는 analyzeRows에서)
    return digits || null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // UPDATE payload 에서 null/undefined/빈문자열 필드를 제거해 DB 기존값을 유지
  // (round-trip 불변성 핵심 헬퍼)
  // keep: 반드시 유지해야 하는 키 목록 (id, import_batch_id 같은 제어용)
  function pruneNullFields(obj, keep) {
    const keepSet = new Set(keep || []);
    Object.keys(obj).forEach(k => {
      if (keepSet.has(k)) return;
      const v = obj[k];
      if (v == null || v === '') delete obj[k];
    });
  }

  // crypto.randomUUID 미지원 브라우저용 폴백 (구식 브라우저 보호)
  function uuidFallback() {
    // RFC4122 v4 형식
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  return { open, openExport };
})();
