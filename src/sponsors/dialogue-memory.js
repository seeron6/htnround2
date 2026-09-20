// Session-only conversation evidence. Raw mic samples and webcam frames never enter history.
const LIMIT = 6;
const clean = (value, limit) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

export function createDialogueMemory() {
  let turns = [];
  return {
    remember({ text, perception, telemetry, hasAudio, hasRoom, reply }) {
      const last = telemetry?.last;
      turns.push({
        text: clean(text, 300),
        heard: clean(perception?.heard, 200),
        seen: clean(perception?.seen, 160),
        room: !!hasRoom && !hasAudio,
        hasAudio: !!hasAudio,
        event: last
          ? clean(
              `${last.name || 'Player'} hit ${last.zone || 'the target'}${telemetry.trigger ? ` (${telemetry.trigger})` : ''}`,
              80,
            )
          : '',
        reply: clean(reply, 599),
      });
      turns = turns.slice(-LIMIT);
    },
    history() {
      return turns.flatMap((turn) => {
        const record = [
          turn.text && `Said: ${turn.text}`,
          turn.heard && `OMNI heard: ${turn.heard}`,
          !turn.text &&
            !turn.heard &&
            turn.hasAudio &&
            'Speech was supplied; words were not recovered.',
          turn.seen && `OMNI saw: ${turn.seen}`,
          turn.event && `Event: ${turn.event}`,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 599);
        return [
          ...(record ? [{ role: 'user', content: record }] : []),
          ...(turn.reply ? [{ role: 'assistant', content: turn.reply }] : []),
        ];
      });
    },
    forgetVision() {
      for (const turn of turns) turn.seen = '';
    },
    forgetRoom() {
      for (const turn of turns) if (turn.room) turn.heard = '';
    },
    clear() {
      turns = [];
    },
  };
}
