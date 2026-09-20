import { timingRows } from './pipeline-timing.js';
import { captureCoverage } from './face-quality.js';
import { EngineChoice } from './meshy-engine.js';
import { requestHeadName, nameFromFile } from './head-name.js';
import { renameHead } from './model-library.js';
import { acknowledgeScanJob, forgetScanJobs, trackScanJob } from './scan-jobs.js';
import qualityURL from './face-quality.js?url';
const $ = (id) => document.getElementById(id);
const EMPTY_SCAN_FEEDBACK =
  'Record your head, upload a video, or import photos. Your full head builds automatically when capture or import finishes. Imported video and extracted frames stay in this local project.';
const frameSize = (width, height) => {
  const scale = Math.min(
    1,
    1280 / Math.max(width, height),
    960 / Math.min(width, height),
  );
  return [Math.round(width * scale), Math.round(height * scale)];
};
const sizePreview = (element, width, height) => {
  if (width > 0 && height > 0)
    element.style.setProperty('--capture-aspect', width / height);
};
const asDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

async function api(path, data) {
  const response = await fetch(
    '/api/' + path,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || 'The local server could not complete this request.',
    );
  return result;
}

export class FaceCapture {
  constructor(onReady, onDelete, onPreview) {
    this.onReady = onReady;
    this.onDelete = onDelete;
    this.onPreview = onPreview;
    this.samples = [];
    this.running = false;
    this.saving = false;
    this.closing = false;
    this.id = null;
    document.body.insertAdjacentHTML(
      'beforeend',
      /* HTML */ `<dialog id="face-scan-dialog">
        <button class="close" id="face-scan-close" aria-label="Close face scan">
          ×</button
        ><span class="eyebrow">Photographs → 3D mesh → Newton physics</span>
        <h1>Scan your whole head.</h1>
        <p class="muted">
          Glasses are supported as a separate estimated 3D accessory. For the clearest
          eye capture, record without them. Keep a neutral expression and your hair,
          ears, and chin fully visible. Start facing the camera with your eyes open and
          look toward the lens for a brief pause; slowly turn your head and torso
          together through a full circle, then face the camera again. Keep your head
          upright. Use even light and pause briefly at each angle. A phone video filmed
          around a seated, still person also works.
        </p>
        <div class="face-capture-media">
          <figure id="face-camera-view" hidden>
            <video
              id="face-scan-video"
              playsinline
              muted
              autoplay
              aria-label="Face capture preview"
            ></video>
            <figcaption>Live camera · keep your head upright</figcaption>
          </figure>
          <figure id="face-saved-view" hidden>
            <canvas
              id="face-scan-preview"
              aria-label="Last saved head and hair crop"
            ></canvas>
            <figcaption>Last saved view</figcaption>
          </figure>
        </div>
        <div class="face-coverage" id="face-coverage">
          0 saved views · front ○ · side A ○ · side B ○
        </div>
        <p class="note" id="face-scan-feedback" role="status">${EMPTY_SCAN_FEEDBACK}</p>
        <div class="row">
          <button id="face-scan-record" class="primary">Record 360°</button
          ><button id="face-scan-stop" disabled>Finish recording</button>
        </div>
        <button id="face-scan-video-import" class="full small" style="margin-top:12px">
          Upload video</button
        ><input id="face-scan-video-file" type="file" accept="video/*" hidden /><button
          id="face-scan-import"
          class="full small"
          style="margin-top:12px"
        >
          Import head photos</button
        ><input
          id="face-scan-photos"
          type="file"
          accept="image/png,image/jpeg"
          multiple
          hidden
        /><label class="check"
          >AI detail refinement (slower)
          <input
            type="checkbox"
            id="face-cloud-review"
            ${import.meta.env.VITE_CONTACT_FAST_CAPTURE === '1' ? '' : 'checked'}
        /></label>
        <p class="muted">
          AI detail refinement sends selected cropped views to Astra to estimate missing
          head regions, hair type, hairstyle, strand controls, hair masks, glasses
          masks, visible ear landmarks, and eye material parameters. Eye crops are
          checked for usable iris detail; Astra generates missing detail when it cannot
          be scanned. For glasses, it can send up to three cropped views to the image
          API to estimate hidden skin and remove lens artifacts. The edited region must
          pass source-image alignment checks. If rear views are missing, it can also
          send three views for a labeled rear prediction. Face geometry, hair silhouette
          fitting, texture baking and Newton physics run locally. At least 24
          overlapping views, including 12 with visible facial landmarks, are required.
          Full-head geometry and materials are always completed, including with AI
          refinement off. Unseen regions use labeled estimates. Camera recovery verifies
          angular coverage; a saved rear-facing frame alone does not prove a complete
          360° reconstruction.
        </p>
        <section id="face-timing" class="pipeline-timing" hidden>
          <h2>Video to model</h2>
          <p id="face-video-source" class="muted"></p>
          <video
            id="face-source-video"
            controls
            playsinline
            preload="metadata"
            hidden
            aria-label="Imported source video"
          ></video>
          <dl id="face-timing-rows"></dl>
          <p class="muted">
            Upload to model ready is elapsed time from selecting the video until the
            finished model is detected, including upload, processing and status checks.
            Loading into the scene is measured separately.
          </p>
        </section>
        <details>
          <summary>Manual build / retry</summary>
          <button id="face-scan-build" class="primary full" disabled>
            Create full head
          </button>
        </details>
        <p class="note" id="face-job-state" role="status">No reconstruction started.</p>
        <button id="face-scan-background" class="primary full" hidden>
          Use another head while this builds
        </button>
        <div class="row">
          <button id="face-scan-load" disabled>Load head</button
          ><button id="face-scan-delete" disabled>Delete scan</button>
        </div>
        <label class="controls-label" for="face-scan-saved">Saved scans</label
        ><select id="face-scan-saved">
          <option value="">No saved face scans</option>
        </select>
        <details>
          <summary>Camera calibration (optional)</summary>
          <label class="controls-label" for="face-fov"
            >Horizontal field of view, degrees</label
          ><input
            id="face-fov"
            type="number"
            min="10"
            max="120"
            step=".01"
            placeholder="Blank = estimate from images"
          />
          <p class="muted">
            Enter a known horizontal FOV for this camera and resolution. Leave blank if
            unknown. Use the same lens and zoom for every view.
          </p>
        </details>
        <details>
          <summary>OpenAI API settings</summary>
          <p class="muted" id="face-api-status">Checking server configuration…</p>
          <input
            id="face-api-key"
            aria-label="OpenAI API key"
            type="password"
            autocomplete="off"
            placeholder="Replacement API key"
          /><button id="face-api-save">Save key on server</button
          ><button id="face-api-test">Test connection</button>
          <p class="muted">
            The key is never included in exports or browser storage. Replace any key
            shared in chat.
          </p>
        </details>
        <p class="muted">
          This fits a full-head template to facial measurements and captured head
          silhouettes, then adds editable hairstyle-specific strands and separate 3D
          eyewear. Opaque frame contours receive local cleanup. A registered edited
          reference can replace the glasses-affected area; that skin is labeled
          estimated. Eyes use recorded iris detail where reliable, otherwise clearly
          labeled generated detail. A glasses-free reference is needed to verify skin
          hidden by lens tint or reflections. Visible ear placement is checked across
          views. Inner-ear folds, eye geometry and unobserved surfaces remain estimates.
          Reconstruction and the impact rig are experimental; inspect the result from
          multiple angles.
        </p>
      </dialog>`,
    );
    // Local pipeline or Meshy cloud for this scan (src/meshy-engine.js). build, poll and load defer to it.
    this.engines = new EngineChoice(this);
    for (const id of ['face-scan-video', 'face-source-video']) {
      const video = $(id);
      const resize = () => sizePreview(video, video.videoWidth, video.videoHeight);
      video.addEventListener('loadedmetadata', resize);
      video.addEventListener('resize', resize);
    }
    $('face-scan-record').onclick = () => this.start().catch((e) => this.fail(e));
    $('face-scan-stop').onclick = () => this.finishCapture().catch((e) => this.fail(e));
    $('face-scan-close').onclick = () => this.close().catch((e) => this.fail(e));
    $('face-scan-background').onclick = async () => {
      try {
        await this.close();
        window.dispatchEvent(new CustomEvent('punching-face-scan-background'));
      } catch (error) {
        this.fail(error);
      }
    };
    $('face-scan-dialog').addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close().catch((error) => this.fail(error));
    });
    $('face-scan-build').onclick = () => this.build().catch((e) => this.fail(e));
    $('face-scan-load').onclick = () => this.load().catch((e) => this.fail(e));
    $('face-scan-delete').onclick = () => this.remove().catch((e) => this.fail(e));
    $('face-scan-video-import').onclick = () => $('face-scan-video-file').click();
    $('face-scan-video-file').onchange = (e) =>
      this.importVideo(e.target.files[0])
        .catch((e) => this.fail(e))
        .finally(() => (e.target.value = ''));
    $('face-scan-import').onclick = () => $('face-scan-photos').click();
    $('face-scan-photos').onchange = (e) =>
      this.importPhotos([...e.target.files])
        .catch((e) => this.fail(e))
        .finally(() => (e.target.value = ''));
    $('face-scan-saved').onchange = () =>
      this.select($('face-scan-saved').value).catch((e) => this.fail(e));
    const rename = document.createElement('button');
    rename.id = 'face-scan-rename';
    rename.textContent = 'Rename selected head';
    rename.onclick = async () => {
      const id = this.id;
      if (!id) return;
      await requestHeadName({
        name: this.saved?.find((scan) => scan.id === id)?.name || '',
        rename: true,
        save: (name) => renameHead(id, name),
      });
    };
    $('face-scan-saved').after(rename);
    window.addEventListener('punching-face-library-changed', () => {
      if ($('face-scan-dialog').open && !this.running && !this.loading)
        this.refresh().catch((e) => this.fail(e));
    });
    $('face-api-save').onclick = async () => {
      try {
        await api('openai-config', { apiKey: $('face-api-key').value.trim() });
        $('face-api-key').value = '';
        await this.configuration();
      } catch (e) {
        $('face-api-status').textContent = e.message;
      }
    };
    $('face-api-test').onclick = async () => {
      $('face-api-test').disabled = true;
      try {
        const result = await api('openai-test', {});
        $('face-api-status').textContent = result.connected
          ? 'OpenAI connection verified.'
          : 'Connection not verified.';
      } catch (e) {
        $('face-api-status').textContent = e.message;
      } finally {
        $('face-api-test').disabled = false;
      }
    };
    window.addEventListener('beforeunload', () => {
      this.worker?.terminate();
      this.stream?.getTracks().forEach((t) => t.stop());
    });
  }

  showTiming(source, timing) {
    this.source = source;
    this.timing = timing;
    $('face-timing').hidden = !source && !timing;
    $('face-video-source').textContent =
      source?.filename ?? 'Saved photograph reconstruction';
    $('face-timing-rows').replaceChildren(
      ...timingRows(source, timing).flatMap(([label, value]) => {
        const dt = document.createElement('dt'),
          dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    const preview = $('face-source-video'),
      url = source?.videoStored ? '/api/face-video?id=' + this.id : null;
    preview.hidden = !url;
    if (url && preview.getAttribute('src') !== url) preview.src = url;
    if (preview.hidden) {
      preview.pause();
      if (preview.hasAttribute('src')) {
        preview.removeAttribute('src');
        preview.load();
      }
    }
  }

  async open() {
    if (this.closing) return;
    $('face-scan-dialog').showModal();
    await Promise.all([this.configuration(), this.refresh(), this.engines.refresh()]);
    if (this.id && !this.running) await this.poll();
  }

  async configuration() {
    const c = await api('openai-config');
    $('face-api-status').textContent = c.configured
      ? `Server key configured · gpt-6-astra`
      : 'No API key configured. Local reconstruction is available.';
    if (!c.configured) $('face-cloud-review').checked = false;
  }

  async refresh() {
    const data = await api('face-captures');
    this.saved = data.captures;
    const select = $('face-scan-saved');
    select.replaceChildren(new Option('Select a saved face scan', ''));
    for (const scan of this.saved)
      select.add(
        new Option(
          `${scan.testFixture ? 'Public test · ' : ''}${scan.name ? scan.name + ' · ' : ''}${scan.frames} views · ${scan.evidence?.includesHairCapture === false ? 'needs whole-head capture' : scan.status} · ${new Date(scan.savedAt * 1000).toLocaleString()}`,
          scan.id,
        ),
      );
    select.value = this.id || '';
    // Saved scans stay available, but a fresh session starts with an empty upload.
    if (!this.id) await this.select('');
  }

  controls() {
    const busy =
      this.running ||
      this.saving ||
      this.loading ||
      this.submitting ||
      this.deleting ||
      this.closing;
    for (const id of [
      'face-scan-record',
      'face-scan-video-import',
      'face-scan-video-file',
      'face-scan-import',
      'face-scan-photos',
      'face-scan-saved',
      'face-fov',
    ])
      $(id).disabled = !!busy;
    $('face-scan-stop').disabled = !this.running;
    $('face-scan-stop').textContent = this.loading ? 'Stop import' : 'Finish recording';
    $('face-scan-rename').disabled = !this.id || !!busy;
    $('face-scan-delete').disabled = !this.id || !!busy || !!this.jobRunning;
    $('face-scan-background').hidden = !this.jobRunning;
    $('face-scan-background').disabled = !!busy;
    const faceOnly =
      this.saved?.find((scan) => scan.id === this.id)?.evidence?.includesHairCapture ===
      false;
    $('face-scan-build').disabled =
      !!busy ||
      !this.id ||
      this.count < this.engines.minimumViews ||
      this.jobRunning ||
      (!this.engines.meshy && faceOnly);
    $('face-scan-load').disabled = !!busy || !this.ready;
  }

  async init() {
    if (this.worker) return;
    this.worker = new Worker('/face-worker.js');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Face tracking initialization timed out.')),
        25000,
      );
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(data.message));
        }
      };
      this.worker.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not load the face tracking worker.'));
      };
      this.worker.postMessage({ type: 'init', qualityURL, origin: location.origin });
    });
  }

  async start() {
    const name = await requestHeadName();
    if (name === null) return;
    this.loading = true;
    this.controls();
    try {
      await this.init();
      this.worker.postMessage({ type: 'reset' });
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 3 / 4 },
          facingMode: 'user',
        },
        audio: false,
      });
      const video = $('face-scan-video');
      video.srcObject = this.stream;
      await video.play();
      sizePreview(video, video.videoWidth, video.videoHeight);
      $('face-camera-view').hidden = false;
      $('face-saved-view').hidden = true;
      const scan = await api('face-captures', {
        name,
        captureRegion: 'head',
        horizontalFovDegrees: $('face-fov').value ? Number($('face-fov').value) : null,
      });
      this.id = scan.id;
      this.samples = [];
      this.count = 0;
      this.previous = null;
      this.lastRejection = null;
      this.ready = false;
      this.jobRunning = false;
      this.running = true;
      this.started = performance.now();
      this.generation = (this.generation || 0) + 1;
      $('face-job-state').textContent =
        'Each accepted frame is saved immediately on this computer.';
      this.updateCoverage();
      this.loop().catch((e) => this.fail(e));
    } catch (e) {
      this.stream?.getTracks().forEach((t) => t.stop());
      $('face-camera-view').hidden = true;
      this.worker?.terminate();
      this.worker = null;
      throw e;
    } finally {
      this.loading = false;
      this.controls();
    }
  }

  process(bitmap, options = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Face detection timed out.')),
        15000,
      );
      this.pendingReject = reject;
      this.worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        this.pendingReject = null;
        data.type === 'error' ? reject(new Error(data.message)) : resolve(data);
      };
      this.worker.postMessage(
        { type: 'frame', bitmap, previous: this.previous, ...options },
        [bitmap],
      );
    });
  }

  async accept(data, generation) {
    if (generation !== this.generation || !this.running) return;
    if (!data.ok) {
      this.lastRejection = data.message;
      $('face-scan-feedback').textContent = data.message;
      return;
    }
    const image = await asDataURL(data.blob);
    if (generation !== this.generation) return;
    this.saving = true;
    this.controls();
    try {
      const saved = await api('face-frames', {
        id: this.id,
        frames: [
          {
            image,
            yaw: data.yaw,
            landmarks: data.landmarks,
            irisLandmarks: data.irisLandmarks,
            timeSeconds: data.timeSeconds ?? null,
          },
        ],
      });
      this.count = saved.frames;
      this.samples.push({ yaw: data.yaw });
      this.previous = data.landmarks ? { yaw: data.yaw, pitch: data.pitch } : null;
      const bitmap = await createImageBitmap(data.blob);
      const canvas = $('face-scan-preview');
      // Frame the preview around the head; saved pixels and landmark coordinates
      // remain in the original image so camera recovery retains one calibration.
      const bounds = data.bounds || [0, 0, bitmap.width - 1, bitmap.height - 1];
      const padding = Math.ceil(
        Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.1,
      );
      const x = Math.max(0, bounds[0] - padding),
        y = Math.max(0, bounds[1] - padding);
      const width = Math.min(bitmap.width, bounds[2] + padding + 1) - x;
      const height = Math.min(bitmap.height, bounds[3] + padding + 1) - y;
      canvas.width = width;
      canvas.height = height;
      sizePreview(canvas, width, height);
      canvas
        .getContext('2d')
        .drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      $('face-saved-view').hidden = false;
      bitmap.close();
      this.updateCoverage();
      $('face-scan-feedback').textContent =
        `Saved view ${this.count}${data.landmarks ? ' · facial landmarks tracked' : ' · profile/rear image retained'}. ${this.importingVideo ? 'Extracting video frames…' : 'Continue slowly around the whole head.'}`;
    } finally {
      this.saving = false;
      this.controls();
    }
  }

  async loop() {
    while (
      this.running &&
      this.count < 240 &&
      performance.now() - this.started < 120000
    ) {
      const generation = this.generation;
      this.inflight = (async () => {
        const bitmap = await createImageBitmap($('face-scan-video'));
        const data = await this.process(bitmap);
        data.timeSeconds = (performance.now() - this.started) / 1000;
        await this.accept(data, generation);
      })();
      try {
        await this.inflight;
      } catch (e) {
        this.fail(e);
        break;
      } finally {
        this.inflight = null;
      }
      if (this.running) await new Promise((r) => setTimeout(r, 600));
    }
    if (this.running) await this.finishCapture();
  }

  updateCoverage() {
    const c = captureCoverage(this.samples);
    $('face-coverage').textContent =
      `${this.count || 0} saved views · front ${c.front ? '✓' : '○'} · side A ${c.left ? '✓' : '○'} · side B ${c.right ? '✓' : '○'} · ${c.headOnly} profile/rear views saved (angles pending reconstruction)`;
  }

  async finishCapture() {
    // Finishing a live recording builds it; stopping an import only cancels it.
    const completed = this.running && !this.loading;
    const pending = this.inflight;
    await this.stop();
    if (completed) {
      await pending;
      await this.buildAutomatically();
    }
  }

  async buildAutomatically() {
    if (
      !this.id ||
      this.running ||
      this.loading ||
      this.saving ||
      this.submitting ||
      this.closing ||
      this.deleting ||
      this.jobRunning ||
      this.ready
    )
      return;
    if (this.count < this.engines.minimumViews) {
      const message = `${this.count || 0} views saved. At least ${this.engines.minimumViews} usable views are needed to build a head. Record a longer scan or import more overlapping views.`;
      $('face-scan-feedback').textContent = message;
      $('face-job-state').textContent = message;
      return;
    }
    if (
      !this.engines.meshy &&
      this.saved?.find((scan) => scan.id === this.id)?.evidence?.includesHairCapture ===
        false
    )
      return;
    await this.build();
    if (this.jobRunning)
      $('face-scan-feedback').textContent =
        'Reconstruction is running in the background.';
    else if (this.ready) $('face-scan-feedback').textContent = 'Your head is ready.';
  }

  async stop({ preserveVideoImport = false } = {}) {
    if (!preserveVideoImport && this.videoImport) this.videoImport.cancelled = true;
    this.running = false;
    this.generation = (this.generation || 0) + 1;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    $('face-scan-video').srcObject = null;
    $('face-camera-view').hidden = true;
    try {
      await this.inflight;
    } catch {}
    this.worker?.terminate();
    this.worker = null;
    this.controls();
    $('face-scan-feedback').textContent =
      `Capture stopped. ${this.count || 0} views saved locally.${this.lastRejection ? ' Last skipped view: ' + this.lastRejection : ''}`;
    await this.refresh();
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.pollTimer);
    this.controls();
    try {
      $('face-source-video').pause();
      await this.stop();
    } finally {
      clearTimeout(this.pollTimer);
      $('face-scan-dialog').close();
      this.closing = false;
      this.controls();
    }
  }

  fail(e) {
    $('face-scan-feedback').textContent = e.message;
    // Create sits below the preview, which can be outside the visible dialog.
    $('face-job-state').textContent = e.message;
    if (this.running) {
      this.running = false;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      $('face-camera-view').hidden = true;
    }
    this.controls();
  }

  async importPhotos(files) {
    if (!files.length) return;
    const name = await requestHeadName({ name: nameFromFile(files[0].name) });
    if (name === null) return;
    await this.stop();
    if (files.length > 240) throw new Error('Import at most 240 overlapping photos.');
    this.loading = true;
    this.controls();
    let completed = false;
    try {
      await this.init();
      this.worker.postMessage({ type: 'reset' });
      const scan = await api('face-captures', {
        captureRegion: 'head',
        name,
        horizontalFovDegrees: $('face-fov').value ? Number($('face-fov').value) : null,
      });
      this.id = scan.id;
      $('face-saved-view').hidden = true;
      this.samples = [];
      this.count = 0;
      this.previous = null;
      this.lastRejection = null;
      this.ready = false;
      this.jobRunning = false;
      this.running = true;
      this.generation = (this.generation || 0) + 1;
      for (const file of files) {
        if (!this.running) break;
        const original = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        [canvas.width, canvas.height] = frameSize(original.width, original.height);
        canvas.getContext('2d').drawImage(original, 0, 0, canvas.width, canvas.height);
        original.close();
        const generation = this.generation;
        this.inflight = (async () => {
          const data = await this.process(await createImageBitmap(canvas));
          await this.accept(data, generation);
        })();
        try {
          await this.inflight;
        } finally {
          this.inflight = null;
        }
      }
      completed = this.running;
    } finally {
      this.loading = false;
      await this.stop();
    }
    if (completed) await this.buildAutomatically();
  }

  async importVideo(file) {
    if (!file) return;
    const uploadStartedAt = Date.now() / 1000;
    const extractionStarted = performance.now();
    if (file.size > 500 * 1024 * 1024)
      throw new Error('Use a video smaller than 500 MB.');
    await this.stop();
    // Use the file's name immediately; the saved head can still be renamed later.
    const name = nameFromFile(file.name);
    const importRun = { cancelled: false };
    this.videoImport = importRun;
    let completed = false;
    this.loading = true;
    this.importingVideo = true;
    this.controls();
    $('face-scan-feedback').textContent = 'Preparing the uploaded video…';
    $('face-job-state').textContent = 'Uploading video and preparing face tracking…';
    const video = document.createElement('video'),
      url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const waitFor = (event, action) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error('Video decoding timed out. Try MP4 or WebM.')),
          20000,
        );
        const done = () => finish(),
          error = () =>
            finish(new Error('This browser cannot decode the video. Try MP4 or WebM.'));
        function finish(e) {
          clearTimeout(timeout);
          video.removeEventListener(event, done);
          video.removeEventListener('error', error);
          e ? reject(e) : resolve();
        }
        video.addEventListener(event, done, { once: true });
        video.addEventListener('error', error, { once: true });
        action();
      });
    try {
      // Model initialization is independent of video upload and native decoding.
      // Join before analyzing frames; observe early rejection in the meantime.
      const trackerReady = this.init();
      trackerReady.catch(() => {});
      await waitFor('loadeddata', () => {
        video.src = url;
        video.load();
      });
      if (importRun.cancelled) return;
      if (
        !Number.isFinite(video.duration) ||
        video.duration < 3 ||
        video.duration > 300
      )
        throw new Error('Use a head rotation video between 3 seconds and 5 minutes.');
      const scan = await api('face-captures', {
        captureRegion: 'head',
        name,
        horizontalFovDegrees: $('face-fov').value ? Number($('face-fov').value) : null,
      });
      if (importRun.cancelled) return;
      this.id = scan.id;
      $('face-saved-view').hidden = true;
      this.samples = [];
      this.count = 0;
      this.previous = null;
      this.ready = false;
      this.jobRunning = false;
      this.lastRejection = null;
      this.running = true;
      this.generation = (this.generation || 0) + 1;
      this.controls();
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = frameSize(video.videoWidth, video.videoHeight);
      this.showTiming(
        {
          filename: file.name,
          uploadStartedAt,
          durationSeconds: video.duration,
          extractionSeconds: 0,
          extractionComplete: false,
        },
        null,
      );
      await api('face-timing', {
        id: this.id,
        kind: 'video',
        filename: file.name,
        uploadStartedAt,
        durationSeconds: video.duration,
        extractionSeconds: 0,
        extractionComplete: false,
      });
      const upload = await fetch('/api/face-video?id=' + this.id, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!upload.ok)
        throw new Error('The original video could not be retained locally.');
      if (importRun.cancelled) return;
      let nativeFrames = null;
      try {
        $('face-job-state').textContent = 'Decoding video locally…';
        const decoded = await api('face-video-frames', { id: this.id });
        // An already-running server may still have the old decoder loaded.
        // Use browser decoding unless native frames explicitly honor orientation.
        if (
          decoded.orientationApplied !== true ||
          !decoded.width ||
          !decoded.height ||
          Math.abs(
            decoded.width / decoded.height - video.videoWidth / video.videoHeight,
          ) > 0.01
        )
          throw new Error('Native video orientation is unverified.');
        nativeFrames = decoded.frames;
      } catch (error) {
        console.info('Using browser video decoding:', error.message);
      }
      if (importRun.cancelled) return;
      await trackerReady;
      if (importRun.cancelled) return;
      this.worker.postMessage({ type: 'reset' });
      const nativeBitmap = async (i) =>
        createImageBitmap(await (await fetch(nativeFrames[i].image)).blob());
      // Imported clips may start behind the head. Locate a frontal view first
      // so the chronological pass can keep the earlier profile/rear frames.
      for (const fraction of [0, 0.8, 0.6, 0.4, 0.2]) {
        if (importRun.cancelled) return;
        let bitmap;
        if (nativeFrames) {
          bitmap = await nativeBitmap(
            Math.min(
              nativeFrames.length - 1,
              Math.round(fraction * nativeFrames.length),
            ),
          );
        } else {
          const time = Math.min(video.duration - 0.05, video.duration * fraction);
          if (Math.abs(video.currentTime - time) > 0.001)
            await waitFor('seeked', () => {
              video.currentTime = time;
            });
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          bitmap = await createImageBitmap(canvas);
        }
        const seed = await this.process(bitmap, { calibrateOnly: true });
        if (seed.ok && Math.abs(seed.yaw) < 35) break;
      }
      const steps =
        nativeFrames?.length ??
        Math.min(220, Math.max(48, Math.ceil(video.duration / 0.3)));
      const sampleTime = (i) =>
        nativeFrames?.[i].timeSeconds ??
        Math.min(video.duration - 0.05, (video.duration * i) / steps);
      const seek = (time) =>
        !nativeFrames && Math.abs(video.currentTime - time) > 0.001
          ? waitFor('seeked', () => {
              video.currentTime = time;
            })
          : Promise.resolve();
      let nextSeek = seek(sampleTime(0));
      let pendingSave = Promise.resolve();
      let processed = 0;
      for (let i = 0; i < steps && this.running; i++) {
        const time = sampleTime(i);
        await nextSeek;
        if (!this.running) break;
        if (!nativeFrames)
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const bitmap = nativeFrames
          ? await nativeBitmap(i)
          : await createImageBitmap(canvas);
        // Decode the next frame while the worker analyzes this private bitmap.
        nextSeek = i + 1 < steps ? seek(sampleTime(i + 1)) : Promise.resolve();
        nextSeek.catch(() => {}); // The next iteration propagates a seek failure.
        const generation = this.generation;
        $('face-job-state').textContent =
          `Extracting video locally · ${Math.round((100 * i) / steps)}% · ${this.count} useful views saved`;
        // One upload may run while the worker analyzes the next frame. Keep
        // writes ordered and bounded, and let Stop await both in-flight tasks.
        this.inflight = Promise.all([this.process(bitmap), pendingSave]);
        try {
          const [data] = await this.inflight;
          data.timeSeconds = time;
          pendingSave = this.accept(data, generation);
          pendingSave.catch(() => {}); // Propagated at the next bounded join.
          processed++;
        } finally {
          this.inflight = pendingSave;
        }
      }
      await pendingSave;
      this.inflight = null;
      await nextSeek;
      let result = await api('face-timing', {
        id: this.id,
        kind: 'video',
        filename: file.name,
        uploadStartedAt,
        durationSeconds: video.duration,
        extractionSeconds: (performance.now() - extractionStarted) / 1000,
        extractionComplete: processed === steps,
      });
      this.showTiming(result.source, result.timing);
      completed = processed === steps && this.running && !importRun.cancelled;
      $('face-job-state').textContent = completed
        ? `Video processed. Starting reconstruction from ${this.count} saved head views…`
        : `Video extraction stopped. ${this.count} head views saved locally.`;
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      this.loading = false;
      this.importingVideo = false;
      await this.stop({ preserveVideoImport: true });
      if (this.videoImport === importRun) this.videoImport = null;
    }
    if (completed && !importRun.cancelled) {
      await this.buildAutomatically();
    }
  }

  async select(id) {
    if (this.running || this.saving) return;
    clearTimeout(this.pollTimer);
    if (id !== this.id) $('face-saved-view').hidden = true;
    this.id = id || null;
    $('face-scan-saved').value = id || '';
    this.ready = false;
    this.jobRunning = false;
    if (!id) {
      this.count = 0;
      this.samples = [];
      $('face-saved-view').hidden = true;
      this.updateCoverage();
      this.showTiming(null, null);
      $('face-scan-feedback').textContent = EMPTY_SCAN_FEEDBACK;
      $('face-job-state').textContent = 'No reconstruction started.';
      this.controls();
      return;
    }
    const scan = this.saved.find((s) => s.id === id);
    this.count = scan?.frames || 0;
    $('face-coverage').textContent =
      `${this.count} saved views · ${Math.round(scan?.span || 0)}° estimated span`;
    await this.poll();
    this.controls();
  }

  async build() {
    if (this.engines.meshy) return this.engines.build();
    if (this.submitting) return;
    this.submitting = true;
    this.controls();
    $('face-job-state').textContent =
      'Checking saved views and starting reconstruction…';
    try {
      await this.stop();
      const id = this.id;
      const result = await api('face-train', {
        id,
        cloudReview: $('face-cloud-review').checked,
      });
      trackScanJob({ id: result.id, engine: 'local' });
      if (id !== this.id || this.engines.meshy) return;
      this.jobRunning = true;
      this.ready = false;
      this.autoLoaded = null;
      await this.poll(result.id);
    } finally {
      this.submitting = false;
      this.controls();
    }
  }

  async poll(id = this.id) {
    clearTimeout(this.pollTimer);
    if (!id || this.closing || !$('face-scan-dialog').open) return;
    if (this.engines.meshy) return this.engines.poll(id);
    const current = () =>
      id === this.id &&
      !this.engines.meshy &&
      !this.closing &&
      $('face-scan-dialog').open;
    if (!current()) return;
    const state = await api('face-status?id=' + id);
    if (!current()) return;
    if (
      state.status === 'complete' &&
      state.photoModel &&
      state.source?.uploadStartedAt &&
      !state.timing?.readyObservedAt
    ) {
      const at = Date.now() / 1000;
      state.timing = { ...state.timing, readyObservedAt: at };
      void api('face-timing', {
        id,
        kind: 'ready',
        at,
      })
        .then((observed) => {
          if (current() && this.timing?.requestedAt === observed.timing?.requestedAt)
            this.showTiming(observed.source, observed.timing);
        })
        // Timing diagnostics must not hide a completed model on an older server.
        .catch((error) => console.info('Ready timing was not saved:', error.message));
    }
    const wasRunning = this.jobRunning;
    this.jobRunning = state.status === 'running';
    if (this.jobRunning && !wasRunning)
      trackScanJob({ id, engine: 'local', resume: true });
    const faceOnly = state.evidence?.includesHairCapture === false;
    this.ready = state.photoModel === true && !faceOnly;
    if (state.status === 'complete' && this.ready && state.source?.uploadStartedAt)
      $('face-scan-feedback').textContent = 'Video imported. Your head is ready.';
    this.showTiming(state.source, state.timing);
    const orbit = state.evidence?.orbitCoverage;
    if (orbit)
      $('face-coverage').textContent =
        `${this.count} saved views · ${state.evidence.registeredViews} recovered cameras · ${orbit.recoveredSpanDegrees}° recovered span · ${orbit.registeredRearViews} rear views${orbit.completeOrbit ? ' · complete orbit' : ' · gaps remain estimated'}`;
    $('face-job-state').textContent =
      (faceOnly
        ? 'This older scan contains face-only crops. Record or import whole-head views including hair, ears, both sides and the back.'
        : state.message) +
      (state.evidence?.cloudReview?.nextCaptureInstruction
        ? ' OpenAI review: ' + state.evidence.cloudReview.nextCaptureInstruction
        : '') +
      (state.evidence?.cloudReview?.error
        ? ' OpenAI review: ' + state.evidence.cloudReview.error
        : '') +
      (state.evidence?.rearPrediction?.error
        ? ' Rear image API unavailable; using local hair-material continuation.'
        : '');
    this.controls();
    const pollAgain = async () => {
      if (!current()) return;
      try {
        await this.poll(id);
      } catch (error) {
        if (!current()) return;
        $('face-job-state').textContent = error.message;
        this.pollTimer = setTimeout(pollAgain, 4000);
      }
    };
    if (this.jobRunning) this.pollTimer = setTimeout(pollAgain, 2000);
  }

  async load() {
    if (this.engines.meshy) return this.engines.load();
    const id = this.id;
    this.loading = true;
    this.controls();
    const started = performance.now();
    try {
      await this.onReady(id);
      acknowledgeScanJob({ id, engine: 'local' });
      this.autoLoaded = id;
      const result = await api('face-timing', {
        id,
        kind: 'load',
        seconds: (performance.now() - started) / 1000,
      });
      this.showTiming(result.source, result.timing);
      $('face-job-state').textContent =
        'Face loaded into the interaction scene. Close this panel to inspect the surface and try a hook.';
    } finally {
      this.loading = false;
      this.controls();
    }
  }

  async remove() {
    if (
      this.deleting ||
      this.running ||
      this.saving ||
      this.loading ||
      this.submitting ||
      this.closing ||
      this.jobRunning
    )
      return;
    this.deleting = true;
    this.controls();
    try {
      await this.stop();
      const id = this.id;
      if (!id || this.jobRunning) return;
      await api('face-delete', { id });
      forgetScanJobs(id);
      clearTimeout(this.pollTimer);
      await this.onDelete(id);
      this.id = null;
      this.count = 0;
      this.samples = [];
      this.ready = false;
      this.jobRunning = false;
      this.autoLoaded = null;
      const c = $('face-scan-preview');
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      this.updateCoverage();
      await this.refresh();
      $('face-job-state').textContent =
        'Scan and its local reconstruction outputs deleted.';
    } finally {
      this.deleting = false;
      this.controls();
    }
  }
}
