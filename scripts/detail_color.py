"""Native video detail fusion without letting cutout background tint its edges."""

import cv2
import numpy as np


def fuse_native_detail(captured_rgba, native_rgb):
    """Return native-size ``(rgba, audit)`` without changing the capture matte.

    Inputs are uint8 registered RGBA and matched native RGB with matching aspect
    ratio (allowing the existing decoder matcher's 0.005 rounding tolerance). Alpha is nearest-neighbour resampled exactly. Native RGB supplies
    detail; registered RGB supplies the slowly varying colour correction.

    Near the cutout, registered colour is resized as premultiplied RGB divided
    by resized alpha, using positive bilinear weights (area weights when downscaling). Then, with native alpha
    A, output = native + Gaussian(A * (registered - native)) / Gaussian(A).
    Neither hidden registered RGB nor native background enters that correction.
    This is not foreground decontamination: retained translucent source pixels
    may themselves contain photographed background, and lost hair stays lost.

    Where the complete cubic-resize and Gaussian footprints are opaque, keep
    the previous cubic/high-pass calculation byte-exact. Camera coordinates,
    dimensions and alpha ownership are unchanged; no pixels are generated.
    """
    captured, native = np.asarray(captured_rgba), np.asarray(native_rgb)
    if (
        captured.ndim != 3
        or captured.shape[2] != 4
        or captured.dtype != np.uint8
        or native.ndim != 3
        or native.shape[2] != 3
        or native.dtype != np.uint8
        or min(captured.shape[:2]) == 0
        or min(native.shape[:2]) == 0
    ):
        raise ValueError('Detail fusion requires nonempty uint8 RGBA and RGB images.')
    h, w = captured.shape[:2]
    nh, nw = native.shape[:2]
    sx, sy = nw / w, nh / h
    if abs(nw / nh - w / h) > 0.005:
        raise ValueError(
            'Registered and native images must have matching aspect ratio.'
        )
    size, sigma = (nw, nh), 1.4 * sx
    alpha = cv2.resize(captured[:, :, 3], size, interpolation=cv2.INTER_NEAREST)
    foreground = alpha > 0
    output = np.zeros((nh, nw, 4), np.uint8)
    output[:, :, 3] = alpha
    audit = dict(
        method='Alpha-normalized registered-colour resampling and low-frequency correction.',
        registeredSize=[w, h],
        nativeSize=[nw, nh],
        scale=sx,
        sigmaNativePixels=sigma,
        foregroundPixels=int(foreground.sum()),
        edgeCorrectedPixels=0,
        legacyInteriorPixels=0,
        alphaPreserved=True,
        expandedForegroundPixels=0,
        limitation='Original alpha retained; does not restore removed hair or unmix translucent foreground.',
    )
    if not foreground.any():
        return output, audit
    n = native.astype(np.float32)
    old_registered = cv2.resize(
        captured[:, :, :3], size, interpolation=cv2.INTER_CUBIC
    ).astype(np.float32)
    old = np.uint8(
        np.clip(
            cv2.GaussianBlur(old_registered, (0, 0), sigma)
            + n
            - cv2.GaussianBlur(n, (0, 0), sigma),
            0,
            255,
        )
    )
    # A conservative support footprint: float Gaussian auto-kernels extend no
    # farther than ceil(4*sigma); cubic interpolation uses two source pixels.
    # Extra two native pixels cover resizing phase/rounding at the mask edge.
    radius = int(np.ceil(4 * sigma) + np.ceil(2 * max(sx, sy)) + 2)
    opaque = (
        cv2.erode(
            np.uint8(alpha == 255),
            np.ones((2 * radius + 1, 2 * radius + 1), np.uint8),
            borderType=cv2.BORDER_REPLICATE,
        )
        > 0
    )
    # Nearest alpha can erase a source hole during downscaling. In that case
    # native opacity cannot prove the original cubic footprint was opaque.
    downscale = min(sx, sy) < 1
    if downscale and not np.all(captured[:, :, 3] == 255):
        opaque[:] = False
    audit['legacyInteriorPixels'] = int(opaque.sum())
    audit['legacySupportRadiusPixels'] = radius
    if opaque.all():
        output[:, :, :3] = old
        return output, audit
    source_alpha = captured[:, :, 3].astype(np.float32) / 255
    # Area support includes sparse source foreground that nearest alpha keeps
    # but a decimated bilinear sample could miss entirely.
    interpolation = cv2.INTER_AREA if downscale else cv2.INTER_LINEAR
    resampled_alpha = cv2.resize(source_alpha, size, interpolation=interpolation)
    premultiplied = captured[:, :, :3].astype(np.float32) * source_alpha[:, :, None]
    premultiplied = cv2.resize(premultiplied, size, interpolation=interpolation)
    registered = np.divide(
        premultiplied,
        resampled_alpha[:, :, None],
        out=np.zeros_like(premultiplied),
        where=resampled_alpha[:, :, None] > 0,
    )
    native_alpha = alpha.astype(np.float32) / 255
    denominator = cv2.GaussianBlur(native_alpha, (0, 0), sigma)
    numerator = cv2.GaussianBlur(
        (registered - n) * native_alpha[:, :, None], (0, 0), sigma
    )
    correction = np.divide(
        numerator,
        denominator[:, :, None],
        out=np.zeros_like(numerator),
        where=denominator[:, :, None] > 0,
    )
    fused = np.uint8(np.clip(n + correction, 0, 255))
    fused[opaque] = old[opaque]
    fused[~foreground] = 0
    output[:, :, :3] = fused
    audit['edgeCorrectedPixels'] = int(np.count_nonzero(foreground & ~opaque))
    return output, audit
