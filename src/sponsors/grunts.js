// The instant answer to a landed punch. OMNI's spoken line is ~1.3 s away (network + model), which
// is a long silence after hitting something. So the face's grunts were recorded once, in its own
// OMNI voice (scripts/build_omni_reactions.py -> public/omni-reactions/), and the one that fits the
// punch is played from memory the moment it lands. It goes through the panel's speech bus, so the
// head's mouth opens with it, the echo gate hears it coming, and LiveKit guests hear it too. The
// reply that follows is queued behind it: "Oof! ... that one actually rattled me."
//
// `gruntLevel` mirrors intensity_of() in omni_senses.py, so the grunt and the spoken line that
// follows agree about how hard the punch was. It is pure, and covered by a Node test.

/** 'low' | 'mid' | 'high' for the last punch, relative to that person's own punches. */
export function gruntLevel(snapshot, triggers = []) {
  if (triggers.includes('personal-best')) return 'high';
  const last = snapshot?.last,
    who =
      snapshot?.participants?.find((p) => p.name === last?.name) ||
      snapshot?.participants?.[0];
  if (!last || !who || !(who.count >= 3)) return 'mid';
  if (last.speed >= 0.97 * who.max && last.speed >= 1.25 * who.avg) return 'high';
  if (last.speed <= 0.8 * who.avg) return 'low';
  return 'mid';
}

export function createGrunts({ base = '/omni-reactions' } = {}) {
  let index = null,
    indexing = null;
  const clips = new Map(); // voice -> { low: AudioBuffer[], mid: [...], high: [...] }
  let lastPlayed = null;

  async function manifest() {
    indexing ??= fetch(`${base}/index.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    return (index ??= await indexing);
  }

  return {
    /** Decode one voice's clips into `ctx`. Safe to call again; a voice without clips is fine. */
    async load(ctx, voice) {
      const listed = (await manifest())[voice];
      if (!ctx || !listed || clips.has(voice)) return clips.has(voice);
      const decoded = {};
      for (const [level, names] of Object.entries(listed))
        decoded[level] = (
          await Promise.all(
            names.map((name) =>
              fetch(`${base}/${voice}/${name}`)
                .then((r) => (r.ok ? r.arrayBuffer() : null))
                .then((bytes) => (bytes ? ctx.decodeAudioData(bytes) : null))
                .catch(() => null),
            ),
          )
        ).filter(Boolean);
      clips.set(voice, decoded);
      return true;
    },
    has: (voice) => clips.has(voice),
    /**
     * Play a grunt now, into `destination`. Returns its length in seconds, or 0 when this voice
     * has nothing at that level (then the punch is simply answered by the spoken line, as before).
     */
    play(ctx, destination, voice, level) {
      const voiceClips = clips.get(voice),
        pool = voiceClips?.[level]?.length
          ? voiceClips[level]
          : voiceClips?.mid?.length
            ? voiceClips.mid
            : null;
      if (!ctx || !destination || !pool) return 0;
      // Never the same take twice running when there is a choice: repetition is what gives a
      // soundboard away.
      const options = pool.length > 1 ? pool.filter((b) => b !== lastPlayed) : pool,
        buffer = options[Math.floor(Math.random() * options.length)];
      lastPlayed = buffer;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
      return buffer.duration;
    },
  };
}
