"""Conservative surface smoothing of low-frequency camera ownership.

Captured RGB, high-frequency detail and physical-support/fallback scores stay
separate. Ownership reuses the accepted first-pass colors and support exactly.
"""

import numpy as np


def _smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def lower_lateral_region(points, face, parts):
    width = np.ptp(face[:468, 0])
    lower = _smooth((face[1, 1] + 0.015 - points[:, 1]) / 0.035)
    lateral = _smooth((np.abs(points[:, 0]) - width * 0.22) / (width * 0.16))
    jaw = _smooth(
        (face[17, 1] - points[:, 1]) / max((face[17, 1] - face[152, 1]) * 0.65, 0.005)
    )
    return lower * np.maximum(lateral, jaw) * (np.asarray(parts) == 0)


class CameraTexture:
    def __init__(
        self, vertices, faces, points, parts, labels, binding, views, completion=None
    ):
        self.vertices, self.faces, self.binding = vertices, faces, binding
        self.points, self.completion = points, completion
        self.region = lower_lateral_region(points, vertices, parts)
        self.ids = np.flatnonzero(self.region > 0)
        self.slots = np.full(len(points), -1, dtype=np.int32)
        self.slots[self.ids] = np.arange(len(self.ids))
        self.views = {view.name: index for index, view in enumerate(views)}
        self.weights = np.zeros((len(self.ids), len(views)))
        self.colors = {}
        self.domain = lower_lateral_region(vertices, vertices, labels) > 0

    def observe(self, view, near, weight, accum):
        slots = self.slots[near]
        valid = slots >= 0
        self.weights[slots[valid], self.views[view.name]] = weight[valid]
        # Retain only accepted regional samples, not whole projected images.
        # Re-projecting a subset can round a boundary sample differently and
        # reject a camera that was valid in pass one. Its exact accepted color
        # is also cheaper to retain than to repeat all source masks and warps.
        accepted = valid & (weight > 0)
        self.colors[view.name] = (
            slots[accepted],
            accum[accepted] / weight[accepted, None],
        )

    def reblend(self, views, confidence, cleanup, hair, hair_total, hair_best):
        from scripts.camera_ownership import (
            fit_camera_ownership_delta,
            apply_camera_ownership_delta,
        )

        ids = self.ids
        total = self.weights.sum(axis=1)
        probabilities = np.divide(
            self.weights,
            total[:, None],
            out=np.zeros_like(self.weights),
            where=total[:, None] > 1e-7,
        )
        del self.weights
        hair_ratio = np.divide(
            hair[ids],
            hair_total[ids],
            out=np.zeros(len(ids)),
            where=hair_total[ids] > 0,
        )
        from scripts.head_material import photographed_scalp_region

        scalp = photographed_scalp_region(
            self.points[ids],
            self.vertices,
            self.completion,
            hair[ids],
            hair_total[ids],
            hair_best[ids],
        )
        blend = (
            self.region[ids]
            * _smooth((confidence[ids] - 0.12) / 0.13)
            * (cleanup[ids] == 0)
            * (hair_ratio < 0.05)
            * (1 - scalp)
        )
        eligible = (blend > 0) & ((probabilities > 1e-5).sum(axis=1) > 1)
        sampled = np.flatnonzero(eligible)
        sampled = sampled[:: max(1, int(np.ceil(len(sampled) / 60000)))]
        audit = {
            'method': 'Surface-edge diffusion of low-frequency camera ownership',
            'sampledTexels': int(len(sampled)),
            'changedTexels': 0,
            'sourceColorsUnchanged': True,
            'physicalSupportUnchanged': True,
            'fineDetailOwnershipUnchanged': True,
            'limitation': 'Local view blending, not recovered skin albedo or illumination.',
        }
        if len(sampled) < 32:
            self.colors.clear()
            return np.empty(0, dtype=int), np.empty((0, 3)), audit

        def subset(selected):
            return {
                'triangles': self.binding['triangles'],
                'triangleIds': self.binding['triangleIds'][selected],
                'weights': self.binding['weights'][selected],
            }

        used = np.unique(self.faces)
        cut = self.vertices[used, 1].min()
        cap = np.all(self.vertices[self.faces, 1] < cut + 0.0001, axis=1)
        delta, diffusion = fit_camera_ownership_delta(
            self.vertices,
            self.faces[~cap],
            subset(ids[sampled]),
            probabilities[sampled],
            vertex_domain=self.domain,
            steps=6,
            diffusion_scale=0.004,
        )
        revised, masking = apply_camera_ownership_delta(
            probabilities,
            subset(ids),
            delta,
            support_mask=probabilities > 0,
            blend=blend,
        )
        changed = np.max(np.abs(revised - probabilities), axis=1) > 1e-10
        audit.update(
            diffusion=diffusion, masking=masking, changedTexels=int(changed.sum())
        )
        selected = ids[changed]
        probabilities = revised[changed]
        if not len(selected):
            self.colors.clear()
            return selected, np.empty((0, 3)), audit
        # Only the weights change. Reuse the colors accepted by the original
        # alpha/depth/ownership/source masks; no rejected camera gains support.
        result = np.zeros((len(selected), 3))
        output_slots = np.full(len(ids), -1, dtype=np.int32)
        output_slots[changed] = np.arange(len(selected))
        for view in views:
            slots, rgb = self.colors.pop(view.name)
            take = changed[slots]
            output = output_slots[slots[take]]
            revised_weight = probabilities[output, self.views[view.name]]
            result[output] += rgb[take] * revised_weight[:, None]
        audit['projectionPasses'] = 1
        return selected, result, audit
