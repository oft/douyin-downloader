import { errorMessage, eventElement } from '../dom';
import { byId } from '../utils/catalog-elements';
import { localPathLabel } from '../utils/format';
import type { ShowToast } from './useToast';

type DialogOptions = { showToast: ShowToast; signal: AbortSignal; getRoot: () => string | undefined };

export function useCatalogDialog({ showToast, signal, getRoot }: DialogOptions) {
    const modal = byId('modal');
    const modalContent = byId('modal-content');
    const fullscreenButton = byId('modal-fullscreen');
    const body = byId('modal-body');
    let modalVersion = 0;
    let disposeWorkPreview: (() => void) | undefined;
    let deleting = false;

    function clearModalBody() {
        disposeWorkPreview?.();
        disposeWorkPreview = undefined;
        body.replaceChildren();
    }

    function updateFullscreenButton() {
        const workOpen = modal.open && modal.classList.contains('work-modal');
        const fullscreen = document.fullscreenElement === modalContent;
        fullscreenButton.hidden = !document.fullscreenEnabled || !workOpen;
        fullscreenButton.textContent = fullscreen ? '退出全屏' : '全屏';
        if (!workOpen) exitWorkFullscreen();
    }

    function exitWorkFullscreen() {
        if (document.fullscreenElement === modalContent) void document.exitFullscreen().catch(() => {});
    }

    function openModal(title: string, variant: string) {
        byId('modal-title').textContent = title;
        byId('modal-subtitle').textContent = '';
        clearModalBody();
        modal.className = variant;
        modal.scrollTop = 0;
        if (!modal.open) modal.showModal();
        updateFullscreenButton();
        return ++modalVersion;
    }

    fullscreenButton.addEventListener('click', () => {
        const change = document.fullscreenElement === modalContent ? document.exitFullscreen() : modalContent.requestFullscreen();
        void change.catch(error => showToast(`无法切换全屏：${errorMessage(error)}`, true));
    }, { signal });
    document.addEventListener('fullscreenchange', updateFullscreenButton, { signal });
    byId('modal-close').addEventListener('click', () => modal.close(), { signal });
    modal.addEventListener('cancel', event => {
        if (deleting || document.fullscreenElement === modalContent) event.preventDefault();
        if (!deleting) exitWorkFullscreen();
    }, { signal });

    modal.addEventListener('click', async event => {
        if (deleting) return;
        const target = eventElement(event);
        if (event.target === modal || target?.closest('[data-modal-link], [data-dismiss]')) modal.close();
        const copy = target?.closest<HTMLElement>('[data-copy]');
        if (!copy) return;
        try {
            const root = getRoot();
            if (!root) throw new Error('下载目录不可用');
            await navigator.clipboard.writeText(localPathLabel(root, copy.dataset.copy));
            showToast('已复制本地路径');
        } catch { showToast('无法访问剪贴板，可以手动选择路径文本', true); }
    }, { signal });

    modal.addEventListener('close', () => {
        if (modal.open) return;
        updateFullscreenButton();
        modalVersion++;
        clearModalBody();
    }, { signal });

    return {
        modal, body,
        open: openModal,
        clear: clearModalBody,
        close() { if (modal.open) modal.close(); },
        setMediaCleanup(cleanup: () => void) { disposeWorkPreview = cleanup; },
        isOpen(version: number) { return modal.open && version === modalVersion; },
        nextVersion() { return ++modalVersion; },
        get version() { return modalVersion; },
        get deleting() { return deleting; },
        set deleting(value: boolean) { deleting = value; },
    };
}
