"""Render every floorlaunch figure, with a collision check on each."""
import runpy
import matplotlib
matplotlib.use("Agg")
import fl_style
from qa import check

_orig = fl_style.save


def hooked(fig, name, outdir="/home/claude/figures"):
    check(fig, name)
    return _orig(fig, name, outdir)


fl_style.save = hooked

SCRIPTS = [
    "fig_charts.py",       # 01, 02, 04  economics
    "fig_lifecycle.py",    # 03
    "fig_flows.py",        # 05 - 08
    "fig_assets.py",       # 09
    "fig_protocol_a.py",   # 10 - 12
    "fig_protocol_b.py",   # 13 - 15
    "fig_protocol_c.py",   # 16 - 19
]
for script in SCRIPTS:
    print(f"=== {script}")
    runpy.run_path(script, run_name="__main__")
