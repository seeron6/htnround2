// An isolated, reproducible local lab; the primary 5173 demo keeps its captures.
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  symlink,
  stat,
  lstat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { videoLabTelemetry } from './video-lab-telemetry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.resolve(
  root,
  process.env.CONTACT_VIDEO_RUNTIME || 'artifacts/video-lab',
);
const captures = path.resolve(
  root,
  process.env.CONTACT_FACE_CAPTURES || '.local/video-captures',
);
await mkdir(runtime, { recursive: true });
await mkdir(captures, { recursive: true });
for (const name of await readdir(root)) {
  if (
    (/\.(py|html|js|json)$/.test(name) || ['.env', '.gitignore'].includes(name)) &&
    (await stat(path.join(root, name))).isFile()
  )
    await cp(path.join(root, name), path.join(runtime, name));
}
for (const name of ['scripts', 'src'])
  await cp(path.join(root, name), path.join(runtime, name), { recursive: true });
// Tailwind's automatic scanner follows the lab's dependency/assets symlinks.
// Restrict this isolated copy to the same application sources and HTML entries;
// scanning Python environments and generated models can stall the dev server.
const designCss = path.join(runtime, 'src/design/index.css');
await writeFile(
  designCss,
  (await readFile(designCss, 'utf8')).replace(
    /@import\s+(["'])tailwindcss\1\s*;/,
    '@import "tailwindcss" source(none);\n@source "../";\n@source "../../*.html";',
  ),
);
for (const name of ['node_modules', '.venv', '.local']) {
  try {
    await symlink(path.join(root, name), path.join(runtime, name), 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const publicDir = path.join(runtime, 'public');
if ((await lstat(publicDir).catch(() => null))?.isSymbolicLink())
  await unlink(publicDir);
await mkdir(publicDir, { recursive: true });
for (const item of await readdir(path.join(root, 'public'), { withFileTypes: true })) {
  const source = path.join(root, 'public', item.name),
    target = path.join(publicDir, item.name);
  if (item.isDirectory()) {
    try {
      await symlink(source, target, 'dir');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } else await cp(source, target);
}

const video = process.argv[2];
if (video) {
  await cp(path.resolve(video), path.join(runtime, 'benchmark-source.mov'));
  const entry = path.join(runtime, 'src/main.js');
  const filename = JSON.stringify(path.basename(video));
  await writeFile(
    entry,
    (await readFile(entry, 'utf8')) +
      `
const benchmarkButton = document.createElement('button');
benchmarkButton.textContent = 'Time supplied video → full head';
benchmarkButton.className = 'full primary';
document.getElementById('scan-face').after(benchmarkButton);
benchmarkButton.onclick = async () => {
  benchmarkButton.disabled = true;
  try {
    await faceCapture.open();
    const response = await fetch('/benchmark-source.mov');
    await faceCapture.importVideo(new File([await response.blob()], ${filename}, {type:'video/quicktime'}));
  } catch (error) { faceCapture.fail(error); }
  finally { benchmarkButton.disabled = false; }
};
`,
  );
}

const env = {
  ...process.env,
  ...videoLabTelemetry(process.env),
  CONTACT_WEB_PORT: process.env.CONTACT_WEB_PORT || '5183',
  CONTACT_API_PORT: process.env.CONTACT_API_PORT || '5184',
  CONTACT_PHYSICS_PORT: process.env.CONTACT_PHYSICS_PORT || '5185',
  CONTACT_FACE_CAPTURES: captures,
  CONTACT_TEXTURE_SIZE: process.env.CONTACT_TEXTURE_SIZE || '3072',
  VITE_CONTACT_FAST_CAPTURE: process.env.VITE_CONTACT_FAST_CAPTURE || '0',
};
const commands = [
  [path.join(root, '.venv/bin/python'), ['server.py']],
  [path.join(root, '.local/newton-env/bin/python'), ['physics_server.py']],
  [process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')]],
];
const children = commands.map(([cmd, args]) =>
  spawn(cmd, args, { cwd: runtime, env, stdio: 'inherit' }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
