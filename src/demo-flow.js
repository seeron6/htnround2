import { installDemoHUD } from './demo-hud.js';
import { listSavedHeads, renameHead } from './model-library.js';
import { requestHeadName } from './head-name.js';
import { ForwardPunchStart } from './forward-punch-start.js';
import { installScanJobs, acknowledgeScanJob } from './scan-jobs.js';
import {
  GuardReadyHold,
  GUARD_FRAME_MAX_AGE_MS,
  GUARD_HOLD_MS,
  handsInGuardTargets,
} from './guard-readiness.js';
import './demo-flow.css';

// The demo is a small UI layer over the same model, camera and physics controls.
export function installDemoFlow(api) {
  const $ = (id) => document.getElementById(id);
  const setText = (id, text) => {
    const element = $(id);
    if (element.textContent !== text) element.textContent = text;
  };
  let screen = 'welcome';
  let selection = 'demo';
  let selectedCapture = null;
  let loading = false;
  let awaitingImport = false;
  let calibrationTimer = null;
  const guardHold = new GuardReadyHold();
  let calibrationError = '';
  let cameraStarting = false;
  let keyboardOnly = false;
  let focused = false;
  let scanPromptOpen = false;
  let view = 'mesh';
  let response = 'clay';
  const dialog = document.createElement('dialog');
  dialog.id = 'demo-onboarding';
  dialog.setAttribute('aria-label', 'Get ready to punch');
  dialog.innerHTML = /* HTML */ `
    <div class="demo-onboarding-top">
      <button class="demo-text-button" data-action="advanced">Advanced mode ↗</button>
    </div>
    <section data-screen="welcome" class="demo-welcome">
      <img class="demo-hero-logo" src="/punching-face-logo.png" alt="Punching Face" />
      <h1 class="demo-hero-wordmark">PUNCHING FACE</h1>
      <p class="demo-tagline">Release yourself.</p>
      <button class="demo-primary" data-action="choose">Start <span>→</span></button>
    </section>
    <section data-screen="models" hidden>
      <h1>Choose your model.</h1>
      <div class="demo-model-options" role="group" aria-label="Model options">
        <button class="demo-model-card" data-model="demo" aria-pressed="true">
          <span class="demo-card-number">01</span><span class="demo-card-icon">◉</span>
          <strong>Demo head</strong>
        </button>
        <button class="demo-model-card" data-model="saved" aria-pressed="false">
          <span class="demo-card-number">02</span><span class="demo-card-icon">▧</span>
          <strong>Preloaded model</strong>
        </button>
        <button class="demo-model-card" data-model="import" aria-pressed="false">
          <span class="demo-card-number">03</span><span class="demo-card-icon">＋</span>
          <strong>Record / upload head</strong>
        </button>
      </div>
      <div id="demo-saved-models" class="demo-model-detail" hidden></div>
      <div id="demo-import-options" class="demo-model-detail" hidden>
        <button class="demo-secondary" data-action="record">
          Record / upload video
        </button>
        <button class="demo-secondary" data-action="upload">
          Upload GLB / session
        </button>
      </div>
      <p id="demo-model-status" class="demo-status" role="status"></p>
      <div class="demo-step-actions">
        <button class="demo-text-button" data-action="welcome">← Back</button>
        <button id="demo-use-model" class="demo-primary" data-action="use-model">
          Use demo head <span>→</span>
        </button>
      </div>
    </section>
    <section data-screen="calibration" hidden>
      <h1 id="demo-calibration-title">Calibrate your guard.</h1>
      <p class="demo-subtitle">
        Face the webcam and hold both fists inside the marked areas for 3 seconds.
      </p>
      <div class="demo-arm-choices">
        <label for="demo-arm-mode">Choose your arms</label>
        <select id="demo-arm-mode">
          <option value="wireframe">1 · Skeleton arms (original)</option>
          <option value="live">2 · Live CV arms (Jace)</option>
          <option value="preset">3 · My 3D arms (quick scan / presets)</option>
        </select>
        <button id="demo-scan-arms" class="demo-secondary" data-action="scan-arms">
          Scan / customize my arms · optional
        </button>
        <p>
          Use the original skeleton, live arm cutouts, or personalize first-person 3D
          presets.
        </p>
      </div>
      <div class="demo-camera-frame">
        <video
          id="demo-camera-preview"
          autoplay
          playsinline
          muted
          aria-label="Calibration camera preview"
        ></video>
        <div class="demo-camera-guide" aria-hidden="true">
          <span>LEFT HAND</span><span>RIGHT HAND</span>
        </div>
        <span id="demo-camera-badge">Starting camera…</span>
      </div>
      <p id="demo-calibration-status" class="demo-status" role="status">
        Allow camera access when your browser asks.
      </p>
      <div id="demo-guard-ready" hidden>
        <div
          id="demo-guard-progress"
          role="progressbar"
          aria-label="Ready to calibrate your guard"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
        >
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle class="demo-ready-track" cx="32" cy="32" r="27" />
            <circle id="demo-ready-fill" cx="32" cy="32" r="27" pathLength="100" />
          </svg>
          <span id="demo-ready-seconds" aria-hidden="true">3</span>
        </div>
        <div class="demo-ready-copy">
          <strong>Ready</strong>
          <span id="demo-ready-hint">Hold both fists in the areas</span>
        </div>
      </div>
      <button id="demo-calibrate" class="demo-primary" data-action="calibrate" disabled>
        Calibrate my guard
      </button>
      <button
        id="demo-retry-camera"
        class="demo-secondary"
        data-action="retry-camera"
        hidden
      >
        Retry camera
      </button>
      <button id="demo-begin" class="demo-primary" data-action="begin" hidden>
        Begin punching <span>↗</span>
      </button>
      <p class="demo-footnote">
        60-second round · Allow microphone access for voice replies.
      </p>
      <div class="demo-step-actions">
        <button class="demo-text-button" data-action="choose">← Change model</button>
        <button class="demo-text-button" data-action="keyboard">
          Use keyboard instead →
        </button>
      </div>
    </section>
    <footer class="demo-onboarding-footer">
      <span id="demo-step-label"></span>
    </footer>
  `;
  document.body.append(dialog);
  $('demo-arm-mode').value = api.getArmMode();
  $('demo-arm-mode').onchange = () => api.setArmMode($('demo-arm-mode').value);
  window.addEventListener('punching-face-arm-mode', () => {
    $('demo-arm-mode').value = api.getArmMode();
  });
  const forwardPunchStart = new ForwardPunchStart($('demo-camera-preview'));

  const hud = installDemoHUD({
    setMode(mode) {
      const selectedView = view;
      response = mode;
      api.setMode(mode);
      api.setView(selectedView);
      hud.sync({ mode: response, view });
    },
    setView(next) {
      view = next;
      api.setView(view);
      hud.sync({ mode: response, view });
    },
    resetHead: api.resetHead,
    onAdvanced: advanced,
    onChooseModel: () => show('models'),
    onCamera: () => document.body.classList.toggle('camera-open'),
  });

  const scanJobs = installScanJobs({
    canPrompt: () => !loading && !cameraStarting && !api.isCapturing(),
    onPrompt(open) {
      scanPromptOpen = open;
      hud.setActive(focused && !dialog.open && !open);
    },
    onContinue: continueWhileScanning,
    onOpenScan: api.openCapture,
    async onSwap(model) {
      awaitingImport = false;
      loading = true;
      const selectedResponse = response;
      const selectedView = view;
      const needsCalibration = dialog.open;
      try {
        await api.closeCapture();
        await api.ready;
        await api.loadSaved(model);
        await api.prepareImpacts();
        api.setMode(selectedResponse);
        api.setView(selectedView);
        api.resetHead();
        if (focused) {
          api.firstPerson();
          hud.startRound();
        }
        if (needsCalibration) await calibrateScreen();
      } finally {
        loading = false;
      }
    },
  });

  async function continueWhileScanning() {
    awaitingImport = false;
    await api.closeCapture();
    show('models');
    $('demo-model-status').textContent =
      'Your scan is building in the background. Choose a head to play.';
  }

  function stopCalibrationPreview() {
    cancelAnimationFrame(calibrationTimer);
    calibrationTimer = null;
    guardHold.reset();
    forwardPunchStart.reset();
    calibrationError = '';
    $('demo-camera-preview').srcObject = null;
  }

  function show(next) {
    stopCalibrationPreview();
    screen = next;
    document.body.classList.add('demo-onboarding-open');
    hud.setActive(false);
    for (const section of dialog.querySelectorAll('[data-screen]'))
      section.hidden = section.dataset.screen !== next;
    $('demo-step-label').textContent = {
      welcome: '',
      models: 'STEP 01 / 02',
      calibration: 'STEP 02 / 02',
    }[next];
    if (!dialog.open) dialog.showModal();
    if (next === 'models' && selection === 'saved') void savedModels();
    dialog
      .querySelector(`[data-screen="${next}"] button:not([disabled]):not([hidden])`)
      ?.focus();
  }

  function close() {
    stopCalibrationPreview();
    document.body.classList.remove('demo-onboarding-open');
    dialog.close();
  }

  function advanced() {
    awaitingImport = false;
    focused = false;
    close();
    document.body.classList.remove('immersive', 'demo-focused', 'camera-open');
    hud.setActive(false);
    $('fullscreen').setAttribute('aria-pressed', 'false');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function begin() {
    focused = true;
    close();
    response = 'clay';
    view = 'mesh';
    api.startSession();
    api.setMode(response);
    api.setView(view);
    api.firstPerson();
    hud.sync({ mode: response, view });
    api.resetHead();
    hud.startRound();
    hud.setActive(true);
    document.body.classList.add('immersive', 'demo-focused', 'camera-open');
    $('fullscreen').setAttribute('aria-pressed', 'true');
    // Keep the user gesture for fullscreen and AudioContext/microphone startup.
    if (!document.fullscreenElement)
      document.documentElement.requestFullscreen?.().catch(() => {});
    window.__punchingFaceDemoStarted = true;
    window.dispatchEvent(new CustomEvent('punching-face-demo-start'));
  }

  async function savedModels() {
    const box = $('demo-saved-models');
    box.textContent = 'Finding your saved heads…';
    const previousKey = selectedCapture?.key;
    selectedCapture = null;
    $('demo-use-model').disabled = true;
    try {
      const models = await listSavedHeads();
      box.replaceChildren();
      if (!models.length) {
        box.textContent = 'No saved heads yet. Try the demo head or record your own.';
        return;
      }
      const label = document.createElement('label');
      label.htmlFor = 'demo-saved-select';
      label.textContent = 'Your saved heads';
      const select = document.createElement('select');
      select.id = 'demo-saved-select';
      models.forEach((model, i) => {
        const date = model.savedAt
          ? new Date(model.savedAt * 1000).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : '';
        select.add(
          new Option(
            `${model.name || `Saved head ${i + 1}`}${models.some((other) => other.id === model.id && other.engine !== model.engine) ? ` · ${model.engine === 'meshy' ? 'Meshy' : 'Local'}` : ''} · ${date || model.id.slice(0, 8)}`,
            model.key,
          ),
        );
      });
      selectedCapture = models.find((model) => model.key === previousKey) || models[0];
      select.value = selectedCapture.key;
      select.onchange = () =>
        (selectedCapture = models.find((model) => model.key === select.value));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'demo-secondary';
      rename.textContent = 'Rename';
      rename.onclick = async () => {
        const model = selectedCapture;
        if (!model || loading) return;
        await requestHeadName({
          name: model.name,
          rename: true,
          save: (name) => renameHead(model.id, name),
        });
      };
      box.append(label, select, rename);
      if (selection === 'saved') $('demo-use-model').disabled = false;
    } catch (error) {
      box.textContent = error.message;
    }
  }

  function selectModel(model) {
    if (loading) return;
    awaitingImport = false;
    selection = model;
    for (const card of dialog.querySelectorAll('[data-model]'))
      card.setAttribute('aria-pressed', String(card.dataset.model === model));
    $('demo-saved-models').hidden = model !== 'saved';
    $('demo-import-options').hidden = model !== 'import';
    $('demo-use-model').hidden = model === 'import';
    $('demo-use-model').disabled = false;
    $('demo-use-model').textContent =
      model === 'saved' ? 'Use selected head →' : 'Use demo head →';
    $('demo-model-status').textContent = '';
    if (model === 'saved') void savedModels();
  }

  function syncCalibration() {
    if (screen !== 'calibration' || !dialog.open) return;
    if (api.isArmScanOpen()) {
      guardHold.reset();
      forwardPunchStart.reset();
      return;
    }
    const state = api.getTracking();
    const video = $('demo-camera-preview');
    if (state.stream && video.srcObject !== state.stream) {
      video.srcObject = state.stream;
      video.play().catch(() => {});
    }
    const calibrated = state.active && state.calibrated;
    const now = performance.now();
    const handCount =
      state.active &&
      Number.isFinite(state.timestamp) &&
      now - state.timestamp <= GUARD_FRAME_MAX_AGE_MS
        ? state.handCount
        : 0;
    const targets = [...dialog.querySelectorAll('.demo-camera-guide span')];
    const occupied = handsInGuardTargets(
      handCount ? (state.landmarks ?? []) : [],
      { width: video.videoWidth, height: video.videoHeight },
      video.getBoundingClientRect(),
      targets.map((target) => target.getBoundingClientRect()),
    );
    const ready =
      state.active &&
      !calibrated &&
      !document.hidden &&
      !cameraStarting &&
      handCount === 2 &&
      occupied.every(Boolean);
    const { progress, complete } = guardHold.update(ready, state.timestamp, now);
    targets.forEach((target, index) =>
      target.classList.toggle('is-ready', occupied[index]),
    );
    const readyBox = $('demo-guard-ready');
    readyBox.hidden = !state.active || calibrated;
    readyBox.classList.toggle('is-ready', ready);
    $('demo-ready-fill').style.strokeDashoffset = String(100 * (1 - progress));
    const seconds = Math.max(1, Math.ceil(((1 - progress) * GUARD_HOLD_MS) / 1000));
    setText('demo-ready-seconds', String(seconds));
    $('demo-guard-progress').setAttribute(
      'aria-valuenow',
      String(Math.round(progress * 100)),
    );
    $('demo-guard-progress').setAttribute(
      'aria-valuetext',
      ready
        ? `${seconds} second${seconds === 1 ? '' : 's'} until guard calibration`
        : 'Waiting for both hands in the marked areas',
    );
    setText('demo-ready-hint', ready ? 'Hold steady…' : 'Hold both fists in the areas');
    $('demo-begin').hidden = !calibrated;
    $('demo-calibrate').hidden = calibrated || !state.active;
    $('demo-calibrate').disabled = !handCount;
    $('demo-retry-camera').hidden = state.active || cameraStarting;
    setText(
      'demo-camera-badge',
      calibrated
        ? 'GUARD CALIBRATED'
        : state.active
          ? `${handCount} HAND${handCount === 1 ? '' : 'S'} DETECTED`
          : cameraStarting
            ? 'STARTING CAMERA…'
            : 'CAMERA OFF',
    );
    setText('demo-calibration-title', calibrated ? 'Ready.' : 'Calibrate your guard.');
    setText(
      'demo-calibration-status',
      calibrated
        ? 'Guard locked in. Punch forward to start, or select Begin punching.'
        : calibrationError ||
            (state.active
              ? ready
                ? 'Both hands in position. Keep your guard up to calibrate automatically.'
                : 'Place one fist in each marked area. Hold for 3 seconds to calibrate.'
              : cameraStarting
                ? 'Allow camera access. Hand tracking may take a moment to get ready.'
                : 'Camera unavailable. Allow access and retry, or continue with your keyboard.'),
    );
    if (forwardPunchStart.update(state, now, !document.hidden && !cameraStarting)) {
      begin();
      return;
    }
    if (complete) calibrateGuard();
  }

  function calibrateGuard() {
    try {
      api.calibrate();
      calibrationError = '';
      syncCalibration();
      if (!$('demo-begin').hidden) $('demo-begin').focus();
    } catch (error) {
      calibrationError = error.message;
      $('demo-calibration-status').textContent = calibrationError;
    }
  }

  function calibrationFrame() {
    syncCalibration();
    if (screen === 'calibration' && dialog.open)
      calibrationTimer = requestAnimationFrame(calibrationFrame);
  }

  async function calibrateScreen() {
    show('calibration');
    keyboardOnly = false;
    cameraStarting = true;
    syncCalibration();
    calibrationTimer = requestAnimationFrame(calibrationFrame);
    try {
      await api.startCamera();
      void api.prepareArms();
    } finally {
      cameraStarting = false;
      if (keyboardOnly) api.stopCamera();
      syncCalibration();
      scanJobs.checkReady();
    }
  }

  async function useModel() {
    if (loading || (selection === 'saved' && !selectedCapture)) return;
    loading = true;
    $('demo-use-model').disabled = true;
    $('demo-model-status').textContent = 'Preparing your head…';
    dialog.classList.add('demo-loading-model');
    try {
      await api.ready;
      if (selection === 'saved') {
        await api.loadSaved(selectedCapture);
        acknowledgeScanJob(selectedCapture);
      } else await api.loadReference();
      await api.prepareImpacts();
      if (!dialog.open || screen !== 'models') return;
      hud.resetScore();
      loading = false;
      await calibrateScreen();
    } catch (error) {
      $('demo-model-status').textContent =
        error.message || 'Could not load that head. Try another model.';
    } finally {
      loading = false;
      dialog.classList.remove('demo-loading-model');
      $('demo-use-model').disabled = false;
      scanJobs.checkReady();
    }
  }

  dialog.addEventListener('click', (event) => {
    const model = event.target.closest('[data-model]');
    if (model) return selectModel(model.dataset.model);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || loading) return;
    if (action === 'advanced') advanced();
    if (action === 'welcome') show('welcome');
    if (action === 'choose') show('models');
    if (action === 'use-model') void useModel();
    if (action === 'retry-camera') void calibrateScreen();
    if (action === 'calibrate') calibrateGuard();
    if (action === 'scan-arms') void api.openArmScan();
    if (action === 'begin') begin();
    if (action === 'keyboard') {
      keyboardOnly = true;
      api.stopCamera();
      begin();
    }
    if (action === 'record' || action === 'upload') {
      awaitingImport = true;
      $('demo-model-status').textContent =
        'Load your head to continue to camera setup.';
      if (action === 'record') api.openCapture();
      else api.openUpload();
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    advanced();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      guardHold.reset();
      forwardPunchStart.reset();
    }
  });
  window.addEventListener('punching-face-model-loaded', async () => {
    if (!awaitingImport) return;
    awaitingImport = false;
    await api.closeCapture();
    await api.prepareImpacts();
    hud.resetScore();
    await calibrateScreen();
  });
  window.addEventListener('punching-face-scan-started', () => {
    awaitingImport = false;
    $('demo-model-status').textContent =
      'Your head will be saved automatically when it is ready.';
  });
  window.addEventListener(
    'punching-face-scan-background',
    () => void continueWhileScanning(),
  );
  window.addEventListener('punching-face-library-changed', () => {
    if (dialog.open && screen === 'models' && selection === 'saved' && !loading)
      void savedModels();
  });
  window.addEventListener('punching-face-model-error', (event) => {
    if (awaitingImport) $('demo-model-status').textContent = event.detail;
  });
  window.addEventListener('punching-face-view-change', (event) => {
    view = event.detail.view;
    response = api.getMode();
    hud.sync({ mode: response, view });
  });
  window.addEventListener('punching-face-mode-change', (event) => {
    response = event.detail.mode;
    hud.sync({ mode: response, view });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && focused && !dialog.open && !scanPromptOpen)
      advanced();
  });
  const demoButton = document.createElement('button');
  demoButton.id = 'demo-launch';
  demoButton.className = 'small';
  demoButton.textContent = 'Demo mode ↗';
  demoButton.onclick = () => show('models');
  document.querySelector('.header-right').prepend(demoButton);
  show('welcome');
  return {
    get isOpen() {
      return dialog.open || scanJobs.isOpen;
    },
    get canPunch() {
      return !scanPromptOpen && (!focused || hud.isRoundActive);
    },
    advanced,
    begin,
  };
}
