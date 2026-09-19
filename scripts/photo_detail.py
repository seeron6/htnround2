"""Recover native video detail without changing registered camera coordinates."""

import json
import cv2
import numpy as np
from PIL import Image
from face_pipeline import atomic
from scripts.detail_color import fuse_native_detail

# Existing captures retain their inputs until an explicit, verified migration.
# RGB hashes bind generated cleanup and semantic caches to these exact images.
DETAIL_CACHE_VERSIONS = (2, 3)
DETAIL_VERSION = 3
DETAIL_SOURCE = (
    'Original video detail at matched timestamps; alpha-normalized colour match '
    'to registered browser-decoded frames; original alpha; no super-resolution'
)


def prepare_detail_frames(folder):
    manifest = folder / 'photo-detail.json'
    if manifest.exists():
        cached = json.loads(manifest.read_text())
        if cached.get('version') in DETAIL_CACHE_VERSIONS:
            return cached
    video = folder / 'source-video'
    if not video.exists():
        return {'frames': [], 'source': 'Captured images'}
    frames = json.loads((folder / 'capture.json').read_text())['frames']
    decoder = cv2.VideoCapture(str(video))
    fps = decoder.get(cv2.CAP_PROP_FPS)
    rotation = int(decoder.get(cv2.CAP_PROP_ORIENTATION_META)) % 360
    decoder.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
    output = folder / 'detail-images'
    output.mkdir(exist_ok=True)
    audit = []
    try:
        for frame in frames:
            if frame.get('timeSeconds') is None or fps <= 0:
                continue
            captured = np.asarray(
                Image.open(folder / 'images' / frame['filename']).convert('RGBA')
            )
            h, w = captured.shape[:2]
            valid = captured[:, :, 3] > 220
            if not valid.any():
                continue
            best = None
            # Browser seeking and native decoders can round a timestamp to
            # adjacent frames. Match against the registered image before use.
            target = int(round(frame['timeSeconds'] * fps))
            for index in range(max(0, target - 2), target + 3):
                decoder.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, bgr = decoder.read()
                if not ok:
                    continue
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                if rotation:
                    rgb = np.rot90(rgb, (360 - rotation) // 90).copy()
                if abs(rgb.shape[1] / rgb.shape[0] - w / h) > 0.005:
                    continue
                small = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
                difference = small.astype(float) - captured[:, :, :3]
                difference -= np.median(difference[valid], axis=0)
                error = float(np.mean(np.abs(difference[valid])))
                if best is None or error < best[0]:
                    best = (error, index, rgb)
            if best is None or best[0] > 12:
                continue
            error, index, rgb = best
            # Phone HDR/colour metadata is handled differently by the browser
            # and OpenCV. Preserve the registered browser-decoded skin colour;
            # take only extra spatial detail from the native decoder.
            rgba, fusion = fuse_native_detail(captured, rgb)
            Image.fromarray(rgba).save(output / frame['filename'])
            audit.append(
                {
                    'filename': frame['filename'],
                    'requestedSeconds': frame['timeSeconds'],
                    'decodedFrame': index,
                    'matchError255': round(error, 3),
                    'size': [rgb.shape[1], rgb.shape[0]],
                    'registeredSize': [w, h],
                    'colorFusion': fusion,
                }
            )
    finally:
        decoder.release()
    result = {
        'version': DETAIL_VERSION,
        'source': DETAIL_SOURCE,
        'frames': audit,
    }
    atomic(manifest, result)
    return result


def detail_image(folder, name):
    path = folder / 'detail-images' / name
    return np.asarray(
        Image.open(path if path.exists() else folder / 'images' / name).convert('RGBA')
    )


BROWS = (
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
)


def brow_mask(shape, frame):
    mask = np.zeros(shape[:2], np.uint8)
    if not frame.get('landmarks'):
        return mask
    h, w = shape[:2]
    for ids in BROWS:
        xy = np.rint(
            [
                [frame['landmarks'][i]['x'] * w, frame['landmarks'][i]['y'] * h]
                for i in ids
            ]
        ).astype(np.int32)
        cv2.fillConvexPoly(mask, cv2.convexHull(xy), 255)
    return cv2.dilate(mask, np.ones((3, 3), np.uint8))
