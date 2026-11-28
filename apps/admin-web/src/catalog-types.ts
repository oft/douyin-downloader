import type { WorkItem } from './work-list-types';

export type Page<T> = { items: T[]; page: number; pages: number; total: number };
export type Author = { id: string; name: string; aliases: string[]; workCount: number; avatar?: string; issueCount?: number };
export type LinkConfig = { links: string[]; revision: string };
export type ReviewStatus = 'pending' | 'resolved' | 'ignored';
export type IssueRow = {
    id: string; path: string; code: string; detail: string; present: boolean; status: ReviewStatus;
    targetId?: string; authorName?: string; reviewedAt?: string; note?: string; title?: string;
};
export type WorkDetail = WorkItem & {
    video?: string; images: string[]; platformId?: string; issueCount?: number;
    copies: { source: string; localPath: string }[];
};
