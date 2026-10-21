from PIL import Image, ImageDraw

VOLT = (217, 255, 61)
BG = (14, 14, 16)
WHITE = (242, 242, 245)


def draw_icon(size, pad_ratio, path):
    img = Image.new("RGBA", (size, size), BG + (255,))
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2

    # clock face
    r = size * pad_ratio
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=VOLT, width=max(4, size // 32))

    # minute hand (up)
    d.line([cx, cy, cx, cy - r * 0.62], fill=WHITE, width=max(4, size // 36))
    # second hand (down-right)
    d.line([cx, cy, cx + r * 0.42, cy + r * 0.34], fill=VOLT, width=max(3, size // 48))
    d.ellipse([cx - size * 0.028, cy - size * 0.028, cx + size * 0.028, cy + size * 0.028], fill=VOLT)

    # crown button
    bw = size * 0.07
    d.rounded_rectangle([cx - bw / 2, cy - r - size * 0.085, cx + bw / 2, cy - r + size * 0.02],
                        radius=bw / 3, fill=VOLT)
    img.save(path)


import os
os.makedirs("icons", exist_ok=True)
draw_icon(192, 0.36, "icons/icon-192.png")
draw_icon(512, 0.36, "icons/icon-512.png")
draw_icon(512, 0.30, "icons/icon-512-maskable.png")
print("icons ok")
