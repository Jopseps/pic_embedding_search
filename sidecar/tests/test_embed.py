"""Embedding tests.

The registry-parity test runs everywhere and is the important one: if the ids
here and in `src/lib/catalog.ts` drift, the settings dropdown selects a model
the backend does not have.

The tests that actually load a model are gated behind PICSEARCH_MODEL_TESTS=1
because the first run downloads weights from Hugging Face.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from picsearch.embed import REGISTRY, Embedder, l2_normalize, spec_for

CATALOG_TS = Path(__file__).resolve().parents[2] / "src" / "lib" / "catalog.ts"

needs_model = pytest.mark.skipif(
    os.environ.get("PICSEARCH_MODEL_TESTS") != "1",
    reason="set PICSEARCH_MODEL_TESTS=1 to run tests that download and load weights",
)


# -- registry ---------------------------------------------------------------

def parse_catalog_ts() -> dict[str, int]:
    """Pull `id` -> `dim` out of the frontend catalog. It is the shared contract."""
    text = CATALOG_TS.read_text(encoding="utf-8")
    block = text.split("EMBEDDING_MODELS", 1)[1].split("];", 1)[0]
    ids = re.findall(r'id:\s*"([^"]+)"', block)
    dims = [int(d) for d in re.findall(r"dim:\s*(\d+)", block)]
    assert len(ids) == len(dims)
    return dict(zip(ids, dims, strict=True))


def test_registry_ids_match_catalog_ts():
    catalog = parse_catalog_ts()
    assert set(catalog) == set(REGISTRY), (
        "embed.py REGISTRY and src/lib/catalog.ts disagree on model ids"
    )


def test_registry_dims_match_catalog_ts():
    catalog = parse_catalog_ts()
    for model_id, dim in catalog.items():
        assert REGISTRY[model_id].dim == dim, f"{model_id}: dim mismatch with catalog.ts"


def test_multilingual_flags_match_catalog_ts():
    text = CATALOG_TS.read_text(encoding="utf-8")
    block = text.split("EMBEDDING_MODELS", 1)[1].split("];", 1)[0]
    ids = re.findall(r'id:\s*"([^"]+)"', block)
    flags = [f == "true" for f in re.findall(r"multilingual:\s*(true|false)", block)]
    for model_id, flag in zip(ids, flags, strict=True):
        assert REGISTRY[model_id].multilingual == flag


def test_unknown_model_id_is_loud():
    with pytest.raises(KeyError):
        spec_for("clip-vit-nope")


# -- normalization ----------------------------------------------------------

def test_l2_normalize_single_vector():
    out = l2_normalize(np.array([3.0, 4.0], dtype=np.float32))
    np.testing.assert_allclose(out, [0.6, 0.8], atol=1e-6)
    assert out.dtype == np.float32


def test_l2_normalize_matrix_rows():
    out = l2_normalize(np.array([[3.0, 4.0], [0.0, 2.0]], dtype=np.float32))
    np.testing.assert_allclose(np.linalg.norm(out, axis=1), [1.0, 1.0], atol=1e-6)


def test_l2_normalize_survives_a_zero_vector():
    out = l2_normalize(np.zeros((2, 3), dtype=np.float32))
    assert np.isfinite(out).all()


# -- fixtures ---------------------------------------------------------------

def solid(color: tuple[int, int, int], size=(384, 384)) -> Image.Image:
    return Image.new("RGB", size, color)


def text_shot(message: str) -> Image.Image:
    img = Image.new("RGB", (1920, 1080), (250, 250, 250))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 1920, 80], fill=(40, 40, 48))
    for i, line in enumerate(message.split("\n")):
        d.text((60, 200 + i * 60), line, fill=(20, 20, 20))
    return img


# -- the real thing ---------------------------------------------------------

@needs_model
def test_text_and_image_land_in_one_space():
    emb = Embedder("siglip2-base-patch16-224")
    images = [solid((220, 20, 20)), solid((20, 40, 220)), solid((20, 180, 60))]
    vecs = emb.embed_pil(images)

    assert vecs.shape == (3, emb.dim)
    np.testing.assert_allclose(np.linalg.norm(vecs, axis=1), np.ones(3), atol=1e-3)

    q = emb.embed_text("a solid blue image")
    assert q.shape == (emb.dim,)
    assert abs(float(np.linalg.norm(q)) - 1.0) < 1e-3
    assert int(np.argmax(vecs @ q)) == 1, "blue query did not rank the blue image first"

    q_red = emb.embed_text("a solid red image")
    assert int(np.argmax(vecs @ q_red)) == 0


@needs_model
def test_turkish_and_english_queries_agree():
    """The multilingual requirement, checked rather than assumed."""
    emb = Embedder("siglip2-base-patch16-224")
    vecs = emb.embed_pil([solid((220, 20, 20)), solid((20, 40, 220))])

    tr = emb.embed_text("kirmizi bir resim")
    en = emb.embed_text("a red image")
    assert int(np.argmax(vecs @ tr)) == int(np.argmax(vecs @ en)) == 0


@needs_model
def test_batching_is_transparent():
    emb = Embedder("siglip2-base-patch16-224")
    images = [solid((c, 20, 20)) for c in range(0, 250, 50)]
    one_batch = emb.embed_pil(images, batch_size=64)
    many_batches = emb.embed_pil(images, batch_size=2)
    np.testing.assert_allclose(one_batch, many_batches, atol=1e-2)
