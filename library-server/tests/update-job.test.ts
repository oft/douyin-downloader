import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { resolveUpdatePython, UpdateJob } from '../util/update-job.ts';

test('selects an explicit Python override, then the project virtual environment, then PATH', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-python-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const windows = process.platform === 'win32';
    assert.equal(resolveUpdatePython(root, {}), windows ? 'python' : 'python3');
    const local = path.join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, '');
    assert.equal(resolveUpdatePython(root, {}), local);
    assert.equal(resolveUpdatePython(root, { PYTHON_EXECUTABLE: 'custom-python' }), 'custom-python');
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
    for (const [code, state] of [[0, 'completed'], [3, 'failed'], [4, 'failed']]) {
        const job = new UpdateJob(process.execPath, ['-e', `process.exit(${code})`], process.cwd());
        job.start();
        await waitFor(() => !job.active);
        assert.equal(job.status.state, state);
        assert.equal(job.status.exitCode, code);
        if (code === 3) assert.match(job.status.error ?? '', /登录/);
        if (code === 4) assert.match(job.status.error ?? '', /PYTHON_EXECUTABLE/);
    }
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
});
