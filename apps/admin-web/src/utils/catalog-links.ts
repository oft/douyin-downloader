import { router } from '../runtime';

export function authorLink(id: string) {
    return router.resolve({ name: 'author-works', params: { authorId: id } }).href;
}

export function issueLink(key: string, value: string) {
    return router.resolve({ name: 'issues', query: { [key]: value } }).href;
}
