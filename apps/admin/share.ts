import './util/io-audit-bootstrap.ts';
import path from 'node:path';
import { projectRoot } from './util/project-paths.ts';
import { readLibraryConfig } from './util/config.ts';
import { TransferController } from './util/transfer-controller.ts';

/** Optional standalone, read-only sharing entry point; no downloader/admin HTTP listener is started. */
export async function main(args = process.argv.slice(2)) {
    if (args.includes('--help')) {
        console.log('只读分享：node share.ts [--config 配置文件] [--port 端口] [--idle-minutes 分钟] [--include-history]');
        return;
    }
    const values = new Map<string, string>();
    let includeHistory = false;
    for (let i = 0; i < args.length; i++) {
        const option = args[i]!;
        if (option === '--include-history') { includeHistory = true; continue; }
        if (!['--config', '--port', '--idle-minutes'].includes(option) || !args[i + 1]) throw new Error('参数无效，使用 --help 查看用法');
        values.set(option, args[++i]!);
    }
    const config = path.resolve(values.get('--config') ?? process.env.CONFIG_PATH ?? path.join(projectRoot, 'config.yml'));
    const { downloadRoot, databaseFile } = readLibraryConfig(config);
    const port = Number(values.get('--port') ?? 0), idle = Number(values.get('--idle-minutes') ?? 15);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(idle) || idle < 1 || idle > 1440) throw new Error('端口或空闲时间无效');
    const controller = new TransferController({ root: downloadRoot, database: databaseFile, config });
    let stopping = false;
    const stop = () => { stopping = true; controller.stopShare(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        console.log('正在建立只读分享索引；不会下载抖音作品或启动资料库管理接口。');
        await controller.startShare({ includeHistory }, port, idle);
        let reported = false, last = '';
        while (true) {
            const status = controller.shareStatus;
            if (status.state === 'failed') throw new Error(status.error ?? '分享启动失败');
            if (status.state === 'stopped' && !controller.shareActive) break;
            if (stopping && !controller.shareActive) break;
            if (status.state === 'ready' && !reported) {
                reported = true;
                console.log(`分享地址：\n${status.addresses!.join('\n')}\n临时分享码：${status.code}\n空闲 ${idle} 分钟后关闭；按 Ctrl+C 停止分享。`);
                if (status.counts?.unassignedFiles) console.log(`另有 ${status.counts.unassignedFiles} 个未归属文件未包含在分享中，请先整理。`);
            } else if (!reported && status.progress) {
                const text = `${status.progress.stage}：${status.progress.completed} 个文件`;
                if (text !== last) { last = text; console.log(text); }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        process.off('SIGINT', stop); process.off('SIGTERM', stop); await controller.close();
    }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : '分享失败'); process.exitCode = 1; });
