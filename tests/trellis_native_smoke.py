"""Real upstream sampler/MLX/mesh-extraction smoke checks; NO pretrained weights.

Run with .local/trellis-env/bin/python -m unittest tests.trellis_native_smoke
"""

import os
from pathlib import Path
import sys
import unittest

SOURCE = Path(__file__).resolve().parents[1] / '.local/third_party/trellis2-apple'
sys.path[:0] = [str(SOURCE), str(SOURCE / 'o-voxel')]
os.environ['ATTN_BACKEND'] = 'sdpa'
os.environ['SPARSE_CONV_BACKEND'] = 'pytorch'
os.environ['HF_HUB_OFFLINE'] = '1'

import numpy as np
import torch
import mlx.core as mx
from trellis2.pipelines.samplers.flow_euler import FlowEulerGuidanceIntervalSampler
from trellis2.modules.sparse import SparseTensor
from mlx_backend.sparse_conv import MlxSparseConv3d
from mlx_backend.sparse_tensor import MlxSparseTensor
from o_voxel.convert import flexible_dual_grid_to_mesh
from scripts.trellis_face_adapter import FaceConditionedFlow, ViewCondition


class NativeSmoke(unittest.TestCase):
    def test_dense_and_sparse_upstream_cfg_integration(self):
        condition = ViewCondition(
            tuple(torch.tensor(v) for v in (1.0, 2.0, 3.0)), (0.4, 0.3, 0.3)
        )
        sampler = FlowEulerGuidanceIntervalSampler(sigma_min=1e-5)
        coords = torch.tensor([[0, 0, 0, 0], [0, 1, 0, 0]], dtype=torch.int32)
        for sparse in (False, True):

            def model(x, timestep, cond):
                if sparse:
                    return x.replace(torch.ones_like(x.feats) * cond)
                return torch.ones_like(x) * cond

            noise = (
                SparseTensor(torch.zeros(2, 2), coords) if sparse else torch.zeros(1, 2)
            )
            result = sampler.sample(
                FaceConditionedFlow(model),
                noise,
                condition,
                neg_cond=torch.tensor(0.0),
                guidance_strength=2.0,
                guidance_interval=(0.0, 1.0),
                steps=4,
                verbose=False,
            ).samples
            value = result.feats if sparse else result
            torch.testing.assert_close(value, torch.full_like(value, -3.8))
            if sparse:
                torch.testing.assert_close(result.coords, coords)

    def test_mlx_sparse_convolution_without_compiled_extensions(self):
        data = MlxSparseTensor(
            feats=mx.array([[1.0, 2.0], [3.0, 4.0]]),
            coords=mx.array([[0, 0, 0, 0], [0, 1, 0, 0]], dtype=mx.int32),
        )
        layer = MlxSparseConv3d(2, 1, 1)
        layer.weight = mx.array([[[[[2.0, 3.0]]]]])
        layer.bias = mx.array([1.0])
        result = layer(data)
        mx.eval(result.feats)
        np.testing.assert_allclose(np.array(result.feats), [[9.0], [19.0]])

    def test_cpu_dual_grid_extracts_only_valid_indices(self):
        coords = torch.tensor(
            [[x, y, z] for x in (2, 3) for y in (2, 3) for z in (2, 3)],
            dtype=torch.int32,
        )
        vertices, faces = flexible_dual_grid_to_mesh(
            coords,
            torch.full((8, 3), 0.5),
            torch.ones((8, 3), dtype=torch.bool),
            torch.ones((8, 1)),
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            grid_size=8,
        )
        self.assertGreater(len(faces), 0)
        self.assertGreaterEqual(int(faces.min()), 0)
        self.assertLess(int(faces.max()), len(vertices))
        self.assertTrue(bool(torch.isfinite(vertices).all()))


if __name__ == '__main__':
    unittest.main()
