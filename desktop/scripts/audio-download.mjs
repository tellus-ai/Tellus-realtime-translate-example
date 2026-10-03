import { createHash } from 'node:crypto';

const CDN_ORIGIN = 'https://download.tellus.ai.kr';
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = 'tellus-audio-sdk-installer';

function serviceBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('TELLUS_AUDIO_DOWNLOAD_BASE_URL must be an HTTPS service URL.');
  }
  return url.href.replace(/\/$/, '');
}

async function readLimited(response, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Artifact response exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function requestGrant({ baseUrl, version, filename, loginToken, fetchFunction }) {
  const response = await fetchFunction(`${serviceBase(baseUrl)}/v1/audio-artifacts/sdk/${version}/${filename}/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${loginToken}`, 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`SDK token request failed: HTTP ${response.status}. Check the login token and artifact deployment.`);
  const grant = JSON.parse((await readLimited(response, 16_384)).toString('utf8'));
  const url = new URL(grant.url);
  if (url.origin !== CDN_ORIGIN || url.username || url.password || url.search || url.hash ||
      !['dev', 'stg', 'prod'].some((env) => url.pathname === `/${env}/audio/sdk/v${version}/${filename}`) ||
      grant.token_type !== 'Bearer' || typeof grant.token !== 'string' || grant.token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.token) ||
      !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= Date.now() / 1000) {
    throw new Error('Invalid SDK download grant.');
  }
  return grant;
}

async function downloadFile(options, maximum) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const grant = await requestGrant(options);
    const response = await options.fetchFunction(grant.url, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${grant.token}`, 'User-Agent': USER_AGENT },
    });
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`SDK CloudFront download failed: HTTP ${response.status}.`);
    return readLimited(response, maximum);
  }
  throw new Error('SDK download authorization failed.');
}

export async function downloadSdk({ baseUrl, version, loginToken, fetchFunction = fetch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid SDK version.');
  if (!loginToken) throw new Error('Set API_KEY or TELLUS_AUDIO_ENGINE_TOKEN to a login access token in desktop/.env.');
  const filename = `tellus-ai-audio-sdk-${version}.tgz`;
  const options = { baseUrl, version, loginToken, fetchFunction };
  const checksum = await downloadFile({ ...options, filename: `${filename}.sha256` }, 1024);
  const match = checksum.toString('utf8').trim().match(/^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/);
  if (!match || match[2] !== filename) throw new Error('Invalid SDK checksum file.');
  const archive = await downloadFile({ ...options, filename }, MAX_PACKAGE_BYTES);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== match[1].toLowerCase()) throw new Error('SDK SHA-256 mismatch.');
  return { filename, archive, checksum };
}
