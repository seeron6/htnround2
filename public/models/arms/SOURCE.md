# Anatomical arm assets

The skin geometry, UVs, joint anchors and skinning weights are extracted from
MakeHuman hm08 / MPFB2 data bundled by [Anny](https://github.com/naver/anny),
pinned at `ee5b909f320c67e40059cb7503af87e9d01856d6`. These data are CC0;
`LICENSE.md` is copied unchanged. No Anny Python runtime or restricted topology
is used. `scripts/prepare_anatomical_arms.py` extracts the arms, normalizes the
upper-arm length to 29 cm, trims and caps the shoulder, applies one Catmull-Clark subdivision in Blender,
and retains 24 authored bone weights per arm (four influences per vertex).
Each arm has 8,830 UV-split vertices and 16,660 triangles.

The 2048px skin atlas is the CC0 MakeHuman system asset
`skins/young_caucasian_male/young_lightskinned_male_diffuse.png`.
[Asset listing and licence](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).
Original author notices are preserved in `skin-source.mhmat`.
`skin-detail.webp` is a subtle high-pass bump approximation of the albedo,
not a measured normal or displacement map.

Download source archive to `.local/arm-assets/system-assets.zip`:
https://files2.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip

Archive SHA256: `b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107`.
Original PNG SHA256: `862a26e335e958b70534cb5f0d7c47ef30ab148a56c42b3e9da969cf76f12963`.

Rebuild with the installed Blender and existing Python environment:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/prepare_anatomical_arms.py
.venv/bin/python scripts/prepare_arm_textures.py
```

The user's [Sketchfab reference](https://sketchfab.com/3d-models/human-arms-d829cff542df4c06b9993f060f41b467)
was inspected for shape/material quality. It was not downloaded or incorporated:
Sketchfab required a login for its download.
