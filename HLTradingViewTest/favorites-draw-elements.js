(function () {
    const KEY_LOCAL_STORAGE = 'tradingview.chart.favoriteDrawings';
    const DB_ENDPOINT = 'https://bot32.app:5443/api/user/favorites';

    let isSyncStarted = false;

    async function checkAuth() {
        try {
            const response = await fetch('/api/auth/status');
            if (!response.ok) return { authenticated: false };
            return await response.json();
        } catch (err) {
            return { authenticated: false };
        }
    }

    async function loadFavoritesFromDB() {
        try {
            const response = await fetch(DB_ENDPOINT);
            if (!response.ok) return;

            const data = await response.json();
            if (data && data.favorites) {
                const favoritesString = JSON.stringify(data.favorites);

                if (localStorage.getItem(KEY_LOCAL_STORAGE) !== favoritesString && data.favorites.length !== 0) {
                    localStorage.setItem(KEY_LOCAL_STORAGE, favoritesString);
                    window.location.reload();
                }
            }
        } catch (err) {
            console.error('❌ Ошибка загрузки из БД:', err);
        }
    }

    function watchAndSave() {
        let lastFavorites = localStorage.getItem(KEY_LOCAL_STORAGE);

        setInterval(() => {
            const currentFavorites = localStorage.getItem(KEY_LOCAL_STORAGE);

            if (currentFavorites && currentFavorites !== lastFavorites) {
                lastFavorites = currentFavorites;

                console.log('Обнаружено изменение в избранном, сохраняю...');

                fetch(DB_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        favorites: JSON.parse(currentFavorites)
                    })
                })
                    .then(res => {
                        if (res.ok) console.log('✅ Успешно сохранено в БД');
                        else console.error('❌ Ошибка сохранения:', res.statusText);
                    })
                    .catch(err => console.error('❌ Ошибка сети при сохранении:', err));
            }
        }, 1000);
    }

    async function initSync() {
        const authInterval = setInterval(async () => {
            const auth = await checkAuth();

            if (auth.authenticated && !isSyncStarted) {
                isSyncStarted = true;
                clearInterval(authInterval);
                await loadFavoritesFromDB();
                watchAndSave();
            }
        }, 5000);
    }

    initSync();
})();

// Ждем, пока легенда загрузится
setTimeout(function () {
    // Находим блок с кнопками в легенде
    const buttonsWrapper = document.querySelector('[data-name="actions"] .buttons-l31H9iuA');

    if (buttonsWrapper) {
        // Создаем новую кнопку
        const newButton = document.createElement('button');
        newButton.className = 'button-l31H9iuA apply-common-tooltip accessible-l31H9iuA';
        newButton.setAttribute('aria-label', 'Моя иконка');
        newButton.setAttribute('type', 'button');
        newButton.innerHTML = `
            <div class="buttonIcon-l31H9iuA">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
            </div>
        `;

        // Что будет при клике
        newButton.addEventListener('click', function () {
            alert('Моя иконка нажата!');
            // тут твоя логика
        });

        // Добавляем перед кнопкой "Ещё" (три точки)
        const moreButton = buttonsWrapper.querySelector('[data-qa-id="legend-more-action"]');
        if (moreButton) {
            buttonsWrapper.insertBefore(newButton, moreButton);
        } else {
            buttonsWrapper.appendChild(newButton);
        }
    }
}, 1000); // ждем 1 секунду, чтобы легенда точно отрендерилась