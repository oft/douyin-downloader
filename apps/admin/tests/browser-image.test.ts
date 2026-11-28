import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoImageType } from '../util/browser-image.ts';

test('distinguishes HEIF from AVIF and ordinary image bytes', () => {
    const box = (brands: string) => {
        const data = Buffer.from(`0000ftyp${brands}`, 'ascii');
        data.writeUInt32BE(data.length);
        return data;
    };
    assert.equal(isoImageType(box('heic0000mif1')), 'image/heic');
    assert.equal(isoImageType(box('mif10000avif')), 'image/avif');
    assert.equal(isoImageType(box('isom0000mp41')), undefined);
    assert.equal(isoImageType(Buffer.from([0xff, 0xd8, 0xff])), undefined);
});
