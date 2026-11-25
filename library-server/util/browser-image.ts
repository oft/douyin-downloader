import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const heifBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function isoImageType(header: Buffer): 'image/heic' | 'image/avif' | undefined {
    if (header.length < 16 || header.toString('ascii', 4, 8) !== 'ftyp') return undefined;
    const end = Math.min(header.readUInt32BE(0), header.length);
    const brands = [header.toString('ascii', 8, 12)];
    for (let offset = 16; offset + 4 <= end; offset += 4) {
        brands.push(header.toString('ascii', offset, offset + 4));
    }
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
    if (brands.some(brand => heifBrands.has(brand))) return 'image/heic';
    return undefined;
}

export function createHeifPreview(python: string, cwd: string) {
    let executable: Promise<string> | undefined;

    return async (file: string) => {
        executable ??= run(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {
            cwd, windowsHide: true, timeout: 5000, encoding: 'utf8',
        }).then(({ stdout }) => stdout.trim() || 'ffmpeg', () => 'ffmpeg');

        try {
            const { stdout } = await run(await executable, [
                '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
                '-i', file, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1',
            ], { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 12 * 1024 * 1024, encoding: 'buffer' });
            return stdout[0] === 0xff && stdout[1] === 0xd8 ? stdout : undefined;
        } catch {
            return undefined;
        }
    };
}
