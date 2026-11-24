import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { electronEnvironment, readDotenv } from './runtime-settings.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron');

const server = await createServer({ root: projectRoot });
await server.listen();
const devServerUrl = server.resolvedUrls?.local[0];
if (!devServerUrl) {
  await server.close();
  throw new Error('Unable to resolve the Vite dev server URL.');
}
console.log(`Renderer dev server: ${devServerUrl} (opened inside Electron)`);

// Electron gets the runtime settings of `.env` and nothing else from it: the API key stays in this
// process, with the Vite server above (vite.config.mts), and the app gets an access token from that
// server for each Conversation. The installation credentials are needed only by setup.
const env = electronEnvironment(process.env, readDotenv(new URL('../.env', import.meta.url)), devServerUrl);

const electron = spawn(electronPath, ['.'], { cwd: projectRoot, env, stdio: 'inherit' });
electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
