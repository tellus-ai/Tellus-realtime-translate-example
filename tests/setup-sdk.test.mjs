import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath || fileURLToPath(new URL('../lib/node_modules/npm/bin/npm-cli.js', `file://${process.execPath}`));
const revision = 'c30e43df7a7ea01872f57bbb37d7645c870f37a4';

function fixture(t, platform) {
  const directory = mkdtempSync(join(tmpdir(), `tellus-${platform}-sdk-setup-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'sdk-source');
  const app = join(directory, 'example');
  mkdirSync(source);
  mkdirSync(app);
  const sdkPackage = `@tellus-ai/audio-sdk-${platform}`;
  const sdkManifest = { name: sdkPackage, version: '0.3.15', scripts: { postinstall: 'node dist/installer/install-binary-cli.js' } };
  const sdkPath = `platforms/${platform}`;
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'sdk-fixture', version: '0.3.15', scripts: { build: 'node build.cjs' } }));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'sdk-fixture', version: '0.3.15', lockfileVersion: 3, packages: { '': { name: 'sdk-fixture', version: '0.3.15' } } }));
  writeFileSync(join(source, 'build.cjs'), `
const { mkdirSync, writeFileSync } = require('node:fs');
if (process.env.FAIL_SDK_BUILD) process.exit(7);
mkdirSync('${sdkPath}/dist/installer', { recursive: true });
writeFileSync('${sdkPath}/package.json', JSON.stringify(${JSON.stringify(sdkManifest)}));
writeFileSync('${sdkPath}/dist/installer/install-binary-cli.js', "require('node:fs').writeFileSync(require('node:path').join(__dirname, '../../engine-ready'), 'installed');");
writeFileSync('${sdkPath}/dist/installer/check-binary-cli.js', "if (!require('node:fs').existsSync(require('node:path').join(__dirname, '../../engine-ready'))) process.exit(9);");
`);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', 'commit', '-qm', 'SDK fixture'], ['tag', 'v0.3.15']]) {
    execFileSync('git', args, { cwd: source, env: gitEnv });
  }
  const fixtureRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  cpSync(join(repository, platform, 'scripts'), join(app, 'scripts'), { recursive: true });
  writeFileSync(join(app, 'scripts/audio-sdk-release.json'), JSON.stringify({ sdkVersion: '0.3.15', sdkRevision: fixtureRevision }));
  // The npm examples install the SDK package from .sdk into node_modules. The Flutter example uses
  // .sdk/platforms/flutter in place (a path dependency in pubspec.yaml) and ends with
  // `flutter pub get`, for which a stand-in is put on PATH.
  const flutter = platform === 'flutter';
  const sdkRoot = flutter ? join(app, '.sdk', sdkPath) : join(app, 'node_modules', sdkPackage);
  const linked = flutter ? join(app, 'pub-get-ran') : join(app, 'node_modules');
  if (flutter) {
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'example-fixture', version: '1.0.0', scripts: { setup: 'node scripts/setup.mjs' } }));
    mkdirSync(join(directory, 'bin'));
    writeFileSync(join(directory, 'bin/flutter'), '#!/bin/sh\necho "$*" > pub-get-ran\n', { mode: 0o755 });
  } else {
    const productionManifest = JSON.parse(readFileSync(join(repository, platform, 'package.json'), 'utf8'));
    const dependency = productionManifest.dependencies[sdkPackage];
    const manifest = { name: 'example-fixture', version: '1.0.0', type: 'module', scripts: { setup: 'node scripts/setup.mjs', 'prepare:engine': 'node scripts/prepare-engine-assets.mjs' }, dependencies: { [sdkPackage]: dependency } };
    writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': manifest, [`node_modules/${sdkPackage}`]: { version: '0.3.15', resolved: dependency, hasInstallScript: true } } }));
    writeFileSync(join(app, '.npmrc'), 'install-links=true\n');
    writeFileSync(join(app, 'scripts/prepare-engine-assets.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('node_modules/${sdkPackage}/engine-ready')) process.exit(9);
writeFileSync('web-assets-ready', 'copied');`);
  }
  const env = {
    ...gitEnv,
    PATH: join(directory, 'bin') + delimiter + process.env.PATH,
    TELLUS_AUDIO_ENGINE_TOKEN: 'fixture-installation-token',
    TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://fixture.invalid',
    npm_execpath: npmCli,
    npm_config_ignore_scripts: 'true',
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_userconfig: '/dev/null',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/tellus-ai/tellus-audio-sdk.git',
    GIT_ALLOW_PROTOCOL: 'file',
  };
  return { app, env, sdkRoot, linked, run: (overrides = {}) => spawnSync(process.execPath, [npmCli, 'run', 'setup'], { cwd: app, env: { ...env, ...overrides }, encoding: 'utf8' }) };
}

for (const platform of ['web', 'mobile', 'desktop', 'flutter']) {
  test(`${platform}: setup installs from a fresh standalone checkout without a sibling SDK`, t => {
    const { app, sdkRoot, linked, run } = fixture(t, platform);
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const installed = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
    assert.equal(installed.version, '0.3.15');
    assert.ok(existsSync(join(sdkRoot, 'engine-ready')));
    if (platform === 'web') assert.ok(existsSync(join(app, 'web-assets-ready')));
    if (platform === 'flutter') assert.equal(readFileSync(linked, 'utf8'), 'pub get\n');
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-installation-token/);
    assert.equal(run().status, 0, 'setup can reuse its own pinned SDK checkout');
  });

  test(`${platform}: setup rejects a different SDK revision before installing app dependencies`, t => {
    const { app, linked, run } = fixture(t, platform);
    writeFileSync(join(app, 'scripts/audio-sdk-release.json'), JSON.stringify({ sdkVersion: '0.3.15', sdkRevision: '0'.repeat(40) }));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SDK revision mismatch/);
    assert.equal(existsSync(linked), false);
  });

  test(`${platform}: setup stops when building the SDK fails`, t => {
    const { linked, run } = fixture(t, platform);
    const result = run({ FAIL_SDK_BUILD: '1' });
    assert.equal(result.status, 7, result.stdout + result.stderr);
    assert.equal(existsSync(linked), false);
  });
}

test('flutter: the plugin is the project-local package of the pinned SDK checkout', () => {
  assert.match(readFileSync(join(repository, 'flutter/pubspec.yaml'), 'utf8'), /^\s+tellus_audio_sdk:\s*\n\s+path: \.sdk\/platforms\/flutter\s*$/m);
  const { sdkVersion, sdkRevision } = JSON.parse(readFileSync(join(repository, 'flutter/scripts/audio-sdk-release.json'), 'utf8'));
  assert.match(sdkVersion, /^\d+\.\d+\.\d+$/);
  assert.match(sdkRevision, /^[0-9a-f]{40}$/);
});

for (const platform of ['web', 'mobile', 'desktop']) {
  test(`${platform}: SDK dependency and lockfile use the pinned project-local package`, () => {
    const manifest = JSON.parse(readFileSync(join(repository, platform, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(repository, platform, 'package-lock.json'), 'utf8'));
    const name = `@tellus-ai/audio-sdk-${platform}`;
    assert.equal(manifest.dependencies[name], `file:.sdk/platforms/${platform}`);
    assert.equal(lock.packages[''].dependencies[name], manifest.dependencies[name]);
    assert.equal(lock.packages[`node_modules/${name}`].resolved, manifest.dependencies[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, '0.3.15');
    assert.deepEqual(JSON.parse(readFileSync(join(repository, platform, 'scripts/audio-sdk-release.json'), 'utf8')), { sdkVersion: '0.3.15', sdkRevision: revision });
  });
}
