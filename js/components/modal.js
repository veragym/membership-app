/**
 * 모달 매니저 — center, bottom, drawer-right 3종
 * 동시 2개 금지: 새 모달 열면 기존 모달 자동 닫힘
 */
const Modal = (() => {
  let currentModal = null;
  let overlay = null;

  function getOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.addEventListener('click', close);
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  /**
   * 모달 열기
   * @param {Object} opts
   * @param {string} opts.type - 'center' | 'bottom' | 'drawer'
   * @param {string} opts.title - 모달 제목
   * @param {string} opts.html - 내부 HTML
   * @param {Function} opts.onOpen - 열린 후 콜백 (el 전달)
   * @param {Function} opts.onClose - 닫힐 때 콜백
   * @param {string} opts.size - 'sm' | 'md' | 'lg' (center만)
   */
  function open(opts) {
    // 기존 모달 닫기
    if (currentModal) close(null, true);

    const el = document.createElement('div');
    el.className = `modal modal-${opts.type || 'center'} ${opts.size ? 'modal-' + opts.size : ''}`;
    el.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title">${opts.title || ''}</h2>
        <button class="modal-close" aria-label="닫기">&times;</button>
      </div>
      <div class="modal-body">${opts.html || ''}</div>
    `;

    el.querySelector('.modal-close').addEventListener('click', close);

    // ESC 키로 닫기
    el._onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', el._onKeyDown);

    const ov = getOverlay();
    ov.classList.add('active');
    document.body.appendChild(el);

    // 트리거 애니메이션
    requestAnimationFrame(() => el.classList.add('active'));

    currentModal = { el, opts };

    if (opts.onOpen) opts.onOpen(el);
  }

  function close(e, skipAnim) {
    if (!currentModal) return;

    const { el, opts } = currentModal;
    document.removeEventListener('keydown', el._onKeyDown);

    if (opts.onClose) opts.onClose();

    if (skipAnim) {
      el.remove();
    } else {
      el.classList.remove('active');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // fallback
      setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
    }

    if (overlay) overlay.classList.remove('active');
    currentModal = null;
  }

  function getBody() {
    return currentModal?.el.querySelector('.modal-body');
  }

  return { open, close, getBody };
})();
