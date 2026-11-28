import { defineStore } from 'pinia';

export interface CatalogStatus {
    works?: number;
    authors?: number;
    pending?: number;
    root?: string;
    scanning?: boolean;
    scannedAt?: string;
    error?: string;
    databaseError?: string;
}

export const useCatalogStore = defineStore('catalog', {
    state: () => ({
        status: {} as CatalogStatus,
        selectedAuthors: new Set<string>(),
        selectedWorks: new Set<string>(),
        workScope: undefined as string | undefined,
    }),
    getters: {
        counters: state => ({
            works: state.status.works,
            authors: state.status.authors,
            issues: state.status.scannedAt ? state.status.pending : undefined,
        }),
    },
    actions: {
        enterWorkScope(authorId?: string) {
            const scope = authorId ? `author:${authorId}` : 'all-works';
            if (scope === this.workScope) return;
            this.selectedWorks.clear();
            this.workScope = scope;
        },
        replaceWorkSelection(ids: ReadonlySet<string>) {
            const selection = new Set(ids);
            this.selectedWorks.clear();
            for (const id of selection) this.selectedWorks.add(id);
        },
    },
});
