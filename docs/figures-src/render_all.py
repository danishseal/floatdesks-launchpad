"""Render every floorlaunch figure with a collision check on the flow diagrams."""
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
for script in ("fig_charts.py", "fig_lifecycle.py", "fig_flows.py", "fig_assets.py"):
    print(f"=== {script}")
    runpy.run_path(script, run_name="__main__")
