import { UpdateJob } from './update-job.ts';

export const linkCheckStates = ['valid', 'unavailable', 'restricted', 'invalid', 'unknown'] as const;
export type LinkCheckResult = {
    link: string; status: typeof linkCheckStates[number]; reason: string; checkedAt: string;
};

export class LinkCheckJob {
    private command: string;
    private args: string[];
    private cwd: string;
    private job?: UpdateJob;
    private links: string[] = [];
    private checked = new Set<string>();
    private results = new Map<string, LinkCheckResult>();
    private currentLink?: string;
    private failure?: string;

    constructor(command: string, args: string[], cwd: string) {
        this.command = command; this.args = args; this.cwd = cwd;
    }

    get active() { return this.job?.active ?? false; }
    get status() {
        const status = this.job?.status ?? { state: 'idle' };
        return { ...status, total: this.links.length, completed: this.checked.size,
            currentLink: this.active ? this.currentLink : undefined,
            results: [...this.results.values()],
            error: this.failure ?? (status.state === 'failed' ? '链接检测未完成，请检查浏览器和 Python 依赖。' : undefined) };
    }

    start(links: string[], showBrowser: boolean) {
        if (this.active) return this.status;
        this.links = [...new Set(links)];
        this.checked.clear(); this.failure = this.currentLink = undefined;
        this.job = new UpdateJob(this.command, this.args, this.cwd, line => this.receive(line));
        this.job.start({ links: this.links, showBrowser });
        return this.status;
    }

    stop() { this.job?.stop(); return this.status; }

    private receive(line: string) {
        if (line.length > 16_384) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.version !== 1) return;
        if (event.type === 'link-check-error' && typeof event.message === 'string') {
            this.failure = event.message.slice(0, 2000); return;
        }
        if (event.type === 'link-check-current' && this.links.includes(event.link)) {
            this.currentLink = event.link; return;
        }
        const result = event.result;
        if (event.type !== 'link-check-result' || !result || !this.links.includes(result.link)
            || !linkCheckStates.includes(result.status) || typeof result.reason !== 'string'
            || result.reason.length > 2000 || typeof result.checkedAt !== 'string'
            || !Number.isFinite(Date.parse(result.checkedAt))) return;
        this.checked.add(result.link);
        this.results.delete(result.link);
        this.results.set(result.link, { link: result.link, status: result.status,
            reason: result.reason, checkedAt: result.checkedAt });
        if (this.results.size > 1000) this.results.delete(this.results.keys().next().value!);
    }
}
