import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../util/project-paths.ts';
import { resolvePython } from '@zqdouyin/python-bridge';

test('admin Node and Python entry points resolve the repository from an unrelated working directory', t => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'dy-app-layout-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const module = new URL('../util/project-paths.ts', import.meta.url).href;
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const {projectRoot}=await import(${JSON.stringify(module)}); console.log(projectRoot);`],
    { cwd: temporary, encoding: 'utf8' }).trim();
    assert.equal(path.resolve(actual), path.resolve(projectRoot));
    assert.equal(path.join(actual, 'pyproject.toml'), fileURLToPath(new URL('../../../pyproject.toml', import.meta.url)));
    const python = resolvePython(projectRoot, {});
    if (!path.isAbsolute(python)) { t.skip('project Python environment not installed'); return; }
    const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
    const result = execFileSync(python, ['-c',
        'import sys; sys.path.insert(0, sys.argv[1]); from project_paths import PROJECT_ROOT; sys.path.insert(0, str(PROJECT_ROOT)); from storage.database import Database; print(PROJECT_ROOT)', scripts],
    { cwd: temporary, encoding: 'utf8', env: { ...process.env, LIBRARY_IO_AUDIT: '0' } }).trim();
    assert.equal(path.resolve(result), path.resolve(projectRoot));
    const help = execFileSync(python, [path.join(scripts, 'analyze-io.py'), '--help'],
        { cwd: temporary, encoding: 'utf8', env: { ...process.env, LIBRARY_IO_AUDIT: '0' } });
    assert.match(help, /--pattern/);
});
