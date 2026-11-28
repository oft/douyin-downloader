"""Compare the first optimization's versioned reader with the incremental reader offline."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def main():
    server = Path(__file__).resolve().parents[1]
    env = dict(os.environ, BENCH_SAMPLES='36', BENCH_MUTATIONS='12')
    with tempfile.TemporaryDirectory(prefix='dy-phase1-baseline-') as temporary:
        baseline = Path(temporary) / 'apps' / 'admin'
        baseline.mkdir(parents=True)
        for directory in ['util', 'benchmarks']:
            shutil.copytree(server / directory, baseline / directory)
        for name in ['index.ts', 'package.json']:
            shutil.copy(server / name, baseline / name)
        (baseline.parent / 'shared').symlink_to(server.parent / 'shared', target_is_directory=True)
        (baseline.parent / 'node_modules').symlink_to(
            server.parent / 'node_modules', target_is_directory=True
        )
        entry = baseline / 'index.ts'
        source = entry.read_text()
        source = source.replace('import { CatalogReader }', 'import { readCatalogVersionInWorker }')
        source = source.replace('const catalogReader = new CatalogReader();\n', '')
        source = source.replace('let databaseView: { stamp: string; snapshot: DatabaseCatalog }',
                                'let databaseView: { stamp: string; signature: string; snapshot: DatabaseCatalog }')
        source = source.replace('        databaseRead = catalogReader.read(root, databaseFile).then(snapshot => {', '''        const previous = databaseView?.snapshot.root === root ? databaseView : undefined;
        databaseRead = readCatalogVersionInWorker(root, databaseFile, previous?.signature).then(result => {
            const snapshot = result.snapshot ?? previous!.snapshot;''')
        source = source.replace('databaseView = { stamp, snapshot };',
                                'databaseView = { stamp, signature: result.signature, snapshot };')
        if 'catalogReader.read(' in source or 'readCatalogVersionInWorker(root,' not in source:
            raise RuntimeError('Reader baseline substitution failed; update the comparison script')
        source = source.replace('    const candidates = author ? snapshot.worksByAuthor.get(author) ?? [] : snapshot.works;\n    const works = candidates.filter(work => (!kind || work.kind === kind) &&',
                                '    const works = snapshot.works.filter(work => (!author || work.authorId === author) && (!kind || work.kind === kind) &&')
        entry.write_text(source)
        with (server / 'benchmarks/before-incremental.json').open('w') as output:
            subprocess.run(['node', str(baseline / 'benchmarks/catalog.ts')], env=env,
                           stdout=output, check=True)
    with (server / 'benchmarks/after-incremental.json').open('w') as output:
        subprocess.run(['node', str(server / 'benchmarks/catalog.ts')], env=env,
                       stdout=output, check=True)


if __name__ == '__main__':
    main()
