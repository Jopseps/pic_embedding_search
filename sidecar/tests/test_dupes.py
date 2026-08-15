"""Near-duplicate clustering.

Most of these drive `cluster()` on hand-built hashes rather than on images:
what a pHash does to a given picture is `imaging.py`'s problem, and mixing the
two makes a failure ambiguous. The two that do touch a store cover the caching
contract, which is the part with a real chance of going quietly wrong.
"""

import random

import pytest

from picsearch.dupes import DEFAULT_THRESHOLD, BkTree, DupeIndex, cluster
from picsearch.store import hamming64, phash_to_db


def bits(*positions: int) -> int:
    """A 64-bit hash with exactly these bits set."""
    out = 0
    for p in positions:
        out |= 1 << p
    return out


def rows(*pairs):
    """(image_id, phash) -> full rows, each with its own sha256."""
    return [(i, h, f"sha{i}") for i, h in pairs]


# ---------------------------------------------------------------------------
# BK-tree
# ---------------------------------------------------------------------------

def test_the_tree_finds_every_neighbour_a_brute_force_scan_would():
    rng = random.Random(1234)
    values = list({rng.getrandbits(64) for _ in range(400)})
    tree = BkTree(values)
    for _ in range(40):
        probe = rng.choice(values) ^ bits(*rng.sample(range(64), 6))
        for radius in (0, 4, 10, 20):
            assert sorted(tree.query(probe, radius)) == sorted(
                v for v in values if hamming64(v, probe) <= radius
            )


def test_equal_hashes_collapse_to_one_node():
    tree = BkTree([7, 7, 7])
    assert len(tree) == 1


def test_an_empty_tree_answers_nothing():
    assert BkTree().query(0, 64) == []


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def test_identical_hashes_group():
    groups = cluster(rows((1, 0xABCD), (2, 0xABCD), (3, 0x1234)))
    assert groups == [[1, 2]]


def test_hashes_further_apart_than_the_threshold_do_not_group():
    far = bits(*range(DEFAULT_THRESHOLD + 1))
    assert cluster(rows((1, 0), (2, far))) == []


def test_hashes_exactly_at_the_threshold_group():
    at = bits(*range(DEFAULT_THRESHOLD))
    assert cluster(rows((1, 0), (2, at))) == [[1, 2]]


def test_a_chain_does_not_become_one_group():
    """The bug this whole module is shaped around.

    A is 10 from B and B is 10 from C, but A is 20 from C. Plain union-find
    calls all three one duplicate group; measured on a real library that turned
    thirteen distinct sprites into a single "duplicate" set whose furthest pair
    was 22 apart.
    """
    a = 0
    b = bits(*range(10))
    c = bits(*range(20))
    assert hamming64(a, c) == 20
    groups = cluster(rows((1, a), (2, b), (3, c)))
    assert [1, 2, 3] not in groups
    assert sum(len(g) for g in groups) <= 2


def test_no_group_exceeds_the_threshold():
    """The invariant complete linkage buys: every pair inside a group is within
    the threshold. Single linkage cannot promise this."""
    rng = random.Random(99)
    # Deliberately clustered: a few seeds, each with near neighbours, so the
    # chains that break single linkage actually occur.
    data = []
    image_id = 1
    for _ in range(12):
        seed = rng.getrandbits(64)
        for _ in range(rng.randint(1, 6)):
            flip = bits(*rng.sample(range(64), rng.randint(0, 14)))
            data.append((image_id, seed ^ flip))
            image_id += 1
    by_id = dict(data)
    for group in cluster(rows(*data)):
        for x in group:
            for y in group:
                assert hamming64(by_id[x], by_id[y]) <= DEFAULT_THRESHOLD


def test_byte_identical_files_always_group():
    """Equal bytes hash equally, so this is already true — asserting it means it
    cannot quietly stop being true."""
    far = bits(*range(40))
    groups = cluster([(1, 0, "same"), (2, far, "same")])
    assert groups == [[1, 2]]


def test_the_signed_database_form_gives_the_same_answer():
    """`phash` is wrapped to signed on write. A hash that lost its top bit on
    the way in would silently be 1 bit away from where it belongs."""
    high = 0xFFFF_FFFF_FFFF_FFFF
    assert phash_to_db(high) < 0
    assert cluster([(1, phash_to_db(high), "a"), (2, phash_to_db(high), "b")]) == [[1, 2]]


def test_groups_come_back_largest_first_and_sorted():
    far = bits(*range(30))
    groups = cluster(rows((5, 1), (3, 1), (9, 1), (2, far), (1, far)))
    assert groups == [[3, 5, 9], [1, 2]]


def test_a_lone_image_is_not_a_group():
    assert cluster(rows((1, 12345))) == []


def test_no_images_is_not_an_error():
    assert cluster([]) == []


def test_clustering_is_deterministic():
    """Complete linkage is order-dependent, so the edge order is sorted. A
    duplicate group that moved between two runs over one library would be a
    genuinely maddening bug."""
    rng = random.Random(7)
    data = []
    for i in range(60):
        seed = rng.getrandbits(64) if i % 5 == 0 else data[-1][1]
        data.append((i + 1, seed ^ bits(*rng.sample(range(64), rng.randint(0, 8)))))
    first = cluster(rows(*data))
    for _ in range(3):
        shuffled = data[:]
        rng.shuffle(shuffled)
        assert cluster(rows(*shuffled)) == first


# ---------------------------------------------------------------------------
# The cached view
# ---------------------------------------------------------------------------

def add_image(store, path, phash_value, sha):
    return store.upsert_image(
        path=path, mtime=1.0, size_bytes=10, width=4, height=4, mime="image/png",
        phash=phash_value, sha256=sha, taken_at=None, is_screenshot=False,
    )


def test_the_index_sees_images_added_after_it_was_built(store):
    index = DupeIndex(store)
    first = add_image(store, "/lib/a.png", 0xAAAA, "sha-a")
    assert index.ids == frozenset()

    second = add_image(store, "/lib/b.png", 0xAAAA, "sha-b")
    assert index.ids == frozenset({first, second})


def test_the_index_sees_a_deletion(store):
    a = add_image(store, "/lib/a.png", 0xAAAA, "sha-a")
    b = add_image(store, "/lib/b.png", 0xAAAA, "sha-b")
    index = DupeIndex(store)
    assert index.ids == frozenset({a, b})

    store.delete_images([b])
    assert index.ids == frozenset()


def test_a_rename_does_not_invalidate_the_index(store):
    """A rename changes a path, never a pixel. Rebuilding an O(N) clustering
    pass for it would put that cost on the watcher's hot path for nothing."""
    add_image(store, "/lib/a.png", 0xAAAA, "sha-a")
    add_image(store, "/lib/b.png", 0xAAAA, "sha-b")
    index = DupeIndex(store)
    assert len(index.ids) == 2
    before = store.pixel_epoch

    store.move_image("/lib/b.png", "/lib/renamed.png")
    assert store.pixel_epoch == before


def test_overwriting_a_different_image_by_rename_does_invalidate(store):
    """The other half: a move that lands on an existing row destroys that row,
    and the image it counted as a duplicate of is no longer one."""
    a = add_image(store, "/lib/a.png", 0xAAAA, "sha-a")
    add_image(store, "/lib/b.png", 0xAAAA, "sha-b")
    add_image(store, "/lib/c.png", 0x5555_0000, "sha-c")
    index = DupeIndex(store)
    assert index.ids == frozenset({a, store.image_by_path("/lib/b.png")["id"]})

    store.move_image("/lib/c.png", "/lib/b.png")
    assert index.ids == frozenset()


def test_the_index_does_not_rebuild_while_nothing_changes(store, monkeypatch):
    add_image(store, "/lib/a.png", 0xAAAA, "sha-a")
    add_image(store, "/lib/b.png", 0xAAAA, "sha-b")
    index = DupeIndex(store)

    builds = []
    real = cluster

    def counting(*args, **kwargs):
        builds.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr("picsearch.dupes.cluster", counting)
    for _ in range(5):
        assert len(index.ids) == 2
    assert len(builds) == 1


@pytest.mark.parametrize("threshold", [0, 4, 10, 30])
def test_the_threshold_is_configurable(store, threshold):
    add_image(store, "/lib/a.png", 0, "sha-a")
    add_image(store, "/lib/b.png", bits(*range(8)), "sha-b")
    index = DupeIndex(store, threshold=threshold)
    assert bool(index.ids) is (threshold >= 8)
