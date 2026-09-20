"""CONTACT_PHYSICS_SLEEP=1: a face that has stopped moving stops being simulated until it is hit
again (newton_face.py; the reason is TRACKS/SENTRY.md, finding 1). This proves the three things
that make that safe to switch on: it is off by default, a punch always wakes it, and what the
person sees is the same as if it had never slept.

Needs a built head on this computer (.local/face-captures/<id>/physics-cage.json) and the physics
interpreter:  .local/newton-env/bin/python -m unittest tests.newton_sleep_test
"""

import sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    import numpy as np
    import newton_face
    from newton_face import NewtonFace, load_cage

    CAGES = sorted((ROOT / '.local/face-captures').glob('*/physics-cage.json'))
    SKIP = None if CAGES else 'no built head on this computer'
except ImportError as missing:
    SKIP = 'Newton is not importable here (%s); use .local/newton-env/bin/python' % missing

PUNCH = ([0.0, 0.0, 0.08], [0, 0, -1], 1.6)


@unittest.skipIf(SKIP, SKIP)
class SleepWhenStill(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cage = load_cage(CAGES[0].parent)

    def face(self, sleeps):
        sim = NewtonFace(self.cage, 0.6)
        sim.sleep_when_still = sleeps
        return sim

    def test_it_is_off_unless_asked_for(self):
        self.assertFalse(newton_face.SLEEP_WHEN_STILL)
        sim = NewtonFace(self.cage, 0.6)
        for _ in range(30):
            self.assertNotIn('asleep', sim.step(1 / 30))

    def test_a_still_face_sleeps_a_punch_wakes_it_and_nothing_visible_changes(self):
        sleeper, twin = self.face(True), self.face(False)
        seen = []
        for sim in (sleeper, twin):
            frames = []
            for punch in range(2):
                sim.impact(*PUNCH)
                for _ in range(75):  # 2.5 s: the hit, the wobble, and well into the quiet after it
                    frames.append(sim.step(1 / 30))
            seen.append(frames)
        slept, never = seen

        asleep = [bool(f.get('asleep')) for f in slept]
        self.assertFalse(any(asleep[:20]), 'it must never sleep through the hit itself')
        self.assertTrue(all(asleep[60:75]), 'it should be asleep within 2 s of a punch')
        self.assertFalse(asleep[75], 'the second punch must wake it on the very next step')
        self.assertFalse(any(asleep[75:95]))
        self.assertFalse(any(f.get('asleep') for f in never))

        # What the page draws: the same to within a fiftieth of a millimetre, asleep or not,
        # including the whole response to the punch that woke it.
        worst = max(
            float(np.abs(np.asarray(a['offsets']) - np.asarray(b['offsets'])).max())
            for a, b in zip(slept, never)
        )
        self.assertLess(worst, 2e-5, 'sleeping changed the motion by %.4f mm' % (worst * 1000))
        self.assertAlmostEqual(
            max(f['peakMm'] for f in slept[75:]), max(f['peakMm'] for f in never[75:]), delta=0.02
        )
        # Time still passes while it sleeps, and the point of it all: a resting step is nearly free.
        self.assertAlmostEqual(slept[-1]['simulationTime'], never[-1]['simulationTime'], places=6)
        resting = sorted(f['stepMs'] for f, a in zip(slept, asleep) if a)
        working = sorted(f['stepMs'] for f in never)
        self.assertLess(resting[len(resting) // 2], 1.0)
        print(
            '\n  awake step p50 %.1f ms -> asleep step p50 %.3f ms; asleep for %d of %d frames; '
            'largest difference in what is drawn: %.4f mm'
            % (
                working[len(working) // 2],
                resting[len(resting) // 2],
                sum(asleep),
                len(asleep),
                worst * 1000,
            )
        )


if __name__ == '__main__':
    unittest.main()
