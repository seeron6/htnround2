/** Store real, independent eyewear nodes alongside the deformable head in GLB. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { HeadGlasses } from '../src/head-accessories.js';
import { pathToFileURL } from 'node:url';

export async function packageEyewear(path) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(path);
  const root = document.getRoot();
  const heads = root
    .listNodes()
    .filter(
      (n) =>
        n.getMesh()?.getExtras().accessories?.glasses ||
        n.getExtras().accessories?.glasses,
    );
  if (heads.length !== 1)
    throw new Error('Expected one head with an eyewear specification.');
  if (root.listNodes().some((n) => n.getExtras().accessory === 'eyeglasses'))
    throw new Error('Eyewear is already packaged; refusing duplicate frames.');
  const previous = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
  const glasses = new HeadGlasses(
    (heads[0].getExtras().accessories || heads[0].getMesh().getExtras().accessories)
      .glasses,
  );
  try {
    const binary = await new GLTFExporter().parseAsync(glasses, { binary: true });
    const accessory = await io.readBinary(new Uint8Array(binary));
    const map = mergeDocuments(document, accessory);
    const scene = root.getDefaultScene() || root.listScenes()[0];
    for (const sourceScene of accessory.getRoot().listScenes()) {
      const mergedScene = map.get(sourceScene);
      for (const node of mergedScene.listChildren()) scene.addChild(node);
      mergedScene.dispose();
    }
    await document.transform(unpartition());
    await io.write(path, document);
  } finally {
    glasses.dispose();
    globalThis.FileReader = previous;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await packageEyewear(process.argv[2]);
