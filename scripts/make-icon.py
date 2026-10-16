"""Generate the console application icon as PNG files.

Pure standard library on purpose: this runs on a bare Python 3.12 with no Pillow
installed, and an icon build step must not add a dependency to the project.
Writes RGBA PNGs at every size electron-builder may ask for.

The mark is a backpack: a handle, a lid band, a body with a shoulder-strap line,
and a front pocket. Colours are chosen so each part stays distinguishable at
16 px, where the pocket and strap read as two darker bands rather than as detail.

Usage: python scripts/make-icon.py <output-directory>
"""

import struct
import sys
import zlib
from pathlib import Path

TILE_A = (0x1E, 0x27, 0x33, 255)
TILE_B = (0x12, 0x18, 0x20, 255)
HANDLE = (0x38, 0xA8, 0x8A, 255)
BODY = (0x4E, 0xC5, 0xA3, 255)
BODY_DARK = (0x3F, 0xAE, 0x8E, 255)
LID = (0x2F, 0x8F, 0x76, 255)
STRAP = (0x25, 0x74, 0x60, 255)
POCKET = (0x1C, 0x5F, 0x4E, 255)
CLEAR = (0, 0, 0, 0)

# Geometry in 0..1 space, shared by every size so the mark scales as one drawing.
TILE_R = 0.22
HANDLE_OUT = 0.170
HANDLE_IN = 0.100
HANDLE_CX = 0.500
HANDLE_CY = 0.360
BODY_L, BODY_T, BODY_R, BODY_B = 0.245, 0.335, 0.755, 0.885
BODY_RADIUS = 0.075
LID_L, LID_T, LID_R, LID_B = 0.235, 0.345, 0.765, 0.470
STRAP_T, STRAP_B = 0.470, 0.530
POCKET_L, POCKET_T, POCKET_R, POCKET_B = 0.335, 0.590, 0.665, 0.805
POCKET_RADIUS = 0.045


def png_bytes(width, height, rows):
    """Encode RGBA pixel rows as a PNG. Each row is a bytes object of RGBA."""
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def in_rounded_rect(x, y, left, top, right, bottom, radius):
    if not (left <= x <= right and top <= y <= bottom):
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def tile(x, y):
    """The rounded background tile, with a diagonal wash for depth."""
    if not in_rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, TILE_R):
        return None
    t = (x + y) / 2.0
    if t < 0.35:
        return TILE_A
    if t < 0.75:
        return tuple(
            int(TILE_A[i] + (TILE_B[i] - TILE_A[i]) * (t - 0.35) / 0.40) for i in range(4)
        )
    return TILE_B


def backpack(x, y):
    """Colour for the backpack, or None to keep the tile underneath.

    Ordered front to back. The parts sit inside the body's rectangle, so testing
    the body first would swallow every one of them — the pocket in particular is
    entirely within it, and that mistake silently produced a plain green block.
    """
    # Handle: a ring segment above the body.
    dx = x - HANDLE_CX
    dy = y - HANDLE_CY
    d = (dx * dx + dy * dy) ** 0.5
    if y <= BODY_T + 0.02 and HANDLE_IN <= d <= HANDLE_OUT:
        return HANDLE
    # Front pocket — drawn before the body because it sits on top of it.
    if in_rounded_rect(x, y, POCKET_L, POCKET_T, POCKET_R, POCKET_B, POCKET_RADIUS):
        return POCKET
    # Lid band: the top of the body, also inside the body's rectangle.
    if in_rounded_rect(x, y, LID_L, LID_T, LID_R, LID_B, BODY_RADIUS):
        return LID
    # Body.
    if in_rounded_rect(x, y, BODY_L, BODY_T, BODY_R, BODY_B, BODY_RADIUS):
        # Recessed band across the middle, read as the zip or strap line.
        if STRAP_T <= y <= STRAP_B:
            return STRAP
        return BODY
    return None


def sample(x, y):
    """Composite the drawing at one point; returns an RGBA tuple or None."""
    base = tile(x, y)
    if base is None:
        return None
    drawn = backpack(x, y)
    return drawn if drawn is not None else base


def render(size):
    """One size, supersampled 4x for smooth edges."""
    ss = 4
    n = size * ss
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    fx = (px * ss + sx + 0.5) / n
                    fy = (py * ss + sy + 0.5) / n
                    colour = sample(fx, fy)
                    if colour is None:
                        continue
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
                    a += colour[3]
            total = ss * ss
            if a == 0:
                row += bytes(CLEAR)
            else:
                covered = a // 255
                # Average only over covered subpixels, so the anti-aliased rim does
                # not darken towards transparent black.
                row += bytes((r // covered, g // covered, b // covered, min(255, a // total)))
        rows.append(bytes(row))
    return png_bytes(size, size, rows)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "console/assets")
    out.mkdir(parents=True, exist_ok=True)
    for size in (256, 512, 1024):
        target = out / f"icon-{size}.png"
        target.write_bytes(render(size))
        print(f"icon: {target} ({target.stat().st_size} bytes)")
    # electron-builder looks for a single `icon.png` beside the build config.
    main_png = out / "icon.png"
    main_png.write_bytes(render(1024))
    print(f"icon: {main_png} ({main_png.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
