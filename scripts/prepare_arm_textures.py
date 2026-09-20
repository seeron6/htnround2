"""Prepare the CC0 MakeHuman skin atlas used by the anatomical arms.

Run: .venv/bin/python scripts/prepare_arm_textures.py
Requires .local/arm-assets/system-assets.zip (URL and hash in SOURCE.md).
"""

import hashlib
from pathlib import Path
import zipfile

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".local/arm-assets"
OUT = ROOT / "public/models/arms"
ARCHIVE_HASH = "b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107"
IMAGE_PATH = "skins/young_caucasian_male/young_lightskinned_male_diffuse.png"


def prepare():
    archive = SOURCE / "system-assets.zip"
    if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_HASH:
        raise ValueError(
            "Skin source archive changed; review provenance before rebuilding."
        )
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as assets:
        (SOURCE / "skin-source.png").write_bytes(assets.read(IMAGE_PATH))
        material = "skins/young_caucasian_male/young_caucasian_male.mhmat"
        (OUT / "skin-source.mhmat").write_bytes(assets.read(material))
    image = Image.open(SOURCE / "skin-source.png").convert("RGB")
    image = image.resize((2048, 2048), Image.Resampling.LANCZOS)
    image.save(OUT / "skin-albedo.webp", quality=94)
    gray = image.convert("L")
    highpass = np.asarray(gray, dtype=float) - np.asarray(
        gray.filter(ImageFilter.GaussianBlur(3)), dtype=float
    )
    detail = np.uint8(np.clip(128 + highpass * 1.3, 0, 255))
    Image.fromarray(detail).save(OUT / "skin-detail.webp", lossless=True)


if __name__ == "__main__":
    prepare()
