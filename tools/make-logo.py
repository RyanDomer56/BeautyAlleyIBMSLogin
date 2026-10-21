"""
Turn the supplied logo raster into clean, transparent brand assets.

The source is a lossy JPEG of a dark-green seal on white. We:
  1. find the bounding box of the artwork and crop to it,
  2. rebuild alpha from luminance (white -> transparent),
  3. recolour the artwork to the brand emerald and to warm ivory,
  4. write both as PNGs into public/brand/.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageOps

SRC = Path(
    r"C:\Users\arnel api\.workbuddy-ai\clipboard-images"
    r"\clipboard-2026-10-09T06-14-39-141Z-d094be4f.jpg"
)
OUT = Path(r"C:\Users\arnel api\WorkBuddy AI\TheBeautyAlley\public\brand")
OUT.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert("RGB")
print("source:", img.size, img.mode)

# --- 1. crop to the artwork ------------------------------------------------
gray = ImageOps.grayscale(img)
# Anything meaningfully darker than paper counts as ink.
mask = gray.point(lambda v: 255 if v < 232 else 0)
bbox = mask.getbbox()
print("bbox:", bbox)
img = img.crop(bbox)
gray = gray.crop(bbox)

# Pad to a square so the seal never looks squashed.
w, h = img.size
side = max(w, h)
pad = int(side * 0.06)
canvas = Image.new("RGB", (side + pad * 2, side + pad * 2), (255, 255, 255))
canvas.paste(img, ((side + pad * 2 - w) // 2, (side + pad * 2 - h) // 2))
gray_canvas = ImageOps.grayscale(canvas)

# --- 2. alpha from darkness ------------------------------------------------
# White paper -> 0, ink -> 1, with a gentle knee so JPEG haloes stay faint.
DARK, LIGHT = 70.0, 236.0
lut = []
for v in range(256):
    t = (LIGHT - v) / (LIGHT - DARK)
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    t = t ** 1.35  # push mid greys down: crisper line art
    lut.append(int(round(t * 255)))
alpha = gray_canvas.point(lut)

# --- 3. recolour ------------------------------------------------------------
def recolour(rgb):
    layer = Image.new("RGB", canvas.size, rgb)
    out = layer.convert("RGBA")
    out.putalpha(alpha)
    return out


emerald = recolour((27, 77, 62))    # #1B4D3E
ivory = recolour((246, 243, 234))   # warm ivory, for dark surfaces

emerald.save(OUT / "logo-emerald.png")
ivory.save(OUT / "logo-ivory.png")

# A favicon-sized square of the emerald mark.
emerald.resize((256, 256), Image.LANCZOS).save(OUT / "logo-mark.png")

print("wrote:", emerald.size)
for f in sorted(OUT.iterdir()):
    print(" ", f.name, f.stat().st_size, "bytes")
