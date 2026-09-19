import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { SurfaceAppearance } from './surface-appearance.js';
import { HeadHair } from './head-hair.js';
import { HeadGlasses } from './head-accessories.js';

const $ = (id) => document.getElementById(id);
const base = '/generated/engine-comparison/';
const candidate = new URLSearchParams(location.search).get('native');
const nativeGlb = new URLSearchParams(location.search).get('nativeGlb');
const nativeBase =
  candidate && /^[a-z0-9-]+$/.test(candidate) ? `/generated/${candidate}/` : base;
const panels = [];
let mode = 'texture',
  syncing = false,
  meta,
  meshyRoot;
const json = async (name, directory = base) => {
  const r = await fetch(directory + name + '?v=' + Date.now());
  if (!r.ok) throw new Error(`Comparison asset unavailable: ${name}`);
  return r.json();
};
const number = (n) => n.toLocaleString();

function panel(id) {
  const host = $(id),
    scene = new THREE.Scene();
  scene.background = new THREE.Color('#222c28');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  host.append(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(0, 0, 2.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 0.65;
  controls.maxDistance = 8;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x65756b, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-2, 3, 4);
  scene.add(light);
  const p = { scene, renderer, camera, controls, meshes: [], details: [] };
  p.draw = () => renderer.render(scene, camera);
  controls.addEventListener('change', () => {
    if (syncing) return;
    syncing = true;
    for (const other of panels) {
      if (other !== p) {
        other.camera.position.copy(camera.position);
        other.camera.quaternion.copy(camera.quaternion);
        other.controls.target.copy(controls.target);
        other.controls.update();
      }
      other.draw();
    }
    syncing = false;
    document
      .querySelectorAll('[data-angle]')
      .forEach((b) => b.setAttribute('aria-pressed', 'false'));
  });
  new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    p.draw();
  }).observe(host);
  panels.push(p);
  return p;
}

function install(p, root, details = []) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const scale = 1 / box.getSize(new THREE.Vector3()).y;
  root.position.sub(center);
  root.position.multiplyScalar(scale);
  root.scale.multiplyScalar(scale);
  const wrapper = new THREE.Group();
  wrapper.add(root);
  p.scene.add(wrapper);
  p.details = details;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (!obj.geometry.getAttribute('normal')) obj.geometry.computeVertexNormals();
    const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]).map(
      (m) =>
        obj.userData.accessory === 'eyeglasses'
          ? m
          : new THREE.MeshBasicMaterial({
              color: m.color || 0xffffff,
              map: m.map || null,
              vertexColors: m.vertexColors,
              transparent: m.transparent,
              opacity: m.opacity,
              alphaTest: m.alphaTest,
              side: THREE.DoubleSide,
              toneMapped: false,
            }),
    );
    // The source atlas already contains photographed lighting.
    if (obj instanceof SurfaceAppearance)
      materials.forEach((m) => m.color.set(0xffffff));
    obj.userData.comparisonMaterials = {
      texture: Array.isArray(obj.material) ? materials : materials[0],
      clay: new THREE.MeshStandardMaterial({
        color: 0xb7c5b6,
        roughness: 0.88,
        side: THREE.DoubleSide,
      }),
      wire: new THREE.MeshBasicMaterial({ color: 0xb8d7bb, wireframe: true }),
    };
    p.meshes.push(obj);
  });
  setMode(mode);
  return wrapper;
}

function setMode(value) {
  mode = value;
  for (const p of panels) {
    p.meshes.forEach((m) => {
      m.material = m.userData.comparisonMaterials[mode];
    });
    p.details.forEach((obj) => {
      obj.visible = mode === 'texture';
    });
    p.draw();
  }
  document
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}

function angle(degrees, elevation = 0) {
  syncing = true;
  const a = THREE.MathUtils.degToRad(degrees);
  const pitch = THREE.MathUtils.degToRad(elevation);
  for (const p of panels) {
    p.camera.position.set(
      Math.sin(a) * Math.cos(pitch) * 2.6,
      Math.sin(pitch) * 2.6,
      Math.cos(a) * Math.cos(pitch) * 2.6,
    );
    p.controls.target.set(0, 0, 0);
    p.controls.update();
    p.draw();
  }
  syncing = false;
  document
    .querySelectorAll('[data-angle]')
    .forEach((b) =>
      b.setAttribute(
        'aria-pressed',
        String(
          Number(b.dataset.angle) === degrees &&
            Number(b.dataset.elevation || 0) === elevation,
        ),
      ),
    );
}

async function native(p) {
  if (nativeGlb && /^[a-z0-9-]+$/.test(nativeGlb)) {
    const directory = `/generated/${nativeGlb}/`;
    const review = await json('review.json', directory);
    const gltf = await new GLTFLoader().loadAsync(directory + 'model.glb');
    const details = [];
    let glassesSpec;
    gltf.scene.traverse((obj) => {
      if (obj.isMesh && obj.userData.accessories?.glasses) {
        glassesSpec = obj.userData.accessories.glasses;
      }
      if (
        obj.userData.accessory === 'eyeglasses' &&
        obj.parent?.userData.accessory !== 'eyeglasses'
      )
        details.push(obj);
    });
    if (glassesSpec) {
      // Rebuild the serialized accessory with the same reflection environment
      // used by the interaction lab (environment maps are not part of glTF).
      details.forEach((obj) => obj.removeFromParent());
      details.length = 0;
      const glasses = new HeadGlasses(glassesSpec);
      gltf.scene.add(glasses);
      details.push(glasses);
    }
    install(p, gltf.scene, details);
    $('native-label').textContent = review.label;
    $('native-kind').textContent = 'GEOMETRY EXPERIMENT';
    $('native-stats').textContent =
      `${number(review.triangles)} triangles · ${review.method}`;
    $('native-method').textContent = review.method;
    $('source-note').textContent =
      `${review.inputViews || 51} saved video frames → independent local photogrammetry. ${meta.views.length} cropped views → Meshy. Estimated shape refinements are described below.`;
    $('try-native').href = `/?nativePreview=${nativeGlb}`;
    $('try-native').hidden = false;
    return;
  }
  const [data, atlas] = await Promise.all([
    json('mesh.json', nativeBase),
    json('texture-atlas.json', nativeBase),
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(data.positions, 3),
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  geometry.setIndex(data.indices);
  const texture = await new THREE.TextureLoader().loadAsync(
    nativeBase + 'appearance.png?v=' + Date.now(),
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  const root = new THREE.Group();
  root.add(new SurfaceAppearance(geometry, atlas, texture));
  const details = [];
  if (data.accessories?.hair)
    details.push(new HeadHair(geometry, data.accessories.hair));
  if (data.accessories?.glasses)
    details.push(new HeadGlasses(data.accessories.glasses));
  root.add(...details);
  install(p, root, details);
  if (candidate) $('native-kind').textContent = 'UNACCEPTED CANDIDATE';
  $('native-stats').textContent =
    `${number(data.indices.length / 3)} head triangles · ${number(data.positions.length / 3)} vertices · ${texture.image.width}px photo atlas`;
}

async function meshy(p) {
  const status = await json('meshy-status.json');
  if (status.status === 'failed') throw new Error(status.message);
  if (status.status !== 'complete') {
    $('meshy-pending').textContent = status.message || 'Meshy is building the model…';
    setTimeout(() => meshy(p).catch(fail), 5000);
    return;
  }
  // The result is copied immediately after its status reaches complete.
  const response = await fetch(base + 'meshy.glb', { method: 'HEAD' });
  if (!response.ok) {
    setTimeout(() => meshy(p).catch(fail), 1500);
    return;
  }
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(base + 'draco/');
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync(base + 'meshy.glb');
  let triangles = 0,
    vertices = 0,
    textureSize = 0;
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    vertices += obj.geometry.attributes.position.count;
    triangles +=
      (obj.geometry.index?.count || obj.geometry.attributes.position.count) / 3;
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material])
      textureSize = Math.max(textureSize, m.map?.image?.width || 0);
  });
  meshyRoot = install(p, gltf.scene);
  draco.dispose();
  $('meshy-pending').remove();
  const fresh = await json('comparison.json');
  const credits = fresh.meshyResult?.consumedCredits ?? status.consumedCredits;
  $('meshy-stats').textContent =
    `${number(triangles)} triangles · ${number(vertices)} vertices · ${textureSize}px texture${credits != null ? ` · ${credits} credits` : ''}`;
}

function fail(error) {
  $('error').textContent = error.message;
}
async function start() {
  meta = await json('comparison.json');
  $('source-name').textContent = meta.source;
  $('source-note').textContent =
    `${meta.native.inputViews} saved frames → ${meta.native.registeredViews} recovered cameras for Punching Face. ${meta.views.length} cropped views → Meshy. Same source, different reconstruction inputs.`;
  const labels = {
    front: 'Front',
    'side-a': 'Side A',
    'side-b': 'Side B',
    far: 'Far side',
  };
  for (const [i, view] of meta.views.entries()) {
    const button = document.createElement('button');
    button.className = 'source-photo';
    const image = document.createElement('img');
    image.src = base + `view-${i}.png`;
    image.alt = labels[view.role];
    const caption = document.createElement('span');
    caption.textContent = labels[view.role];
    button.append(image, caption);
    button.onclick = () => {
      $('large-photo').src = image.src;
      $('photo-dialog').showModal();
    };
    $('source-views').append(button);
  }
  const a = panel('native-stage'),
    b = panel('meshy-stage');
  await Promise.all([native(a), meshy(b)]);
}
document.querySelectorAll('[data-angle]').forEach((b) => {
  b.onclick = () => angle(Number(b.dataset.angle), Number(b.dataset.elevation || 0));
});
document.querySelectorAll('[data-mode]').forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});
$('reset').onclick = () => angle(0);
$('meshy-yaw').onchange = () => {
  if (meshyRoot) {
    meshyRoot.rotation.y = THREE.MathUtils.degToRad(Number($('meshy-yaw').value));
    panels[1].draw();
  }
};
$('close-photo').onclick = () => $('photo-dialog').close();
start().catch(fail);
