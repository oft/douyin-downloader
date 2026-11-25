import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
    5: '抖音网页显示服务异常，已停止本轮更新，请稍后手动检查网页状态。',
};

export function resolveUpdatePython(projectRoot: string, env: NodeJS.ProcessEnv = process.env) {
    if (env.PYTHON_EXECUTABLE) return env.PYTHON_EXECUTABLE;
    const windows = process.platform === 'win32';
    const local = path.join(projectRoot, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
    return statSync(local, { throwIfNoEntry: false })?.isFile() ? local : windows ? 'python' : 'python3';
}

export class UpdateJob {
    private command: string;
    private args: string[];
    private cwd: string;
    private child?: ChildProcess;
    private current: UpdateStatus = { state: 'idle' };
    private stopTimer?: ReturnType<typeof setTimeout>;
    private forced = false;
    private onLine?: (line: string) => void;

    constructor(command: string, args: string[], cwd: string, onLine?: (line: string) => void) {
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.onLine = onLine;
    }

    get active() { return this.child !== undefined; }
    get status() { return this.current; }

    send(input: unknown) {
        if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify(input) + '\n');
    }

    start(input?: unknown) {
        if (this.child) return this.status;
        const startedAt = new Date().toISOString();
        const child = spawn(this.command, this.args, {
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'inherit'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        this.child = child;
        this.current = { state: 'starting', startedAt };
        this.forced = false;
        const output = child.stdout && createInterface({ input: child.stdout });
        output?.on('line', line => {
            const progress = parseUpdateProgress(line);
            if (progress && this.child === child) this.current = { ...this.current, progress };
            if (this.child === child) this.onLine?.(line);
        });
        let spawnError: string | undefined;
        child.stdin?.on('error', () => { /* The child may exit before receiving the stop request. */ });
        child.once('spawn', () => {
            if (this.current.state === 'starting') this.current = { ...this.current, state: 'running' };
        });
        child.on('error', (error: NodeJS.ErrnoException) => {
            if (!child.pid) {
                spawnError = error.code === 'ENOENT'
                    ? '找不到 Python，请安装下载器依赖并检查 PYTHON_EXECUTABLE。'
                    : '无法启动下载器进程。';
            }
        });
        child.once('close', (code, signal) => {
            output?.close();
            clearTimeout(this.stopTimer);
            this.stopTimer = undefined;
            const finishedAt = new Date().toISOString();
            const outcome = { startedAt, finishedAt, exitCode: code ?? undefined,
                ...(this.current.progress ? { progress: this.current.progress } : {}) };
            if (this.current.state === 'stopping' && (code === 130 || this.forced || signal)) {
                this.current = { ...outcome, state: 'stopped' };
            } else if (code === 0) {
                this.current = { ...outcome, state: 'completed' };
            } else {
                const error = spawnError ?? exitErrors[code ?? -1]
                    ?? '下载器异常退出，详情请查看 library-server 的终端输出。';
                this.current = { ...outcome, state: 'failed', error };
            }
            this.child = undefined;
        });
        if (input !== undefined) child.stdin?.write(JSON.stringify(input) + '\n');
        return this.status;
    }

    stop() {
        const child = this.child;
        if (child && this.current.state !== 'stopping') {
            this.current = { ...this.current, state: 'stopping' };
            this.stopTimer = setTimeout(() => {
                this.forced = true;
                this.killTree(child);
            }, 10_000);
            child.stdin?.end();
        }
        return this.status;
    }

    private killTree(child: ChildProcess) {
        if (!child.pid) return;
        if (process.platform === 'win32') {
            const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
                stdio: 'ignore', windowsHide: true,
            });
            taskkill.on('error', () => child.kill('SIGKILL'));
            taskkill.on('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { child.kill('SIGKILL'); }
        }
    }
}
