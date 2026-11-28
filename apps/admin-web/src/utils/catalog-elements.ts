import { requiredElement } from '../dom';

type CatalogElements =
    & Record<'modal', HTMLDialogElement>
    & Record<'review-form', HTMLFormElement>
    & Record<'link-search' | 'search' | 'select-page' | 'select-issue-page', HTMLInputElement>
    & Record<'modal-fullscreen' | 'scan-button' | 'open-douyin' | 'add-link' | 'confirm-author-links' | 'confirm-removal'
        | 'reload-author-links' | 'batch-delete-selection', HTMLButtonElement>;

type IdElement<K extends string> = K extends keyof CatalogElements ? CatalogElements[K] : HTMLElement;

export const byId = <K extends string>(id: K) => requiredElement<IdElement<K>>(document, `#${id}`);
export const findId = <K extends string>(id: K) => document.getElementById(id) as IdElement<K> | null;
