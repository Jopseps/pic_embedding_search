"""Embedding backends: text and images into one shared vector space.

The registry below mirrors `src/lib/catalog.ts` exactly. The four ids must stay
identical in both files — the settings dropdown sends one of them straight to
this module, and a mismatch means the UI selects a model the backend does not
have. Adding a model is one entry here plus one there, never a refactor.

Two invariants:

* **Vectors are L2-normalized before they leave this module.** Cosine then
  reduces to a dot product and the whole search is one matmul.
* **`dim` is stored alongside every vector and vectors are never compared
  across `model_id`.** Different models are different, incompatible spaces.
"""

from __future__ import annotations

import argparse
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

BATCH_SIZE = 32


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    hf_id: str
    dim: int
    multilingual: bool
    # How to drive it: SigLIP/CLIP expose get_*_features, jina exposes encode_*.
    kind: str
    trust_remote_code: bool = False


# Keep in lockstep with src/lib/catalog.ts EMBEDDING_MODELS.
REGISTRY: dict[str, ModelSpec] = {
    "siglip2-so400m-patch14-384": ModelSpec(
        model_id="siglip2-so400m-patch14-384",
        hf_id="google/siglip2-so400m-patch14-384",
        dim=1152,
        multilingual=True,
        kind="siglip",
    ),
    "jina-clip-v2": ModelSpec(
        model_id="jina-clip-v2",
        hf_id="jinaai/jina-clip-v2",
        dim=1024,
        multilingual=True,
        kind="jina",
        trust_remote_code=True,
    ),
    "siglip2-base-patch16-224": ModelSpec(
        model_id="siglip2-base-patch16-224",
        hf_id="google/siglip2-base-patch16-224",
        dim=768,
        multilingual=True,
        kind="siglip",
    ),
    "openclip-vit-l14": ModelSpec(
        model_id="openclip-vit-l14",
        hf_id="laion/CLIP-ViT-L-14-laion2B-s32B-b82K",
        dim=768,
        multilingual=False,
        kind="clip",
    ),
}

DEFAULT_MODEL_ID = "siglip2-base-patch16-224"


def spec_for(model_id: str) -> ModelSpec:
    spec = REGISTRY.get(model_id)
    if(spec is None):
        known = ", ".join(sorted(REGISTRY))
        raise KeyError(f"unknown model_id {model_id!r}; known: {known}")
    return spec


def _features_to_numpy(out: Any) -> np.ndarray:
    """transformers 5 returns BaseModelOutputWithPooling from get_*_features;
    transformers 4 returned a bare tensor. Accept either."""
    tensor = out
    if(not hasattr(tensor, "float")):
        tensor = getattr(out, "pooler_output", None)
        if(tensor is None):
            tensor = out[0]
    return tensor.float().cpu().numpy()


def l2_normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if(x.ndim == 1):
        n = float(np.linalg.norm(x))
        return x if n == 0.0 else (x / n).astype(np.float32)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return (x / norms).astype(np.float32)


def load_pretrained(factory: Any, hf_id: str, **kwargs: Any) -> Any:
    """`factory.from_pretrained`, offline when the files are already cached.

    A cached load still makes HEAD requests to huggingface.co unless told not
    to, which is network I/O in an app that promises none once the weights are
    on disk. So the cache is tried first and the hub only when it has to be:
    first run, or a model the user has just picked and never downloaded. Per
    call, not `HF_HUB_OFFLINE`: that is read at import time and would also
    block that legitimate download.
    """
    try:
        return factory.from_pretrained(hf_id, local_files_only=True, **kwargs)
    except OSError:
        return factory.from_pretrained(hf_id, **kwargs)


# ---------------------------------------------------------------------------
# Embedder
# ---------------------------------------------------------------------------

class Embedder:
    """One resident model. Loads lazily on first use, swaps on `load()`."""

    def __init__(self, model_id: str = DEFAULT_MODEL_ID, device: str | None = None):
        self.spec = spec_for(model_id)
        self._device = device
        self._model: Any = None
        self._processor: Any = None
        self._lock = threading.RLock()

    # -- device -------------------------------------------------------------

    @property
    def device(self) -> str:
        if(self._device is None):
            import torch

            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        return self._device

    @property
    def dtype(self):
        import torch

        return torch.float16 if self.device == "cuda" else torch.float32

    @property
    def model_id(self) -> str:
        return self.spec.model_id

    @property
    def dim(self) -> int:
        return self.spec.dim

    @property
    def loaded(self) -> bool:
        return self._model is not None

    # -- loading ------------------------------------------------------------

    def switch(self, model_id: str) -> None:
        """Point at a different model. The old one is dropped from VRAM."""
        if(model_id == self.spec.model_id):
            return
        with self._lock:
            self.unload()
            self.spec = spec_for(model_id)

    def unload(self) -> None:
        with self._lock:
            self._model = None
            self._processor = None
            try:
                import torch

                if(torch.cuda.is_available()):
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def load(self) -> None:
        if(self._model is not None):
            return
        with self._lock:
            if(self._model is not None):
                return
            import torch
            from transformers import AutoModel, AutoProcessor

            spec = self.spec
            log.info("loading %s (%s) on %s", spec.model_id, spec.hf_id, self.device)

            kwargs: dict[str, Any] = {"trust_remote_code": spec.trust_remote_code}
            model = load_pretrained(AutoModel, spec.hf_id, dtype=self.dtype, **kwargs)
            model = model.to(self.device).eval()

            if(spec.kind == "jina"):
                # jina-clip exposes encode_text/encode_image and tokenizes itself.
                processor = None
            else:
                processor = load_pretrained(
                    AutoProcessor, spec.hf_id, trust_remote_code=spec.trust_remote_code
                )

            self._model = model
            self._processor = processor

            got = self._probe_dim()
            if(got != spec.dim):
                raise RuntimeError(
                    f"{spec.model_id}: registry says dim={spec.dim} but the model emits {got}. "
                    "Fix the entry here and in src/lib/catalog.ts before indexing anything."
                )
            _ = torch  # keep the import meaningful to linters

    def _probe_dim(self) -> int:
        vec = self._embed_text_raw(["dim probe"])
        return int(vec.shape[1])

    # -- text ---------------------------------------------------------------

    def embed_text(self, text: str | Sequence[str]) -> np.ndarray:
        """Returns (dim,) for one string, (N, dim) for a sequence."""
        single = isinstance(text, str)
        items = [text] if single else list(text)
        self.load()
        out = l2_normalize(self._embed_text_raw(items))
        return out[0] if single else out

    def _embed_text_raw(self, items: list[str]) -> np.ndarray:
        import torch

        with torch.inference_mode():
            if(self.spec.kind == "jina"):
                vecs = self._model.encode_text(items, convert_to_numpy=True)
                return np.asarray(vecs, dtype=np.float32)

            if(self.spec.kind == "siglip"):
                # SigLIP was trained with fixed-length padding; "longest" degrades it.
                batch = self._processor(
                    text=items, padding="max_length", max_length=64,
                    truncation=True, return_tensors="pt",
                )
            else:
                batch = self._processor(
                    text=items, padding=True, truncation=True, return_tensors="pt"
                )
            batch = {k: v.to(self.device) for k, v in batch.items()}
            feats = self._model.get_text_features(**batch)
            return _features_to_numpy(feats)

    # -- images -------------------------------------------------------------

    def embed_images(
        self, paths: Sequence[Path | str], batch_size: int = BATCH_SIZE
    ) -> np.ndarray:
        """Decode + embed a list of image paths. Returns (N, dim), L2-normalized."""
        from .imaging import open_image

        images = [open_image(p) for p in paths]
        return self.embed_pil(images, batch_size=batch_size)

    def embed_pil(self, images: Sequence[Any], batch_size: int = BATCH_SIZE) -> np.ndarray:
        import torch

        if(not images):
            return np.zeros((0, self.dim), dtype=np.float32)
        self.load()

        chunks: list[np.ndarray] = []
        with torch.inference_mode():
            for start in range(0, len(images), batch_size):
                batch_imgs = list(images[start:start + batch_size])
                if(self.spec.kind == "jina"):
                    vecs = self._model.encode_image(batch_imgs, convert_to_numpy=True)
                    chunks.append(np.asarray(vecs, dtype=np.float32))
                    continue
                batch = self._processor(images=batch_imgs, return_tensors="pt")
                pixel_values = batch["pixel_values"].to(self.device, dtype=self.dtype)
                feats = self._model.get_image_features(pixel_values=pixel_values)
                chunks.append(_features_to_numpy(feats))

        return l2_normalize(np.concatenate(chunks, axis=0))


_ACTIVE: Embedder | None = None
_ACTIVE_LOCK = threading.Lock()


def active_embedder(model_id: str | None = None) -> Embedder:
    """Process-wide single resident model. 8 GB of VRAM does not hold two."""
    global _ACTIVE
    with _ACTIVE_LOCK:
        if(_ACTIVE is None):
            _ACTIVE = Embedder(model_id or DEFAULT_MODEL_ID)
        elif(model_id is not None):
            _ACTIVE.switch(model_id)
        return _ACTIVE


# ---------------------------------------------------------------------------
# CLI smoke test — build step 2's acceptance check
# ---------------------------------------------------------------------------

def _main() -> int:
    parser = argparse.ArgumentParser(description="Rank images against a text query.")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--query", "-q", default="a photo of a table")
    parser.add_argument("--model", "-m", default="siglip2-base-patch16-224")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    emb = Embedder(args.model)
    img_vecs = emb.embed_images(args.images)
    q_vec = emb.embed_text(args.query)
    scores = img_vecs @ q_vec

    print(f"\nmodel: {emb.model_id}  device: {emb.device}  dim: {emb.dim}")
    print(f"query: {args.query!r}\n")
    for rank, i in enumerate(np.argsort(-scores), start=1):
        print(f"  {rank}. {scores[i]:+.4f}  {args.images[i]}")
    return 0


if(__name__ == "__main__"):
    raise SystemExit(_main())
