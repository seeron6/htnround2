"""Decode an uploaded orbit once, instead of seeking through HEVC for every view."""

import base64
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import math
import time
import cv2


def _encode_frame(pixels, size, timestamp):
    pixels = cv2.resize(pixels, size, interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode('.png', pixels, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    if not ok:
        raise ValueError('A sampled frame could not be encoded.')
    return {
        'timeSeconds': timestamp,
        'image': 'data:image/png;base64,' + base64.b64encode(encoded).decode(),
    }


def decode(folder):
    started = time.perf_counter()
    decoder = cv2.VideoCapture(str(folder / 'source-video'))
    try:
        # Phone videos often store landscape pixels plus a display-rotation tag.
        # OpenCV's default here is off: apply the tag before tracking or resizing.
        orientation_enabled = decoder.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        if decoder.get(cv2.CAP_PROP_ORIENTATION_META) and not orientation_enabled:
            raise ValueError('Native orientation unavailable; use browser decoding.')
        fps = decoder.get(cv2.CAP_PROP_FPS)
        count = decoder.get(cv2.CAP_PROP_FRAME_COUNT)
        if not decoder.isOpened() or not math.isfinite(fps) or fps <= 0:
            raise ValueError('Native video decoding unavailable; use browser decoding.')
        duration = count / fps
        if not math.isfinite(duration) or not 3 <= duration <= 300:
            raise ValueError('Use a head video between 3 seconds and 5 minutes.')
        steps = min(220, max(48, math.ceil(duration / 0.3)))
        wanted = {
            round(min(duration - 0.05, duration * i / steps) * fps)
            for i in range(steps)
        }
        frames = []
        index = 0
        # PNG encoding dominates native extraction and releases the GIL. Keep
        # decoding on one thread, with at most four sampled images in flight;
        # consuming futures in submission order preserves every sample time.
        with ThreadPoolExecutor(max_workers=4) as encoders:
            pending = deque()
            while index <= max(wanted) and decoder.grab():
                if index in wanted:
                    ok, pixels = decoder.retrieve()
                    if not ok:
                        raise ValueError('A sampled video frame could not be decoded.')
                    height, width = pixels.shape[:2]
                    scale = min(1, 1280 / max(width, height), 960 / min(width, height))
                    size = (round(width * scale), round(height * scale))
                    pending.append(
                        encoders.submit(_encode_frame, pixels, size, index / fps)
                    )
                    if len(pending) >= 4:
                        frames.append(pending.popleft().result())
                index += 1
            frames.extend(future.result() for future in pending)
        if len(frames) != len(wanted):
            raise ValueError('Video ended before all requested frames were decoded.')
        return {
            'frames': frames,
            'width': size[0],
            'height': size[1],
            'orientationApplied': True,
            'decodeSeconds': round(time.perf_counter() - started, 3),
            'decoder': 'local sequential native frames',
        }
    finally:
        decoder.release()
