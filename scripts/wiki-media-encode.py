#!/usr/bin/env python3
"""Pinned Pillow encoder for the reproducible wiki media generator.

The TypeScript generator supplies already-rendered PNG frames. Keeping the GIF
step in a tiny, version-checked script avoids a dependency on ffmpeg and makes
the encoder part of the reviewable asset pipeline.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import PIL
from PIL import Image

EXPECTED_PILLOW = "12.3.0"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("frames", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fps", type=int, default=10)
    args = parser.parse_args()

    if PIL.__version__ != EXPECTED_PILLOW:
        raise SystemExit(
            f"wiki-media requires Pillow {EXPECTED_PILLOW}; found {PIL.__version__}"
        )
    if args.fps <= 0:
        raise SystemExit("--fps must be positive")

    frame_paths = sorted(args.frames.glob("frame-*.png"))
    if not frame_paths:
        raise SystemExit(f"no PNG frames found in {args.frames}")

    with Image.open(frame_paths[0]) as first:
        frames = [first.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)]
        width, height = first.size
        for path in frame_paths[1:]:
            with Image.open(path) as frame:
                if frame.size != (width, height):
                    raise SystemExit(f"frame size mismatch: {path}")
                frames.append(frame.convert("P", palette=Image.Palette.ADAPTIVE, colors=256))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=round(1000 / args.fps),
        loop=0,
        disposal=2,
        optimize=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
