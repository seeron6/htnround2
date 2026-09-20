"""Prepare continuous CC0 arms with authored skinning weights and UVs.

Run with Blender: blender --background --python scripts/prepare_anatomical_arms.py
Source data stays in .local; the compact arm-only browser asset goes in public.
"""

import json
from pathlib import Path
import shutil

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".local/third_party/anny/src/anny/data/mpfb2"
OUT = ROOT / "public/models/arms"


def prepare():
    positions, texcoords, faces, face_uvs, groups = [], [], [], [], {}
    group = ""
    for line in (SOURCE / "3dobjs/base.obj").read_text().splitlines():
        t = line.split()
        if not t:
            continue
        if t[0] == "v":
            positions.append(Vector(tuple(float(x) * 0.1 for x in t[1:4])))
        elif t[0] == "vt":
            texcoords.append(tuple(float(x) for x in t[1:3]))
        elif t[0] == "g":
            group = t[1]
            groups[group] = set()
        elif t[0] == "f":
            ids = [int(x.split("/")[0]) - 1 for x in t[1:]]
            groups[group].update(ids)
            if group == "body":
                faces.append(ids)
                face_uvs.append([int(x.split("/")[1]) - 1 for x in t[1:]])

    rig = json.loads((SOURCE / "rigs/standard/rig.default.json").read_text())
    weights = json.loads((SOURCE / "rigs/standard/weights.default.json").read_text())[
        "weights"
    ]

    def anchor(spec):
        if spec["strategy"] == "CUBE":
            ids = groups[spec["cube_name"]]
        elif spec["strategy"] == "MEAN":
            ids = spec["vertex_indices"]
        else:
            ids = [spec["vertex_index"]]
        return sum((positions[i] for i in ids), Vector()) / len(ids)

    result = {"source": "MakeHuman / Anny CC0", "version": 1, "arms": {}}
    for side, suffix in [("left", ".L"), ("right", ".R")]:
        names = [
            n
            for n in rig
            if n.endswith(suffix)
            and n.startswith(("upperarm", "lowerarm", "wrist", "metacarpal", "finger"))
        ]
        names.sort()
        heads = {n: anchor(rig[n]["head"]) for n in names}
        tails = {n: anchor(rig[n]["tail"]) for n in names}
        shoulder, elbow, wrist = [
            heads[n + suffix] for n in ["upperarm01", "lowerarm01", "wrist"]
        ]
        # Scale to an adult 29 cm upper arm, preserving authored proportions.
        scale = 0.29 / (elbow - shoulder).length
        totals = [0.0] * len(positions)
        for name in names:
            for i, w in weights[name]:
                totals[i] += w
        selected = [i for i, f in enumerate(faces) if all(totals[v] > 0.01 for v in f)]
        ids = sorted({v for i in selected for v in faces[i]})
        remap = {v: i for i, v in enumerate(ids)}
        mesh = bpy.data.meshes.new(side)
        mesh.from_pydata(
            [tuple((positions[i] - wrist) * scale) for i in ids],
            [],
            [[remap[v] for v in faces[i]] for i in selected],
        )
        obj = bpy.data.objects.new(side, mesh)
        bpy.context.collection.objects.link(obj)
        uv = mesh.uv_layers.new(name="SkinUV")
        for poly, src in zip(mesh.polygons, selected):
            for loop, uv_id in zip(poly.loop_indices, face_uvs[src]):
                uv.data[loop].uv = texcoords[uv_id]
            poly.use_smooth = True
        for name in names:
            vg = obj.vertex_groups.new(name=name)
            for i, w in weights[name]:
                if i in remap:
                    vg.add([remap[i]], w / totals[i], "REPLACE")
        # Trim at a clean shoulder section instead of exposing a jagged boundary
        # selected by skin weights. Preserve interpolated UVs and bone weights.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        # In the authored A-pose the arms are lateral to the torso. A plane
        # across the upper-arm axis also retains a wedge of the armpit/torso;
        # trim laterally instead, just outside the shoulder anchor.
        axis = Vector((1 if suffix == ".L" else -1, 0, 0))
        cut = bmesh.ops.bisect_plane(
            bm,
            geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
            plane_co=(shoulder - wrist) * scale + axis * 0.035,
            plane_no=axis,
            clear_inner=True,
            clear_outer=False,
            dist=0.000001,
        )
        edges = [e for e in bm.edges if e.is_boundary]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        if bm.calc_volume(signed=True) < 0:
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        sub = obj.modifiers.new("Anatomical surface refinement", "SUBSURF")
        sub.levels = 1
        bpy.ops.object.modifier_apply(modifier=sub.name)
        mesh = obj.data
        mesh.calc_loop_triangles()
        attrs = {
            k: []
            for k in [
                "positions",
                "normals",
                "uv",
                "skinIndex",
                "skinWeight",
                "indices",
            ]
        }
        unique = {}
        for tri in mesh.loop_triangles:
            for loop_id in tri.loops:
                loop = mesh.loops[loop_id]
                v = mesh.vertices[loop.vertex_index]
                uv = mesh.uv_layers.active.data[loop_id].uv
                key = (v.index, round(uv.x, 7), round(uv.y, 7))
                if key not in unique:
                    unique[key] = len(unique)
                    attrs["positions"].extend(round(x, 7) for x in v.co)
                    attrs["normals"].extend(round(x, 6) for x in v.normal)
                    attrs["uv"].extend(round(x, 7) for x in uv)
                    influences = sorted(
                        [(g.group, g.weight) for g in v.groups], key=lambda x: -x[1]
                    )[:4]
                    total = sum(w for _, w in influences)
                    influences += [(0, 0)] * (4 - len(influences))
                    attrs["skinIndex"].extend(i for i, _ in influences)
                    attrs["skinWeight"].extend(
                        round(w / total, 7) for _, w in influences
                    )
                attrs["indices"].append(unique[key])
        attrs["bones"] = [
            {
                "name": n[:-2],
                "head": list((heads[n] - wrist) * scale),
                "tail": list((tails[n] - wrist) * scale),
            }
            for n in names
        ]
        result["arms"][side] = attrs
        print(side, len(unique), "vertices", len(attrs["indices"]) // 3, "triangles")
        obj.select_set(False)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "anatomical-arms.json").write_text(json.dumps(result, separators=(",", ":")))
    shutil.copyfile(SOURCE / "LICENSE.md", OUT / "LICENSE.md")


prepare()
