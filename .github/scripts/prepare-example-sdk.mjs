// Prepares the pinned public SDK source of one example in <app>/.sdk, the way `npm run setup` does,
// without the engine download that needs an installation token. Type checks, unit tests and builds
// need only the SDK's JavaScript packages; the native engine is checked by the native pipeline.
//
//   node .github/scripts/prepare-example-sdk.mjs web
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const app = resolve(process.argv[2] ?? '.');
const { prepareSdk } = await import(pathToFileURL(join(app, 'scripts/prepare-sdk.mjs')).href);
const npmCli = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'npm/bin/npm-cli.js');
// Clones the pinned tag, checks the pinned commit, then installs and builds the SDK packages.
prepareSdk(pathToFileURL(`${app}/`), process.env, npmCli);
