/**
 * nav-pages.js  v1.2
 *
 * Изменения v1.2:
 *  - Добавлена кнопка «📈 График» для возврата к графику
 *  - ESC закрывает текущую страницу и возвращает к графику
 *  - Активная страница подсвечена, «График» активна по умолчанию
 */

(function () {
  'use strict';

  let currentPage  = 'chart';
  let setupsInited   = false;
  let backtestInited = false;

  const router = {
    navigate(page) {
      currentPage = page;
      updateHighlight();
      if (page === 'chart') { hidePage(); return; }
      showPage(page);
      if (page === 'setups') {
        if (!setupsInited) { setupsInited = true; window.setupsPage?.init(); }
        else window.setupsPage?.reload();
      }
      if (page === 'backtest') {
        if (!backtestInited) { backtestInited = true; window.backtestPage?.init(); }
        else window.backtestPage?.reload();
      }
    },
    current: () => currentPage,
  };

  window.spRouter = router;

  // ── ESC для возврата к графику ────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentPage !== 'chart') {
      router.navigate('chart');
    }
  });

  function injectNavButtons() {
    const navRight = document.querySelector('.navbar-right');
    if (!navRight) { setTimeout(injectNavButtons, 300); return; }
    if (document.getElementById('nav-chart-btn')) return;

    // Кнопка «График» — возврат к графику
    const btnChart = document.createElement('button');
    btnChart.id = 'nav-chart-btn';
    btnChart.className = 'nav-btn nav-page-btn nav-page-btn-active';
    btnChart.title = 'Вернуться к графику (ESC)';
    btnChart.innerHTML = '📈 График';
    btnChart.addEventListener('click', () => router.navigate('chart'));

    // Кнопка «Сетапы»
    const btnSetups = document.createElement('button');
    btnSetups.id = 'nav-setups-btn';
    btnSetups.className = 'nav-btn nav-page-btn';
    btnSetups.textContent = '📐 Сетапы';
    btnSetups.addEventListener('click', () => router.navigate('setups'));

    // Кнопка «Бэктест»
    const btnBacktest = document.createElement('button');
    btnBacktest.id = 'nav-backtest-btn';
    btnBacktest.className = 'nav-btn nav-page-btn';
    btnBacktest.textContent = '📊 Бэктест';
    btnBacktest.addEventListener('click', () => router.navigate('backtest'));

    // Разделитель
    const sep = document.createElement('div');
    sep.className = 'nav-page-sep';

    navRight.insertBefore(btnBacktest, navRight.firstChild);
    navRight.insertBefore(btnSetups,   navRight.firstChild);
    navRight.insertBefore(sep,         navRight.firstChild);
    navRight.insertBefore(btnChart,    navRight.firstChild);

    injectCSS();
    injectContainers();
  }

  function injectContainers() {
    if (document.getElementById('page-overlay')) return;

    // Монтируем overlay в .main-content чтобы navbar остался виден
    // Если main-content не найден — монтируем в app-container
    const mount = document.querySelector('.main-content') || document.querySelector('.app-container');
    if (!mount) return;

    const overlay = document.createElement('div');
    overlay.id = 'page-overlay';
    overlay.innerHTML = `
      <div id="setups-page-container"   class="page-container" style="display:none">
        <div id="setups-page-root"   style="height:100%"></div>
      </div>
      <div id="backtest-page-container" class="page-container" style="display:none">
        <div id="backtest-page-root" style="height:100%"></div>
      </div>
    `;
    mount.appendChild(overlay);
    mount.style.position = 'relative';
  }

  function showPage(page) {
    const overlay = document.getElementById('page-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.querySelectorAll('.page-container').forEach(c => c.style.display = 'none');
    const c = document.getElementById(`${page}-page-container`);
    if (c) c.style.display = 'flex';
  }

  function hidePage() {
    const overlay = document.getElementById('page-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function updateHighlight() {
    ['chart', 'setups', 'backtest'].forEach(page => {
      const btn = document.getElementById(`nav-${page}-btn`);
      if (btn) btn.classList.toggle('nav-page-btn-active', currentPage === page);
    });
  }

  function injectCSS() {
    if (document.getElementById('nav-pages-css')) return;
    const style = document.createElement('style');
    style.id = 'nav-pages-css';
    style.textContent = `
/* Nav page buttons */
.nav-page-btn {
  font-weight: 600;
  transition: background .12s, color .12s, border-color .12s;
}
.nav-page-btn-active {
  background: rgba(79,109,245,.15) !important;
  color: #4f6df5 !important;
  border-color: rgba(79,109,245,.35) !important;
  border-radius: 6px;
}
#nav-chart-btn.nav-page-btn-active {
  background: rgba(34,197,94,.12) !important;
  color: #16a34a !important;
  border-color: rgba(34,197,94,.3) !important;
}
.nav-page-sep {
  width: 1px;
  height: 20px;
  background: rgba(128,128,128,.25);
  margin: 0 4px;
  align-self: center;
  flex-shrink: 0;
}

/* Overlay */
#page-overlay {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: none;
  z-index: 50;
  background: var(--page-bg, #f8f9fc);
  flex-direction: column;
}
/* Navbar должен быть поверх overlay */
.top-navbar {
  position: relative;
  z-index: 200;
}
body.dark-theme #page-overlay { background: #060810; }

.page-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-container { position: relative; }

/* Light theme */
body.light-theme .nav-page-btn-active {
  background: rgba(41,98,255,.1) !important;
  color: #2962ff !important;
  border-color: rgba(41,98,255,.3) !important;
}
body.light-theme #nav-chart-btn.nav-page-btn-active {
  background: rgba(22,163,74,.1) !important;
  color: #15803d !important;
  border-color: rgba(22,163,74,.3) !important;
}
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNavButtons);
  else injectNavButtons();

})();