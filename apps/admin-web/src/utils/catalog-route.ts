import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { headings } from '../router';
import type { Author, Page } from '../catalog-types';
import type { WorkItem } from '../work-list-types';

export type CatalogRoute = { view: keyof typeof headings; authorId?: string; params: URLSearchParams; fullPath: string };
export type WorkListPage = { data: Page<WorkItem>; params: URLSearchParams; author: Author | null; route: CatalogRoute };
export type ListLoadOptions = { showLoading?: boolean; workPage?: WorkListPage };
export type QueryChanges = Record<string, string | number | null>;
export type NavigationOptions = { replace?: boolean; workPage?: WorkListPage };

export function readCatalogRoute(current: RouteLocationNormalizedLoaded): CatalogRoute {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(current.query)) {
        for (const item of Array.isArray(value) ? value : [value]) params.append(key, item ?? '');
    }
    return {
        view: current.meta.section as CatalogRoute['view'],
        authorId: typeof current.params.authorId === 'string' ? current.params.authorId : undefined,
        params, fullPath: current.fullPath,
    };
}

export function applyCatalogQuery(previous: URLSearchParams, changes: QueryChanges) {
    const params = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(changes)) {
        if (value != null && value !== '' && !(key === 'page' && Number(value) === 1)) params.set(key, String(value));
        else params.delete(key);
    }
    return params;
}
