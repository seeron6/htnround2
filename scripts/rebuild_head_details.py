"""Refine an existing head without replacing its accepted face or hairstyle.

Work is staged; matching texture/UV/geometry hashes publish only after validation.
Usage: PYTHONPATH=. .venv/bin/python scripts/rebuild_head_details.py CAPTURE
"""

import argparse, hashlib, json, shutil
from pathlib import Path
import numpy as np, pycolmap, trimesh
from face_pipeline import atomic
from head_artifacts import HeadArtifactTransaction, published_folder
from scripts.fit_head_template import fit_template
from scripts.head_semantics import analyze
from scripts.ear_fit import triangulate_ears, fit_ears, refine_ear_ownership
from scripts.fitted_eyewear import fit_photo_glasses
from scripts.photo_geometry import bake_photographs
from scripts.hair_recognition import hair_completion


def rebuild(folder, geometry_only=False):
    with HeadArtifactTransaction(folder, seed=True) as publication:
        return _rebuild(folder, geometry_only, publication)


def _rebuild(folder, geometry_only, publication):
    accepted = published_folder(folder)
    snapshot = (accepted / 'mesh.json').read_bytes()
    current = json.loads(snapshot)
    backup = folder / 'before-semantic-head-v1'
    backup.mkdir(exist_ok=True)
    for name in (
        'mesh.json',
        'appearance.png',
        'appearance-roughness.png',
        'texture-atlas.json',
        'physics-cage.json',
        'physics-binding.json',
    ):
        if (accepted / name).exists() and not (backup / name).exists():
            shutil.copy2(accepted / name, backup / name)
    original = json.loads((backup / 'mesh.json').read_text())
    baseline = accepted / 'pre-ear-surface.npz'
    baseline_payload = {}
    if baseline.exists():
        with np.load(baseline, allow_pickle=False) as saved:
            baseline_payload = {key: saved[key].copy() for key in saved.files}
            if (
                str(saved['captureHash'])
                != hashlib.sha256((folder / 'capture.json').read_bytes()).hexdigest()
            ):
                raise ValueError(
                    'Ear baseline does not match this capture; run the complete pipeline.'
                )
            if float(saved['regularization']) != current['stats']['templateFit'].get(
                'regularization', 0.025
            ):
                raise ValueError(
                    'Ear baseline uses a different identity fit; run the complete pipeline.'
                )
            original = json.loads(snapshot)
            original['positions'] = saved['positions'].ravel().tolist()
            original['indices'] = saved['indices'].ravel().tolist()
    if current['indices'] != original['indices']:
        raise ValueError(
            'Topology changed after the backup; run the complete pipeline.'
        )
    from scripts.surface_evidence import validate_refinement_baseline

    validate_refinement_baseline(
        current, original, json.loads((accepted / 'physics-cage.json').read_text())
    )
    advice = json.loads((folder / 'astra-head-completion.json').read_text())
    if (folder / 'hair-recognition.json').exists():
        advice = hair_completion(
            advice, json.loads((folder / 'hair-recognition.json').read_text())
        )
    semantics = analyze(folder, advice)
    rec = pycolmap.Reconstruction(str(folder / 'photo-cameras'))
    points = np.array(
        json.loads((accepted / 'surface-validation.json').read_text())['landmarksWorld']
    )
    center = (points[10] + points[152]) / 2
    right = points[263] - points[33]
    right /= np.linalg.norm(right)
    up = points[10] - points[152]
    up -= right * np.dot(up, right)
    up /= np.linalg.norm(up)
    B = np.stack([right, up, np.cross(right, up)])
    frames = {
        v['filename']: v
        for v in json.loads((folder / 'capture.json').read_text())['frames']
    }
    for im in rec.images.values():
        c = (im.projection_center() - center) @ B.T
        frames[im.name]['cameraYaw'] = float(np.degrees(np.arctan2(c[0], c[2])))
    p = np.array(original['positions']).reshape(-1, 3)
    f = np.array(original['indices']).reshape(-1, 3)
    count = original['stats']['observedFaceTriangles']
    normalized = (points - center) @ B.T * original['transform']['scale']
    neutral, topology, _, info = fit_template(
        normalized, original['stats']['templateFit'].get('regularization', 0.025)
    )
    if len(neutral) != len(p) or not np.array_equal(f, topology):
        raise ValueError(
            'Cannot recover semantic template correspondence for this topology.'
        )
    measurements = triangulate_ears(
        folder, rec, center, B, original['transform'], semantics
    )
    from scripts.ear_contour_rest import (
        contour_rest_fields,
        load_contour_rest,
        measurement_digest,
    )

    current_positions = np.array(current['positions']).reshape(-1, 3)
    rest = load_contour_rest(
        baseline_payload,
        current_positions,
        f,
        count,
        measurements,
    )
    if rest is not None:
        p = rest
        audit = current['stats']['earFit']
        info['earRegions'] = json.loads(
            json.dumps(current['stats']['templateFit']['earRegions'])
        )
    elif (accepted / 'ear-measurements.json').exists() and measurement_digest(
        json.loads((accepted / 'ear-measurements.json').read_text())
    ) == measurement_digest(measurements):
        if current['stats'].get('earContourFit'):
            raise ValueError(
                'Refined contours are missing their rest snapshot; run the complete pipeline.'
            )
        # One-time migration of an accepted legacy surface. Later shape edits
        # may have followed ear fitting; replaying the nonlinear fit would
        # silently change them. Keep the independent pre-ear quality baseline.
        p = current_positions
        audit = current['stats']['earFit']
        info['earRegions'] = json.loads(
            json.dumps(current['stats']['templateFit']['earRegions'])
        )
    else:
        p, audit = fit_ears(p, f, count, info['earRegions'], measurements)
    for region in info['earRegions'].values():
        region['coreVertices'] = region.get(
            'anatomicalCoreVertices', region['coreVertices']
        ).copy()
    rest_fields = contour_rest_fields(p, f, measurements)
    from scripts.ear_contour_pipeline import refine_capture_ear_contours

    p, contour_audit = refine_capture_ear_contours(
        folder,
        p,
        f,
        count,
        info['earRegions'],
        semantics,
        rec,
        center,
        B,
        original['transform'],
        baseline=np.array(original['positions']).reshape(-1, 3),
    )
    mesh = trimesh.Trimesh(p, f, process=False)
    if not mesh.is_watertight or not np.isfinite(p).all():
        raise ValueError('Refinement failed topology validation.')
    print(json.dumps(audit, indent=2), flush=True)
    atomic(publication.stage / 'ear-measurements.json', measurements)
    if geometry_only:
        np.savez_compressed(folder / 'ear-fit-preview.npz', positions=p, indices=f)
        return
    # Fit from the same baseline on every rerun. Facial rig vertices and face
    # triangles are fixed. Transport conformed hair stations to the corrected
    # envelope while retaining their photographic appearance and correspondence.
    data = current
    data['positions'] = p.astype(np.float32).ravel().tolist()
    data['normals'] = np.asarray(mesh.vertex_normals, dtype=np.float32).ravel().tolist()
    data['stats']['templateFit']['earRegions'] = info['earRegions']
    data['stats']['earFit'] = audit
    data['stats']['earContourFit'] = contour_audit
    data['stats']['earOwnership'] = refine_ear_ownership(
        folder, p, f, info['earRegions'], semantics, rec, center, B, data['transform']
    )
    from scripts.surface_evidence import surface_projection_error

    validation = json.loads((accepted / 'surface-validation.json').read_text())
    held = [im for im in rec.images.values() if im.name in validation['withheldFrames']]
    surface_test = surface_projection_error(
        p, info['landmarkBindings'], rec, frames, held, center, B, data['transform']
    )
    if surface_test['medianPx'] > 4 or surface_test['p95Px'] > 12:
        raise ValueError(
            'Refined surface does not explain the withheld face views; previous model retained.'
        )
    data['stats']['templateFit']['landmarkBindings'] = info['landmarkBindings']
    data['stats']['withheldSurfaceLandmarks'] = {
        **surface_test,
        'usedForTemplateFit': False,
        'usedForParameterSelection': False,
        'appearanceAndCompletionMayUseTheseViews': True,
    }
    validation['evidence'].update(
        {
            key: data['stats'][key]
            for key in (
                'withheldSurfaceLandmarks',
                'earFit',
                'earContourFit',
                'earOwnership',
            )
        }
    )
    atomic(publication.stage / 'surface-validation.json', validation)
    from scripts.hair_groom import build_hair_groom

    previous_hair = current.get('accessories', {}).get('hair')
    if previous_hair:
        advice['hair'] = {**advice['hair'], **previous_hair['parameters']}
    if ((previous_hair or {}).get('photoGuides') or {}).get('surfaceConformed'):
        from scripts.hair_surface_transport import transport_photo_groom

        groom, transport = transport_photo_groom(
            previous_hair,
            np.array(json.loads(snapshot)['positions']).reshape(-1, 3),
            np.asarray(data['positions']).reshape(-1, 3),
            f,
        )
        data['stats']['hairSurfaceTransport'] = transport
    else:
        groom = build_hair_groom(
            p, f, advice, rec, center, B, data['transform'], folder, info['earRegions']
        )
    if previous_hair and not groom:
        raise ValueError(
            'Corrected head has insufficient hair evidence; previous model retained.'
        )
    data['accessories']['hair'] = groom
    if groom:
        data['stats']['hairGroom'] = {
            **data['stats'].get('hairGroom', {}),
            'version': groom['version'],
            'roots': groom['rootCount'],
            'recognition': groom['recognition'],
            **groom['evidence'],
        }
    data['accessories']['glasses'] = fit_photo_glasses(
        folder, p, advice, rec, frames, center, B, data['transform']
    )
    # Float32 is the persisted/rendered mesh; hash those exact same positions.
    p = np.asarray(data['positions']).reshape(-1, 3)
    eyes = (
        json.loads((folder / 'eye-detail.json').read_text())
        if (folder / 'eye-detail.json').exists()
        else None
    )
    data['stats']['appearance'] = bake_photographs(
        folder,
        p,
        f,
        count,
        rec,
        frames,
        list(rec.images.values()),
        center,
        B,
        data['transform'],
        advice,
        eyes,
        semantics,
        info['earRegions'],
        output_folder=publication.stage,
    )
    if baseline_payload:
        np.savez_compressed(
            publication.stage / 'pre-ear-surface.npz',
            **{**baseline_payload, **rest_fields},
        )
    atomic(publication.stage / 'mesh.json', data)
    publication.commit()
    print('Published validated head details. Backup:', backup, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--geometry-only', action='store_true')
    args = parser.parse_args()
    rebuild(args.folder.resolve(), args.geometry_only)
