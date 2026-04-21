/**
 * 앱 초기화 + 탭 라우팅
 */
const App = (() => {
  const TABS = ['inquiry', 'stats', 'pt', 'spt', 'promo', 'settings'];
  const tabInitialized = {};
  let activeTab = 'inquiry';

  async function init() {
    // 세션 확인
    const trainer = await Auth.checkSession();
    if (trainer) {
      showApp(trainer);
    } else {
      showLogin();
    }
  }

  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-main').style.display = 'none';
    bindLoginForm();
  }

  function showApp(trainer) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-main').style.display = 'flex';

    // 헤더에 사용자 이름 표시
    document.getElementById('user-name').textContent = trainer.name;

    // admin 전용 탭(.tab-admin-only) 표시/숨김
    //   - isPureAdmin()=true → 설정 탭 버튼 표시
    //   - counselor 등 일반 직원 → 설정 탭 버튼 숨김 유지
    const isAdmin = Auth.isPureAdmin();
    document.querySelectorAll('.tab-admin-only').forEach(btn => {
      btn.style.display = isAdmin ? '' : 'none';
    });

    // 탭 바인딩
    bindTabs();
    switchTab('inquiry');

    // 로그아웃 버튼
    document.getElementById('btn-logout').addEventListener('click', async () => {
      await Auth.logout();
      showLogin();
    });
  }

  function bindLoginForm() {
    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const submitBtn = form.querySelector('button[type="submit"]');

    // 이전 리스너 제거를 위해 clone
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);

    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = newForm.querySelector('#login-email').value.trim();
      const password = newForm.querySelector('#login-password').value;
      const btn = newForm.querySelector('button[type="submit"]');
      const err = document.getElementById('login-error');

      if (!email || !password) {
        err.textContent = '이메일과 비밀번호를 입력해주세요.';
        err.classList.add('show');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 로그인 중...';
      err.classList.remove('show');

      try {
        const trainer = await Auth.login(email, password);
        showApp(trainer);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.add('show');
      } finally {
        btn.disabled = false;
        btn.textContent = '로그인';
      }
    });
  }

  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tabId) {
    activeTab = tabId;

    // 탭 버튼 활성화
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    // 탭 패널 활성화
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `tab-${tabId}`);
    });

    // 탭 초기화 (최초 1회)
    if (!tabInitialized[tabId]) {
      tabInitialized[tabId] = true;
      if (tabId === 'inquiry' && typeof InquiryTab !== 'undefined') InquiryTab.init();
      if (tabId === 'stats' && typeof StatsTab !== 'undefined') StatsTab.init();
      if (tabId === 'pt' && typeof PtTab !== 'undefined') PtTab.init();
      if (tabId === 'spt' && typeof SptTab !== 'undefined') SptTab.init();
      if (tabId === 'promo' && typeof PromoTab !== 'undefined') PromoTab.init();
      if (tabId === 'settings' && typeof SettingsTab !== 'undefined') SettingsTab.init();
    } else {
      // 재진입 시 자동 새로고침 (SPT: 트레이너 앱 변경 반영)
      if (tabId === 'spt' && typeof SptTab !== 'undefined') SptTab.reload();
    }
  }

  return { init };
})();

// DOM 준비 후 초기화
document.addEventListener('DOMContentLoaded', App.init);
