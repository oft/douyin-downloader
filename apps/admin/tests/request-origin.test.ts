import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLibraryRequest } from '../util/request-origin.ts';

test('loopback stays same-origin and external hosts require explicit configuration', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        assert.equal(isLibraryRequest(`http://${host}:3001/`, undefined, ''), true);
        assert.equal(isLibraryRequest(`http://${host}:3001/`, `http://${host}:3001`, ''), true);
        assert.equal(isLibraryRequest(`http://${host}:3001/`, 'https://foreign.example', ''), false);
    }
    assert.equal(isLibraryRequest('http://library.example/', undefined, ''), false);
});

test('configured HTTPS origin works behind TLS termination without trusting forwarded headers', () => {
    const origin = 'https://youyin-server.home.zqzyz.com';
    const backend = 'http://youyin-server.home.zqzyz.com/api/catalog/maintenance/status';
    assert.equal(isLibraryRequest(backend, origin, origin), true);
    assert.equal(isLibraryRequest(backend, undefined, origin), true);
    for (const foreign of ['https://foreign.example', 'http://youyin-server.home.zqzyz.com', 'null', `${origin}:444`]) {
        assert.equal(isLibraryRequest(backend, foreign, origin), false);
    }
    assert.equal(isLibraryRequest('http://another.example/', origin, origin), false);
    assert.equal(isLibraryRequest('http://localhost:3001/', origin, origin), false);
});

test('trust configuration rejects malformed origins, credentials and path scopes', () => {
    const url = 'http://library.example/';
    for (const configured of ['*', 'library.example', 'ftp://library.example', 'https://user:password@library.example',
        'https://library.example/path', 'https://library.example/?secret=1', 'https://library.example/#fragment']) {
        assert.equal(isLibraryRequest(url, undefined, configured), false);
    }
    assert.equal(isLibraryRequest(url, 'https://library.example', 'invalid, https://library.example , https://other.example'), true);
});
