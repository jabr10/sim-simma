"""
Publish pipeline output to Cloudflare using Wrangler.

  JSON files -> Workers KV  (key = {DATA_VERSION}/{relative path})
  SQL files  -> D1  (wrangler d1 execute --remote --file ...)

Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment
when run in CI. Run from the repo root so Wrangler finds wrangler.jsonc.

Usage:
  python pipeline/publish.py --data build/data
  python pipeline/publish.py --data build/data --dry-run
  python pipeline/publish.py --data build/data --local   # seeds wrangler dev storage
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402


def log(msg: str) -> None:
    print(f"[publish] {msg}", flush=True)


def wrangler_cmd() -> list[str]:
    if shutil.which("wrangler"):
        return ["wrangler"]
    return ["npx", "--yes", "wrangler@4"]


def run(cmd: list[str], dry_run: bool, retries: int = 2) -> None:
    printable = " ".join(cmd)
    if dry_run:
        log(f"DRY RUN: {printable}")
        return
    for attempt in range(retries + 1):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return
        log(f"attempt {attempt + 1} failed: {printable}\n{result.stdout[-800:]}\n{result.stderr[-800:]}")
    raise RuntimeError(f"Command failed after {retries + 1} attempts: {printable}")


def upload_json(base: list[str], data_dir: Path, path: Path, dry_run: bool, target: str) -> str:
    rel = path.relative_to(data_dir).as_posix()
    key = f"{C.DATA_VERSION}/{rel}"
    # Binding name DATA matches wrangler.jsonc kv_namespaces.binding
    cmd = base + [
        "kv", "key", "put", key,
        "--binding", "DATA",
        "--path", str(path),
        target,
    ]
    run(cmd, dry_run)
    return key


def main() -> None:
    ap = argparse.ArgumentParser(description="Publish Sim Simma data to Cloudflare")
    ap.add_argument("--data", default="build/data")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=4, help="Parallel uploads")
    ap.add_argument("--local", action="store_true", help="Write to local wrangler dev storage instead of Cloudflare")
    args = ap.parse_args()

    data_dir = Path(args.data)
    if not data_dir.exists():
        sys.exit(f"Data directory not found: {data_dir}")

    base = wrangler_cmd()
    target = "--local" if args.local else "--remote"
    if args.local:
        # Local storage starts empty, so create the tables first. Workers run
        # one at a time locally to avoid SQLite/KV file locking.
        args.workers = 1
        log("applying D1 migrations to local storage")
        run(base + ["d1", "migrations", "apply", C.D1_DATABASE, "--local"], args.dry_run)
    json_files = sorted(p for p in data_dir.rglob("*.json"))
    # Upload meta.json last so the app never points at files that are not there yet.
    meta = [p for p in json_files if p.name == "meta.json" and p.parent == data_dir]
    body = [p for p in json_files if p not in meta]

    log(f"uploading {len(json_files)} JSON files to kv://{C.KV_NAMESPACE}/{C.DATA_VERSION}/ ({target})")
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(upload_json, base, data_dir, p, args.dry_run, target) for p in body]
        for f in as_completed(futures):
            log(f"  ok {f.result()}")
    for p in meta:
        log(f"  ok {upload_json(base, data_dir, p, args.dry_run, target)}")

    sql_files = sorted((data_dir / "d1").glob("*.sql"))
    for sql in sql_files:
        log(f"executing {sql.name} on D1 {C.D1_DATABASE}")
        run(base + ["d1", "execute", C.D1_DATABASE, target, "--file", str(sql), "--yes"], args.dry_run)

    log("publish complete")


if __name__ == "__main__":
    main()
