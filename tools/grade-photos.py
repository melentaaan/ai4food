"""
Re-grade the catalogue photography.

The set shipped as fifteen stock frames shot by different people under
different lights: some cold, some flat, all softly compressed. Individually
they are passable; side by side in one feed they read as clip art. A single
grade — one white balance, one contrast curve, one level of bite — is what
makes a mixed set look art-directed rather than assembled.

Nothing here invents detail. It crops, balances and sharpens what is there.

Usage:

    python3 tools/grade-photos.py photos/ > blob.js

Every JPEG/PNG/WebP in the folder becomes one entry keyed by its filename, so
replacing a shop's photo means dropping a file in and re-running. The output is
the `const P = {...}` block the app carries inline; paste it over the existing
one in ai4food-app.html. Needs Pillow.
"""
import io, os, sys, base64, glob
from PIL import Image, ImageEnhance, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else 'photos'
OUT = os.environ.get('GRADED_DIR')       # optional: also keep the graded files

W, H = 744, 558          # 4:3, ~1.2x the 392pt hero so retina has something to eat

# Per-photo framing: (focal_x, focal_y) in 0..1, and how tight to crop (1 = full
# frame). Chosen by eye — several of the originals put the subject off-centre or
# cut it. A file with no entry here is simply centred.
FRAME = {
    'accara':    (0.50, 0.55, 0.94),
    'buffet':    (0.50, 0.50, 0.96),
    'crevettes': (0.48, 0.52, 0.92),
    'cupcakes':  (0.52, 0.55, 0.88),   # tighter: the empty table top adds nothing
    'epicerie':  (0.50, 0.50, 0.96),
    'fonio':     (0.50, 0.52, 0.92),
    'legumes1':  (0.50, 0.52, 0.94),
    'mafe':      (0.44, 0.55, 0.90),   # centre the pan, drop the grey wall
    'marche':    (0.50, 0.50, 0.94),
    'pain':      (0.56, 0.52, 0.90),   # the loaf, not the empty board
    'pastels':   (0.50, 0.52, 0.92),
    'rizgras':   (0.50, 0.55, 0.90),
    'sombi':     (0.50, 0.58, 0.88),
    'thieb':     (0.50, 0.52, 0.94),
    'yassa':     (0.50, 0.55, 0.92),
}

# 'tarte' is gone: a blown-out lemon meringue on a blue table, and the wrong
# promise for a surprise bag from a bakery. La Galette takes the pastels
# instead — a real photo of what a Dakar bakery counter actually has left.


def grade(im):
    """One look for the whole set: warm, open shadows, a little bite."""
    r, g, b = im.split()
    # A touch of warmth — these were shot under mixed light and several are blue.
    r = r.point(lambda v: min(255, int(v * 1.035)))
    b = b.point(lambda v: int(v * 0.975))
    im = Image.merge('RGB', (r, g, b))

    # Lift the blacks slightly and roll the highlights: flat compressed stock
    # goes muddy under a hard S-curve.
    def curve(v):
        x = v / 255.0
        x = 0.045 + x * 0.94                      # lifted floor, protected ceiling
        x = x + 0.13 * (x - 0.5) * (1 - abs(2 * x - 1))   # gentle S
        return max(0, min(255, int(x * 255)))
    lut = [curve(v) for v in range(256)]
    im = im.point(lut * 3)

    im = ImageEnhance.Color(im).enhance(1.10)
    im = ImageEnhance.Contrast(im).enhance(1.04)
    return im


def process(im, fx, fy, zoom):
    w, h = im.size
    cw, ch = w * zoom, h * zoom
    if cw / ch > W / H:
        cw = ch * W / H
    else:
        ch = cw * H / W
    x = min(max(fx * w - cw / 2, 0), w - cw)
    y = min(max(fy * h - ch / 2, 0), h - ch)
    im = im.crop((int(x), int(y), int(x + cw), int(y + ch)))
    im = im.resize((W, H), Image.LANCZOS)
    im = grade(im)
    # Sharpen after the resize, gently: these are already compressed and
    # anything heavier turns the JPEG blocks into edges of their own.
    return im.filter(ImageFilter.UnsharpMask(radius=1.6, percent=88, threshold=3))


files = sorted(f for f in glob.glob(os.path.join(SRC, '*'))
               if os.path.splitext(f)[1].lower() in ('.jpg', '.jpeg', '.png', '.webp'))
if not files:
    sys.exit('no photos in %s' % SRC)

parts, total = [], 0
for f in files:
    name = os.path.splitext(os.path.basename(f))[0]
    fx, fy, zoom = FRAME.get(name, (0.5, 0.5, 0.94))
    im = process(Image.open(f).convert('RGB'), fx, fy, zoom)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=76, method=6)
    data = buf.getvalue()
    total += len(data)
    if OUT:
        os.makedirs(OUT, exist_ok=True)
        open(os.path.join(OUT, name + '.webp'), 'wb').write(data)
    parts.append('"%s": "data:image/webp;base64,%s"' % (name, base64.b64encode(data).decode()))
    print('%-10s %sx%s  %s KB' % (name, im.width, im.height, len(data) // 1024), file=sys.stderr)

print('<script>')
print('const P={' + ',\n'.join(parts) + '};')
print('%s photos, %s KB before base64' % (len(parts), total // 1024), file=sys.stderr)
