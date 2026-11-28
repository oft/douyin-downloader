import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { UpdateJob } from '../util/update-job.ts';
import { resolvePython } from '@zqdouyin/python-bridge';

test('selects an explicit Python override, then the project virtual environment, then PATH', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-python-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const windows = process.platform === 'win32';
    assert.equal(resolvePython(root, {}), windows ? 'python' : 'python3');
    const local = path.join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, '');
    assert.equal(resolvePython(root, {}), local);
    assert.equal(resolvePython(root, { PYTHON_EXECUTABLE: 'custom-python' }), 'custom-python');
});

async function waitFor(test: () => boolean) {
    for (let retry = 0; retry < 200; retry++) {
        if (test()) return;
        await setTimeout(25);
    }
    assert.fail('Timed out waiting for update status');
}

test('keeps one update running until the child receives the stop request', { timeout: 12_000 }, async t => {
    const job = new UpdateJob(process.execPath, [
        '-e', 'process.stdin.on("end", () => process.exit(130)).resume()',
    ], process.cwd());
    t.after(() => { job.stop(); });
    assert.equal(job.status.state, 'idle');
    assert.equal(job.start().state, 'starting');
    await waitFor(() => job.status.state === 'running');
    assert.equal(job.start(), job.status);
    assert.equal(job.stop().state, 'stopping');
    assert.equal(job.stop(), job.status);
    await waitFor(() => !job.active);
    assert.equal(job.status.state, 'stopped');
    assert.equal(job.status.exitCode, 130);
    assert.ok(job.status.startedAt && job.status.finishedAt);
    assert.equal(job.start().finishedAt, undefined);
    job.stop();
    await waitFor(() => !job.active);
});

test('reports completion, login failure and missing dependencies', async () => {
    for (const [code, state] of [[0, 'completed'], [3, 'failed'], [4, 'failed'], [5, 'failed']]) {
        const job = new UpdateJob(process.execPath, ['-e', `process.exit(${code})`], process.cwd());
        job.start();
        await waitFor(() => !job.active);
        assert.equal(job.status.state, state);
        assert.equal(job.status.exitCode, code);
        if (code === 3) assert.match(job.status.error ?? '', /登录/);
        if (code === 4) assert.match(job.status.error ?? '', /PYTHON_EXECUTABLE/);
        if (code === 5) assert.match(job.status.error ?? '', /服务异常/);
    }
});

test('reads fragmented progress without blocking status and retains the final snapshot', async () => {
    const snapshot = {
        totalUrls: 2, completedUrls: 1, currentIndex: 2, failedUrls: 0,
        url: 'https://www.douyin.com/user/test', author: '测试作者', step: '下载作品', detail: '',
        itemsTotal: 3, itemsCompleted: 1, success: 1, failed: 0, skipped: 0,
        bytesRead: 0, bytesTotal: 0, currentItem: '', message: '',
    };
    const line = JSON.stringify({ type: 'progress', version: 1, progress: snapshot });
    const child = `
        const bytes = Buffer.from(${JSON.stringify(line)});
        const split = bytes.indexOf(Buffer.from('测试')) + 1;
        process.stdout.write('ordinary log\\n');
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
    `;
    const job = new UpdateJob(process.execPath, ['-e', child], process.cwd());
    job.start();
    await waitFor(() => !job.active);
    assert.equal(job.status.state, 'completed');
    assert.equal(job.status.progress?.author, '测试作者');
    assert.equal(job.status.progress?.completedUrls, 1);
    assert.ok(job.status.progress?.updatedAt);
    assert.equal(job.start().progress, undefined);
    await waitFor(() => !job.active);
});

test('update routes validate local requests and expose start failures', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-update-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.yml');
    await writeFile(config, 'link: []\n');
    const options = { CONFIG_PATH: config, PYTHON_EXECUTABLE: path.join(root, 'missing-python') };
    const previous = { CONFIG_PATH: process.env.CONFIG_PATH, PYTHON_EXECUTABLE: process.env.PYTHON_EXECUTABLE };
    Object.assign(process.env, options);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const { app } = await import('../index.ts');
    const endpoint = 'http://localhost/api/catalog/update';
    const post = (action: string, origin = 'http://localhost') => app.request(`${endpoint}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}',
    });
    const status = await app.request(endpoint);
    assert.equal(status.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await status.json(), { state: 'idle' });
    assert.equal((await app.request(endpoint, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await post('start', 'https://example.com')).status, 403);
    assert.equal((await post('stop', 'https://example.com')).status, 403);
    assert.equal((await app.request(`${endpoint}/start`, { method: 'POST' })).status, 415);
    assert.equal((await post('start')).status, 422);
    await writeFile(config, 'link: https://www.douyin.com/video/123\n');
    assert.equal((await post('start')).status, 202);
    let result;
    for (let retry = 0; retry < 100; retry++) {
        result = await (await app.request(endpoint)).json() as { state: string; error?: string };
        if (result.state === 'failed') break;
        await setTimeout(25);
    }
    assert.equal(result?.state, 'failed');
    assert.match(result?.error ?? '', /Python/);
    const browser = 'http://localhost/api/catalog/browser';
    assert.equal((await app.request(browser + '/open', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' })).status, 403);
    assert.equal((await app.request(browser + '/open', { method: 'POST' })).status, 415);
    assert.equal((await app.request(browser + '/open', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: '{}' })).status, 202);
    for (let retry = 0; retry < 100; retry++) {
        const current = await (await app.request(browser)).json() as { state: string; error?: string };
        if (current.state === 'failed') { assert.match(current.error ?? '', /Python/); break; }
        await setTimeout(25);
        assert.ok(retry < 99, 'The fake missing interpreter must fail without launching a browser');
    }
});

test('focus commands do not stop the existing child process', async () => {
    const lines: string[] = [];
    const job = new UpdateJob(process.execPath, ['-e', `
        process.stdin.on('data', chunk => { if (chunk.toString().includes('focus')) console.log('focused'); });
        process.stdin.on('end', () => process.exit(130));
    `], process.cwd(), line => lines.push(line));
    job.start();
    job.send({ action: 'focus' });
    await waitFor(() => lines.includes('focused'));
    assert.equal(job.active, true);
    job.stop();
    await waitFor(() => !job.active);
    assert.equal(job.status.state, 'stopped');
});


test('restores final update results after a service restart and never resumes an interrupted job automatically', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-update-status-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'status.json');
    const job = new UpdateJob(process.execPath, ['-e', 'process.exit(0)'], root, undefined, file);
    job.start(); await waitFor(() => !job.active);
    for (let i = 0; i < 100; i++) {
        const saved = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
        if (saved.state === 'completed') break;
        await setTimeout(10);
    }
    const restored = new UpdateJob(process.execPath, [], root, undefined, file);
    assert.equal(restored.status.state, 'completed');
    assert.equal(restored.status.startedAt, job.status.startedAt);
    assert.equal(restored.active, false);
    await writeFile(file, JSON.stringify({ state: 'running', startedAt: job.status.startedAt }));
    const interrupted = new UpdateJob(process.execPath, [], root, undefined, file);
    assert.equal(interrupted.status.state, 'stopped');
    assert.match(interrupted.status.error ?? '', /手动继续/);
    assert.equal(interrupted.active, false);
});
