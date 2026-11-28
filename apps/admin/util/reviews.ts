import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Issue } from './catalog.ts';

export type ReviewStatus = 'pending' | 'resolved' | 'ignored';

interface Review {
    status: ReviewStatus;
    note: string;
    updatedAt: string;
    issue: Issue;
}

export class ReviewStore {
    private readonly file: string;
    private readonly records: Record<string, Review>;

    constructor(file: string) {
        this.file = file;
        this.records = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    }

    list(issues: Issue[]) {
        const present = new Set(issues.map(issue => issue.id));
        return [
            ...issues.map(issue => this.format(issue, true)),
            ...Object.values(this.records).filter(record => !present.has(record.issue.id)).map(record => this.format(record.issue, false)),
        ];
    }

    update(id: string, issue: Issue | undefined, status: ReviewStatus, note: string) {
        const result = this.updateMany([id], issue ? [issue] : [], status, note);
        return result?.[0];
    }

    updateMany(ids: string[], issues: Issue[], status: ReviewStatus, note?: string) {
        const current = new Map(issues.map(issue => [issue.id, issue]));
        const selected = [...new Set(ids)].map(id => current.get(id) ?? this.records[id]?.issue);
        if (selected.some(issue => !issue)) return undefined;
        const changes: Record<string, Review> = {};
        for (const issue of selected as Issue[]) changes[issue.id] = { status, note: note ?? this.records[issue.id]?.note ?? '', updatedAt: new Date().toISOString(), issue };
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        mkdirSync(path.dirname(this.file), { recursive: true });
        try {
            writeFileSync(temporary, JSON.stringify({ ...this.records, ...changes }, null, 2), { flag: 'wx' });
            renameSync(temporary, this.file);
        } finally { rmSync(temporary, { force: true }); }
        Object.assign(this.records, changes);
        return (selected as Issue[]).map(issue => this.format(issue, current.has(issue.id)));
    }

    private format(issue: Issue, present: boolean) {
        const record = this.records[issue.id];
        return { ...issue, present, status: record?.status ?? 'pending', note: record?.note ?? '', updatedAt: record?.updatedAt };
    }
}
