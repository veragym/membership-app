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
