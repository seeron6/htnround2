/** Store real, independent eyewear nodes alongside the deformable head in GLB. */
import fs from 'node:fs';
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
  // Detached nodes can remain in the document graph after a previous package
  // pass. Only a scene-attached eyewear group is a duplicate publication.
  if (
    root
      .listScenes()
      .some((scene) =>
        scene.listChildren().some((n) => n.getExtras().accessory === 'eyeglasses'),
      )
  )
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
    const reflectionPath = new URL(
      '../public/textures/lens-reflection.png',
      import.meta.url,
    );
    if (fs.existsSync(reflectionPath)) {
      const texture = document
        .createTexture('serialized lens reflection')
        .setMimeType('image/png')
        .setImage(fs.readFileSync(reflectionPath));
      for (const material of document.getRoot().listMaterials()) {
        const factor = material.getBaseColorFactor();
        const roughness = material.getRoughnessFactor();
        // GLTFExporter stores the clear lens opacity at 0.1212 and the
        // polished edge at 0.16. The old 0.06-0.1 window missed both, so the
        // published GLB silently lost its lens coating even though the live
        // Three.js material had one. Restrict the replacement to translucent,
        // optical materials so skin and acetate are never recolored.
        if (factor[3] >= 0.1 && factor[3] <= 0.2 && roughness <= 0.06)
          material.setBaseColorTexture(texture);
      }
    }
    await io.write(path, document);
  } finally {
    glasses.dispose();
    globalThis.FileReader = previous;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await packageEyewear(process.argv[2]);
