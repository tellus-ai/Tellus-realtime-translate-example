import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { sdkVersion, sdkRevision } = JSON.parse(readFileSync(new URL('./audio-sdk-release.json', import.meta.url), 'utf8'));

/** Prepare the pinned public SDK source inside this standalone example before npm ci. */
export function prepareSdk(root, env, npmCli) {
  const sdkRoot = new URL('.sdk/', root);
  if (!existsSync(sdkRoot)) {
    execFileSync('git', ['clone', '--depth', '1', '--branch', `v${sdkVersion}`,
      'https://github.com/tellus-ai/tellus-audio-sdk.git', fileURLToPath(sdkRoot)], {
      cwd: root, env, stdio: 'inherit',
    });
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sdkRoot, env, encoding: 'utf8' }).trim();
  if (revision !== sdkRevision) {
    throw new Error('SDK revision mismatch. Remove this example\'s .sdk directory and run npm run setup again.');
  }
  for (const args of [['ci', '--ignore-scripts'], ['run', 'build']]) {
    execFileSync(process.execPath, [npmCli, ...args], { cwd: sdkRoot, env, stdio: 'inherit' });
  }
}
