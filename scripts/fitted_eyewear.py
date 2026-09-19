"""Keep source-fitted eyewear consistent across full builds and detail rebuilds."""

from scripts.head_accessories import build_glasses, sample_frame_colors
from scripts.eyewear_detail import refine_glasses_detail


def fit_photo_glasses(folder, points, advice, rec, frames, center, basis, transform):
    if not advice:
        return None
    glasses = build_glasses(points, advice, rec, frames, center, basis, transform)
    if not glasses:
        return None
    glasses = refine_glasses_detail(
        folder, glasses, advice, rec, center, basis, transform['scale']
    )
    color = sample_frame_colors(folder, advice)
    if color:
        glasses.update(
            frameColor=color,
            colorSource='Opaque photo frame samples; never part of the skin atlas',
        )
    return glasses
