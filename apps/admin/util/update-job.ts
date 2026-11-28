import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { startProcess } from '@zqdouyin/python-bridge';
import type { RunningProcess } from '@zqdouyin/python-bridge';
import { parseUpdateProgress } from './update-progress.ts';
import type { UpdateProgress } from './update-progress.ts';

type UpdateStatus = {
    state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
    error?: string;
    progress?: UpdateProgress;
};

const exitErrors: Partial<Record<number, string>> = {
    3: '登录已失效，请更新下载器的登录信息后重试。',
    4: '下载运行环境未就绪。请查看进度中的具体原因，检查 Python 依赖、浏览器及 PYTHON_EXECUTABLE。',
    5: '抖音网页需要人工检查（服务异常或安全验证），已停止本轮更新，请通过手动登录窗口检查后继续。',
};

export class UpdateJob {
    private command: string;
    private args: string[];
    private cwd: string;
    private child?: RunningProcess;
    private current: UpdateStatus = { state: 'idle' };
    private onLine?: (line: string) => void;
    private stateFile?: string;
    private saving: Promise<void> = Promise.resolve();
    private failureMessage?: string;

    constructor(command: string, args: string[], cwd: string, onLine?: (line: string) => void, stateFile?: string, failureMessage?: string) {
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.onLine = onLine;
        this.stateFile = stateFile;
        this.failureMessage = failureMessage;
        if (stateFile) {
            try {
                const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
                if (['completed', 'stopped', 'failed', 'starting', 'running', 'stopping'].includes(saved.state)) {
                    const interrupted = ['starting', 'running', 'stopping'].includes(saved.state);
                    const progress = saved.progress && parseUpdateProgress(JSON.stringify({ type: 'progress', version: 1, progress: saved.progress }));
                    this.current = { state: interrupted ? 'stopped' : saved.state,
                        ...(typeof saved.startedAt === 'string' ? { startedAt: saved.startedAt } : {}),
                        ...(typeof saved.finishedAt === 'string' ? { finishedAt: saved.finishedAt } : {}),
                        ...(Number.isInteger(saved.exitCode) ? { exitCode: saved.exitCode } : {}),
                        ...(progress ? { progress } : {}),
                        ...(interrupted ? { error: '上次更新已中断，请手动继续' } : typeof saved.error === 'string' ? { error: saved.error.slice(0, 2000) } : {}) };
                }
            } catch { /* A new installation has no persisted update status. */ }
        }
    }

    private persistStatus() {
        const file = this.stateFile;
        if (!file) return;
        const body = JSON.stringify(this.current);
        this.saving = this.saving.then(async () => {
            await mkdir(path.dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await writeFile(temporary, body, { mode: 0o600 });
            await rename(temporary, file);
        }).catch(() => { /* Progress persistence must never interrupt downloads. */ });
    }

    get active() { return this.child !== undefined; }
    get status() { return this.current; }

    send(input: unknown) {
        this.child?.send(input);
    }

    start(input?: unknown) {
        if (this.child) return this.status;
        const startedAt = new Date().toISOString();
        const child = startProcess(this.command, this.args, this.cwd, {
            onStart: () => {
                if (this.current.state === 'starting') this.current = { ...this.current, state: 'running' };
            },
            onLine: line => {
                if (this.child !== child) return;
                const progress = parseUpdateProgress(line);
                if (progress) this.current = { ...this.current, progress };
                this.onLine?.(line);
            },
            onClose: ({ code, signal, forced, spawnError }) => {
                const finishedAt = new Date().toISOString();
                const outcome = { startedAt, finishedAt, exitCode: code ?? undefined,
                    ...(this.current.progress ? { progress: this.current.progress } : {}) };
                if (this.current.state === 'stopping' && (code === 130 || forced || signal)) {
                    this.current = { ...outcome, state: 'stopped' };
                } else if (code === 0) {
                    this.current = { ...outcome, state: 'completed' };
                } else {
                    const error = spawnError
                        ? (spawnError.code === 'ENOENT'
                            ? '找不到 Python，请安装下载器依赖并检查 PYTHON_EXECUTABLE。'
                            : '无法启动下载器进程。')
                        : this.failureMessage ?? exitErrors[code ?? -1]
                            ?? '下载器异常退出，详情请查看 admin 的终端输出。';
                    this.current = { ...outcome, state: 'failed', error };
                }
                this.child = undefined;
                this.persistStatus();
            },
        });
        this.child = child;
        this.current = { state: 'starting', startedAt };
        this.persistStatus();
        if (input !== undefined) child.send(input);
        return this.status;
    }

    stop() {
        if (this.child && this.current.state !== 'stopping') {
            this.current = { ...this.current, state: 'stopping' };
            this.child.stop();
        }
        return this.status;
    }
}
