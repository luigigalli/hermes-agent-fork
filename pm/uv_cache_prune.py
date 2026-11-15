"""Exact-to-lock pruning for uv caches.

The lock is the contract for anything downstream consumes wholesale: a
shipped bundle payload and a rolling CI cache snapshot both must not carry
wheels the project's uv.lock cannot resolve. Rolling caches accumulate
entries for superseded pins (prefix restores across dependency changes);
pruning to the lock keeps every consumer exact without discarding wheels
the current lock still needs (unlike ``uv cache prune --ci``).
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path


def _normalized(name: str) -> str:
    """PEP 503 name: a ``ruamel.yaml-*.dist-info`` bucket is the lock's ``ruamel-yaml``."""
    return re.sub(r"[-_.]+", "-", name).lower()


def lock_package_names(source_repo: Path) -> set[str]:
    """Dist names the lock can resolve; the exactness contract for a cache."""
    import tomllib

    data = tomllib.loads((source_repo / "uv.lock").read_text(encoding="utf-8"))
    return {_normalized(entry["name"]) for entry in data["package"]}


def _drop_uncontained(entry: Path, cache: Path) -> int:
    """Drop a symlink that can't ever be a cache hit: gone or foreign.

    A shipped or rolled cache must be self-contained: uv keeps its links
    relative inside the cache, so an absolute link text pins a foreign
    directory and a stale target resolves to nothing — both only mean a
    rejected payload downstream. Returns 1 when the link was dropped.
    """
    if not entry.is_symlink():
        return 0
    target = os.readlink(entry)
    inside = Path(target) if os.path.isabs(target) else entry.parent / target
    if not inside.exists() or not inside.resolve().is_relative_to(cache.resolve()):
        entry.unlink()
        return 1
    return 0


def _drop_dangling_links(cache: Path) -> int:
    """Delete wheel and sdist links that can't ever be a cache hit.

    URL, git and named-index entries sit a hash directory deeper than ``pypi``
    and are not pruned by name; their links into ``archive-v0`` must be
    self-contained. A link with no target is never a cache hit, and a payload
    that ships one fails ``publish_prepared``'s link check with "missing or
    escaped prepared path"; an absolute link text pins a foreign directory,
    which the same check refuses as "escaped". ``os.walk`` never follows
    symlinks: directory links (uv's ``wheels-v*/index/<url-hash>/<name>/<version>``
    level is one) ride in ``dirs`` here and file links in ``files``; both go.
    """
    dropped = 0
    for family_dir in (*cache.glob("wheels-v*"), *cache.glob("sdists-v*")):
        for directory, dirs, files in os.walk(family_dir):
            for name in files:
                dropped += _drop_uncontained(Path(directory, name), cache)
            for name in list(dirs):
                dropped += _drop_uncontained(Path(directory, name), cache)
    return dropped


def prune_uv_cache_to_lock(cache: Path, source_repo: Path) -> int:
    """Delete cache entries for dists the lock cannot resolve.

    Unidentifiable buckets (no dist-info) survive — pruning fails open for
    unknown layouts, never for identifiable stale pins. Links left without a
    target go too. Returns the pruned entry count for the build log.
    """
    keep = lock_package_names(source_repo)
    dist_info = re.compile(r"([A-Za-z0-9_.]+?)-\d[^-]*\.dist-info")

    def dist_name(bucket: Path) -> str | None:
        for marker_file in bucket.glob("*.dist-info"):
            match = dist_info.match(marker_file.name)
            if match:
                return _normalized(match.group(1))
        return None

    pruned = 0
    archive = cache / "archive-v0"
    if archive.is_dir():
        for bucket in archive.iterdir():
            if not bucket.is_dir():
                continue
            name = dist_name(bucket)
            if name is not None and name not in keep:
                shutil.rmtree(bucket, ignore_errors=True)
                pruned += 1
    for family_dir in (*cache.glob("wheels-v*/pypi"), *cache.glob("sdists-v*/pypi")):
        if not family_dir.is_dir():
            continue
        for entry in family_dir.iterdir():
            if entry.is_dir() and _normalized(entry.name) not in keep:
                shutil.rmtree(entry, ignore_errors=True)
                pruned += 1
    return pruned + _drop_dangling_links(cache)
