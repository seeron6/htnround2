"""Explicit eyewear detection and ownership contract shared by reconstruction engines.

The existing multiview vision analysis detects the accessory. Missing evidence is
unknown, never a negative detection. Geometry repair is handled by each engine.
"""

import hashlib
import json
from pathlib import Path
import numpy as np


class EyewearSeparationError(ValueError):
    pass


def detect_eyewear(advice):
    info = (advice or {}).get('glasses', {})
    confidence = info.get('confidence', 0)
    if not isinstance(confidence, (float, int)) or not np.isfinite(confidence):
        confidence = 0
    confidence = float(np.clip(confidence, 0, 1))
    views = (advice or {}).get('views', [])
    visible = [
        v.get('filename')
        for v in views
        if any(
            len(v.get(key, [])) >= 2
            for key in (
                'imageLeftLens',
                'imageRightLens',
                'bridge',
                'imageLeftTemple',
                'imageRightTemple',
            )
        )
        or v.get('eyewearRegions')
    ]
    present = info.get('present')
    state = 'unknown'
    if confidence >= 0.75 and isinstance(present, bool):
        state = 'present' if present else ('unknown' if visible else 'absent')
    return {
        'state': state,
        'confidence': confidence,
        'method': 'Saved multiview accessory analysis',
        'model': (advice or {}).get('model'),
        'visibleViews': visible,
        'requiresSeparateGeometry': state == 'present',
        'reason': (
            'Eyewear contours contradict a negative classification.'
            if present is False and visible
            else (
                'Insufficient confidence or missing analysis.'
                if state == 'unknown'
                else None
            )
        ),
    }


def load_eyewear_detection(capture):
    capture = Path(capture)
    path = capture / 'astra-head-completion.json'
    if not path.exists():
        raise EyewearSeparationError(
            'Eyewear analysis is missing. Analyze accessories before preparing this scan.'
        )
    advice = json.loads(path.read_text())
    signature = hashlib.sha256((capture / 'capture.json').read_bytes()).hexdigest()
    if advice.get('captureHash') != signature:
        raise EyewearSeparationError(
            'Eyewear analysis belongs to an older capture. Reanalyze this capture first.'
        )
    detection = detect_eyewear(advice)
    if detection['state'] == 'unknown':
        raise EyewearSeparationError(
            'Eyewear detection is uncertain. Reanalyze sharper front and side views before publishing.'
        )
    return advice, detection


def require_separate_glasses(detection, spec):
    """Do not publish a positive detection without actual reconstructable paths."""
    if detection['state'] != 'present':
        return
    if not spec or len(spec.get('rims', [])) != 2 or len(spec.get('temples', [])) != 2:
        raise EyewearSeparationError(
            'Glasses were detected but could not be fitted as independent geometry.'
        )
    paths = [*spec['rims'], spec.get('bridge', []), *spec['temples']]
    for i, path in enumerate(paths):
        p = np.asarray(path, dtype=float)
        minimum = 8 if i < 2 else 2
        if (
            p.ndim != 2
            or p.shape[1] != 3
            or len(p) < minimum
            or not np.isfinite(p).all()
            or np.any(abs(p) >= 1)
        ):
            raise EyewearSeparationError(
                'The independently fitted glasses contain invalid contours.'
            )
    if np.ptp(np.asarray(spec['rims'][0]), axis=0)[:2].min() < 0.005:
        raise EyewearSeparationError('The fitted eyeglass rim is degenerate.')


def require_glasses_cleanup(detection, cleanup, front_filename):
    if detection['state'] != 'present':
        return
    available = {
        v.get('filename') for v in cleanup.get('views', []) if v.get('available')
    }
    if front_filename not in available or len(available) < 3:
        raise EyewearSeparationError(
            'Glasses were detected, but clean source-registered front and side references are missing. '
            'The previous model was retained instead of publishing glasses painted into the skin.'
        )
