import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileIdFromLink } from '../public/profile-link.js';

test('matches only exact official profile links, including queries, trailing slashes and share text', () => {
    for (const link of ['https://www.douyin.com/user/sec-author',
        'https://douyin.com/user/sec-author/?from=share#top',
        '分享作者主页 https://www.douyin.com/user/sec%2Dauthor 复制打开']) {
        assert.equal(profileIdFromLink(link), 'sec-author');
    }
    for (const link of ['https://example.com/user/sec-author', 'https://www.douyin.com.evil.com/user/sec-author',
        'https://www.douyin.com/video/sec-author', 'https://v.douyin.com/short/',
        'https://www.douyin.com/user/sec-author/other', 'https://www.douyin.com/user/sec%2Fauthor',
        'https://user@www.douyin.com/user/sec-author', 'https://www.douyin.com/user/%invalid', 'not a URL']) {
        assert.equal(profileIdFromLink(link), undefined);
    }
    assert.equal(profileIdFromLink('https://www.douyin.com/user/sec-author-other'), 'sec-author-other');
});
