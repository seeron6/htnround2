# Who speaks for the face

Written 2026-09-19. Everything marked **measured** was run on this machine against the live services.

This file is about the *voice*. What the model sees and hears, the expression it sets by function call, the tone
direction and the cached grunts are in [../TRACKS/OMNI_JUDGES.md](../TRACKS/OMNI_JUDGES.md).

## The chain

1. **OMNI's own voice** (primary). `sponsor_server.py` asks `qwen3.5-omni-flash` for text + audio with the voice picked
   in the panel (`omniVoice`, allow-listed by `OMNI_ACCEPTED`), else `OMNI_VOICE`, else `Ethan`.
2. **ElevenLabs** (backup, `elevenlabs_voice.py`). Steps in when there is no OMNI key (mock mode), when the gateway
   refuses the voice (the turn is asked again for words only), or when a reply arrives as words without audio. The panel's
   "Use the ElevenLabs voice instead of OMNI's" puts it in front on purpose: OMNI then only writes, and ElevenLabs speaks
   sentence by sentence while the rest is still streaming.
3. **The browser's `speechSynthesis`** (last resort), only when nobody above produced audio, so the face is never mute.

Both engines reach the page as the same `audio` SSE events (base64 PCM16, 24 kHz), so the mouth analyser
(`src/omni/mouth-signal.js`: real lip-sync), the echo gate and the LiveKit guest stream work unchanged. The browser voice
cannot be analysed, which is why mock mode without a backup key only gets the synthetic mouth.

The status line under the log says who spoke: `Voice: OMNI Ryan.`, `Voice: ElevenLabs The Brawler (backup: …).` or
`Voice: the browser.` plus the reason.

## Keys

| Service | Where | Notes |
| --- | --- | --- |
| OMNI | `OMNI_API_KEY` or `.local/secrets/omni.json` (panel: "OMNI key") | read per request, no restart needed |
| ElevenLabs | `ELEVENLABS_API_KEY` or `.local/secrets/elevenlabs.json` (panel: "ElevenLabs key") | needs the **Text to Speech** permission; **Voices: Read** lets the picker mark which cast voices the account has |

`sponsor_server.py` has no reloader: restart `npm run sponsors` after editing it, `sponsor_personas.py`
or `elevenlabs_voice.py`.

A key problem that will not fix itself (missing permission, bad key, no credits, plan) is remembered for 120 s so turns
stop paying for a failing call; saving a key or a working **Hear it** clears it at once.

## The OMNI cast (measured)

The cast now selects **diction and cadence as well as the voice**. `sponsor_personas.py` supplies a separate
writing direction and audition line for each character:

| Character | Dialogue style |
| --- | --- |
| Showman / Ryan | Theatrical setups, audience asides, showbiz metaphors |
| Loudmouth / Ethan | Fast interruptions, disbelief, everyday banter |
| Heavyweight / Marcus | Clipped fragments, few words, dry understatement |
| Street Kid / Dylan | Toronto/GTA banter, relaxed cadence, dry wit and occasional local slang |
| Ice Queen / Jennifer | Precise diction, cool politeness, cutting verdicts |
| Veteran / Katerina | Knowing ring idioms, conversational wit, old-school confidence |

Directions include fresh phrasing, sparing slang, and reactions to the actual exchange. Toronto is a writing
direction, not a guarantee that the stock voice reproduces a Toronto accent. The chosen character remains the
writer when ElevenLabs or browser speech takes over. Coach mode keeps the diction but gives constructive cues;
the existing safety rules override the act. Changing cast in the panel cancels the current reply and clears its
dialogue history. **Hear it** uses a different sample for each character and mode, including when auditioning
the backup voice. The no-key mock remains a canned development reply, not a model-generated character.

Live dialogue keeps the last six exchanges as quoted conversation records, rather than replaying earlier taunts
as assistant examples to imitate. `sponsor_dialogue.py` gives each turn a different writing cue and reminds OMNI
of the recent lines to avoid; direct questions and safety take priority. The panel's turn counter keeps the cues
moving after the history fills. Audition samples stay in **Hear it**;
they are no longer embedded in the live writing prompt. Weak-hit direction describes delivery rather than
suggesting a stock line. Video, room audio, expression function calling and the voice fallback chain remain enabled.

Unsolicited face reactions also use a streaming repeat guard. It holds text and audio together only while the
opening could be a verbatim repeat of an earlier line, releasing them as soon as the wording diverges. A fully
repeated taunt gets one fresh attempt with OMNI's native voice; if that also repeats, the face quietly skips that
reaction. The log omits an empty reply. Direct typed/spoken conversation keeps its ordinary stream, including
requests to repeat something, and safety advice can repeat. Normal replies use one generation; a rejected
duplicate can cost a second call and extra time. This blocks exact unsolicited repeats, while similar ideas or
phrases within otherwise new replies can still recur.

The measurements below used the same line for every voice, before cast-specific writing was added.

`scripts/voice_audition.py --engine omni` had every candidate say the same taunt through yibuapi, then pitch was tracked
by autocorrelation. Accepted: Ryan, Ethan, Marcus, Dylan, Peter, Rocky, Eric, Serena, Jennifer, Katerina. Refused
(`Voice '…' is not supported`, delivered **inside a 200 stream**): Elias, Roy, Nofish, Cherry, Chelsie.

| Voice | Role in the panel | Median pitch | Pitch swing (p10–p90) | Same line took |
| --- | --- | --- | --- | --- |
| Ryan | The Showman | 131 Hz | 19.8 st | 4.64 s |
| Ethan | The Loudmouth (default) | 203 Hz | 15.7 st | 3.60 s |
| Marcus | The Heavyweight | 147 Hz | 11.6 st | 3.92 s |
| Dylan | The Street Kid | 204 Hz | 18.3 st | 4.08 s |
| Jennifer | The Ice Queen | 209 Hz | 4.9 st | 4.16 s |
| Katerina | The Veteran | 247 Hz | 6.7 st | 4.16 s |
| Peter / Rocky / Eric / Serena | "Also accepted" | 188 / 171 / 171 / 304 Hz | 16.4 / 11.5 / 9.6 / 8.7 st | 3.84–4.56 s |

First audio arrived 1.0–1.2 s after the request for every voice. The roles are a reading of those numbers (deep + wide
swing = theatrical, low + flat = cold), not a listening test: open `.local/voice-audition/index.html` and trust your ears.

## The ElevenLabs cast (not yet heard)

The Brawler (Callum), The Deadpan Brit (Daniel), The Cocky Aussie (Charlie), The Heavyweight (Brian), The Firecracker
(Jessica), The Ice Queen (Alice), The Old Cornerman (Bill, coach default). Left on "Match the OMNI voice", the backup is
the closest character to the OMNI pick (`BACKUP_FOR`), so a fallback never changes the head's gender mid-round.

**Unverified:** the key saved on 2026-09-19 authenticates but lacks the Text to Speech permission, so no ElevenLabs audio
has been produced here yet; request shape, streaming, fallbacks and error handling are covered by
`tests/face_voice_test.py` against a fake upstream. The ids are ElevenLabs "Default" voices: only on accounts created
before March 2026, retired 2026-12-31. After that, put ids from My Voices into `VOICES`, or set `ELEVENLABS_VOICE_ID`.
Once the key is fixed: `.venv/bin/python scripts/voice_audition.py --engine elevenlabs`.

## Endpoints added to the relay

- `GET /sponsors/voice/options` — both casts, availability, any standing ElevenLabs problem. No secrets.
- `POST /sponsors/voice/preview` `{engine: 'omni'|'elevenlabs', mode, omniVoice, backupVoice}` — one sample line as SSE.
- `POST /sponsors/coach/turn` also takes `omniVoice`, `backupVoice`, `voiceEngine`; `meta` reports `voiceEngine`,
  `voiceName`, `backupVoice`, `voiceProblem`; a `voice` event reports a fallback or a backup failure; `done.speech` has
  the ElevenLabs timing.
- `POST /sponsors/settings` accepts `group: 'elevenlabs'`.
