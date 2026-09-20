// The face's expression, chosen by the OMNI model. The relay asks it, beside every spoken turn, to
// call `set_expression(emotion, intensity)`; that tool call arrives here as an `expression` event
// and the head wears it. That answer is 1.0 to 2.7 s away (measured: TRACKS/SENTRY.md, finding 2),
// so the device picks a look itself the instant a punch lands (instant-expression.js) and OMNI's
// call confirms or corrects it. Both arrive through set() below.
//
// It is drawn through the one channel the head already exposes to this panel: the three mouth
// shapes `window.__faceSpeech` feeds the speech rig (jaw open, corners spread, lips rounded). So
// nothing in main.js changes, and speech always wins the jaw: an expression only fills whatever the
// voice is not using. Brows and eyes belong to the impact rig's pain pose, which a landed punch
// fires locally and at once. Pure and clock-injected, so Node tests cover it.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// Each shape is a function of seconds since it was set, returning the three mouth channels at full
// intensity, plus how long it holds before easing out.
export const EXPRESSIONS = {
  // Closed-lip smirk that just sits there.
  smug: { hold: 6, shape: () => ({ open: 0, spread: 0.6, round: 0 }) },
  // A grin with a short chuckle riding on the jaw.
  amused: {
    hold: 4,
    shape: (t) => ({
      open: t < 1.2 ? 0.28 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4.5 * t)) : 0.04,
      spread: 0.75,
      round: 0,
    }),
  },
  // The jaw drops and takes a moment to come back.
  stunned: {
    hold: 2.6,
    shape: (t) => ({ open: 0.6 * Math.exp(-t / 1.4) + 0.08, spread: 0, round: 0.3 }),
  },
  // Panting: open and rounded, a breath a little over once a second.
  winded: {
    hold: 5,
    shape: (t) => ({
      open: 0.24 + 0.16 * Math.sin(2 * Math.PI * 1.15 * t),
      spread: 0,
      round: 0.4,
    }),
  },
  // Jaw set, lips pressed.
  defiant: { hold: 5, shape: () => ({ open: 0.02, spread: 0.12, round: 0.34 }) },
  // The act drops: no smirk, mouth a little open, still.
  concerned: { hold: 5, shape: () => ({ open: 0.1, spread: 0, round: 0.12 }) },
};

export const EXPRESSION_ICONS = {
  smug: '😏',
  amused: '😄',
  stunned: '😵',
  winded: '😮‍💨',
  defiant: '😤',
  concerned: '😟',
};

const EASE_IN = 0.18,
  EASE_OUT = 1.2,
  GLIDE = 0.25; // seconds for a look already on the face to reach a new strength

export function createExpressionSignal({
  now = () =>
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
} = {}) {
  // `began` clocks the shape (a jaw drop decays from the hit), `at` clocks the hold and the easing.
  let current = null; // { emotion, intensity, from, changed, began, at }
  const strength = (t) =>
    current.from +
    (current.intensity - current.from) * clamp((t - current.changed) / GLIDE);
  return {
    /**
     * Wear `emotion` (0..1 strong) from now. Unknown names are ignored, not guessed at.
     *
     * The same look again is held longer and glides to the new strength; it does not start over.
     * That is the common case twice over: a second weak punch, and OMNI agreeing a second later
     * with what the device chose the instant the punch landed (instant-expression.js). Starting
     * over there would ease the face to neutral and back, which reads as a twitch. `restart` is for
     * a new event that should replay the shape: another hard punch drops the jaw again.
     */
    set(emotion, intensity = 0.6, { restart = false } = {}) {
      // Own keys only: the name comes from a model, and `constructor` is not an expression.
      if (!Object.hasOwn(EXPRESSIONS, String(emotion))) return false;
      const t = now(),
        level = clamp(Number(intensity) || 0.6, 0.2, 1),
        shown = this.showing;
      if (shown && shown.emotion === emotion && !restart)
        current = {
          ...current,
          from: strength(t),
          intensity: level,
          changed: t,
          // Keep whatever easing-in is left, drop any easing-out, and hold from here.
          at: t - Math.min(shown.age, EASE_IN),
        };
      else
        current = {
          emotion,
          intensity: level,
          from: level,
          changed: t,
          began: t,
          at: t,
        };
      return true;
    },
    clear() {
      current = null;
    },
    /** What is showing right now, or null once it has eased away. */
    get showing() {
      if (!current) return null;
      const t = now(),
        age = t - current.at;
      return age > EXPRESSIONS[current.emotion].hold + EASE_OUT
        ? null
        : {
            emotion: current.emotion,
            intensity: current.intensity,
            age,
            since: t - current.began,
          };
    },
    read() {
      const shown = this.showing;
      if (!shown) return { open: 0, spread: 0, round: 0 };
      const spec = EXPRESSIONS[shown.emotion],
        raw = spec.shape(shown.since),
        envelope =
          clamp(shown.age / EASE_IN) * clamp(1 - (shown.age - spec.hold) / EASE_OUT),
        k = strength(now()) * envelope;
      return {
        open: clamp(raw.open * k),
        spread: clamp(raw.spread * k),
        round: clamp(raw.round * k),
      };
    },
  };
}

/** Speech owns the jaw; the expression fills in only what the voice is not using. */
export function blendMouth(speech, expression) {
  const s = speech || { open: 0, spread: 0, round: 0 },
    e = expression || { open: 0, spread: 0, round: 0 },
    quiet = 1 - clamp(s.open * 1.6);
  return {
    open: Math.max(s.open, e.open * quiet),
    spread: Math.max(s.spread, e.spread * (0.45 + 0.55 * quiet)),
    round: Math.max(s.round, e.round * quiet),
  };
}
