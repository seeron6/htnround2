"""Read unmasked video evidence at the already registered decoder frame.

This does not change the capture matte, texture inputs, or generated cleanup
caches. Unmasked RGB is geometry/appearance review evidence, never a replacement
for foreground ownership or a calibrated skin-albedo measurement.
"""

import hashlib
import json
import cv2
import numpy as np
from PIL import Image


def matched_video_observation(folder, filename):
    video, manifest = folder / 'source-video', folder / 'photo-detail.json'
    if not video.is_file() or not manifest.is_file():
        return None, {'available': False, 'reason': 'No matched original video frame.'}
    detail = json.loads(manifest.read_text())
    frame = next(
        (v for v in detail.get('frames', []) if v['filename'] == filename), None
    )
    if frame is None:
        return None, {'available': False, 'reason': 'No registered decoder frame.'}
    index = frame.get('decodedFrame')
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise ValueError('Invalid registered decoder frame.')
    captured = np.asarray(Image.open(folder / 'images' / filename).convert('RGBA'))
    valid = captured[:, :, 3] > 220
    if not valid.any():
        raise ValueError(
            'Cannot verify the video frame without opaque registered pixels.'
        )
    decoder = cv2.VideoCapture(str(video))
    try:
        rotation = int(decoder.get(cv2.CAP_PROP_ORIENTATION_META)) % 360
        if rotation not in (0, 90, 180, 270):
            raise ValueError('Unsupported source-video orientation.')
        decoder.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
        decoder.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, bgr = decoder.read()
        if not ok:
            raise ValueError('Cannot decode the registered source-video frame.')
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        if rotation:
            rgb = np.rot90(rgb, (360 - rotation) // 90).copy()
    finally:
        decoder.release()
    h, w = captured.shape[:2]
    if (
        list(rgb.shape[1::-1]) != frame.get('size')
        or abs(rgb.shape[1] / rgb.shape[0] - w / h) > 0.005
    ):
        raise ValueError('Original video dimensions differ from the registered frame.')
    small = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
    difference = small.astype(float) - captured[:, :, :3]
    difference -= np.median(difference[valid], axis=0)
    error = float(np.mean(np.abs(difference[valid])))
    if error > 12:
        raise ValueError('Original video no longer matches the registered photograph.')
    return rgb, {
        'available': True,
        'decodedFrame': index,
        'rotationDegrees': rotation,
        'size': list(rgb.shape[1::-1]),
        'registeredSize': [w, h],
        'matchError255': error,
        'rgbSha256': hashlib.sha256(rgb.tobytes()).hexdigest(),
        'registeredImageSha256': hashlib.sha256(
            (folder / 'images' / filename).read_bytes()
        ).hexdigest(),
        'segmented': False,
        'color': 'Original native decoder RGB; no registered-color correction.',
    }
