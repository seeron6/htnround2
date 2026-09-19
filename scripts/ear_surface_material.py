"""Apply estimated head appearance behind masked source ears exactly once."""

import numpy as np

from scripts.ear_surface_completion import continue_ear_surface


def complete_masked_ear_surface(
    vertices,
    faces,
    binding,
    vertex_parts,
    parts,
    color,
    *,
    photographic_color,
    prepared_color,
    ear_hidden,
    total,
    estimated_total,
    best,
    hair_support,
    hair_accum,
    hair_total,
    hair_votes,
    hair_visibility,
    hair_semantic_best,
    preserve,
):
    """Continue reliable boundary color into source-ear occlusion gaps.

    The caller saves photographic_color before estimated/cleanup blends, and
    prepared_color after cleanup but before generic material completion.
    Eligible head texels replace that earlier fallback once. Reliable photos,
    positive hair semantics, generated cleanup, ears, eyes, mouth and neck cap
    retain their current color. Unanchored components keep their old fallback.

    This changes estimated appearance only. It cannot reveal hidden anatomy or
    increase source coverage. Inputs, mesh and confidence arrays are unchanged.
    """
    mass = ear_hidden + total + estimated_total
    fraction = np.divide(ear_hidden, mass, out=np.zeros_like(total), where=mass > 1e-7)
    occlusion = np.clip((fraction - 0.05) / 0.35, 0, 1)
    occlusion = occlusion * occlusion * (3 - 2 * occlusion)
    observed_hair = (hair_semantic_best > 0.30) & (hair_votes >= hair_visibility * 0.75)
    support = np.maximum(best, hair_support)
    photographic = (total > 1e-7) & ~preserve
    # Relaxed oblique hair support must carry its own RGB. The unrestricted
    # photographed blend can contain skin from a different camera.
    donor_color = photographic_color.copy()
    hair_only = (best <= 0.15) & (hair_support > 0.15) & (hair_total > 1e-7)
    donor_color[hair_only] = hair_accum[hair_only] / hair_total[hair_only, None]
    photographic &= (best > 0.15) | hair_only
    estimate, alpha, ownership, audit = continue_ear_surface(
        vertices,
        faces,
        binding,
        donor_color,
        parts,
        vertex_parts,
        support,
        occlusion,
        photographed=photographic,
        preserve=preserve,
        observed_hair=observed_hair,
    )
    selected = ownership > 0
    result = color.copy()
    result[selected] += ownership[selected, None] * (
        prepared_color[selected] - result[selected]
    ) + alpha[selected, None] * (estimate[selected] - prepared_color[selected])
    protected = preserve | (support >= 0.12) | observed_hair | (parts != 0)
    if not np.array_equal(result[protected], color[protected]):
        raise ValueError('Ear-surface completion changed protected appearance.')
    audit.update(
        actuallyChangedTexels=int(np.any(result != color, axis=1).sum()),
        protectedTexels=int(protected.sum()),
        protectedChanged=0,
        photoSnapshotBeforeEstimatedBlend=True,
        relaxedHairDonorsUseHairOnlyRGB=True,
        ownership='Smooth source-ear occlusion fraction from 0.05 to 0.40; hidden votes included once in total mass.',
    )
    return result, audit
