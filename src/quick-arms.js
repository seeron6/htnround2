import * as THREE from 'three';
import { PresetArm } from './preset-arm.js';
import {
  ARM_SCAN_MS,
  ARM_BUILD_BUDGET_MS,
  DEFAULT_ARM,
  ArmScanAccumulator,
  normalizeArmProfile,
  sampleArmFrame,
  restoreArmSample,
  storeArmSample,
} from './arm-personalization.js';
import './quick-arms.css';

const STORAGE_KEY = 'punching-face-arm-presets-v1';
const sides = ['left', 'right'];

export class QuickArms {
  constructor({ tracking, camera, scene, setMode, getMode, onChange = () => {} }) {
    Object.assign(this, { tracking, setMode, getMode, onChange });
    this.profiles = { left: { ...DEFAULT_ARM }, right: { ...DEFAULT_ARM } };
    this.samples = {};
    this.arms = [];
    this.group = new THREE.Group();
    camera.add(this.group);
    if (!camera.parent) scene.add(camera);
    this.readSaved();
    this.buildArms();
    this.group.visible = false;
    this.accumulator = new ArmScanAccumulator();
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'quick-arm-dialog';
    this.dialog.setAttribute('aria-label', 'Personalize your first-person arms');
    this.dialog.innerHTML = /* HTML */ ` <div class="quick-arm-content">
        <div class="quick-arm-heading">
          <div>
            <p class="quick-arm-eyebrow">YOUR ARMS / FIRST PERSON</p>
            <h1>Make them yours.</h1>
          </div>
          <button id="quick-arm-close" aria-label="Close arm scan">×</button>
        </div>
        <p class="quick-arm-intro">
          Scan your skin, sleeves and visible accessories in 8 seconds. Show the backs
          of your open hands and your wrists, then slowly turn both forearms.
        </p>
        <div class="quick-arm-layout">
          <div class="quick-arm-visuals">
            <div id="quick-arm-preview" aria-label="First-person 3D arm preview"></div>
            <span class="quick-arm-view-label">FIRST-PERSON PREVIEW</span>
            <label for="quick-arm-reach">Bend / extend arms</label>
            <input
              id="quick-arm-reach"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value="0"
            />
            <label for="quick-arm-grip">Open hand / closed fist</label>
            <input
              id="quick-arm-grip"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value="1"
            />
            <label class="quick-arm-check"
              ><input id="quick-arm-anchors" type="checkbox" /> Show shoulder, elbow and
              wrist anchors</label
            >
            <label class="quick-arm-check"
              ><input id="quick-arm-inspect" type="checkbox" /> Inspect full arms</label
            >
            <video
              id="quick-arm-video"
              playsinline
              muted
              hidden
              aria-label="Arm scan camera preview"
            ></video>
            <p class="quick-arm-hint">
              Keep elbows, wrists and open fingers in view, away from your body. Show
              your watch face and rings to the camera. Good light helps capture colors
              and fabric details.
            </p>
          </div>
          <div class="quick-arm-options">
            <label for="quick-arm-side">Customize</label
            ><select id="quick-arm-side">
              <option value="both">Both arms</option>
              <option value="left">Left arm</option>
              <option value="right">Right arm</option>
            </select>
            <label for="quick-arm-style">Clothing</label
            ><select id="quick-arm-style">
              <option value="mixed" hidden disabled>Different on each arm</option>
              <option value="bare">No sleeves</option>
              <option value="short">Short sleeves</option>
              <option value="long">Long sleeves</option>
              <option value="hoodie">Hoodie / loose sleeves</option>
            </select>
            <div class="quick-arm-colors">
              <label>Skin color<input id="quick-arm-skin" type="color" /></label
              ><label
                >Clothing color<input id="quick-arm-clothing" type="color"
              /></label>
            </div>
            <label for="quick-arm-width">Arm width</label
            ><input
              id="quick-arm-width"
              type="range"
              min="0.75"
              max="1.3"
              step="0.01"
            />
            <label class="quick-arm-check"
              ><input id="quick-arm-detail" type="checkbox" checked /> Keep scanned
              markings / tattoos</label
            >
            <p class="quick-arm-hint">
              The scan fits each arm separately, including visible sleeves, watches and
              rings. You can correct the result here.
            </p>
            <label class="quick-arm-check"
              ><input id="quick-arm-watch" type="checkbox" /> Watch</label
            >
            <label class="quick-arm-check"
              ><input id="quick-arm-ring" type="checkbox" /> Ring</label
            >
            <p class="quick-arm-hint">
              Processed locally. The scan fits a 3D arm template and preserves visible
              colors and details; hidden surfaces and accessory shapes are approximated.
              Saved in this browser when you use these arms.
            </p>
            <details>
              <summary>Existing arm reconstruction</summary>
              <button id="quick-arm-advanced">Open multiview capture / import</button>
            </details>
          </div>
        </div>
      </div>
      <div class="quick-arm-footer">
        <p id="quick-arm-status" role="status" aria-live="polite"></p>
        <progress
          id="quick-arm-progress"
          max="8000"
          value="0"
          hidden
          aria-label="Arm scan progress"
        ></progress>
        <div class="quick-arm-actions">
          <button id="quick-arm-start" class="primary">Scan my arms · 8 seconds</button>
          <button id="quick-arm-stop" hidden>Cancel scan</button>
          <button id="quick-arm-use" class="primary">Use these arms</button>
        </div>
      </div>`;
    document.body.append(this.dialog);
    this.$ = (id) => this.dialog.querySelector(`#quick-arm-${id}`);
    this.$('close').onclick = () => this.close();
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.$('start').onclick = () => void this.start();
    this.$('stop').onclick = () => this.cancel();
    this.$('side').onchange = () => this.syncFields();
    for (const key of [
      'skin',
      'clothing',
      'style',
      'width',
      'detail',
      'watch',
      'ring',
    ]) {
      this.$(key).oninput = () => {
        const value = ['detail', 'watch', 'ring'].includes(key)
          ? this.$(key).checked
          : this.$(key).value;
        const selected = this.$('side').value;
        for (const side of selected === 'both' ? sides : [selected]) {
          this.draft[side][key === 'detail' ? 'photoDetail' : key] =
            key === 'width' ? Number(value) : value;
          // Explicit color/style changes override the corresponding photograph.
          if (['skin', 'clothing', 'style'].includes(key))
            this.draft[side].photoDetail = false;
        }
        this.syncFields();
        this.buildPreview();
      };
    }
    this.$('use').onclick = () => {
      this.profiles = structuredClone(this.draft);
      this.samples = { ...this.draftSamples };
      this.buildArms();
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            profiles: this.profiles,
            samples: Object.fromEntries(
              Object.entries(this.samples).map(([side, s]) => [
                side,
                storeArmSample(s),
              ]),
            ),
          }),
        );
      } catch {
        /* In-memory arms still work when storage is unavailable/full. */
      }
      this.setMode('preset');
      this.onChange();
      this.close();
    };
    this.contactListener = ({ detail }) => {
      if (this.getMode() !== 'preset') return;
      const side =
        String(detail.side).toLowerCase() === 'left' || detail.side === -1 ? -1 : 1;
      this.arms.find((arm) => arm.side === side)?.motor.recoil(detail.speed);
    };
    window.addEventListener('punching-face-contact', this.contactListener);
    this.visibilityListener = () => {
      if (document.hidden && this.running)
        this.cancel(
          'Scan paused because the tab was hidden. Your previous arms are kept.',
        );
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
    tracking.onArmSample = (data) => this.accept(data);
  }

  get isOpen() {
    return this.dialog.open;
  }
  // Whether these arms have ever been fitted to the user — a kept photo strip is what separates
  // "scanned" from the stock preset. Drives the one-time scan prompt when they pick these arms.
  get scanned() {
    return sides.some((side) => !!this.samples[side]);
  }
  get state() {
    return {
      ready: true,
      scanned: this.scanned,
      scanning: !!this.running,
      frames: this.accumulator.frames,
      timing: this.timing,
      profiles: this.profiles,
      draftProfiles: this.isOpen ? this.draft : undefined,
      visible: this.group.visible,
    };
  }
  readSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved?.profiles) return;
      for (const side of sides) {
        this.profiles[side] = normalizeArmProfile(saved.profiles[side]);
        const sample = restoreArmSample(saved.samples?.[side]);
        if (sample) this.samples[side] = sample;
      }
    } catch {
      /* A stale or invalid local preset falls back to the defaults. */
    }
  }
  buildArms() {
    this.arms.forEach((a) => a.dispose());
    this.arms = sides.map(
      (side, i) => new PresetArm(i ? 1 : -1, this.profiles[side], this.samples[side]),
    );
    this.group.add(...this.arms);
  }
  update(hands, dt) {
    this.group.visible = this.getMode() === 'preset';
    if (this.group.visible)
      this.arms.forEach((arm) =>
        arm.update(
          // Keep the avatar in a boxing fist without changing the tracked
          // closure used to decide whether a real punch can land.
          { ...hands.find((h) => h.side === arm.side), closed: 1 },
          dt,
        ),
      );
  }
  async prepare() {
    if (!this.tracking.active) return false;
    try {
      await this.tracking.enableBody();
      return true;
    } catch {
      return false;
    }
  }
  async open() {
    if (this.dialog.open) return;
    this.draft = structuredClone(this.profiles);
    this.draftSamples = { ...this.samples };
    this.$('side').value = 'both';
    this.$('grip').value = '1';
    this.syncFields();
    this.dialog.showModal();
    this.$('video').srcObject = this.tracking.stream;
    this.$('video').hidden = !this.tracking.active;
    this.$('video')
      .play()
      .catch(() => {});
    this.createPreview();
    this.buildPreview();
    this.renderPreview();
    this.$('start').disabled = true;
    this.status(
      this.tracking.active
        ? 'Preparing arm tracking… You can customize the presets now.'
        : 'Connect the webcam to scan, or customize the presets now.',
    );
    const ready = await this.prepare();
    if (!this.dialog.open) return;
    this.$('start').disabled = !ready;
    if (ready)
      this.status(
        'Ready to scan. Show open hands, wrists and sleeves with both elbows in view.',
      );
    else if (this.tracking.active)
      this.status(
        'Arm tracking could not load. Reopen this panel to retry, or use the presets.',
      );
  }
  status(message, state = '') {
    this.$('status').textContent = message;
    this.$('status').dataset.state = state;
  }
  syncFields() {
    const p = this.draft[this.$('side').value === 'right' ? 'right' : 'left'];
    for (const key of ['skin', 'clothing', 'style', 'width'])
      this.$(key).value = p[key];
    if (
      this.$('side').value === 'both' &&
      this.draft.left.style !== this.draft.right.style
    )
      this.$('style').value = 'mixed';
    for (const [key, field] of [
      ['detail', 'photoDetail'],
      ['watch', 'watch'],
      ['ring', 'ring'],
    ])
      this.$(key).checked = p[field];
    for (const key of ['watch', 'ring', 'detail']) {
      const field = key === 'detail' ? 'photoDetail' : key;
      this.$(key).indeterminate =
        this.$('side').value === 'both' &&
        this.draft.left[field] !== this.draft.right[field];
    }
  }
  async start() {
    if (this.running || !this.tracking.active || !this.tracking.poseReady) return;
    this.accumulator.reset();
    this.running = true;
    this.started = performance.now();
    this.tracking.scanArms = true;
    this.setScanning(true);
    this.timer = setInterval(() => {
      if (!this.tracking.active)
        return this.cancel('Camera disconnected. Reconnect it, then reopen the scan.');
      const elapsed = performance.now() - this.started;
      this.$('progress').value = elapsed;
      this.status(
        `${Math.max(0, Math.ceil((ARM_SCAN_MS - elapsed) / 1000))}s · left ${this.accumulator.frames.left} views · right ${this.accumulator.frames.right} views · ${elapsed < 4000 ? 'show backs of open hands, rings and watch face' : 'turn your forearms to show sleeves and skin'}`,
      );
      if (elapsed >= ARM_SCAN_MS) this.finish();
    }, 100);
  }
  setScanning(active) {
    this.$('progress').hidden = !active;
    this.$('stop').hidden = !active;
    this.$('start').hidden = active;
    this.$('use').disabled = active;
    this.$('advanced').disabled = active;
    this.dialog
      .querySelectorAll('.quick-arm-options input, .quick-arm-options select')
      .forEach((el) => {
        el.disabled = active;
      });
  }
  accept(data) {
    if (!this.running || data.timestamp < this.started) return;
    const pose = data.pose;
    if (!pose || Math.abs(data.timestamp - pose.timestamp) > 100) return;
    const samples = sampleArmFrame(data.armSample, data.landmarks, pose.landmarks?.[0]);
    this.accumulator.add(samples, data.timestamp);
  }
  finish() {
    const previousDraft = this.draft;
    const previousSamples = this.draftSamples;
    const capturedAt = performance.now();
    this.tracking.scanArms = false;
    this.running = false;
    clearInterval(this.timer);
    this.setScanning(false);
    try {
      if (capturedAt - this.started >= ARM_BUILD_BUDGET_MS)
        throw new Error('The scan was interrupted. Try again with this tab in front.');
      const profiles = this.accumulator.finish();
      this.draft = {};
      this.draftSamples = {};
      for (const side of sides) {
        this.draft[side] = { ...profiles[side] };
        delete this.draft[side].sample;
        this.draftSamples[side] = profiles[side].sample;
      }
      this.syncFields();
      this.buildPreview();
      this.previewRenderer.render(this.previewScene, this.previewCamera);
      const readyAt = performance.now();
      this.timing = {
        captureMs: capturedAt - this.started,
        buildMs: readyAt - capturedAt,
        totalMs: readyAt - this.started,
        budgetMs: ARM_BUILD_BUDGET_MS,
      };
      if (this.timing.totalMs >= ARM_BUILD_BUDGET_MS)
        throw new Error(
          'This device exceeded 15 seconds. Presets are ready; retry for a faster scan.',
        );
      this.status(
        `Scan complete. ${sides
          .map((side) => {
            const p = this.draft[side];
            const items = [p.style === 'bare' ? 'bare arm' : `${p.style} sleeves`];
            if (p.watch) items.push('watch');
            if (p.ring) items.push('ring');
            return `${side === 'left' ? 'Left' : 'Right'}: ${items.join(', ')}.`;
          })
          .join(' ')} Review the preview, then use these arms.`,
        'success',
      );
    } catch (error) {
      this.draft = previousDraft;
      this.draftSamples = previousSamples;
      this.syncFields();
      this.buildPreview();
      this.status(`Scan did not apply: ${error.message}`, 'error');
    }
  }
  cancel(message = 'Scan cancelled. Your previous arms are kept.') {
    clearInterval(this.timer);
    this.tracking.scanArms = false;
    this.running = false;
    this.setScanning(false);
    this.status(message);
  }
  createPreview() {
    this.previewScene = new THREE.Scene();
    this.previewScene.background = new THREE.Color('#e9ece8');
    this.previewCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 3);
    this.previewCamera.lookAt(0, -0.12, -0.4);
    this.previewRenderer = new THREE.WebGLRenderer({ antialias: true });
    this.previewRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.previewScene.add(new THREE.HemisphereLight(0xffffff, 0x59615b, 1.45));
    const key = new THREE.DirectionalLight(0xfff2e1, 2.5);
    key.position.set(-1, 2, 1);
    this.previewScene.add(key);
    const fill = new THREE.DirectionalLight(0xdbe9ff, 0.7);
    fill.position.set(1, 0.2, -1);
    this.previewScene.add(fill);
    this.$('preview').replaceChildren(this.previewRenderer.domElement);
  }
  buildPreview() {
    this.previewArms?.forEach((a) => a.dispose());
    this.previewArms = sides.map(
      (side, i) => new PresetArm(i ? 1 : -1, this.draft[side], this.draftSamples[side]),
    );
    this.previewScene.add(...this.previewArms);
  }
  renderPreview() {
    if (!this.dialog.open) return;
    const box = this.$('preview'),
      width = Math.max(1, box.clientWidth),
      height = Math.max(1, box.clientHeight);
    if (
      this.previewRenderer.domElement.clientWidth !== width ||
      this.previewRenderer.domElement.clientHeight !== height
    ) {
      this.previewRenderer.setSize(width, height);
      this.previewCamera.aspect = width / height;
      this.previewCamera.updateProjectionMatrix();
    }
    const inspect = this.$('inspect').checked;
    this.previewCamera.position.set(0, inspect ? 0.02 : 0, inspect ? 0.36 : 0);
    const fov = inspect ? 48 : 62;
    if (this.previewCamera.fov !== fov) {
      this.previewCamera.fov = fov;
      this.previewCamera.updateProjectionMatrix();
    }
    this.previewCamera.lookAt(0, inspect ? -0.25 : -0.12, inspect ? -0.16 : -0.4);
    const reach = Number(this.$('reach').value);
    for (const arm of this.previewArms) {
      arm.anchorMarkers.visible = this.$('anchors').checked;
      arm.update(
        {
          visible: true,
          center: new THREE.Vector3(
            arm.side * (0.15 - reach * 0.04),
            -0.105 + reach * 0.13,
            -0.34 - reach * 0.24,
          ),
          closed: Number(this.$('grip').value),
        },
        1 / 60,
      );
    }
    this.previewRenderer.render(this.previewScene, this.previewCamera);
    this.animation = requestAnimationFrame(() => this.renderPreview());
  }
  close() {
    if (this.running) this.cancel();
    this.dialog.close();
    this.$('video').srcObject = null;
    cancelAnimationFrame(this.animation);
    this.previewArms?.forEach((a) => a.dispose());
    this.previewArms = [];
    this.previewRenderer?.dispose();
    this.previewRenderer?.forceContextLoss();
    this.previewRenderer = null;
    this.$('preview').replaceChildren();
  }
  dispose() {
    this.disposed = true;
    this.close();
    this.arms.forEach((a) => a.dispose());
    this.group.removeFromParent();
    window.removeEventListener('punching-face-contact', this.contactListener);
    document.removeEventListener('visibilitychange', this.visibilityListener);
    this.dialog.remove();
    this.tracking.onArmSample = null;
  }
}
