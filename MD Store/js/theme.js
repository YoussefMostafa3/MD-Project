(() => {
    'use strict';

    const STORAGE_KEY = 'mdstore-theme';
    const DEFAULT_THEME = 'midnight-navy';
    const themes = [
        { id: 'midnight-navy', name: 'Midnight Navy', colors: ['#071323', '#0d1d34', '#2f6ca6', '#ead8b0'] },
        { id: 'cream-coral', name: 'Cream & Coral', colors: ['#f5f0e7', '#fffaf2', '#b93636', '#a55743'] },
        { id: 'warm-minimal', name: 'Warm Minimal', colors: ['#eeeae3', '#f8f5ef', '#76583f', '#c3a27f'] },
    ];
    const validThemes = new Set(themes.map(theme => theme.id));

    function readTheme() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            return validThemes.has(saved) ? saved : DEFAULT_THEME;
        } catch (_) {
            return DEFAULT_THEME;
        }
    }

    function applyTheme(themeId, persist = true) {
        const theme = validThemes.has(themeId) ? themeId : DEFAULT_THEME;
        document.documentElement.dataset.theme = theme;
        if (persist) {
            try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) { /* Storage can be unavailable in private contexts. */ }
        }
        document.querySelectorAll('[data-theme-choice]').forEach(choice => {
            const selected = choice.dataset.themeChoice === theme;
            choice.setAttribute('aria-checked', String(selected));
            const check = choice.querySelector('.theme-choice-check');
            if (check) check.classList.toggle('hidden', !selected);
        });
    }

    function closeMenus() {
        document.querySelectorAll('[data-theme-menu]').forEach(menu => menu.dataset.open = 'false');
        document.querySelectorAll('[data-theme-toggle]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    }

    function buildMenu(picker, index) {
        const button = picker.querySelector('[data-theme-toggle]');
        if (!button) return;
        const menuId = `mdstore-theme-menu-${index + 1}`;
        button.setAttribute('aria-controls', menuId);
        button.setAttribute('aria-expanded', 'false');
        const menu = document.createElement('div');
        menu.id = menuId;
        menu.className = 'theme-picker-menu';
        menu.dataset.themeMenu = '';
        menu.dataset.open = 'false';
        menu.setAttribute('role', 'radiogroup');
        menu.setAttribute('aria-label', 'اختيار ألوان الموقع');
        menu.innerHTML = `<div class="theme-picker-title">اختر مظهر المتجر</div>${themes.map(theme => `
            <button type="button" class="theme-choice" data-theme-choice="${theme.id}" role="radio" aria-checked="false">
                <span class="theme-swatches" aria-hidden="true">${theme.colors.map(color => `<i class="theme-swatch" style="background-color:${color}"></i>`).join('')}</span>
                <span class="theme-choice-name">${theme.name}</span>
                <i class="theme-choice-check fa-solid fa-check hidden" aria-hidden="true"></i>
            </button>`).join('')}`;
        picker.appendChild(menu);
        button.addEventListener('click', () => {
            const shouldOpen = menu.dataset.open !== 'true';
            closeMenus();
            menu.dataset.open = String(shouldOpen);
            button.setAttribute('aria-expanded', String(shouldOpen));
        });
    }

    document.documentElement.dataset.theme = readTheme();
    document.querySelectorAll('[data-theme-picker]').forEach(buildMenu);
    applyTheme(readTheme(), false);

    document.addEventListener('click', event => {
        const choice = event.target.closest('[data-theme-choice]');
        if (choice) {
            applyTheme(choice.dataset.themeChoice);
            closeMenus();
            return;
        }
        if (!event.target.closest('[data-theme-picker]')) closeMenus();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMenus();
    });
})();
