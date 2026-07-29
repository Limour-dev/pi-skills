#!/usr/bin/env python3
"""verify_links.py — check internal markdown links and image references.

Usage:
  python3 verify_links.py PATH [PATH...]

PATH may be a single paper directory or a collection parent; every *.md under
each PATH is checked recursively. Link targets are resolved relative to the
file containing them. Prints broken links and unreferenced images.
Exit codes: 0 = no broken links, 1 = broken links found, 2 = usage error.
"""
import os
import re
import sys

IMG_EXTS = ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg')
LINK_RE = re.compile(r'\]\(([^)]+)\)')
SCHEME_RE = re.compile(r'^[a-z][a-z0-9+.-]*://', re.I)


def iter_files(root, exts):
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith(exts):
                yield os.path.join(dirpath, fn)


def check_root(root):
    broken = []
    md_count = 0
    referenced = set()
    for md in iter_files(root, ('.md',)):
        md_count += 1
        base = os.path.dirname(md)
        with open(md, encoding='utf-8') as fh:
            text = fh.read()
        for raw in LINK_RE.findall(text):
            target = raw.split(' "', 1)[0].strip().strip('<>')
            if SCHEME_RE.match(target) or target.startswith(('mailto:', '#')):
                continue
            path = target.split('#')[0]
            if not path:
                continue
            tgt = os.path.normpath(os.path.join(base, path))
            referenced.add(tgt)
            if not os.path.exists(tgt):
                broken.append((os.path.relpath(md, root), target))
    unref = []
    for img in iter_files(root, IMG_EXTS):
        if os.path.normpath(img) not in referenced:
            unref.append(os.path.relpath(img, root))
    return md_count, broken, unref


def main(paths):
    total_md = 0
    total_broken = 0
    for root in paths:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            print(f"skip (not a directory): {root}", file=sys.stderr)
            continue
        md_count, broken, unref = check_root(root)
        total_md += md_count
        total_broken += len(broken)
        print(f"=== {root} ===")
        print(f"MD files checked: {md_count}")
        if broken:
            print(f"BROKEN LINKS: {len(broken)}")
            for src, tgt in broken:
                print(f"  {src} -> {tgt}")
        else:
            print("All internal links OK")
        if unref:
            print(f"Unreferenced images: {len(unref)} (informational)")
            for u in unref:
                print(f"  {u}")
        print()
    print(f"TOTAL: {total_md} MD files, {total_broken} broken links")
    return 1 if total_broken else 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1:]))
