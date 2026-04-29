/**
 * 전화번호 포맷: 숫자만 추출 → 010-XXXX-XXXX
 */
function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return digits.slice(0, 3) + '-' + digits.slice(3);
  return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7, 11);
}

/**
 * 디바운스
 */
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * v11: HTML 이스케이프 (XSS 방지) — innerHTML 에 DB 값 주입 시 필수
 */
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * v11: PostgREST .or() / .ilike() 입력 sanitize
 *   - % _ : PostgreSQL LIKE 와일드카드 이스케이프
 *   - , ) ( : PostgREST or() 파싱 문자 제거
 */
function sanitizeSearch(q) {
  if (!q) return '';
  return String(q)
    .replace(/[\\%_]/g, '\\$&')   // LIKE 와일드카드 이스케이프
    .replace(/[,()"]/g, '');        // PostgREST or() 예약문자 제거
}

/**
 * 전화번호 입력 필드에 자동 포맷 바인딩
 */
function bindPhoneFormat(input) {
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    const before = input.value;
    input.value = formatPhone(before);
    // 커서 위치 보정
    const diff = input.value.length - before.length;
    input.setSelectionRange(pos + diff, pos + diff);
  });
}


/**
 * 자동 발송 예약 INSERT (sms_scheduled)
 *   record: 등록된 row (registrations or pt_registrations) — id, name, phone, ... 포함
 *   triggerCategory: 'registration' or 'pt' (sms_templates.category 매칭)
 *   relatedTable: 'registrations' or 'pt_registrations'
 *
 *   동작:
 *   1) 매칭 활성 템플릿 모두 조회 (auto_send=true, category=...)
 *   2) 각 템플릿마다:
 *      - 발송 due_at = 등록일 자정 + delay_days일 + 10:00 KST
 *      - 변수 치환 (이름, 전화번호, 등록상품, 회수 등)
 *      - sms_scheduled 에 INSERT (status='pending')
 *   3) 결과 Toast (조용히, 에러 시만 warning)
 */
async function autoScheduleSmsForRegistration(record, triggerCategory, relatedTable) {
  if (!record || !record.id || !record.phone) return;

  // SMS 기능 차단 플래그 (Aligo 전환 작업 중에는 큐 추가 안 함)
  try {
    const { data: dis } = await supabase
      .from('app_secrets').select('value').eq('key', 'SMS_DISABLED').maybeSingle();
    if (dis?.value === '1') {
      console.info('[auto-sms] SMS_DISABLED=1 → sms_scheduled INSERT skip');
      return;
    }
  } catch (e) { /* 조회 실패 시 그대로 진행 */ }

  try {
    // v15: 신규/재등록 sub-filter 매칭
    //   · template.registration_category = NULL → 둘 다 매칭
    //   · '신규' → 신규 가입자만, '재등록' → 재등록자만
    //   · record.category 가 '신규' 또는 '재등록' 일 때만 sub-filter 동작
    let query = supabase
      .from('sms_templates')
      .select('id, name, msg, msg_type, title, send_once, delay_days, registration_category')
      .eq('auto_send', true)
      .eq('is_active', true)
      .eq('category', triggerCategory);

    const { data: rawTpls } = await query;
    if (!rawTpls || rawTpls.length === 0) return;

    // 신규/재등록 필터링 (클라이언트 측 — PostgREST OR 쿼리 복잡성 회피)
    const recCat = record.category;  // '신규' / '재등록' / null
    const tpls = rawTpls.filter(t => {
      if (!t.registration_category) return true;          // NULL → 둘 다 매칭
      if (!recCat) return true;                            // record 에 카테고리 정보 없으면 NULL과 동일하게 매칭
      return t.registration_category === recCat;          // 명시적 매칭
    });

    if (tpls.length === 0) return;

    // 변수 치환 컨텍스트
    const ctx = {
      이름: record.name || '',
      전화번호: record.phone || '',
      등록일: record.registered_date || record.contract_date || '',
      등록상품: record.product || '',
      회수: record.pt_count != null ? String(record.pt_count) : '',
      잔여횟수: record.pt_count != null ? String(record.pt_count) : '',
      거주지: record.residence || '',
    };
    const apply = (str) => String(str || '').replace(/\{([^{}]+)\}/g,
      (m, key) => ctx[key.trim()] != null ? ctx[key.trim()] : m);

    // 발송 시각: 등록일 + delay_days + 10:00 KST (UTC+9 → 01:00 UTC)
    // 기준 등록일 = record.registered_date or record.contract_date or 오늘
    const baseDateStr = record.registered_date || record.contract_date ||
      new Date().toISOString().slice(0, 10);

    const rows = tpls.map(tpl => {
      const due = new Date(`${baseDateStr}T01:00:00Z`); // 등록일 10:00 KST
      due.setUTCDate(due.getUTCDate() + (tpl.delay_days || 1));
      return {
        template_id: tpl.id,
        related_table: relatedTable,
        related_id: record.id,
        receiver: String(record.phone).replace(/\D/g, ''),
        receiver_name: record.name || null,
        msg: apply(tpl.msg),
        msg_type: tpl.msg_type || 'auto',
        title: tpl.title || null,
        due_at: due.toISOString(),
        status: 'pending',
      };
    });

    const { error } = await supabase.from('sms_scheduled').insert(rows);
    if (error) {
      // 23505 (unique violation) — 같은 entity 에 같은 템플릿이 이미 큐에 있음 → 정상 동작 (중복 차단)
      if (error.code === '23505' || /duplicate key/i.test(error.message)) {
        console.info('[auto-sms] 같은 등록·템플릿 조합 이미 큐에 있음 — 중복 INSERT 차단됨 (정상)');
        return;
      }
      console.warn('[auto-sms] scheduled insert failed:', error);
      if (typeof Toast !== 'undefined') Toast.warning(`자동 문자 예약 실패: ${error.message}`);
      return;
    }
    if (typeof Toast !== 'undefined') {
      const names = tpls.map(t => `${t.name} (+${t.delay_days}일)`).join(', ');
      Toast.info(`자동 문자 예약: ${names}`);
    }
  } catch (e) {
    console.warn('[auto-sms] exception:', e);
  }
}
