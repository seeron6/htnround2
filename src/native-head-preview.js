// Explicit local candidate previews use the app's existing GLB import path.
// The saved scan and its Newton generation remain available on a normal URL.
export async function loadNativeHeadPreview(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid local head candidate.');
  const base = `/generated/${name}/`;
  const [infoResponse, modelResponse] = await Promise.all([
    fetch(base + 'review.json', { cache: 'no-store' }),
    fetch(base + 'model.glb', { cache: 'no-store' }),
  ]);
  if (!infoResponse.ok || !modelResponse.ok)
    throw new Error('The local head candidate is unavailable.');
  const info = await infoResponse.json();
  const file = new File([await modelResponse.arrayBuffer()], info.label + '.glb', {
    type: 'model/gltf-binary',
  });
  const input = document.getElementById('face-file');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  await input.onchange({ target: input });
  if (document.getElementById('model-name').textContent !== file.name)
    throw new Error('The candidate could not be imported.');
  document.getElementById('model-kind').textContent =
    'Independent photo reconstruction · experimental';
  document.getElementById('physics-engine').textContent =
    'Candidate preview · springs + facial impact rig';
  document.getElementById('photo-count').textContent =
    `${info.inputViews ?? 'Recorded'} local photo views · no Meshy geometry`;
}
