/**
 * Toast 알림
 * 사용: Toast.success('저장 완료'), Toast.error('오류 발생')
 */
const Toast = (() => {
  let container;

  function init() {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  function show(message, type = 'info', duration = 3000) {
    if (!container) init();

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }

  return {
    info:    (msg, dur) => show(msg, 'info', dur),
    success: (msg, dur) => show(msg, 'success', dur),
    error:   (msg, dur) => show(msg, 'error', dur),
    warning: (msg, dur) => show(msg, 'warning', dur),
  };
})();
