// `npm start`: the development server and `flutter run` in one command, so that the app always has
// the server it calls. Arguments go to Flutter, for example `npm start -- -d <device>`.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeDartDefines } from './dart-defines.mjs';
import { startDevServer } from './dev-server.mjs';
import { readEnv, serverPort } from './env.mjs';

const env = readEnv();
const port = serverPort(env);

writeDartDefines(env);
const server = await startDevServer({ env, port });
console.log(`[tellus] Development server: http://localhost:${port}`);

// Lets an Android emulator or a USB-connected Android device reach this computer's localhost. It
// fails without adb or without exactly one Android device; iOS does not need it.
spawnSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'ignore', timeout: 10_000 });

const flutter = spawn('flutter', ['run', '--dart-define-from-file=.dart-defines.json', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
// Ctrl+C in the terminal reaches Flutter as well, and it quits by itself. Exit after it, not before.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => flutter.kill());

function stop(exitCode) {
  server.closeAllConnections();
  server.close();
  process.exitCode = exitCode;
}
flutter.on('exit', code => stop(code ?? 1));
flutter.on('error', error => {
  console.error(`flutter could not be started: ${error.message}`);
  stop(1);
});
