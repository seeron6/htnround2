"""Experimental PunchingFace specialization of a pretrained TRELLIS.2 pipeline.

This changes the *conditional denoising*, not the provider or the app's name.
Each captured view predicts a velocity on the same latent; angularly balanced
velocities are combined before the upstream sampler applies guidance/rescaling.
No generated textures are used: the output is geometry for subsequent alignment,
measurement fitting and PunchingFace's photographic bake. See docs/TRELLIS_FACE.md.

No torch import at module load: capture preparation and adapter tests run in .venv.
"""

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

UPSTREAM_COMMIT = '75fbf0183001ed9876c8dbb35de6b68552ee08bd'
APPLE_COMMIT = '17347247c91c36c8cdc1896234983e878a457bba'
ADAPTER_VERSION = 1


def select_head_views(frames, training_names, limit=5):
    """Use only an explicit training split; unknown-angle frames are not rear views.

    A front plus both sides is required for this specialization. Rank by angular
    distance, not capture frequency, so a long pause facing forward cannot swamp
    the profile evidence. Additional quarter/rear views need known cameraYaw.
    """
    if not 3 <= limit <= 5:
        raise ValueError('Choose between three and five conditioning views.')
    allowed = set(training_names)
    candidates = []
    for frame in frames:
        name = frame.get('filename')
        if name not in allowed:
            continue
        angle = frame.get('cameraYaw')
        if angle is None and frame.get('landmarks'):
            angle = frame.get('yaw')
        if (
            isinstance(angle, bool)
            or not isinstance(angle, (int, float))
            or not math.isfinite(angle)
        ):
            continue
        angle = (angle + 180) % 360 - 180
        candidates.append({'filename': name, 'yaw': float(angle)})
    chosen = []
    for target, tolerance in ((0, 20), (-55, 30), (55, 30)):
        usable = [v for v in candidates if v not in chosen]
        nearest = min(
            usable, key=lambda v: (abs(v['yaw'] - target), v['filename']), default=None
        )
        if nearest is None or abs(nearest['yaw'] - target) > tolerance:
            raise ValueError(
                'TRELLIS face conditioning needs a tracked front and both side views in the training split.'
            )
        chosen.append(nearest)

    def gap(a, b):
        return abs((a - b + 180) % 360 - 180)

    while len(chosen) < limit:
        remaining = [v for v in candidates if v not in chosen]
        if not remaining:
            break
        nearest_distance = lambda v: min(gap(v['yaw'], c['yaw']) for c in chosen)
        pick = max(remaining, key=lambda v: (nearest_distance(v), v['filename']))
        if nearest_distance(pick) < 30:
            break
        chosen.append(pick)
    # Front gets 40%, the angularly distinct supporting views share the rest.
    # This is a hypothesis to evaluate, not a learned or benchmarked coefficient.
    for i, view in enumerate(chosen):
        view['weight'] = 0.4 if i == 0 else 0.6 / (len(chosen) - 1)
    return chosen


def prepare_capture(folder, training_names, output, limit=5):
    """Write an isolated input bundle; never edit a capture or published model."""
    from meshy_backend import (
        prepare_view,
    )  # image cutout utility only; makes no API calls

    folder, output = Path(folder).resolve(), Path(output).resolve()
    if output == folder or folder in output.parents:
        raise ValueError('Use a separate experiment folder outside the source capture.')
    manifest = json.loads((folder / 'capture.json').read_text())
    views = select_head_views(manifest['frames'], training_names, limit)
    # Create only after all selection validation succeeds. Existing runs are immutable.
    output.mkdir(parents=True, exist_ok=False)
    try:
        for i, view in enumerate(views):
            path = (folder / 'images' / view['filename']).resolve()
            if path.parent != (folder / 'images').resolve():
                raise ValueError('Invalid capture image path.')
            raw = prepare_view(path, size=1024)
            name = f'view-{i}.png'
            (output / name).write_bytes(raw)
            view.update(image=name, sha256=hashlib.sha256(raw).hexdigest())
        report = {
            'format': 'punching-face-trellis-input-v1',
            'adapterVersion': ADAPTER_VERSION,
            'capture': folder.name,
            'captureSha256': hashlib.sha256(
                (folder / 'capture.json').read_bytes()
            ).hexdigest(),
            'trainingFrames': sorted(set(training_names)),
            'views': views,
            'upstreamCommit': UPSTREAM_COMMIT,
            'appleCommit': APPLE_COMMIT,
            'generatedGeometryIsMeasured': False,
        }
        (output / 'input.json').write_text(json.dumps(report, indent=2))
        return report
    except Exception:
        # Leave a diagnostic marker; never reuse a partial bundle for inference.
        (output / 'FAILED').write_text(
            'Input preparation failed; create a fresh experiment folder.\n'
        )
        raise


@dataclass(frozen=True)
class ViewCondition:
    features: tuple
    weights: tuple

    def __post_init__(self):
        if not self.features or len(self.features) != len(self.weights):
            raise ValueError('One weight is required for each conditioning view.')
        if any(not math.isfinite(w) or w <= 0 for w in self.weights):
            raise ValueError('View weights must be finite and positive.')
        if not math.isclose(sum(self.weights), 1.0, abs_tol=1e-8):
            raise ValueError('View weights must sum to one.')


class FaceConditionedFlow:
    """A model adapter usable with dense and sparse upstream Euler samplers.

    Negative conditioning goes through once. Positive features stay separate;
    averaging DINO tokens would lose the view-specific attention predictions.
    Shared x/t and unchanged sparse coordinates keep the predictions compatible.
    """

    def __init__(self, model):
        self.model = model

    def __getattr__(self, name):
        return getattr(self.model, name)

    def __call__(self, latent, timestep, condition, **kwargs):
        if not isinstance(condition, ViewCondition):
            return self.model(latent, timestep, condition, **kwargs)
        combined = None
        for features, weight in zip(condition.features, condition.weights):
            prediction = self.model(latent, timestep, features, **kwargs) * weight
            combined = prediction if combined is None else combined + prediction
        return combined


@contextmanager
def specialize_pipeline(pipeline):
    """Patch one dedicated pipeline instance and restore it even on failure.

    Samplers (including CFG, interval, rescale and sigma_min) stay intact. This
    instance must not be shared with concurrent inference. No class/global patch.
    """
    names = [
        name
        for name in pipeline.models
        if name == 'sparse_structure_flow_model'
        or name.startswith('shape_slat_flow_model_')
    ]
    if not names or any(
        isinstance(pipeline.models[name], FaceConditionedFlow) for name in names
    ):
        raise ValueError('Expected an unmodified TRELLIS.2 geometry pipeline.')
    original = {name: pipeline.models[name] for name in names}
    try:
        for name, model in original.items():
            pipeline.models[name] = FaceConditionedFlow(model)
        yield pipeline
    finally:
        pipeline.models.update(original)


def conditioning(pipeline, images, weights, resolution):
    features, negative = [], None
    # Batch size remains one: all views condition one head, not N separate heads.
    for image in images:
        result = pipeline.get_cond([image], resolution, include_neg_cond=True)
        features.append(result['cond'])
        if negative is None:
            negative = result['neg_cond']
    return {
        'cond': ViewCondition(tuple(features), tuple(weights)),
        'neg_cond': negative,
    }


def generate_geometry(pipeline, images, weights, resolution=512, seed=42):
    """Run pretrained structure/shape with face conditioning; skip texture diffusion.

    Call inside the backend's no-grad context with its RNG seeded. Decode output
    remains in TRELLIS coordinates; it is deliberately NOT a viewer-ready head.
    """
    if resolution not in (512, 1024):
        raise ValueError('The initial face adapter supports 512 and 1024 geometry.')
    if len(images) != len(weights):
        raise ValueError('Input views and weights differ.')
    ViewCondition(tuple(images), tuple(weights))  # validate before model execution
    with specialize_pipeline(pipeline):
        cond_structure = conditioning(pipeline, images, weights, 512)
        cond_shape = (
            cond_structure
            if resolution == 512
            else conditioning(pipeline, images, weights, 1024)
        )
        coords = pipeline.sample_sparse_structure(
            cond_structure, 32 if resolution == 512 else 64, 1
        )
        latent = pipeline.sample_shape_slat(
            cond_shape, pipeline.models[f'shape_slat_flow_model_{resolution}'], coords
        )
        meshes, _ = pipeline.decode_shape_slat(latent, resolution)
    if len(meshes) != 1:
        raise ValueError('Expected one generated head.')
    return meshes[0], {
        'adapterVersion': ADAPTER_VERSION,
        'resolution': resolution,
        'seed': seed,
        'conditioningViews': len(images),
        'weights': list(weights),
        'textureDiffusionUsed': False,
        'measuredGeometry': False,
        'coordinateSystem': 'trellis-object-units',
        'requiresAlignmentAndMeasurementFit': True,
    }


def fit_measured_landmarks(
    vertices, faces, binding, targets, smoothing=1.0, anchor_weight=100.0
):
    """Refine an ALIGNED generated mesh against known barycentric correspondences.

    Solve a regularized displacement field, retaining topology. Correspondences
    must be established on the generated mesh; template indices are not valid.
    Returns a private candidate and residuals, never publishes or certifies likeness.
    """
    from scipy.sparse import coo_matrix, diags, eye
    from scipy.sparse.linalg import spsolve
    from scripts.ear_deformation import bounded_surface_step

    p = np.asarray(vertices, dtype=float)
    f = np.asarray(faces)
    ids = np.asarray(binding['vertices'])
    bary = np.asarray(binding['weights'], dtype=float)
    target = np.asarray(targets, dtype=float)
    if p.ndim != 2 or p.shape[1] != 3 or not np.isfinite(p).all():
        raise ValueError('Invalid generated vertices.')
    for array in (f, ids):
        if (
            array.ndim != 2
            or array.shape[1] != 3
            or not np.issubdtype(array.dtype, np.integer)
            or array.size == 0
            or array.min() < 0
            or array.max() >= len(p)
        ):
            raise ValueError('Invalid generated-mesh indices.')
    if (
        bary.shape != ids.shape
        or target.shape != (len(ids), 3)
        or not np.isfinite(bary).all()
        or not np.isfinite(target).all()
    ):
        raise ValueError('Invalid landmark measurements.')
    if np.any(bary < 0) or not np.allclose(bary.sum(axis=1), 1):
        raise ValueError('Invalid barycentric landmark weights.')
    if (
        not np.isfinite([smoothing, anchor_weight]).all()
        or min(smoothing, anchor_weight) <= 0
    ):
        raise ValueError('Fitting strengths must be positive and finite.')
    # A correspondence must be a real triangle, not arbitrary nearby vertices.
    triangles = {tuple(sorted(row)) for row in f.tolist()}
    if any(tuple(sorted(row)) not in triangles for row in ids.tolist()):
        raise ValueError('Landmark binding does not belong to this generated mesh.')
    n = len(p)
    edges = np.unique(
        np.sort(np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1), axis=0
    )
    i, j = edges.T
    rows, cols = np.r_[i, j], np.r_[j, i]
    adjacency = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n)).tocsr()
    degree = np.asarray(adjacency.sum(axis=1)).ravel()
    laplacian = diags(degree) - adjacency
    anchors = coo_matrix(
        (bary.ravel(), (np.repeat(np.arange(len(ids)), 3), ids.ravel())),
        shape=(len(ids), n),
    ).tocsr()
    before = anchors @ p
    lhs = (
        smoothing * (laplacian.T @ laplacian)
        + anchor_weight * (anchors.T @ anchors)
        + eye(n) * 1e-6
    )
    displacement = spsolve(lhs.tocsc(), anchor_weight * anchors.T @ (target - before))
    if not np.isfinite(displacement).all():
        raise ValueError('Measurement fit produced invalid geometry.')
    fitted, quality = bounded_surface_step(p, p + displacement, f)
    initial = float(np.sqrt(np.mean((before - target) ** 2)))
    final = float(np.sqrt(np.mean((anchors @ fitted - target) ** 2)))
    if final > initial + 1e-10:
        raise ValueError('Measurement refinement worsened landmark agreement.')
    return fitted, {
        'initialRms': initial,
        'finalRms': final,
        'quality': quality,
        'coordinateUnits': 'same as aligned input',
        'validatedLikeness': False,
    }
