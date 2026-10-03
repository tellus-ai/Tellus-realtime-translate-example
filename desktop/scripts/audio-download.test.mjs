import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { downloadSdk } from './audio-download.mjs';

const version = '0.2.1';
const filename = `tellus-ai-audio-sdk-${version}.tgz`;
const archive = Buffer.from('test package bytes');
const digest = createHash('sha256').update(archive).digest('hex');
const baseUrl = 'https://stgrtsapi.tellus.ai.kr';
const loginToken = 'login-secret';

function fixture({ badGrant = {}, corruptArchive = false, rejectDownloads = 0 } = {}) {
  const calls = [];
  let grants = 0;
  const fetchFunction = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.startsWith(baseUrl)) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Bearer ${loginToken}`);
      const file = url.split('/').at(-2);
      return Response.json({
        url: `https://download.tellus.ai.kr/stg/audio/sdk/v${version}/${file}`,
        token: `download.token.${++grants}`, token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) + 300, ...badGrant,
      });
    }
    assert.match(options.headers.Authorization, /^Bearer download\.token\./);
    if (rejectDownloads-- > 0) return new Response(null, { status: 401 });
    return new Response(url.endsWith('.sha256')
      ? `${digest}  ${filename}\n` : corruptArchive ? 'corrupt' : archive);
  };
  return { calls, options: { version, baseUrl, loginToken, fetchFunction } };
}

test('downloads SDK and checksum from CloudFront using separate file grants', async () => {
  const { options, calls } = fixture();
  const result = await downloadSdk(options);
  assert.deepEqual(result.archive, archive);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer download.token.1');
  assert.equal(calls[3].options.headers.Authorization, 'Bearer download.token.2');
});

test('refreshes a rejected download grant once', async () => {
  const { options, calls } = fixture({ rejectDownloads: 1 });
  await downloadSdk(options);
  assert.equal(calls.length, 6);
  assert.equal(calls[3].options.headers.Authorization, 'Bearer download.token.2');
});

test('does not retry a rejected grant indefinitely', async () => {
  const { options, calls } = fixture({ rejectDownloads: 3 });
  await assert.rejects(downloadSdk(options), /HTTP 401/);
  assert.equal(calls.length, 4);
});

test('rejects unexpected download hosts and paths before sending the download token', async () => {
  for (const url of [
    'https://other.test/file.tgz',
    `https://download.tellus.ai.kr/stg/audio/sdk/v0.2.2/${filename}`,
    `https://download.tellus.ai.kr/stg/audio/sdk/v${version}/${filename}?token=secret`,
  ]) {
    const { options, calls } = fixture({ badGrant: { url } });
    await assert.rejects(downloadSdk(options), /Invalid SDK download grant/);
    assert.equal(calls.length, 1);
  }
});

test('rejects expired grants and corrupted archives', async () => {
  await assert.rejects(downloadSdk(fixture({ badGrant: { expires_at: 1 } }).options), /Invalid SDK download grant/);
  await assert.rejects(downloadSdk(fixture({ corruptArchive: true }).options), /SHA-256 mismatch/);
});

test('rejects an unsafe service URL and missing login credentials before networking', async () => {
  const { options, calls } = fixture();
  await assert.rejects(downloadSdk({ ...options, baseUrl: 'http://example.test' }), /HTTPS service URL/);
  await assert.rejects(downloadSdk({ ...options, loginToken: '' }), /login access token/);
  assert.equal(calls.length, 0);
});
