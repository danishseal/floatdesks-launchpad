#!/usr/bin/env python3
"""Regenerate src/lib/float/abi.ts from Float's forge artifacts.

The app calls a handful of members on each contract, not the whole surface, so
the manifest below is explicit: adding a call means adding its name here and
re-running, which keeps the file honest about what the app actually touches and
keeps the diff readable when a contract changes.

    python3 scripts/gen-abi.py            # writes src/lib/float/abi.ts
    python3 scripts/gen-abi.py --check    # exit 1 if the file is stale

Reads $FLOAT_OUT, default ~/float/contracts/out. CurveFunder is the mainnet
venue and lives on the unmerged `curve-funder` branch, so it is read from that
worktree instead; override with $FLOAT_OUT_CURVE_FUNDER.
"""

import json, os, sys, pathlib

OUT = pathlib.Path(os.environ.get("FLOAT_OUT", os.path.expanduser("~/float/contracts/out")))
CURVE_OUT = pathlib.Path(os.environ.get(
    "FLOAT_OUT_CURVE_FUNDER",
    os.path.expanduser("~/float/.claude/worktrees/curve-funder/contracts/out"),
))
DEST = pathlib.Path(__file__).resolve().parent.parent / "src/lib/float/abi.ts"

# export name -> (artifact, members the app calls, artifact dir)
MANIFEST = [
    ("REGISTRY_ABI", "Registry", ["addrs"]),
    ("LISTINGS_ABI", "Listings", ["assetIds", "get", "listings"]),
    ("DESK_ABI", "Desk", [
        "availableLiquidity", "buy", "claimWithdraw", "deposit", "equity", "markPx",
        "netOI", "nextRequestId", "premium", "previewBuy", "previewSell",
        "requestWithdraw", "sell", "shares", "stakerFeeBps", "totalShares",
        "txFeeBps", "withdrawDelay", "withdrawRequests",
    ]),
    ("TOKENLAUNCHPAD_ABI", "TokenLaunchpad", [
        "allTokens", "buy", "claimCreatorFees", "creatorFeesByQuote", "creatorShareBps",
        "curves", "feeBps", "graduationUsd", "launchFeeUsdg", "launchToken", "metaOf",
        "poolIdOf", "previewBuy", "previewSell", "sell", "tokenCount", "virtualQuoteUsd",
    ]),
    ("VAULTFUNDER_ABI", "VaultFunder", [
        "claimLaunchShares", "contribute", "contributions", "current", "feeBalance",
        "poured", "queue", "queueIndexOf", "queueLength",
    ]),
    # capBoostQuote is what Desk._effectiveCap adds to the listed OI cap. The app
    # reads it for the same reason the Desk does: the listed cap alone is not the
    # cap a trade is measured against.
    ("STAKEVAULTS_ABI", "StakeVaults", [
        "boostBps", "capBoostQuote", "claimRewards", "claimUnstake", "harvest",
        "pendingRewards", "pools", "positions", "requestUnstake", "stake", "unstakeDelay",
    ]),
    ("ORACLEHUBMEDIAN_ABI", "OracleHubMedian", ["getQuote", "minPosters", "posterFreshWindow"]),
    ("CURVEFUNDER_ABI", "CurveFunder", CURVE_OUT, [
        "allTokens", "buy", "creatorShareBps", "curves", "defaultTarget", "feeBps",
        "launchFeeUsdg", "launchNew", "launchToken", "listFeeUsdg", "previewBuy",
        "previewSell", "raiseTargetOf", "sell", "tokenCount", "virtualBps",
    ]),
]


def members(artifact, out, wanted):
    path = out / f"{artifact}.sol" / f"{artifact}.json"
    if not path.exists():
        sys.exit(f"missing artifact {path}. Run `forge build` in ~/float/contracts.")
    abi = json.loads(path.read_text())["abi"]
    picked = [e for e in abi if e.get("type") == "function" and e["name"] in wanted]
    found = {e["name"] for e in picked}
    if missing := set(wanted) - found:
        sys.exit(f"{artifact} has no {sorted(missing)}. Stale artifact, or the name changed.")
    # Sort by name, then by arity so overloads stay in a stable order.
    return sorted(picked, key=lambda e: (e["name"], len(e["inputs"])))


def render():
    lines = [
        "// Generated from ~/float/contracts/out by scripts/gen-abi.py. Do not hand-edit.",
        "// Trimmed to the members this app calls.",
    ]
    for export, artifact, *rest in MANIFEST:
        out, wanted = (rest + [None])[:2] if len(rest) == 2 else (OUT, rest[0])
        body = json.dumps(members(artifact, out, wanted), separators=(",", ":"))
        lines += ["", f"export const {export} = {body} as const;"]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv:
        current = DEST.read_text() if DEST.exists() else ""
        if current != text:
            sys.exit(f"{DEST} is stale. Run python3 scripts/gen-abi.py")
        print(f"{DEST} is current")
    else:
        DEST.write_text(text)
        print(f"wrote {DEST}")
