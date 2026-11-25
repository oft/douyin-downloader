import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

type UpdateStatus = {
    state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
    error?: string;
};

const exitErrors: Partial<Record<number, string>> = {
    3: '登录已失效，请更新下载器的登录信息后重试。',
    4: '当前 Python 缺少下载器依赖。请安装 requirements.txt 或检查 PYTHON_EXECUTABLE。',
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

    constructor(command: string, args: string[], cwd: string) {
        this.command = command;
        this.args = args;
        this.cwd = cwd;
    }

    get active() { return this.child !== undefined; }
    get status() { return this.current; }

    start() {
        if (this.child) return this.status;
        const startedAt = new Date().toISOString();
        const child = spawn(this.command, this.args, {
            cwd: this.cwd,
            stdio: ['pipe', 'inherit', 'inherit'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        this.child = child;
        this.current = { state: 'starting', startedAt };
        this.forced = false;
        let spawnError: string | undefined;
        child.stdin?.on('error', () => { /* The child may exit before receiving the stop request. */ });
        child.once('spawn', () => {
            if (this.current.state === 'starting') this.current = { state: 'running', startedAt };
        });
        child.on('error', (error: NodeJS.ErrnoException) => {
            if (!child.pid) {
                spawnError = error.code === 'ENOENT'
                    ? '找不到 Python，请安装下载器依赖并检查 PYTHON_EXECUTABLE。'
                    : '无法启动下载器进程。';
            }
        });
        child.once('close', (code, signal) => {
            clearTimeout(this.stopTimer);
            this.stopTimer = undefined;
            const finishedAt = new Date().toISOString();
            const outcome = { startedAt, finishedAt, exitCode: code ?? undefined };
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
