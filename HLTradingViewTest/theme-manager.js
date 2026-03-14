/**
 * Theme Manager
 * Управление темой для всего интерфейса
 */

class ThemeManager {
    constructor() {
        this.currentTheme = localStorage.getItem('tradingview_theme') || 'dark';
        this.applyThemeImmediately(this.currentTheme);
    }

    toggle() {
        const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
        
        // Сначала применяем тему ко всему UI (мгновенно)
        this.applyThemeImmediately(newTheme);
        
        // Сохраняем в localStorage
        this.currentTheme = newTheme;
        localStorage.setItem('app_theme', newTheme);
        localStorage.setItem('tradingview_theme', newTheme);

        document.querySelector('body').classList = newTheme + "-theme";
        
        // ПОТОМ перезагружаем страницу для TradingView виджета
        setTimeout(() => {
            window.location.reload();
        }, 100);
    }

    applyThemeImmediately(theme) {
        // Применяем класс к body МГНОВЕННО
        document.body.className = theme + '-theme';
        
        // Обновляем иконку кнопки
        const themeBtn = document.querySelector('.theme-toggle');
        if (themeBtn) {
            themeBtn.innerHTML = theme === 'dark' ? '☀️' : '🌙';
            themeBtn.title = theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
        }
        
        console.log(`✓ Theme applied: ${theme}`);
    }
}

// Создаём глобальный экземпляр
const themeManager = new ThemeManager();
window.themeManager = themeManager;

// Функция для кнопки
function toggleTheme() {
    themeManager.toggle();
}