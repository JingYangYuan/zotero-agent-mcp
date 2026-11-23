#!/usr/bin/env python3
"""Generate the Zotero-Agent-MCP icon set.

Flat, geometric, legible down to 16px: Zotero-red rounded square with a white "Z"
plus a small agent-node cluster in the corner (the "MCP" hint). Drawn at 8x and
downsampled with LANCZOS so the strokes stay crisp.

Outputs (plugin/icons/):
  icon-96.png, icon-48.png   — add-on list (manifest icons)
  prefs-64.png, prefs-32.png — settings sidebar (PreferencePanes image)
  icon.svg                   — vector source for future edits
"""

from PIL import Image, ImageDraw

OUT = "/Users/yjy/Documents/zotero-agent-mcp/plugin/icons"
RED = (204, 41, 54, 255)        # Zotero accent
RED_DARK = (164, 26, 39, 255)
WHITE = (255, 255, 255, 255)
SS = 8                          # supersample factor


def rounded_mask(size, radius_ratio, ss=SS):
    s = size * ss
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)
    r = int(s * radius_ratio)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    return mask


def draw_icon(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # body
    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=RED)

    # white "Z"
    def P(x, y):
        return (x * s, y * s)

    top = [P(0.235, 0.325), P(0.765, 0.325), P(0.765, 0.425), P(0.235, 0.425)]
    diag = [P(0.655, 0.425), P(0.765, 0.425), P(0.345, 0.575), P(0.235, 0.575)]
    bottom = [P(0.235, 0.575), P(0.765, 0.575), P(0.765, 0.675), P(0.235, 0.675)]
    for poly in (top, diag, bottom):
        d.polygon(poly, fill=WHITE)

    # agent-node cluster (three dots + connector) bottom-right
    if size >= 48:
        rr = 0.052 * s
        d.line([(0.705 * s, 0.795 * s), (0.800 * s, 0.725 * s)], fill=WHITE, width=max(1, int(0.020 * s)))
        for cx, cy in [(0.700, 0.800), (0.800, 0.720), (0.790, 0.875)]:
            x0, y0 = cx * s, cy * s
            d.ellipse([x0 - rr, y0 - rr, x0 + rr, y0 + rr], fill=WHITE)

    # clip to the rounded square and downsample
    mask = rounded_mask(size, 0.22)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def main():
    for size, name in [(96, "icon-96.png"), (48, "icon-48.png"), (64, "prefs-64.png"), (32, "prefs-32.png")]:
        draw_icon(size).save(f"{OUT}/{name}")
        print("wrote", name, size)

    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" rx="21" fill="#cc2936"/>
  <g fill="#ffffff">
    <polygon points="22.6,31.2 73.4,31.2 73.4,40.8 22.6,40.8"/>
    <polygon points="62.9,40.8 73.4,40.8 33.1,55.2 22.6,55.2"/>
    <polygon points="22.6,55.2 73.4,55.2 73.4,64.8 22.6,64.8"/>
    <circle cx="67.8" cy="78.6" r="5.3"/>
    <circle cx="78.6" cy="71.1" r="5.3"/>
    <circle cx="76.5" cy="87.0" r="5.3"/>
  </g>
  <path d="M70 76.8 L76.5 72.6" stroke="#ffffff" stroke-width="2.1"/>
</svg>
"""
    with open(f"{OUT}/icon.svg", "w") as fh:
        fh.write(svg)
    print("wrote icon.svg")


if __name__ == "__main__":
    main()
