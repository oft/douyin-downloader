import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { LinkCheckJob } from '../util/link-check-job.ts';
import { projectRoot } from '../util/project-paths.ts';
import { createPythonBridge, resolvePython } from '@zqdouyin/python-bridge';
import { linkCheckResult } from '../../admin-web/src/link-check.ts';

async function waitFor(condition: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (condition()) return;
        await setTimeout(20);
    }
    assert.fail('link check did not finish');
}

test('checks draft links through a dedicated process and rejects forged/invalid results', async () => {
    const source = `
        require('node:readline').createInterface({input:process.stdin}).once('line', line => {
            const {links} = JSON.parse(line);
            function send(result) { console.log(JSON.stringify({type:'link-check-result',version:1,result})); }
            send({link:'not-requested',status:'valid',reason:'forged',checkedAt:new Date().toISOString()});
            send({link:links[0],status:'wrong',reason:'bad status',checkedAt:new Date().toISOString()});
            send({link:links[0],status:'valid',reason:'主页可访问',checkedAt:new Date().toISOString()});
            process.exit(0);
        });
    `;
    const job = new LinkCheckJob(process.execPath, ['-e', source], process.cwd());
    assert.equal(job.status.state, 'idle');
    job.start(['first', 'first'], false);
    await waitFor(() => !job.active);
    assert.equal(job.status.state, 'completed');
    assert.equal(job.status.total, 1);
    assert.equal(job.status.completed, 1);
    assert.deepEqual(job.status.results.map(item => [item.link, item.status]), [['first', 'valid']]);
    job.start(['second'], false);
    await waitFor(() => !job.active);
    assert.equal(job.status.completed, 1);
    assert.equal(job.status.results.length, 2, 'a single-row check must retain other row results');
});

test('stops a running link check and preserves already checked rows', async t => {
    const source = `
        process.stdin.on('end', () => process.exit(130));
        require('node:readline').createInterface({input:process.stdin}).once('line', line => {
            const {links} = JSON.parse(line);
            console.log(JSON.stringify({type:'link-check-result',version:1,result:{
                link:links[0],status:'unknown',reason:'安全验证',checkedAt:new Date().toISOString()}}));
        });
    `;
    const job = new LinkCheckJob(process.execPath, ['-e', source], process.cwd());
    t.after(() => job.stop());
    job.start(['first', 'second'], false);
    await waitFor(() => job.status.completed === 1);
    job.stop();
    await waitFor(() => !job.active);
    assert.equal(job.status.state, 'stopped');
    assert.equal(job.status.completed, 1);
    assert.equal(job.status.results.length, 1);
});

test('row results follow exact link text after editing, reordering or removal', () => {
    const results = new Map([['first', {link:'first',status:'valid' as const,reason:'exists',checkedAt:'2026-11-26T00:00:00Z'}]]);
    assert.equal(linkCheckResult('first', {state:'idle'}, results).name, '正常');
    assert.equal(linkCheckResult('edited', {state:'idle'}, results).status, 'unchecked');
    assert.equal(linkCheckResult('first', {state:'running',currentLink:'first'}, results).status, 'checking');
    assert.equal(linkCheckResult('first', {state:'stopped',currentLink:'first'}, results).status, 'valid');
});

test('verification interruption leaves unchecked links unclassified', async () => {
    const source = `
        require('node:readline').createInterface({input:process.stdin}).once('line', line => {
            const {links} = JSON.parse(line);
            console.log(JSON.stringify({type:'link-check-current',version:1,link:links[0]}));
            console.log(JSON.stringify({type:'link-check-result',version:1,result:{
                link:links[0],status:'unknown',reason:'安全验证',checkedAt:new Date().toISOString()}}));
            console.log(JSON.stringify({type:'link-check-error',version:1,message:'需人工确认，其余未检测'}));
            process.exit(3);
        });
    `;
    const job = new LinkCheckJob(process.execPath, ['-e',source], process.cwd());
    job.start(['first','second'],false);
    await waitFor(()=>!job.active);
    assert.equal(job.status.state,'failed');
    assert.equal(job.status.completed,1);
    assert.equal(job.status.results[0]?.status,'unknown');
    assert.match(job.status.error ?? '',/人工确认/);
    assert.equal(job.status.results.some(result=>result.link==='second'),false);
});

test('real Python runner checks malformed input without opening a browser or writing user data', async t => {
    const root = projectRoot;
    const python = resolvePython(root,{});
    if (!python.startsWith(root)) { t.skip('project Python environment not installed'); return; }
    const temp = await mkdtemp(path.join(os.tmpdir(),'dy-link-check-python-'));
    t.after(()=>rm(temp,{recursive:true,force:true}));
    const config=path.join(temp,'config.yml');
    const before='cookie: ""\n';
    await writeFile(config,before);
    const bridge = createPythonBridge(root, path.join(root, 'apps/admin/scripts'));
    const job = new LinkCheckJob(...bridge.checkLinks(config));
    job.start(['not-a-url'],false);
    await waitFor(()=>!job.active);
    assert.equal(job.status.state,'completed');
    assert.equal(job.status.results[0]?.status,'invalid');
    assert.equal(await readFile(config,'utf8'),before);
});

test('link-check routes enforce origin, validate input, exclude downloads, and do not edit configuration', async t => {
    if (process.platform === 'win32') { t.skip('uses a Unix executable fixture'); return; }
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-link-check-route-'));
    let cleanup = async () => {};
    t.after(async () => { await cleanup(); await rm(root, {recursive:true,force:true}); });
    const config = path.join(root, 'config.yml');
    const before = 'link: [https://www.douyin.com/user/original]\ncookie: fixture-only\n';
    await writeFile(config, before);
    const executable = path.join(root, 'fake-python');
    await writeFile(executable, `#!/usr/bin/env node\nprocess.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(130));\n`);
    await chmod(executable, 0o700);
    process.env.CONFIG_PATH = config;
    process.env.PYTHON_EXECUTABLE = executable;
    const {app} = await import('../index.ts');
    const endpoint = 'http://localhost/api/catalog/link-check';
    const post = (action: string, data = {}, origin='http://localhost') => app.request(`${endpoint}/${action}`, {
        method:'POST', headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(data),
    });
    cleanup = async () => {
        await post('stop');
        await app.request('http://localhost/api/catalog/update/stop', {
            method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
        });
        for (let i=0;i<200;i++) {
            const status = await (await app.request('http://localhost/api/catalog/update')).json() as {state:string};
            if (!['starting','running','stopping'].includes(status.state)) break;
            await setTimeout(20);
        }
        delete process.env.CONFIG_PATH;
        delete process.env.PYTHON_EXECUTABLE;
    };
    assert.equal((await app.request(endpoint, {headers:{Origin:'https://evil.test'}})).status, 403);
    assert.equal((await post('start', {links:['first']}, 'https://evil.test')).status, 403);
    assert.equal((await app.request(endpoint+'/start', {method:'POST'})).status, 415);
    assert.equal((await post('start', {links:[]})).status, 400);
    assert.equal((await post('start', {links:['first'],showBrowser:'yes'})).status, 400);
    assert.equal((await post('start', {links:['first']})).status, 202);
    assert.equal((await app.request('http://localhost/api/catalog/update/start', {
        method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
    })).status, 409);
    assert.equal(await readFile(config,'utf8'), before);
    await post('stop');
    let state = '';
    for (let i=0;i<100;i++) {
        state = (await (await app.request(endpoint)).json() as {state:string}).state;
        if (state==='stopped') break;
        await setTimeout(20);
    }
    assert.equal(state, 'stopped');
    assert.equal((await app.request('http://localhost/api/catalog/update/start', {
        method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
    })).status, 202);
    assert.equal((await post('start', {links:['first']})).status, 409);
});
