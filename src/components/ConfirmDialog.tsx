import { t } from '../i18n';

/**
 * Promise-based confirm dialog — same pattern as the Electron app.
 * Uses raw DOM insertion + CSS transition. No React state = no race conditions.
 */
export function showConfirm(msg: string, lang: string): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box">
                <p class="confirm-msg">${msg}</p>
                <div class="confirm-actions">
                    <button class="action-btn confirm-cancel">${t('cancel', lang)}</button>
                    <button class="action-btn danger confirm-ok">${t('delete', lang)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        overlay.querySelector('.confirm-cancel')!.addEventListener('click', () => {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 200);
            resolve(false);
        });
        overlay.querySelector('.confirm-ok')!.addEventListener('click', () => {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 200);
            resolve(true);
        });
    });
}
