"""Shared dark style for floorlaunch figures.

Background is #0b0d10, text is near white, and each figure picks one accent
from ACCENTS. Legacy names (INK, G1..G5, WHITE) are kept as aliases so the
figure scripts read the same as before.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.font_manager as fm

fm._load_fontmanager(try_read_cache=False)

BG    = "#0b0d10"   # page background
FG    = "#eef1f5"   # primary text and strokes
MUT   = "#a7b0bc"   # secondary text
DIM   = "#79828f"   # tertiary text, light rules
FAINT = "#414954"   # spines, de-emphasised strokes
GRID  = "#232931"   # grid and row separators
PANEL = "#12161b"   # subtle panel fill

ACCENTS = {
    "gold":   "#f0b24a",
    "cyan":   "#4fd1c5",
    "violet": "#a78bfa",
    "sky":    "#60a5fa",
    "coral":  "#fb7185",
    "mint":   "#34d399",
    "orange": "#fb923c",
    "lime":   "#a3e635",
    "pink":   "#f472b6",
}

# legacy aliases
INK, G1, G2, G3, G4, G5, WHITE = FG, MUT, DIM, FAINT, GRID, PANEL, BG


def mix(color, other=BG, t=0.85):
    """Blend `color` toward `other`. t = 1 returns `other`."""
    def rgb(c):
        c = c.lstrip("#")
        return [int(c[i:i + 2], 16) for i in (0, 2, 4)]
    a, b = rgb(color), rgb(other)
    return "#%02x%02x%02x" % tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


plt.rcParams.update({
    "font.family": "Inter",
    "font.size": 10,
    "text.color": FG,
    "axes.edgecolor": FAINT,
    "axes.labelcolor": MUT,
    "axes.linewidth": 0.9,
    "axes.titlesize": 12,
    "axes.titleweight": "semibold",
    "axes.titlelocation": "left",
    "axes.titlepad": 12,
    "axes.titlecolor": FG,
    "axes.labelsize": 9.5,
    "xtick.color": MUT,
    "ytick.color": MUT,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.frameon": False,
    "legend.fontsize": 9,
    "legend.labelcolor": MUT,
    "figure.facecolor": BG,
    "axes.facecolor": BG,
    "savefig.facecolor": BG,
    "figure.dpi": 200,
})


def clean_axes(ax, grid=True):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(FAINT)
    ax.tick_params(length=3, width=0.8)
    if grid:
        ax.grid(True, color=GRID, linewidth=0.7)
        ax.set_axisbelow(True)


def canvas(w=9.0, h=5.4, xlim=(0, 100), ylim=(0, 100)):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.axis("off")
    return fig, ax


def box(ax, x, y, w, h, text, fill=BG, edge=FG, lw=1.1, fontsize=9.5,
        weight="regular", textcolor=FG, radius=1.4, dashed=False, zorder=3):
    """x, y is the center of the box."""
    patch = FancyBboxPatch(
        (x - w / 2, y - h / 2), w, h,
        boxstyle=f"round,pad=0,rounding_size={radius}",
        linewidth=lw, edgecolor=edge, facecolor=fill,
        linestyle=(0, (3, 2)) if dashed else "solid", zorder=zorder,
    )
    ax.add_patch(patch)
    ax.text(x, y, text, ha="center", va="center", fontsize=fontsize,
            fontweight=weight, color=textcolor, zorder=zorder + 1,
            linespacing=1.45)
    return (x, y, w, h)


def arrow(ax, start, end, color=FG, lw=1.1, style="-|>", rad=0.0,
          dashed=False, zorder=2, ms=7):
    a = FancyArrowPatch(
        start, end, arrowstyle=style, mutation_scale=ms,
        linewidth=lw, color=color, zorder=zorder,
        connectionstyle=f"arc3,rad={rad}",
        linestyle=(0, (3, 2)) if dashed else "solid",
        shrinkA=0, shrinkB=0,
    )
    ax.add_patch(a)
    return a


def edge(cx, cy, w, h, tx, ty, margin=1.2):
    """Point on the border of a box centred at (cx, cy) facing (tx, ty)."""
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return (cx, cy)
    hw, hh = w / 2 + margin, h / 2 + margin
    sx = abs(dx) / hw if dx else 0
    sy = abs(dy) / hh if dy else 0
    s = max(sx, sy)
    return (cx + dx / s, cy + dy / s)


def connect(ax, b1, b2, rad=0.0, dashed=False, color=FG, lw=1.1, margin=1.2):
    """Arrow from box tuple b1 to box tuple b2, anchored on their borders."""
    x1, y1, w1, h1 = b1
    x2, y2, w2, h2 = b2
    start = edge(x1, y1, w1, h1, x2, y2, margin)
    end = edge(x2, y2, w2, h2, x1, y1, margin)
    return arrow(ax, start, end, rad=rad, dashed=dashed, color=color, lw=lw)


def label(ax, x, y, text, fontsize=8.5, color=MUT, ha="center", va="center",
          weight="regular", bg=None, zorder=5):
    kw = {}
    if bg:
        kw["bbox"] = dict(facecolor=bg, edgecolor="none", pad=1.8)
    ax.text(x, y, text, ha=ha, va=va, fontsize=fontsize, color=color,
            fontweight=weight, zorder=zorder, linespacing=1.4, **kw)


def title_block(ax, title, subtitle=None, x=0, y=100):
    ax.text(x, y, title, ha="left", va="top", fontsize=12.5,
            fontweight="semibold", color=FG)
    if subtitle:
        ax.text(x, y - 5.6, subtitle, ha="left", va="top", fontsize=9.2,
                color=MUT, linespacing=1.4)


def save(fig, name, outdir="/home/claude/figures"):
    import os
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, name)
    fig.savefig(path, bbox_inches="tight", pad_inches=0.3, facecolor=BG)
    plt.close(fig)
    print(path)
    return path
