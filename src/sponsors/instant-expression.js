// The face's expression, the instant a punch lands.
//
// OMNI chooses the expression with a `set_expression` tool call (expression.js), and that call is
// a network round trip away. Sentry's traces of the first real turns put it at 1.0 to 2.7 s, against
// ~1.5 s for the first word of the reply: half the time the face was already talking before its
// expression changed (TRACKS/SENTRY.md, finding 2). A face that reacts a second after it is hit
// does not look hit.
//
// So this does for the face what grunts.js does for the voice: answer at once, from what the device
// already measured, and let the model have the last word. The mapping follows the same rules the
// model is given (EXPRESSION_DIRECTOR in omni_senses.py) and the same thresholds the relay uses for
// the spoken line (intensity_of there, gruntLevel here), so the two usually agree, and when they
// do the look simply carries on. When they do not, OMNI's arrives and replaces it.
//
// It only ever guesses from what a punch can tell it. `amused` (they said something funny, they
// flailed) and `concerned` (someone said stop, someone looks dizzy) need eyes and ears, so they are
// never chosen here: that is what the model is for. And it never replaces a `concerned` that OMNI
// set. Safety beats the act, and it certainly beats a guess.
//
// Pure and clock-injected, like expression.js and grunts.js, so Node tests cover it.
import { gruntLevel } from './grunts.js';

// "defiant: it got hurt a moment ago and is coming back meaner." This is the moment.
export const HURT_MEMORY_MS = 8000;
// A jaw that has just dropped gets to finish dropping before a lesser punch changes the subject.
const STUNNED_PLAYS_FOR = 1.5;

export function createInstantExpression({
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  let lastBigAt = -Infinity;
  return {
    /**
     * The look for the punch that just landed, or null to leave the face as it is.
     * `snapshot` and `triggers` are what gruntLevel takes (telemetry.js); `showing` is
     * createExpressionSignal().showing. `restart` says the shape should play again from the top.
     */
    react(snapshot, triggers = [], showing = null) {
      const t = now(),
        level = gruntLevel(snapshot, triggers);
      let choice;
      if (level === 'high') {
        lastBigAt = t;
        choice = {
          emotion: 'stunned',
          intensity: triggers.includes('personal-best') ? 1 : 0.85,
          restart: true,
          why: 'big',
        };
      } else if (triggers.includes('combo'))
        choice = { emotion: 'winded', intensity: 0.7, why: 'pressure' };
      else if (level === 'low')
        choice = { emotion: 'smug', intensity: 0.7, why: 'weak' };
      else if (t - lastBigAt < HURT_MEMORY_MS)
        choice = { emotion: 'defiant', intensity: 0.65, why: 'hurt a moment ago' };
      // No baseline yet, or an ordinary punch: the heel's resting face, worn lightly.
      else choice = { emotion: 'smug', intensity: 0.4, why: 'ordinary' };

      if (showing?.emotion === 'concerned') return null;
      if (
        showing?.emotion === 'stunned' &&
        choice.emotion !== 'stunned' &&
        showing.since < STUNNED_PLAYS_FOR
      )
        return null;
      return choice;
    },
  };
}

/** How OMNI's answer relates to what the device chose, for the chip and for Sentry. */
export function verdict(guess, emotion) {
  if (!guess) return 'OMNI';
  return guess.emotion === emotion ? 'OMNI agrees' : 'OMNI corrected it';
}
