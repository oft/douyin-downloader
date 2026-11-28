import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export { startProcess } from './process.ts';
export type { RunningProcess } from './process.ts';

const run = promisify(execFile);

export function resolvePython(projectRoot: string, env: NodeJS.ProcessEnv = process.env) {
    if (env.PYTHON_EXECUTABLE) return env.PYTHON_EXECUTABLE;
    const windows = process.platform === 'win32';
    const local = path.join(projectRoot, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
    return statSync(local, { throwIfNoEntry: false })?.isFile() ? local : windows ? 'python' : 'python3';
}

type PythonCommand = [command: string, args: string[], cwd: string];

export function createPythonBridge(projectRoot: string, scriptsDirectory: string) {
    const python = resolvePython(projectRoot);

    function script(name: string, ...args: string[]): PythonCommand {
        return [python, ['-u', path.join(scriptsDirectory, name), ...args], projectRoot];
    }

    return {
        updateLibrary(config: string, downloadRoot: string, database: string) {
            return script('update-library.py', config, downloadRoot, database);
        },
        checkLinks(config: string) {
            return script('check-links.py', config);
        },
        openLogin(config: string) {
            return script('open-douyin.py', config);
        },
        scanLocalFiles(database: string, downloadRoot: string) {
            return script('scan-local-files.py', database, downloadRoot);
        },
        async findFfmpeg() {
            try {
                const { stdout } = await run(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {
                    cwd: projectRoot, windowsHide: true, timeout: 5000, encoding: 'utf8',
                });
                return stdout.trim() || 'ffmpeg';
            } catch {
                return 'ffmpeg';
            }
        },
    };
}
