import * as THREE from 'three';

const curve = (points) =>
  new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(...p)),
    false,
    'centripetal',
  );

// Profile detections can wobble at the ear. Keep the visible temple as a
// straight rigid shaft, then reserve only the final section for the downward
// hook. The lateral shoulder is deliberately bounded so the arm stays tucked
// behind the front silhouette instead of flaring into a side spike.
function templeCurve(points) {
  const start = new THREE.Vector3(...points[0]),
    end = new THREE.Vector3(...points.at(-1)),
    span = start.z - end.z;
  if (points.length < 3 || span < 0.04) return new THREE.LineCurve3(start, end);
  const hookStart = 0.78,
    sign = Math.sign(start.x) || 1,
    shoulder = start.clone().lerp(end, hookStart),
    rawLateral = sign * (shoulder.x - start.x),
    lateral = Math.min(Math.max(0, rawLateral), 0.022);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (a[2] >= shoulder.z && b[2] <= shoulder.z && a[2] > b[2]) {
      shoulder.y = THREE.MathUtils.lerp(
        a[1],
        b[1],
        (a[2] - shoulder.z) / (a[2] - b[2]),
      );
      break;
    }
  }
  // Preserve the measured vertical slope at the shoulder while suppressing
  // noisy lateral excursions that become visible in the frontal render.
  shoulder.x = start.x + sign * lateral;
  const path = new THREE.CurvePath(),
    direction = shoulder.clone().sub(start).normalize(),
    hookLength = shoulder.distanceTo(end);
  path.add(new THREE.LineCurve3(start, shoulder));
  path.add(
    new THREE.CubicBezierCurve3(
      shoulder,
      shoulder.clone().addScaledVector(direction, hookLength * 0.35),
      end.clone().lerp(shoulder, 0.25),
      end,
    ),
  );
  return path;
}

// Surface-fitted paths already encode the shaft and ear bend. Preserve those
// segments: straightening or spline overshoot can put a cleared arm back inside
// the head. Older specifications retain their original rendering path.
function fittedTempleCurve(points) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < points.length; i++) {
    const a = new THREE.Vector3(...points[i - 1]),
      b = new THREE.Vector3(...points[i]);
    if (a.distanceToSquared(b) < 1e-14)
      throw new Error('Invalid fitted eyeglass arm segment.');
    path.add(new THREE.LineCurve3(a, b));
  }
  return path;
}

// A small studio reflection field gives polished acetate and lens surfaces
// broad highlights in viewers that have no room environment. Skin is untouched.
function eyewearEnvironment() {
  const w = 256,
    h = 128,
    data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w,
        v = y / h;
      let light = 0.025 + 0.045 * Math.max(0, 1 - v * 2);
      for (const [cx, cy, sx, sy, power] of [
        [0.2, 0.35, 0.04, 0.18, 0.9],
        [0.72, 0.32, 0.08, 0.11, 0.7],
        [0.48, 0.13, 0.17, 0.035, 0.4],
      ]) {
        const dx = Math.min(Math.abs(u - cx), 1 - Math.abs(u - cx)) / sx,
          dy = (v - cy) / sy;
        light += power * Math.exp(-Math.pow(dx, 6) - Math.pow(dy, 6));
      }
      const i = (y * w + x) * 4,
        c = Math.round(Math.min(1, light) * 255);
      data.set([c, c, Math.round(c * 0.97), 255], i);
    }
  const texture = new THREE.DataTexture(data, w, h);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

// Sweep a bevelled rectangular section. Acetate frames have flat faces and
// small edge radii; circular TubeGeometry makes them look like bent wire.
function sweep(path, closed, section, segments = 96, breaks = []) {
  const times = [
    ...new Set([
      ...Array.from({ length: segments + 1 }, (_, i) => i / segments),
      ...breaks,
    ]),
  ].sort((a, b) => a - b);
  segments = times.length - 1;
  const positions = [],
    indices = [],
    // Acetate has a broad, almost planar face with a small rounded bevel.
    // More section samples keep that bevel smooth without turning the frame
    // into a thin circular wire.
    sides = 20;
  for (let i = 0; i <= segments; i++) {
    const t = times[i],
      p = path.getPoint(t),
      tangent = path.getTangent(t).normalize();
    const { axis, width, depth } = section(t, p, tangent);
    const u = axis.clone().addScaledVector(tangent, -axis.dot(tangent)).normalize(),
      v = new THREE.Vector3().crossVectors(tangent, u).normalize();
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2,
        c = Math.cos(a),
        s = Math.sin(a);
      positions.push(
        ...p
          .clone()
          .addScaledVector(u, (Math.sign(c) * Math.pow(Math.abs(c), 0.32) * width) / 2)
          .addScaledVector(v, (Math.sign(s) * Math.pow(Math.abs(s), 0.32) * depth) / 2)
          .toArray(),
      );
    }
    if (i)
      for (let j = 0; j < sides; j++) {
        const a = (i - 1) * sides + j,
          b = (i - 1) * sides + ((j + 1) % sides),
          c = i * sides + j,
          d = i * sides + ((j + 1) % sides);
        indices.push(a, b, c, b, d, c);
      }
  }
  if (!closed)
    for (const end of [0, segments]) {
      const c = positions.length / 3;
      positions.push(...path.getPoint(times[end]).toArray());
      for (let j = 0; j < sides; j++) {
        const a = end * sides + j,
          b = end * sides + ((j + 1) % sides);
        indices.push(...(end ? [c, a, b] : [c, b, a]));
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function lensGeometry(path, radius, thickness = 0.0014) {
  const ring = path.getPoints(96).slice(0, -1),
    center = ring
      .reduce((a, p) => a.add(p), new THREE.Vector3())
      .multiplyScalar(1 / ring.length),
    positions = [],
    uvs = [],
    indices = [],
    levels = 8,
    // The fitted contours are camera-facing, but the upper/lower edges carry
    // a small measured depth variation. A stable optical normal keeps the
    // shell coherent at profile angles without bending it into the face.
    normal = new THREE.Vector3(0, 0, 1),
    half = THREE.MathUtils.clamp(thickness, 0.0006, 0.002) / 2,
    minX = Math.min(...ring.map((p) => p.x)),
    maxX = Math.max(...ring.map((p) => p.x)),
    minY = Math.min(...ring.map((p) => p.y)),
    maxY = Math.max(...ring.map((p) => p.y));
  const addUv = (p) =>
    uvs.push(
      (p.x - minX) / Math.max(1e-6, maxX - minX),
      1 - (p.y - minY) / Math.max(1e-6, maxY - minY),
    );
  const addSurface = (sign) => {
    const start = positions.length / 3;
    for (let k = 0; k <= levels; k++) {
      const r = k / levels;
      for (const p of ring) {
        const offset = p.clone().sub(center),
          radial = Math.max(0.0001, Math.hypot(offset.x, offset.y)),
          inset = Math.max(0, 1 - (radius * 0.65) / radial),
          point = center.clone().addScaledVector(offset, r * inset),
          bulge = half * 0.7 * (1 - r * r);
        point.addScaledVector(normal, sign * (half + bulge));
        positions.push(...point.toArray());
        addUv(point);
      }
    }
    for (let k = 0; k < levels; k++)
      for (let j = 0; j < ring.length; j++) {
        const a = start + k * ring.length + j,
          b = start + k * ring.length + ((j + 1) % ring.length),
          c = a + ring.length,
          d = b + ring.length;
        indices.push(...(sign > 0 ? [a, b, c, b, d, c] : [a, c, b, b, c, d]));
      }
  };
  addSurface(1);
  addSurface(-1);
  const frontStart = 0,
    backStart = (levels + 1) * ring.length;
  for (let j = 0; j < ring.length; j++) {
    const a = frontStart + levels * ring.length + j,
      b = frontStart + levels * ring.length + ((j + 1) % ring.length),
      c = backStart + levels * ring.length + j,
      d = backStart + levels * ring.length + ((j + 1) % ring.length);
    indices.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function lensReflectionTexture() {
  if (typeof document === 'undefined') return null;
  const width = 256,
    height = 256,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1),
        v = y / (height - 1),
        // A broad diagonal studio strip and a softer lower return are the
        // coating response visible in the source eyewear. They are deliberately
        // wide enough to survive the small review render without hiding the
        // photographed eyes behind a painted gray card.
        upperReflection = Math.exp(-(((u * 0.84 + v * 0.52 - 0.34) / 0.105) ** 2)),
        lowerReflection = Math.exp(-(((u * 0.46 + v * 1.08 - 1.04) / 0.16) ** 2)),
        reflection = Math.min(1, upperReflection * 0.82 + lowerReflection * 0.18),
        // A clear lens still has a cool gray-green veil from its coating. The
        // lower alpha keeps the irises and lids authoritative over the veil.
        tone = 0.88,
        alpha = Math.round(72 + reflection * 183),
        i = (y * width + x) * 4;
      data[i] = Math.round(Math.max(0, tone - reflection * 0.24) * 255);
      data[i + 1] = Math.round(Math.min(1, tone + 0.025 - reflection * 0.045) * 255);
      data[i + 2] = Math.round(Math.min(1, tone + 0.02 + reflection * 0.01) * 255);
      // A real clear lens is mostly transparent; only the polarized studio
      // streak carries a visible veil. Encoding that in alpha keeps the eyes
      // readable while preserving a reflection that survives a profile turn.
      data[i + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Rigid eyewear remains independent of deformable skin and serializes from spec.
export class HeadGlasses extends THREE.Group {
  constructor(spec) {
    super();
    this.name = 'Photo-fitted 3D glasses';
    this.spec = structuredClone(spec);
    this.userData = { accessory: 'eyeglasses', estimated: true };
    const paths = [...(spec?.rims ?? []), spec?.bridge, ...(spec?.temples ?? [])];
    if (
      spec?.rims?.length !== 2 ||
      paths.some(
        (p) =>
          !Array.isArray(p) ||
          p.length < 2 ||
          p.length > 64 ||
          p.some(
            (v) =>
              v.length !== 3 || !v.every((x) => Number.isFinite(x) && Math.abs(x) < 1),
          ),
      )
    )
      throw new Error('Invalid reconstructed glasses paths.');
    if (
      spec.rimWidths &&
      (spec.rimWidths.length !== 2 ||
        spec.rimWidths.some(
          (widths, i) =>
            !Array.isArray(widths) ||
            widths.length !== spec.rims[i].length ||
            widths.some((w) => !Number.isFinite(w) || w <= 0 || w > 0.01),
        ))
    )
      throw new Error('Invalid measured eyeglass rim widths.');
    if (spec.templePathMode !== undefined && spec.templePathMode !== 'fitted-polyline')
      throw new Error('Invalid fitted eyeglass arm mode.');
    const dimensions = [
      spec.templeWidth,
      spec.rimDepth,
      spec.bridgeWidth,
      spec.bridgeDepth,
      spec.lensThickness,
      spec.templeAccent?.length,
      spec.templeAccent?.width,
      spec.templeAccent?.offset,
    ].filter((v) => v !== undefined);
    if (dimensions.some((v) => !Number.isFinite(v) || v <= 0 || v > 0.03))
      throw new Error('Invalid eyeglass detail dimensions.');
    const color = new THREE.Color().setRGB(
      ...(spec.frameColor ?? [0.04, 0.04, 0.04]),
      THREE.SRGBColorSpace,
    );
    // The source acetate is near-black brown, but its polished face still
    // carries a readable warm highlight. Lift the linear base enough that the
    // side arms retain their acetate tone instead of collapsing into black.
    color.multiplyScalar(2.4);
    this.reflection = eyewearEnvironment();
    this.lensReflection = lensReflectionTexture();
    const material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.2,
      metalness: 0,
      // Dark acetate still produces a broad warm grazing highlight. Keep this
      // lobe separate from the clearcoat so the frames read as solid plastic
      // at three-quarter and profile angles instead of flat black ink.
      specularIntensity: 0.82,
      specularColor: new THREE.Color(0.28, 0.24, 0.21),
      clearcoat: 1,
      clearcoatRoughness: 0.085,
      envMap: this.reflection,
      envMapIntensity: 2.05,
      sheen: 0.12,
      sheenColor: new THREE.Color(0.22, 0.16, 0.12),
      sheenRoughness: 0.3,
    });
    const tint = THREE.MathUtils.clamp(spec.lensTint ?? 0, 0, 0.6);
    // Preserve the measured eyes: screen-space refraction bends the already
    // photographed lens distortion a second time and pulls in the backdrop.
    const lensMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(1 - tint * 0.25, 1 - tint * 0.22, 1 - tint * 0.2),
      roughness: 0.03,
      metalness: 0,
      ior: 1.5,
      transparent: true,
      // Meshy shows a readable gray-green lens reflection. Keep this below a
      // sunglass tint so the photographed eyes and brows remain authoritative,
      // while the curved shell still reads as glass at three-quarter angles.
      // The source lenses are clear acetate. A lower veil keeps the
      // photographed eyelids and irises readable while the reflection map
      // and polished edge still establish a real optical surface.
      opacity: 0.23 + tint * 0.03,
      depthWrite: false,
      // The shell contains front and back surfaces with opposite winding;
      // front-face culling keeps both visible from their respective sides
      // without drawing both alpha layers through the same eye.
      side: THREE.FrontSide,
      specularIntensity: 0.9,
      specularColor: new THREE.Color(0.78, 0.84, 0.82),
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      iridescence: 0.14,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [120, 360],
      envMap: this.reflection,
      // The studio field is intentionally low contrast; a stronger optical
      // response keeps the lens readable at grazing/profile angles without
      // increasing the transparent veil over the photographed eyes.
      envMapIntensity: 3.6,
    });
    if (this.lensReflection) lensMaterial.map = this.lensReflection;
    const metal = new THREE.MeshStandardMaterial({
      // The source frames have a pale brushed insert at each hinge. Keep it
      // metallic, but give it enough broad studio response to remain legible
      // when the temple turns edge-on instead of disappearing into black
      // acetate.
      color: 0xd3d0c7,
      roughness: 0.2,
      // A small diffuse component keeps the pale inset visible in the
      // neutral viewer even when its normal points away from the reflection
      // field. It still reads as brushed metal through the clear highlight.
      metalness: 0.28,
      envMap: this.reflection,
      envMapIntensity: 2.1,
    });
    const templeMaterial = material.clone();
    // A separate arm response preserves the source's slim glossy side
    // highlight without changing the measured front rim contour.
    templeMaterial.roughness = 0.13;
    templeMaterial.clearcoatRoughness = 0.055;
    templeMaterial.envMapIntensity = 1.72;
    // Small silicone nose pads and their metal carriers are easy to miss in a
    // frontal photograph, but they are what keeps the bridge from reading as
    // a flat decal when the head turns. Keep them translucent and tucked
    // behind the bridge so the photographed nose and eyes remain authoritative.
    const padMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x9aa3a1,
      roughness: 0.28,
      metalness: 0.08,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      envMap: this.reflection,
      envMapIntensity: 0.7,
    });
    const radius = THREE.MathUtils.clamp(spec.radius ?? 0.0015, 0.0008, 0.003);
    const add = (geometry, mat, name) => {
      const m = new THREE.Mesh(geometry, mat);
      m.name = name;
      m.userData.accessory = 'eyeglasses';
      this.add(m);
      return m;
    };
    spec.rims.forEach((points, i) => {
      const path = curve(points);
      path.closed = true;
      const ys = points.map((p) => p[1]),
        bottom = Math.min(...ys),
        height = Math.max(...ys) - bottom;
      const measuredWidths = spec.rimWidths?.[i];
      const rimWidth = (t, p) => {
        if (!measuredWidths?.length)
          return radius * (1.25 + (0.75 * (p.y - bottom)) / Math.max(0.001, height));
        const index = (t % 1) * measuredWidths.length;
        const a = Math.floor(index),
          f = index - a;
        return THREE.MathUtils.clamp(
          (measuredWidths[a] * (1 - f) +
            measuredWidths[(a + 1) % measuredWidths.length] * f) *
            1.34,
          0.001,
          0.0068,
        );
      };
      add(
        sweep(
          path,
          true,
          (t, p, tangent) => ({
            axis: new THREE.Vector3(-tangent.y, tangent.x, 0),
            width: rimWidth(t, p),
            depth: spec.rimDepth ?? radius * 1.65,
          }),
          128,
        ),
        material,
        `Eyeglass rim ${i + 1}`,
      );
      const lens = add(
        lensGeometry(path, radius, spec.lensThickness ?? 0.0014),
        lensMaterial,
        `Eyeglass lens ${i + 1}`,
      );
      lens.renderOrder = 2;
      if (spec.lensThickness) {
        const center = points
          .reduce((p, q) => p.add(new THREE.Vector3(...q)), new THREE.Vector3())
          .divideScalar(points.length);
        const edge = curve(
          points.map((q, j) => {
            const p = new THREE.Vector3(...q),
              d = p.clone().sub(center);
            const inset = rimWidth(j / points.length, p) * 0.48;
            p.addScaledVector(d, -inset / Math.max(0.001, Math.hypot(d.x, d.y)));
            return p.toArray();
          }),
        );
        edge.closed = true;
        const edgeMaterial = lensMaterial.clone();
        edgeMaterial.opacity = 0.16;
        edgeMaterial.color.setRGB(0.82, 0.9, 0.88);
        edgeMaterial.map = null;
        const edgeMesh = add(
          sweep(
            edge,
            true,
            (_, p, tangent) => ({
              axis: new THREE.Vector3(-tangent.y, tangent.x, 0),
              width: 0.0003,
              depth: THREE.MathUtils.clamp(spec.lensThickness, 0.0006, 0.002),
            }),
            128,
          ),
          edgeMaterial,
          `Eyeglass polished lens edge ${i + 1}`,
        );
        edgeMesh.renderOrder = 2;
      }
    });
    add(
      sweep(
        curve(spec.bridge),
        false,
        () => ({
          axis: new THREE.Vector3(0, 1, 0),
          width: (spec.bridgeWidth ?? radius * 1.8) * 0.9,
          depth: (spec.bridgeDepth ?? radius * 1.7) * 0.88,
        }),
        48,
      ),
      material,
      'Eyeglass bridge',
    );
    // Fit one pad below each bridge end. They remain children of the rigid
    // eyewear group and therefore never become vertices of the head surface.
    const bridgeEnds = [spec.bridge[0], spec.bridge.at(-1)];
    bridgeEnds.forEach((point, i) => {
      const support = new THREE.Vector3(...point),
        pad = support.clone().add(new THREE.Vector3(0, -0.0027, -0.00125));
      add(
        sweep(
          curve([support.toArray(), pad.toArray()]),
          false,
          () => ({
            axis: new THREE.Vector3(0, 1, 0),
            width: 0.00028,
            depth: 0.00022,
          }),
          12,
        ),
        metal,
        `Eyeglass nose pad carrier ${i + 1}`,
      );
      const padMesh = add(
        new THREE.SphereGeometry(0.00145, 16, 10),
        padMaterial,
        `Eyeglass silicone nose pad ${i + 1}`,
      );
      padMesh.position.copy(pad);
      padMesh.scale.set(1.05, 0.68, 0.42);
      padMesh.renderOrder = 2;
    });
    spec.temples.forEach((points, i) => {
      const path =
          spec.templePathMode === 'fitted-polyline'
            ? fittedTempleCurve(points)
            : templeCurve(points),
        // Restore the broad acetate section after head-height normalization.
        // The photographed arm is broad acetate, but the previous 1.15x
        // display multiplier made it float away from the temple in profile.
        // Keep a measured clearance while matching the slim polished side arm.
        width = THREE.MathUtils.clamp(
          (spec.templeWidth ?? 0.005) * 1.16,
          0.0022,
          0.0064,
        );
      add(
        sweep(
          path,
          false,
          (t) => ({
            axis: new THREE.Vector3(0, 1, 0),
            width: width * (1 - 0.52 * THREE.MathUtils.smoothstep(t, 0.08, 0.95)),
            // The source shows broad acetate arms rather than wire temples. Keep
            // the measured shaft path, while giving the side panel enough depth
            // to produce a real edge highlight in profile views.
            depth: 0.0033 * (1 - 0.25 * t),
          }),
          96,
          spec.templePathMode === 'fitted-polyline'
            ? path.getCurveLengths().map((length) => length / path.getLength())
            : [],
        ),
        templeMaterial,
        `Eyeglass temple ${i + 1}`,
      );
      // Small hinge plates on the outside, aligned with the start of each arm.
      const t = 0.035,
        p = path.getPoint(t),
        tangent = path.getTangent(t).normalize(),
        sign = Math.sign(p.x) || 1;
      const plate = add(
        new THREE.BoxGeometry(0.00075, width * 0.62, 0.0048),
        metal,
        `Eyeglass hinge ${i + 1}`,
      );
      plate.position.copy(p);
      plate.position.x += sign * 0.00125;
      plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
      if (spec.templeAccent) {
        const detail = spec.templeAccent,
          length = path.getLength();
        const start = THREE.MathUtils.clamp((detail.offset ?? 0.004) / length, 0, 0.3);
        const end = Math.min(
          0.6,
          start + THREE.MathUtils.clamp(detail.length, 0.004, 0.02) / length,
        );
        const accentPoints = Array.from({ length: 9 }, (_, j) => {
          const t = start + ((end - start) * j) / 8;
          const q = path.getPointAt(t),
            tangent = path.getTangentAt(t);
          const outward = new THREE.Vector3(-tangent.z, 0, tangent.x)
            .normalize()
            .multiplyScalar(sign);
          // Seat the metal inlay on the upper/outboard face of the acetate;
          // this makes the silver strip catch light in profile without
          // turning it into a floating second temple.
          q.addScaledVector(outward, 0.0031);
          q.y += width * 0.36;
          return q.toArray();
        });
        const accentMesh = add(
          sweep(
            curve(accentPoints),
            false,
            () => ({
              axis: new THREE.Vector3(0, 1, 0),
              width: THREE.MathUtils.clamp(detail.width * 1.55, 0.0008, 0.0028),
              depth: 0.00055,
            }),
            32,
          ),
          metal,
          `Eyeglass inset temple accent ${i + 1}`,
        );
        accentMesh.renderOrder = 3;
        for (const [j, point] of [accentPoints[0], accentPoints[8]].entries()) {
          const screw = add(
            new THREE.CylinderGeometry(0.00045, 0.00045, 0.00022, 16),
            metal,
            `Eyeglass hinge screw ${i + 1}.${j + 1}`,
          );
          screw.rotation.z = Math.PI / 2;
          screw.position.set(...point);
          screw.position.x += sign * 0.00016;
        }
      }
    });
  }

  dispose() {
    this.removeFromParent();
    const materials = new Set();
    this.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        materials.add(o.material);
      }
    });
    materials.forEach((m) => m.dispose());
    this.reflection.dispose();
    this.lensReflection?.dispose();
  }
}
