import * as THREE from 'three';

let skinMap, detailMap, fabricMap;
function textures() {
  if (typeof document === 'undefined') return {};
  if (!skinMap) {
    const loader = new THREE.TextureLoader();
    skinMap = loader.load('/models/arms/skin-albedo.webp');
    skinMap.colorSpace = THREE.SRGBColorSpace;
    skinMap.anisotropy = 8;
    detailMap = loader.load('/models/arms/skin-detail.webp');
    detailMap.anisotropy = 8;
    // Deterministic woven cotton height field, used only for the cloth surface.
    const n = 128,
      data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const warp = Math.sin((x * Math.PI) / 2),
          weft = Math.cos((y * Math.PI) / 2);
        const v = 128 + 34 * warp + 27 * weft + 10 * warp * weft;
        const i = (y * n + x) * 4;
        data.set([v, v, v, 255], i);
      }
    fabricMap = new THREE.DataTexture(data, n, n);
    fabricMap.wrapS = fabricMap.wrapT = THREE.RepeatWrapping;
    fabricMap.repeat.set(6, 9);
    fabricMap.magFilter = THREE.LinearFilter;
    fabricMap.minFilter = THREE.LinearMipmapLinearFilter;
    fabricMap.generateMipmaps = true;
    fabricMap.needsUpdate = true;
  }
  return { skinMap, detailMap, fabricMap };
}

export function makeArmMaterials(profile, sample) {
  const maps = textures();
  // Tint around the photographic atlas's neutral tone, retaining veins,
  // freckles, wrist/palm creases and nail colour rather than painting them flat.
  const tint = new THREE.Color(profile.skin);
  const neutral = new THREE.Color('#c99c83');
  tint.r /= neutral.r;
  tint.g /= neutral.g;
  tint.b /= neutral.b;
  const skin = new THREE.MeshPhysicalMaterial({
    color: maps.skinMap && !sample ? tint : profile.skin,
    map: maps.skinMap ?? null,
    bumpMap: maps.detailMap ?? null,
    bumpScale: 0.00028,
    roughness: 0.63,
    metalness: 0,
    specularIntensity: 0.32,
    sheen: 0.08,
    sheenColor: new THREE.Color(profile.skin),
    sheenRoughness: 0.85,
  });
  if (sample && maps.skinMap) {
    // The atlas supplies fine variation, not the template person's skin hue.
    // A captured skin color must also reach hands and the backs of the arms.
    const neutralLuminance =
      neutral.r * 0.2126 + neutral.g * 0.7152 + neutral.b * 0.0722;
    skin.onBeforeCompile = (shader) => {
      shader.uniforms.armNeutralLuminance = { value: neutralLuminance };
      shader.fragmentShader =
        'uniform float armNeutralLuminance;\n' +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
          vec3 armAtlas = texture2D(map, vMapUv).rgb;
          float armDetail = clamp(dot(armAtlas, vec3(0.2126, 0.7152, 0.0722)) / armNeutralLuminance, 0.65, 1.35);
          diffuseColor.rgb *= armDetail;
        #endif`,
        );
    };
    skin.customProgramCacheKey = () => 'arm-measured-skin-v1';
  }
  const cloth = new THREE.MeshPhysicalMaterial({
    color: profile.clothing,
    bumpMap: maps.fabricMap ?? null,
    bumpScale: 0.00045,
    roughness: 0.96,
    sheen: 0.7,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(profile.clothing).lerp(new THREE.Color('white'), 0.2),
    side: THREE.DoubleSide,
  });
  let photoMap = null,
    upperPhotoMap = null;
  if (
    sample &&
    sample?.strip?.length === sample.stripWidth * sample.stripHeight * 4 &&
    profile.photoDetail
  ) {
    photoMap = new THREE.DataTexture(
      new Uint8Array(sample.strip),
      sample.stripWidth,
      sample.stripHeight,
    );
    photoMap.colorSpace = THREE.SRGBColorSpace;
    photoMap.magFilter = photoMap.minFilter = THREE.LinearFilter;
    photoMap.needsUpdate = true;
    if (sample.upperStrip?.length === sample.strip.length) {
      upperPhotoMap = new THREE.DataTexture(
        new Uint8Array(sample.upperStrip),
        sample.stripWidth,
        sample.stripHeight,
      );
      upperPhotoMap.colorSpace = THREE.SRGBColorSpace;
      upperPhotoMap.magFilter = upperPhotoMap.minFilter = THREE.LinearFilter;
      upperPhotoMap.needsUpdate = true;
    }
    for (const material of [skin, cloth]) {
      const baseCompile = material.onBeforeCompile;
      material.onBeforeCompile = (shader) => {
        // Add the photo after the base map/tint, including measured skin.
        const marker = '// ARM_PHOTO_OVERLAY';
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n' + marker,
        );
        baseCompile(shader);
        shader.uniforms.armPhotoMap = { value: photoMap };
        shader.uniforms.armUpperPhotoMap = { value: upperPhotoMap ?? photoMap };
        shader.vertexShader =
          'attribute vec3 armPhotoUv; varying vec3 vArmPhotoUv;\n' +
          shader.vertexShader.replace(
            '#include <uv_vertex>',
            '#include <uv_vertex>\nvArmPhotoUv = armPhotoUv;',
          );
        shader.fragmentShader =
          'uniform sampler2D armPhotoMap; uniform sampler2D armUpperPhotoMap; varying vec3 vArmPhotoUv;\n' +
          shader.fragmentShader.replace(
            marker,
            'vec3 armCaptured = vArmPhotoUv.y > 1.0 ? texture2D(armUpperPhotoMap, vec2(vArmPhotoUv.x, vArmPhotoUv.y - 1.0)).rgb : texture2D(armPhotoMap, vArmPhotoUv.xy).rgb;\ndiffuseColor.rgb = mix(diffuseColor.rgb, armCaptured, vArmPhotoUv.z);',
          );
      };
      material.customProgramCacheKey = () =>
        `arm-photo-overlay-v2-${material === skin}`;
    }
  }
  return { skin, cloth, photoMap, upperPhotoMap };
}
