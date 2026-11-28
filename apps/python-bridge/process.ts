import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type ProcessEvents = {
    onStart: () => void;
    onLine: (line: string) => void;
    onClose: (result: {
        code: number | null;
        signal: NodeJS.Signals | null;
        forced: boolean;
        spawnError?: NodeJS.ErrnoException;
    }) => void;
};

export type RunningProcess = {
    send(input: unknown): void;
    stop(): void;
};

export function startProcess(command: string, args: string[], cwd: string, events: ProcessEvents): RunningProcess {
    const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
        detached: process.platform !== 'win32',
        windowsHide: true,
    });
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let forced = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const output = createInterface({ input: child.stdout });

    output.on('line', events.onLine);
    child.stdin.on('error', () => { /* The child can exit before receiving input. */ });
    child.once('spawn', events.onStart);
    child.on('error', (error: NodeJS.ErrnoException) => {
        if (!child.pid) spawnError = error;
    });
    child.once('close', (code, signal) => {
        output.close();
        clearTimeout(stopTimer);
        events.onClose({ code, signal, forced, spawnError });
    });

    return {
        send(input) {
            if (child.stdin.writable) child.stdin.write(JSON.stringify(input) + '\n');
        },
        stop() {
            if (stopTimer) return;
            stopTimer = setTimeout(() => {
                forced = true;
                killTree(child);
            }, 10_000);
            child.stdin.end();
        },
    };
}

function killTree(child: ChildProcess) {
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
