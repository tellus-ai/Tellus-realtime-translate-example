import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

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

const env = { ...process.env, TELLUS_DESKTOP_DEV_SERVER_URL: devServerUrl };
// VS Code terminals set this, which would make Electron start as plain Node.js.
delete env.ELECTRON_RUN_AS_NODE;
// Download credentials are needed only by setup; runtime authorization uses API_KEY.
delete env.NODE_OPTIONS;
delete env.TELLUS_AUDIO_ENGINE_TOKEN;
delete env.TELLUS_AUDIO_DOWNLOAD_BASE_URL;

const electron = spawn(electronPath, ['.'], { cwd: projectRoot, env, stdio: 'inherit' });
electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
