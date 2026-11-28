import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupLogs, inspectLogs } from '../util/log-maintenance.ts';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-log-cleanup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const audit = path.join(root, 'logs/io-audit'), phase = path.join(root, 'logs/library-update');
    await mkdir(audit, { recursive: true }); await mkdir(phase, { recursive: true });
    return { root, audit, phase };
}
test('cleanup only deletes ended log sessions and protects every volume of active sessions', async t => {
    const { root, audit, phase } = await fixture(t);
    const dead = '20260101T000000000Z-999999-updater';
    for (const part of ['0000', '0001']) await writeFile(path.join(audit, `${dead}-${part}.jsonl`), '{"event":"begin"}\n');
    const running = `20260102T000000000Z-${process.pid}-node-0`;
    for (const part of ['0000', '0001']) await writeFile(path.join(audit, `${running}-${part}.jsonl`), '{"event":"begin"}\n');
    await writeFile(path.join(audit, `20260103T000000000Z-${process.pid}-python-0000.jsonl`), '{"event":"audit_stop"}\n');
    await writeFile(path.join(phase, '20260101T000000Z-999999.jsonl'), '{}\n');
    await writeFile(path.join(phase, `20260101T000000Z-${process.pid}.jsonl`), '{}\n');
    const unrelated = path.join(root, 'report.json'); await writeFile(unrelated, 'keep');
    await writeFile(path.join(audit, 'unrecognized.jsonl'), 'keep');
    await symlink(unrelated, path.join(audit, '20260104T000000000Z-999999-updater-0000.jsonl'));
    const preview = await inspectLogs(root, 0, audit);
    assert.equal(preview.files, 4); assert.equal(preview.retainedFiles, 3);
    const result = await cleanupLogs(root, 0, preview.token, audit);
    assert.equal(result.removedFiles, 4); assert.equal(result.skippedFiles, 0);
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    assert.equal(await readFile(path.join(audit, 'unrecognized.jsonl'), 'utf8'), 'keep');
    assert.ok((await readdir(audit)).includes(`${running}-0000.jsonl`));
    assert.ok((await readdir(audit)).includes(`${running}-0001.jsonl`));
});
test('changed preview refuses all deletion; expired retention applies to entire sessions', async t => {
    const { root, audit } = await fixture(t);
    const file = path.join(audit, '20260101T000000000Z-999999-updater-0000.jsonl');
    await writeFile(file, '{}\n');
    const preview = await inspectLogs(root, 0, audit);
    await appendFile(file, '{}\n');
    await assert.rejects(cleanupLogs(root, 0, preview.token, audit), /日志范围已变化/);
    assert.equal(await readFile(file, 'utf8'), '{}\n{}\n');
    const old = new Date(Date.now() - 10 * 86400_000); await utimes(file, old, old);
    assert.equal((await inspectLogs(root, 7, audit)).files, 1);
    await writeFile(path.join(audit, '20260101T000000000Z-999999-updater-0001.jsonl'), '{}\n');
    const protectedSession = await inspectLogs(root, 7, audit);
    assert.equal(protectedSession.files, 0); assert.equal(protectedSession.retainedFiles, 2);
});
test('cleanup refuses a symbolic-link log root', async t => {
    const { root, audit } = await fixture(t);
    const link = path.join(root, 'linked-logs'); await symlink(audit, link);
    await assert.rejects(inspectLogs(root, 0, link), /日志目录已变化/);
});
