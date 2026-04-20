/**
 * 인증 모듈
 * - Supabase signInWithPassword
 * - trainers.role IN ('admin','counselor') 또는 is_admin=true 검증
 *
 * 회원권 앱 사용자 구분:
 *   - admin: 관리자 (두 앱 모두 접근)
 *   - counselor: 상담 직원 (회원권 앱 전용)
 *   - trainer: 베라짐 앱 전용 — 회원권 앱 로그인 차단
 */
const Auth = (() => {
  let currentUser = null;   // auth.users 정보
  let currentTrainer = null; // trainers 행

  async function checkSession() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const trainer = await verifyAppAccess(user.id);
    if (!trainer) {
      await supabase.auth.signOut();
      return null;
    }

    currentUser = user;
    currentTrainer = trainer;
    return trainer;
  }

  // @ 없으면 @vg.internal 자동 보정 (예: "admin" → "admin@vg.internal")
  function normalizeEmail(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return trimmed;
    return trimmed.includes('@') ? trimmed : `${trimmed}@vg.internal`;
  }

  async function login(email, password) {
    const normalized = normalizeEmail(email);
    const { data, error } = await supabase.auth.signInWithPassword({ email: normalized, password });
    if (error) throw new Error(error.message);

    const trainer = await verifyAppAccess(data.user.id);
    if (!trainer) {
      await supabase.auth.signOut();
      throw new Error('이 앱은 관리자·상담 직원 전용입니다. 접근 권한이 없습니다.');
    }

    currentUser = data.user;
    currentTrainer = trainer;
    return trainer;
  }

  // 회원권 앱 접근 권한 체크: role IN ('admin','counselor') 또는 is_admin=true
  async function verifyAppAccess(authId) {
    const { data, error } = await supabase
      .from('trainers')
      .select('id, name, role, is_admin')
      .eq('auth_id', authId)
      .single();

    if (error || !data) return null;
    const allowed = data.role === 'admin' || data.role === 'counselor' || data.is_admin === true;
    if (!allowed) return null;
    return data;
  }

  async function logout() {
    await supabase.auth.signOut();
    currentUser = null;
    currentTrainer = null;
  }

  function getTrainer() { return currentTrainer; }
  function getRole() { return currentTrainer ? currentTrainer.role : null; }
  function isPureAdmin() {
    return currentTrainer
      ? (currentTrainer.role === 'admin' || currentTrainer.is_admin === true)
      : false;
  }

  return { checkSession, login, logout, getTrainer, getRole, isPureAdmin };
})();
