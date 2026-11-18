"""Draws icon.png and images/demo.png. Run from the extension folder: python3 images/make_images.py
The demo picture is a drawing of what happens, not a screenshot. Fonts: Menlo and Helvetica (macOS)."""
import textwrap
from PIL import Image, ImageDraw, ImageFont

NAVY, PANEL, BLUE, YELLOW, WHITE = "#0D2240", "#16345F", "#7FB2FF", "#FFD23F", "#FFFFFF"
MONO, SANS = "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Helvetica.ttc"
mono = lambda size: ImageFont.truetype(MONO, size)
sans = lambda size, bold=False: ImageFont.truetype(SANS, size, index=1 if bold else 0)


def icon():
    s = 4  # draw four times larger, then shrink, so the edges are smooth
    im = Image.new("RGBA", (256 * s, 256 * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = lambda box, rad, **kw: d.rounded_rectangle([v * s for v in box], rad * s, **kw)
    r((0, 0, 256, 256), 56, fill=NAVY)
    r((30, 62, 226, 214), 20, fill=PANEL)                      # the code block
    for y, right in ((96, 150), (130, 196), (164, 120)):       # its rows of text
        r((54, y, right, y + 16), 8, fill=BLUE)
    r((150, 34, 204, 96), 12, outline=YELLOW, width=9 * s)     # the copy sign: two sheets
    r((172, 56, 226, 118), 12, fill=YELLOW)
    im.resize((256, 256), Image.LANCZOS).save("icon.png")


SENTENCE = ("Thank you for the kind words. We tested it with three teams for two weeks, "
            "and every team asked to keep it. I will share the numbers on Friday.")


def demo():
    W, H = 1280, 470
    im = Image.new("RGB", (W, H), "#F4F3EE")
    d = ImageDraw.Draw(im)
    rows = textwrap.wrap(SENTENCE, 52)  # the terminal breaks the line between words

    # left: the terminal
    d.rounded_rectangle((32, 32, 740, H - 32), 14, fill="#1E1E1E")
    d.text((56, 52), "TERMINAL", font=sans(13, True), fill="#8A8A8A")
    f = mono(19)
    d.text((56, 96), "●", font=f, fill="#E8E8E8")
    d.text((82, 96), "Here is a reply you can post:", font=f, fill="#E8E8E8")
    y0, step = 190, 32
    for i, row in enumerate(rows):
        d.text((82, y0 + i * step), row, font=f, fill="#6CB6FF")
    hover = 0                                                   # the pointer is on the first row
    hy = y0 + hover * step
    d.line((82, hy + 26, 82 + d.textlength(rows[hover], font=f), hy + 26), fill="#6CB6FF", width=2)
    tip = "Copy code block: Thank you for the kind words. We… (cmd + click)"
    tw = d.textlength(tip, font=sans(15))
    d.rounded_rectangle((230, hy - 44, 230 + tw + 24, hy - 12), 6, fill="#3A3D41", outline="#5A5D61")
    d.text((242, hy - 37), tip, font=sans(15), fill=WHITE)
    px, py = 330, hy + 10                                        # the mouse pointer
    d.polygon([(px, py), (px, py + 22), (px + 6, py + 17), (px + 10, py + 26), (px + 14, py + 24), (px + 10, py + 15), (px + 17, py + 15)], fill=WHITE, outline="#000000")
    d.rectangle((32, H - 76, 740, H - 46), fill="#007ACC")       # the status bar
    d.rounded_rectangle((32, H - 60, 740, H - 32), 14, fill="#007ACC")
    d.text((56, H - 67), f"Copied {len(SENTENCE)} characters: Thank you for the kind words. We tested…", font=sans(14), fill=WHITE)
    d.rectangle((622, H - 65, 631, H - 54), outline=WHITE, width=1)   # the copy sign: two sheets
    d.rectangle((626, H - 61, 635, H - 50), fill="#007ACC", outline=WHITE, width=1)
    d.text((644, H - 67), "Copy block", font=sans(14, True), fill=WHITE)

    # right: what you get when you paste
    def card(top, bottom, title, colour, lines, note):
        d.rounded_rectangle((772, top, W - 32, bottom), 14, fill=WHITE, outline="#DDDAD0")
        d.rounded_rectangle((772, top, 780, bottom), 4, fill=colour)
        d.text((800, top + 16), title, font=sans(18, True), fill="#1C2B3F")
        for i, line in enumerate(lines):
            d.text((800, top + 54 + i * 24), line, font=mono(13), fill="#1C2B3F")
        d.text((800, bottom - 34), note, font=sans(14), fill=colour)

    broken = [rows[0] + " ↵"] + ["··" + r + (" ↵" if i < len(rows) - 2 else "") for i, r in enumerate(rows[1:])]
    card(32, 222, "Selected with the mouse, then pasted", "#B3261E", broken, "Line breaks and spaces are added.")
    clean = textwrap.wrap(SENTENCE, 56)
    card(248, H - 32, "Copied with this extension, then pasted", "#1A7F37", clean, "One line, as it was written. (It only wraps to fit this box.)")
    im.save("images/demo.png", optimize=True)


icon()
demo()
print("icon.png and images/demo.png written;", len(SENTENCE), "characters in the sample sentence")
