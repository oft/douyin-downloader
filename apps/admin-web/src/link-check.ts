export const linkCheckNames = { valid: '正常', unavailable: '不可访问', restricted: '访问受限', invalid: '格式无效', unknown: '待确认' };

export type LinkCheckStatus = keyof typeof linkCheckNames;
export type LinkCheckResult = { link: string; status: LinkCheckStatus; reason: string; checkedAt: string };
export type LinkCheckJob = {
    state: string;
    total: number;
    completed: number;
    currentLink?: string;
    results: LinkCheckResult[];
    error?: string;
};

export function linkCheckResult(link: string, job: Pick<LinkCheckJob, 'state' | 'currentLink'>, results: ReadonlyMap<string, LinkCheckResult>): {
    status: LinkCheckStatus | 'checking' | 'unchecked'; name: string; checkedAt?: string; reason?: string;
} {
    if (['starting', 'running', 'stopping'].includes(job.state) && job.currentLink === link) {
        return { status: 'checking', name: '正在检测…' };
    }
    const result = results.get(link);
    return result ? { ...result, name: linkCheckNames[result.status] } : { status: 'unchecked', name: '未检测' };
}
