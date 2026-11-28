import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeTarget, IOAudit } from '../util/io-audit.ts';

const run = promisify(execFile);
test('I/O audit preserves real file/stream/transaction/network behavior and removes secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-audit-test-'));
    const module = new URL('../util/io-audit.ts', import.meta.url).href;
    const db = new URL('../util/db.ts', import.meta.url).href;
    const script = `
        import fs from 'node:fs'; import fsp from 'node:fs/promises';
        import { promisify } from 'node:util'; import http from 'node:http';
        import { installIOAudit } from ${JSON.stringify(module)};
        import { openDatabase } from ${JSON.stringify(db)};
        const root = ${JSON.stringify(root)}, secret = 'cookie-body-token-do-not-log';
        const audit = installIOAudit(root + '/logs');
        await fsp.writeFile(root + '/sample', secret);
        const handle = await fsp.open(root + '/sample', 'r');
        const result = await handle.readFile('utf8'); if (result !== secret) throw Error('file changed');
        await handle.close();
        const fd = fs.openSync(root + '/sample', 'r');
        const result2 = await promisify(fs.read)(fd, Buffer.alloc(100), 0, 100, 0);
        if (result2.bytesRead !== secret.length) throw Error('promisify metadata lost'); fs.closeSync(fd);
        const stream = fs.createReadStream(root + '/sample');
        if (stream.readableFlowing !== null) throw Error('logger consumed stream');
        let value = ''; for await (const chunk of stream) value += chunk;
        if (value !== secret) throw Error('stream changed');
        const database = openDatabase(root + '/sample.db');
        database.exec('CREATE TABLE data (value TEXT); BEGIN');
        database.prepare('INSERT INTO data VALUES (?)').run(secret);
        database.exec('ROLLBACK');
        if (database.prepare('SELECT COUNT(*) AS n FROM data').get().n !== 0) throw Error('rollback changed');
        database.prepare('INSERT INTO data VALUES (?)').run(secret);
        for (const row of database.prepare('SELECT value FROM data').iterate()) { if (row.value !== secret) throw Error('iterator changed'); break; }
        database.close();
        try { await fsp.stat(root + '/missing'); throw Error('ENOENT lost'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const server = http.createServer(async (req,res) => { await fsp.readFile(root + '/sample'); res.end(secret); });
        await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/test?token=' + secret, { headers: { Authorization: 'Bearer ' + secret } });
        if (await response.text() !== secret) throw Error('body changed');
        await new Promise(resolve => server.close(resolve)); audit.close();
    `;
    await run(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, LIBRARY_IO_AUDIT: '1' }, timeout: 30_000,
    });
    const files = await readdir(root + '/logs');
    const text = (await Promise.all(files.map(file => readFile(path.join(root, 'logs', file), 'utf8')))).join('');
    assert.equal(text.includes('cookie-body-token-do-not-log'), false);
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    const begin = events.filter(e => e.event === 'begin');
    const ended = new Set(events.filter(e => ['end', 'error'].includes(e.event)).map(e => e.id));
    assert.deepEqual(begin.filter(e => !ended.has(e.id)), []);
    assert.deepEqual([...new Set(begin.map(e => e.category))].sort(), ['database', 'filesystem', 'http_server', 'network']);
    assert.ok(events.some(e => e.error === 'ENOENT'));
    const incoming = begin.find(e => e.category === 'http_server');
    assert.ok(begin.some(e => e.category === 'filesystem' && e.parent === incoming.id));
});

test('URL sanitizing and rotation retain all operations', async () => {
    assert.equal(safeTarget('https://user:password@example.com/a?cookie=secret#token'), 'https://example.com/a');
    assert.equal(safeTarget('/relative?code=secret'), '/relative');
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-audit-rotate-'));
    const audit = new IOAudit(root, 1024);
    for (let i = 0; i < 1000; i++) { const span = audit.begin('test', 'operation'); audit.end(span); }
    audit.close();
    const files = await readdir(root); assert.ok(files.length > 1);
    const events = (await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8'))))
        .join('').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.event === 'begin').length, 1000);
    assert.equal(events.filter(e => e.event === 'end').length, 1000);
});
