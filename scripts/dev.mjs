import { spawn } from 'node:child_process';
import net from 'node:net';
import { capturePython, newtonPython } from './venv.mjs';
const children = [
  spawn(newtonPython, ['physics_server.py'], { stdio: 'inherit' }),
  spawn(capturePython, ['server.py'], { stdio: 'inherit' }),
  spawn(capturePython, ['omni_relay.py'], { stdio: 'inherit' }),
  spawn('node', ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let stopping = false,
  sponsors = null;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill('SIGTERM');
  sponsors?.kill('SIGTERM');
  process.exitCode = code;
}

for (const p of children) {
  p.on('error', (e) => {
    console.error(e.message);
    stop(1);
  });
  p.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

// The Face (the OMNI voice, eyes and ears) and the Arena live in sponsor_server.py on :5176. The
// demo needs it, so `npm run dev` brings it up too. It stays optional: if the port is taken because
// someone already ran `npm run sponsors`, or if it exits, everything above keeps running.
const free = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(5176, '127.0.0.1');
});
if (stopping) {
  /* a child died while we were probing */
} else if (free) {
  sponsors = spawn(capturePython, ['sponsor_server.py'], { stdio: 'inherit' });
  sponsors.on('error', (e) => console.error('Sponsor relay: ' + e.message));
  sponsors.on('exit', (code) => {
    if (!stopping)
      console.error(
        `Sponsor relay exited (${code}). Restart it with: npm run sponsors`,
      );
  });
} else console.log('Sponsor relay: :5176 is already in use, leaving that one running.');
