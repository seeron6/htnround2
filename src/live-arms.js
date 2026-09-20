import maskURL from './arm-mask.js?url';
import { compositeArms } from './arm-composite.js';
import './live-arms.css';

// Contacts use the landmarks from the displayed camera with the same cover crop
// and reflection as its pixels, including a separate first-person arm camera.
export class LiveArms {
  constructor({ tracking, stage, mirrored = () => true }) {
    this.tracking = tracking;
    this.stage = stage;
    this.mirrored = mirrored;
    this.epoch = 0;
    this.bodyEpoch = 0;
    this.lastSent = -Infinity;
    this.frames = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'live-arm-layer';
    this.canvas.setAttribute('aria-hidden', 'true');
    stage.append(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.panel = document.createElement('div');
    this.panel.className = 'arm-camera-controls';
    this.panel.innerHTML = /* HTML */ ` <label for="arm-display">Arm appearance</label>
      <select id="arm-display">
        <option value="wireframe">1 · Skeleton arms (original)</option>
        <option value="live" selected>2 · Live CV arms (Jace)</option>
        <option value="preset">3 · My 3D arms (quick scan / presets)</option>
      </select>
      <label for="arm-source">Arm view</label>
      <select id="arm-source">
        <option value="punch">Laptop camera · front view</option>
        <option value="body">Separate camera · first person</option>
      </select>
      <div id="body-camera-controls" hidden>
        <label for="body-camera-device">Body / phone camera</label>
        <select id="body-camera-device">
          <option value="">Choose another camera</option>
        </select>
        <button id="body-camera-connect" type="button">Connect body camera</button>
        <video id="body-camera-preview" playsinline muted hidden></video>
        <label class="arm-mirror-label" for="body-camera-mirror"
          >Mirror body view
          <input id="body-camera-mirror" type="checkbox" />
        </label>
      </div>
      <button id="refresh-arm-cameras" type="button">Refresh camera list</button>
      <p id="live-arm-status" class="muted" role="status">
        Connect the laptop camera to see your real arms.
      </p>
      <details class="arm-camera-guide">
        <summary>How to set up a separate camera</summary>
        <ol>
          <li>
            <strong>Laptop camera:</strong> choose the built-in webcam above, then
            connect it. Keep your face and both hands visible; this camera detects
            punches.
          </li>
          <li>
            <strong>Connect a second camera to this Mac:</strong> use a USB webcam or a
            phone that appears as a webcam. Click <em>Refresh camera list</em>, choose
            <em>Separate camera · first person</em>, select a different device, then
            <em>Connect body camera</em>.
          </li>
          <li>
            <strong>Position it:</strong> secure the camera at upper chest level, in
            landscape, facing forward toward the screen. Use the preview to aim it so
            your real forearms enter from the bottom corners and both fists stay
            visible. Keep it clear of your punch path.
          </li>
          <li>
            <strong>Check both views:</strong> the laptop preview should show you; the
            body preview should show your arms from behind. Raise your guard, then use
            <em>Calibrate guard</em>. Turn off Center Stage, Portrait, or background
            effects if they crop or remove your arms.
          </li>
        </ol>
        <p>
          <strong>iPhone:</strong> enable Settings → General → AirPlay &amp; Continuity
          → Continuity Camera. Use the same Apple Account with two-factor authentication
          on both devices and turn on Wi-Fi and Bluetooth. Connect by USB and trust the
          Mac if needed; keep the iPhone locked, with its rear camera facing forward.
          <a
            href="https://support.apple.com/en-us/102546"
            target="_blank"
            rel="noreferrer"
            >Apple setup and compatibility guide ↗</a
          >
        </p>
        <p>
          <strong>Android / other phones:</strong> use a supported USB webcam mode or a
          webcam connection you already have installed. It must appear in the Mac
          browser's camera list. Opening localhost on the phone does not connect its
          camera to this app.
        </p>
        <p>
          <strong>Only one camera?</strong> choose <em>Laptop camera · front view</em>.
          You will see the real pixels of your hands and arms from that viewpoint. The
          separate camera gives a first-person view; these are live cutouts, not
          reconstructed 3D arms. Both feeds are processed locally.
        </p>
        <p>
          <strong>Missing device:</strong> allow camera access, close other apps using
          the phone camera, then refresh. If your arms disappear, move both fists into
          the preview and improve the lighting. Disconnect each camera with its own
          button.
        </p>
      </details>`;
    document.getElementById('calibrate').after(this.panel);
    this.$ = (id) => this.panel.querySelector(`#${id}`);
    this.video = this.$('body-camera-preview');
    this.video.muted = true;
    const label = document.createElement('label');
    label.className = 'punch-camera-label';
    label.htmlFor = 'punch-camera-device';
    label.textContent = 'Punch-detection camera';
    this.target = document.createElement('select');
    this.target.id = 'punch-camera-device';
    this.target.innerHTML = '<option value="">Default laptop camera</option>';
    document.getElementById('camera').before(label, this.target);
    this.$('arm-display').onchange = () => {
      this.resetWorker();
      this.syncControls();
      window.dispatchEvent(
        new CustomEvent('punching-face-arm-mode', { detail: this.display }),
      );
    };
    this.$('arm-source').onchange = () => {
      this.sourceError = null;
      this.$('body-camera-controls').hidden = this.source !== 'body';
      if (this.source !== 'body') this.stopBody();
      this.resetWorker();
    };
    this.$('body-camera-connect').onclick = () =>
      this.bodyStream ? this.stopBody() : this.startBody();
    this.$('refresh-arm-cameras').onclick = () => this.refreshDevices();
    this.deviceListener = () => this.refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', this.deviceListener);
    this.refreshDevices();
    this.syncControls();
  }

  syncControls() {
    this.poseFailed = false;
    const live = this.display === 'live';
    for (const selector of [
      'label[for="arm-source"]',
      '#arm-source',
      '#refresh-arm-cameras',
      '.arm-camera-guide',
      '#live-arm-status',
    ])
      this.panel.querySelector(selector).hidden = !live;
    this.$('body-camera-controls').hidden = !live || this.source !== 'body';
    if (!live && this.bodyStream) this.stopBody();
    this.tracking.trackArmView = live && this.source === 'punch';
  }

  setDisplay(mode) {
    if (
      mode === 'captured' &&
      !this.$('arm-display').querySelector('[value="captured"]')
    )
      this.$('arm-display').add(
        new Option('Imported 3D arm reconstruction', 'captured'),
      );
    this.$('arm-display').value = mode;
    this.$('arm-display').dispatchEvent(new Event('change'));
  }

  get display() {
    return this.$('arm-display').value;
  }
  get source() {
    return this.$('arm-source').value;
  }
  get targetDeviceId() {
    return this.target.value;
  }
  get state() {
    return {
      display: this.display,
      source: this.source,
      bodyConnected: !!this.bodyStream,
      workerReady: !!this.ready,
      frames: this.frames,
      visiblePixels: this.visiblePixels || 0,
      overlayVisible: !this.canvas.hidden && !!this.mask,
      status: this.$('live-arm-status').textContent,
    };
  }
  status(message) {
    if (this.$('live-arm-status').textContent !== message)
      this.$('live-arm-status').textContent = message;
  }

  async refreshDevices() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
      if (this.disposed) return;
      const activeId = this.tracking.stream
        ?.getVideoTracks()[0]
        ?.getSettings().deviceId;
      for (const [select, isBody] of [
        [this.target, false],
        [this.$('body-camera-device'), true],
      ]) {
        const selected = select.value;
        select.replaceChildren(
          new Option(isBody ? 'Choose another camera' : 'Default laptop camera', ''),
        );
        devices.forEach((device, index) => {
          const option = new Option(
            device.label || `Camera ${index + 1}`,
            device.deviceId,
          );
          option.disabled = isBody && device.deviceId === activeId;
          select.add(option);
        });
        if ([...select.options].some((o) => o.value === selected && !o.disabled))
          select.value = selected;
        else if (!isBody && activeId) select.value = activeId;
      }
    } catch (error) {
      this.status(`Camera list unavailable: ${error.message}`);
    }
  }

  async startBody() {
    this.sourceError = null;
    const deviceId = this.$('body-camera-device').value;
    if (!this.tracking.active) {
      this.sourceError =
        'Connect the laptop punch-detection camera first, then choose a different body camera.';
      this.status(this.sourceError);
      return;
    }
    if (
      !deviceId ||
      deviceId === this.tracking.stream?.getVideoTracks()[0]?.getSettings().deviceId
    ) {
      this.sourceError =
        'Choose a different camera for the body view. Refresh the list if your phone is missing.';
      this.status(this.sourceError);
      return;
    }
    const epoch = ++this.bodyEpoch;
    const button = this.$('body-camera-connect');
    button.disabled = true;
    this.status('Connecting body camera…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      if (epoch !== this.bodyEpoch || this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.bodyStream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (epoch !== this.bodyEpoch) return;
      this.video.hidden = false;
      this.$('body-camera-device').disabled = true;
      button.textContent = 'Disconnect body camera';
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (this.bodyStream !== stream) return;
        this.stopBody();
        this.sourceError =
          'Body camera disconnected. Reconnect it and click Connect body camera.';
        this.status(this.sourceError);
      });
      this.resetWorker();
      this.refreshDevices();
    } catch (error) {
      if (epoch !== this.bodyEpoch) return;
      this.stopBody();
      this.sourceError = `Body camera could not start: ${error.message}. Close other apps using it and reconnect.`;
      this.status(this.sourceError);
    } finally {
      if (epoch === this.bodyEpoch) button.disabled = false;
    }
  }

  stopBody() {
    this.sourceError = null;
    this.bodyEpoch++;
    this.bodyStream?.getTracks().forEach((track) => track.stop());
    this.bodyStream = null;
    this.video.srcObject = null;
    this.video.hidden = true;
    this.$('body-camera-device').disabled = false;
    this.$('body-camera-connect').disabled = false;
    this.$('body-camera-connect').textContent = 'Connect body camera';
    this.resetWorker();
  }

  resetWorker() {
    this.epoch++;
    clearTimeout(this.initTimeout);
    this.worker?.terminate();
    this.worker = null;
    this.key = null;
    this.failedKey = null;
    this.ready = this.busy = false;
    this.clear();
  }
  clear() {
    this.contactResults = null;
    this.mask?.close();
    this.mask = null;
    this.frame?.close();
    this.frame = null;
    this.visiblePixels = 0;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.hidden = true;
  }
  fail(message, key) {
    this.resetWorker();
    this.failedKey = key;
    this.status(
      `Live arms unavailable: ${message}. Change Arm appearance and select live arms again to retry.`,
    );
  }

  startWorker(key) {
    this.resetWorker();
    this.key = key;
    const epoch = this.epoch;
    try {
      this.worker = new Worker('/arm-view-worker.js');
      this.status('Loading live arm cutout…');
      this.initTimeout = setTimeout(
        () => this.fail('model loading timed out', key),
        30000,
      );
      this.worker.onmessage = ({ data }) => {
        if (epoch !== this.epoch) {
          data.mask?.close();
          data.frame?.close();
          return;
        }
        if (data.type === 'ready') {
          clearTimeout(this.initTimeout);
          this.ready = true;
        } else if (data.type === 'result') {
          this.busy = false;
          this.mask?.close();
          this.frame?.close();
          this.mask = data.mask;
          this.frame = data.frame;
          this.maskTime = data.timestamp;
          this.contactResults = data;
          this.visiblePixels = data.visiblePixels;
          this.frames++;
        } else if (data.type === 'error') this.fail(data.message, key);
      };
      this.worker.onerror = (event) => {
        if (epoch === this.epoch) this.fail(event.message, key);
      };
      this.worker.postMessage({
        type: 'init',
        maskURL,
        origin: location.origin,
        bodyCamera: this.source === 'body',
      });
    } catch (error) {
      this.fail(error.message, key);
    }
  }

  update(time, hidden = false) {
    if (this.disposed) return;
    if (!this.tracking.active) this.poseFailed = false;
    this.tracking.trackArmView = this.display === 'live' && this.source === 'punch';
    if (
      this.tracking.active &&
      this.tracking.trackArmView &&
      !this.tracking.poseReady &&
      !this.tracking.poseInitPromise &&
      !this.poseFailed
    ) {
      this.tracking.enableBody().catch(() => {
        this.poseFailed = true;
      });
    }
    this.target.disabled = this.tracking.active || !!this.bodyStream;
    const isBody = this.source === 'body';
    const video = isBody ? this.video : this.tracking.video;
    const stream = isBody
      ? this.bodyStream
      : this.tracking.active
        ? this.tracking.stream
        : null;
    const key = stream?.id;
    if (this.display !== 'live' || !key || hidden) {
      if (this.worker || this.mask) this.resetWorker();
      if (this.display === 'live' && !key)
        this.status(
          this.sourceError ||
            (isBody
              ? 'Choose a body camera and connect it. Open the setup guide below for placement.'
              : 'Connect the laptop camera to see your real arms.'),
        );
      return;
    }
    if (key === this.failedKey) return;
    if (this.key !== key) this.startWorker(key);
    if (
      this.ready &&
      !this.busy &&
      video.readyState >= 2 &&
      time - this.lastSent >= 50 &&
      video.currentTime !== this.lastVideoTime
    ) {
      this.busy = true;
      this.lastSent = time;
      this.lastVideoTime = video.currentTime;
      const epoch = this.epoch;
      const results = this.tracking.results;
      const landmarks =
        results && time - results.timestamp < 250 ? results.landmarks : [];
      createImageBitmap(video)
        .then((bitmap) => {
          if (epoch !== this.epoch) {
            bitmap.close();
            return;
          }
          this.worker.postMessage(
            {
              type: 'frame',
              bitmap,
              timestamp: time,
              landmarks,
              pose:
                results?.pose && time - results.pose.timestamp < 300
                  ? results.pose.landmarks?.[0]
                  : null,
            },
            [bitmap],
          );
        })
        .catch((error) => {
          if (epoch === this.epoch) this.fail(error.message, key);
        });
    }
    if (
      !this.mask ||
      !this.frame ||
      time - this.maskTime > 400 ||
      video.readyState < 2
    ) {
      this.canvas.hidden = true;
      if (this.ready)
        this.status(
          'Show both hands and forearms clearly in the selected camera preview.',
        );
      return;
    }
    const width = Math.max(1, Math.min(1280, this.stage.clientWidth));
    const height = Math.max(
      1,
      Math.round(
        (width * this.stage.clientHeight) / Math.max(1, this.stage.clientWidth),
      ),
    );
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const mirror = isBody ? this.$('body-camera-mirror').checked : this.mirrored();
    this.video.style.transform = this.$('body-camera-mirror').checked
      ? 'scaleX(-1)'
      : '';
    // The worker returns the source frame with its mask. Sampling the live video here would
    // put an older silhouette over a newer punch and expose a wide fringe of background.
    compositeArms(this.context, this.frame, this.mask, width, height, mirror);
    this.canvas.hidden = false;
    this.status(
      this.visiblePixels
        ? isBody
          ? this.tracking.active
            ? 'Live body-camera arms · laptop camera detects punches.'
            : 'Live body-camera arms · reconnect the laptop camera to detect punches.'
          : 'Your live arms · laptop front view. Use a body camera for a first-person view.'
        : 'No arms found. Bring both fists into view; in the body view, forearms must enter from the bottom corners.',
    );
  }

  dispose() {
    this.disposed = true;
    this.stopBody();
    navigator.mediaDevices?.removeEventListener('devicechange', this.deviceListener);
    this.canvas.remove();
  }
}
