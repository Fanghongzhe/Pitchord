"""Rebuild the Windows icon from the same simple waveform as public/favicon.svg."""

from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
size = 256
scale = size / 48
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(12 * scale), fill="#1b2431")
points = [(8, 24), (13, 24), (16, 24), (16, 16), (16, 32),
          (16, 24), (21, 24), (21, 9), (21, 39), (21, 24),
          (26, 24), (26, 19), (26, 29), (26, 24), (31, 24),
          (31, 13), (31, 35), (31, 24), (36, 24), (36, 21),
          (36, 27), (40, 27)]
for start, end in [((8, 24), (13, 24)), ((16, 16), (16, 32)),
                   ((21, 9), (21, 39)), ((26, 19), (26, 29)),
                   ((31, 13), (31, 35)), ((36, 21), (36, 27)),
                   ((36, 24), (40, 24))]:
    xy = tuple(round(value * scale) for point in (start, end) for value in point)
    draw.line(xy, fill="#6aa9f4", width=round(3 * scale), joint="curve")
    for point in (start, end):
        x, y = (round(value * scale) for value in point)
        radius = round(1.5 * scale)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="#6aa9f4")

target = root / "assets" / "icon.ico"
target.parent.mkdir(exist_ok=True)
image.save(target, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(target)
