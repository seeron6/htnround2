"""Capture adapter for conservative, repeatable ear-outline refinement."""

import numpy as np


def refine_capture_ear_contours(
    folder,
    points,
    faces,
    face_count,
    regions,
    semantics,
    reconstruction,
    center,
    basis,
    transform,
    *,
    baseline,
):
    from scripts.ear_contour_fit import capture_contour_views, fit_ear_contours
    from scripts.ear_deformation import surface_quality
    from scripts.surface_intersections import new_crossings

    # Fitting and validation use the exact precision persisted in mesh.json.
    rest = np.asarray(points, np.float32).astype(float)
    original = np.asarray(baseline, np.float32).astype(float)
    if not semantics:
        return rest, dict(accepted=False, reason='No source ear observations.')
    views, observations = capture_contour_views(
        folder, semantics, reconstruction, center, basis
    )
    proposal, audit = fit_ear_contours(
        rest,
        faces,
        face_count,
        regions,
        views,
        center,
        basis,
        transform['scale'],
        baseline=original,
    )
    saved = proposal.astype(np.float32).astype(float)
    protected = np.zeros(len(rest), dtype=bool)
    protected[: min(468, len(rest))] = True
    protected[np.unique(np.asarray(faces)[:face_count])] = True
    for region in regions.values():
        protected[list(region.get('anchors', {}).values())] = True
    protected_exact = np.array_equal(saved[protected], rest[protected])
    quality = surface_quality(original, saved, faces)
    quality.update(new_crossings(original, saved, faces))
    audit.update(
        observations=observations,
        persistedQuality=quality,
        persistedProtectedVerticesExact=protected_exact,
    )
    if not protected_exact:
        audit.update(
            accepted=False,
            reason='Persisted contour proposal changed protected face, cage, or ear anchors.',
        )
        return rest, audit
    if (
        quality['reversedTriangles']
        or quality['minimumNormalAgreement'] <= 0.1
        or quality['minimumAreaRatio'] <= 0.25
        or quality['maximumAreaRatio'] >= 3
        or quality['newCrossings']
    ):
        audit.update(
            accepted=False, reason='Persisted contour proposal failed surface quality.'
        )
        return rest, audit
    return saved, audit
