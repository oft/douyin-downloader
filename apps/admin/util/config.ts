import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export function readLibraryConfig(configFile: string, env: NodeJS.ProcessEnv = process.env) {
    const raw: unknown = existsSync(configFile) ? parse(readFileSync(configFile, 'utf8')) : {};
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new Error('下载器配置格式无效');
    }
    const config = (raw ?? {}) as Record<string, unknown>;
    const directory = path.dirname(configFile);
    const configuredRoot = typeof config.path === 'string' ? config.path : './Downloaded';
    const configuredDatabase = typeof config.database_path === 'string'
        ? config.database_path : './data/dy_downloader.db';
    return {
        downloadRoot: env.DOWNLOAD_ROOT ? path.resolve(env.DOWNLOAD_ROOT) : path.resolve(directory, configuredRoot),
        databaseFile: env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.resolve(directory, configuredDatabase),
    };
}
