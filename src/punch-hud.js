import { clamp } from './physics.js';
const $ = (id) => document.getElementById(id);
// MediaPipe hand skeleton (21 landmarks): [wrist, thumb×4, index×4, middle×4, ring×4, pinky×4].
const SLAP_HAND_LINKS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
const SLAP_HAND_TIPS = [4, 8, 12, 16, 20];

function drawHand(state) {
  const hand = $('slap-view-hand'),
    links = $('slap-view-hand-links'),
    fill = $('slap-view-hand-fill'),
    joints = $('slap-view-hand-joints');
  if (!state.landmarks || !state.handDetected) {
    hand.classList.remove('visible', 'armed');
    links.setAttribute('d', '');
    fill.setAttribute('points', '');
    joints.replaceChildren();
    return;
  }
  // Video is mirrored via CSS scaleX(-1); flip x here so the skeleton lines up with the user's hand.
  const pts = state.landmarks.map((p) => ({
    x: 1 - clamp(p.x, 0, 1),
    y: clamp(p.y, 0, 1),
  }));
  links.setAttribute(
    'd',
    SLAP_HAND_LINKS.map(
      ([a, b]) =>
        `M${pts[a].x.toFixed(4)} ${pts[a].y.toFixed(4)}L${pts[b].x.toFixed(4)} ${pts[b].y.toFixed(4)}`,
    ).join(''),
  );
  fill.setAttribute(
    'points',
    SLAP_HAND_TIPS.map((i) => `${pts[i].x.toFixed(4)},${pts[i].y.toFixed(4)}`).join(
      ' ',
    ),
  );
  if (joints.childElementCount !== pts.length) {
    joints.replaceChildren(
      ...pts.map(() =>
        document.createElementNS('http://www.w3.org/2000/svg', 'circle'),
      ),
    );
  }
  for (let i = 0; i < pts.length; i++) {
    const c = joints.children[i];
    c.setAttribute('cx', pts[i].x.toFixed(4));
    c.setAttribute('cy', pts[i].y.toFixed(4));
    c.setAttribute('r', SLAP_HAND_TIPS.includes(i) ? 0.014 : i === 0 ? 0.017 : 0.008);
  }
  hand.classList.add('visible');
  // "Armed" — palm is inside the trigger range. The fingertip polygon still grows/shrinks
  // continuously with palm size, so users see the ramp toward this yellow state.
  hand.classList.toggle('armed', state.closed);
}

export function installPunchHud(punching) {
  let lastAt = 0;
  const previousEvent = punching.onEvent;
  punching.onEvent = (event) => {
    previousEvent(event);
    lastAt = performance.now();
    if (!event.landed) return;
    const label =
      `${event.hand ?? ''} ${event.mode === 'jab' ? 'straight' : event.mode}`
        .trim()
        .toUpperCase();
    $('impact-label').textContent = label;
    const flash = $('slap-view-flash');
    flash.className = '';
    void flash.offsetWidth;
    flash.className = 'fire type-' + event.mode;
  };
  $('punch-mirrored').onchange = (event) => {
    punching.tracker.setMirrored(event.target.checked);
    punching.reset();
  };
  return (results, now, active) => {
    const tracker = punching.tracker,
      d = (punching.screen ?? tracker).debug;
    const fresh = active && now - (results?.timestamp ?? -Infinity) < 350;
    const landmarks = fresh ? results?.landmarks?.[0] : null;
    const closing = fresh ? d.closing : 0;
    const reach = fresh ? d.travel : 0;
    const span = fresh ? d.span : 0;
    $('slap-growth-fill').style.width =
      clamp(closing / (punching.screen ? 1500 : 4), 0, 1) * 100 + '%';
    $('slap-growth-mark').hidden = !!punching.screen;
    $('slap-growth-mark').style.left = (tracker.minPeak / 4) * 100 + '%';
    $('slap-growth-val').textContent = punching.screen
      ? Math.round(closing) + ' px/s'
      : closing.toFixed(1) + ' m/s';
    $('slap-vy-fill').style.left = '0';
    $('slap-vy-fill').style.width =
      clamp(reach / (punching.screen ? 200 : 0.4), 0, 1) * 100 + '%';
    $('slap-vy-mark').hidden = !!punching.screen;
    $('slap-vy-mark').style.left = (tracker.minTravel / 0.4) * 100 + '%';
    $('slap-vy-val').textContent = punching.screen
      ? Math.round(reach) + ' px'
      : Math.round(reach * 100) + ' cm';
    $('slap-width-fill').style.width = clamp(span / 0.3, 0, 1) * 100 + '%';
    $('slap-width-mark').hidden = true;
    $('slap-width-val').textContent = span.toFixed(2);
    drawHand({ landmarks, handDetected: !!landmarks, closed: d.phase === 'closing' });
    const badge = $('slap-state-badge');
    badge.className =
      'slap-badge ' +
      (d.phase === 'closing' && fresh ? 'armed' : landmarks ? 'watching' : 'idle');
    badge.textContent = !active ? 'idle' : !landmarks ? 'searching' : d.phase;
    const event = punching.lastEvent;
    $('slap-last').textContent = event
      ? `${event.landed ? '' : 'MISS · '}${event.hand ?? ''} ${event.mode} · ${((now - lastAt) / 1000).toFixed(1)} s ago`.trim()
      : '—';
    $('slap-status-line').textContent = active
      ? 'Close fist · overlap or sweep across the on-screen head'
      : 'Connect webcam · aim your punch at the head';
  };
}
