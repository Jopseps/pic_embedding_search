"""Near-duplicate clustering by perceptual hash.

**This, not cosine, is the duplicate detector.** SigLIP puts two entirely
different screenshots of the same IDE at ~0.97, so a cosine threshold would
call half a screenshot folder duplicated. Only pixel structure can tell "the
same image twice" from "the same application twice". Cosine's correct use is
`Searcher.similar`, which answers a different question.

Two decisions here were measured on a real 298-image library rather than
guessed, and both look like implementation details until they are wrong.

**Grouping is complete linkage, not connected components.** Plain union-find at
Hamming <= 10 chained thirteen distinct Krita sprites into one "duplicate"
group whose furthest pair was 22 apart — A within 10 of B and B within 10 of C
says nothing about A and C. Complete linkage merges two groups only when
*every* cross pair is within the threshold, which turns the group into a
statement that can be checked: **no two images in a group are further apart
than `threshold`** (`test_no_group_exceeds_the_threshold`). On that library it
turned the 13-image chain into a group of 8 and left every real duplicate —
the `-1.png` re-download pairs, bursts of screenshots seconds apart — intact.

**A popcount guard would do nothing.** The obvious defence against flat images
hashing alike is to skip hashes with too few or too many bits set. This pHash
sets a bit per DCT coefficient above the *median*, so every hash has exactly 32
bits set by construction. Measured across the library: 297 of 298 images at
popcount 32. There is no signal there.

Byte-identical files are always grouped. That follows from the hash — identical
pixels hash identically — but a final pass over `sha256` states it outright
rather than leaving it to be derived, because "the same file twice is a
duplicate" is the one case a user will never accept being wrong.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Sequence

from .store import Store, hamming64, phash_from_db

log = logging.getLogger(__name__)

# Hamming distance at which two 64-bit pHashes are "the same image".
# Measured: 10 keeps the real duplicates and, under complete linkage, bounds the
# worst pair inside any group at exactly 10.
DEFAULT_THRESHOLD = 10


# ---------------------------------------------------------------------------
# BK-tree
# ---------------------------------------------------------------------------

class BkTree:
    """Metric tree over 64-bit hashes.

    Hamming distance obeys the triangle inequality, so a node at distance `d`
    from the query can only have matches within `radius` down edges labelled
    `d - radius .. d + radius`. Every other subtree is skipped without being
    compared, which is what keeps this from being the O(N^2) scan it replaces.
    """

    def __init__(self, values: Iterable[int] = ()):
        self._root: int | None = None
        self._kids: dict[int, dict[int, int]] = {}
        for v in values:
            self.add(v)

    def __len__(self) -> int:
        return len(self._kids)

    def add(self, value: int) -> None:
        """Equal values collapse — callers group images by hash first, so a
        repeated hash is not new information."""
        if(self._root is None):
            self._root = value
            self._kids[value] = {}
            return
        node = self._root
        while True:
            d = hamming64(node, value)
            if(d == 0):
                return
            nxt = self._kids[node].get(d)
            if(nxt is None):
                self._kids[node][d] = value
                self._kids[value] = {}
                return
            node = nxt

    def query(self, value: int, radius: int) -> list[int]:
        """Every stored value within `radius` of `value`, including itself."""
        if(self._root is None):
            return []
        out: list[int] = []
        stack = [self._root]
        while stack:
            node = stack.pop()
            d = hamming64(node, value)
            if(d <= radius):
                out.append(node)
            lo, hi = d - radius, d + radius
            for edge, child in self._kids[node].items():
                if(lo <= edge <= hi):
                    stack.append(child)
        return out


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster(
    rows: Sequence[tuple[int, int, str]], threshold: int = DEFAULT_THRESHOLD
) -> list[list[int]]:
    """Group `(image_id, phash, sha256)` rows into near-duplicate sets.

    Returns only groups of two or more, largest first, ids ascending inside
    each. `phash` may arrive in either the signed database form or the unsigned
    one — `hamming64` masks, so both give the same distance.
    """
    by_hash: dict[int, list[int]] = {}
    by_sha: dict[str, list[int]] = {}
    hash_of: dict[int, int] = {}
    for image_id, raw_hash, sha in rows:
        h = phash_from_db(int(raw_hash))
        by_hash.setdefault(h, []).append(int(image_id))
        by_sha.setdefault(sha, []).append(int(image_id))
        hash_of[int(image_id)] = h
    if(not by_hash):
        return []

    hashes = sorted(by_hash)
    tree = BkTree(hashes)

    # Candidate pairs, shortest first. Sorting by (distance, a, b) makes the
    # agglomeration deterministic — complete linkage is order-dependent, and a
    # duplicate group that changes between two runs over the same library would
    # be a genuinely maddening bug.
    edges: list[tuple[int, int, int]] = []
    for h in hashes:
        for other in tree.query(h, threshold):
            if(other > h):
                edges.append((hamming64(h, other), h, other))
    edges.sort()

    members: dict[int, list[int]] = {h: [h] for h in hashes}
    root: dict[int, int] = {h: h for h in hashes}

    for _distance, a, b in edges:
        ra, rb = root[a], root[b]
        if(ra == rb):
            continue
        left, right = members[ra], members[rb]
        # The complete-linkage test. Groups stay tiny, so the quadratic check
        # costs nothing next to the distances already computed.
        if(not all(hamming64(x, y) <= threshold for x in left for y in right)):
            continue
        left.extend(right)
        for h in right:
            root[h] = ra
        del members[rb]

    # Byte-identical files, unconditionally. Equal bytes hash equally, so this
    # is already true above; asserting it here means it cannot quietly stop
    # being true.
    for ids in by_sha.values():
        if(len(ids) < 2):
            continue
        seed = root[hash_of[ids[0]]]
        for image_id in ids[1:]:
            other = root[hash_of[image_id]]
            if(other == seed):
                continue
            members[seed].extend(members[other])
            for h in members[other]:
                root[h] = seed
            del members[other]

    groups: list[list[int]] = []
    for hs in members.values():
        ids = sorted(image_id for h in hs for image_id in by_hash[h])
        if(len(ids) > 1):
            groups.append(ids)
    groups.sort(key=lambda g: (-len(g), g[0]))
    return groups


# ---------------------------------------------------------------------------
# Cached view over the store
# ---------------------------------------------------------------------------

class DupeIndex:
    """Near-duplicate membership, cached across requests.

    `search.hydrate` sets `isDupe` on every item of every response, so this
    cannot rebuild per request — a rebuild is O(N) over the library and the
    search path is 5-17 ms. It rebuilds when `Store.pixel_epoch` moves, which
    happens when an image is added, re-ingested or deleted. **A rename does not
    move it**: the pixels did not change, so neither did any hash.
    """

    def __init__(self, store: Store, threshold: int = DEFAULT_THRESHOLD):
        self.store = store
        self.threshold = threshold
        self._epoch = -1
        self._ids: frozenset[int] = frozenset()
        self._groups: list[list[int]] = []
        self._lock = threading.Lock()

    def _refresh(self) -> None:
        # Captured *before* the query: a write that lands mid-build leaves the
        # stored epoch behind, so the next caller rebuilds rather than caching a
        # result that silently missed it.
        epoch = self.store.pixel_epoch
        if(epoch == self._epoch):
            return
        with self._lock:
            if(epoch == self._epoch):
                return
            rows = [
                (int(r["id"]), int(r["phash"]), r["sha256"])
                for r in self.store.conn().execute("SELECT id, phash, sha256 FROM images")
            ]
            groups = cluster(rows, self.threshold)
            self._groups = groups
            self._ids = frozenset(i for g in groups for i in g)
            self._epoch = epoch
            log.debug("dupe index: %d groups, %d images", len(groups), len(self._ids))

    @property
    def ids(self) -> frozenset[int]:
        """Images belonging to a group of two or more."""
        self._refresh()
        return self._ids

    @property
    def groups(self) -> list[list[int]]:
        self._refresh()
        return self._groups
