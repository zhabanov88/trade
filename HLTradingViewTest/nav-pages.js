/**
 * nav-pages.js  v1.1
 *
 * Добавляет кнопки «Сетапы» и «Бэктест» в .navbar-right
 * и монтирует страницы через overlay поверх .app-container.
 *
 * Подключить в index.html ПОСЛЕ setups-page.js и backtest-page.js:
 *   <script src="setups-page.js"></script>
 *   <script src="backtest-page.js"></script>
 *   <script src="nav-pages.js"></script>
 */

(function () {
    'use strict';
  
    let currentPage = 'chart';
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
  
    function injectNavButtons() {
      const navRight = document.querySelector('.navbar-right');
      if (!navRight) { setTimeout(injectNavButtons, 300); return; }
      if (document.getElementById('nav-setups-btn')) return;
  
      const btnBacktest = document.createElement('button');
      btnBacktest.id = 'nav-backtest-btn';
      btnBacktest.className = 'nav-btn nav-page-btn';
      btnBacktest.textContent = '📊 Бэктест';
      btnBacktest.addEventListener('click', () => router.navigate('backtest'));
  
      const btnSetups = document.createElement('button');
      btnSetups.id = 'nav-setups-btn';
      btnSetups.className = 'nav-btn nav-page-btn';
      btnSetups.textContent = '📐 Сетапы';
      btnSetups.addEventListener('click', () => router.navigate('setups'));
  
      navRight.insertBefore(btnBacktest, navRight.firstChild);
      navRight.insertBefore(btnSetups,   navRight.firstChild);
  
      injectCSS();
      injectContainers();
    }
  
    function injectContainers() {
      if (document.getElementById('page-overlay')) return;
      const app = document.querySelector('.app-container');
      if (!app) return;
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
      app.appendChild(overlay);
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
      ['setups','backtest'].forEach(page => {
        const btn = document.getElementById(`nav-${page}-btn`);
        if (btn) btn.classList.toggle('nav-page-btn-active', currentPage === page);
      });
    }
  
    function injectCSS() {
      if (document.getElementById('nav-pages-css')) return;
      const style = document.createElement('style');
      style.id = 'nav-pages-css';
      style.textContent = `
  .nav-page-btn { font-weight: 600; transition: background .12s, color .12s; }
  .nav-page-btn-active { background: rgba(79,109,245,.15) !important; color: #4f6df5 !important; border-radius: 6px; }
  #page-overlay {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    display: none; z-index: 100;
    background: var(--page-bg, #f8f9fc);
  }
  body.dark-theme #page-overlay { background: #060810; }
  .page-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .app-container  { position: relative; }
      `;
      document.head.appendChild(style);
    }
  
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNavButtons);
    else injectNavButtons();
  
  })();