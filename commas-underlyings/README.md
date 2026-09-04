# commas underlyings export

Every collectible and NFT commas supports, with images and on-chain identifiers.

## Files
- `manifest.csv` - one row per underlying: name, kind, category, grade, ids, image.
- `underlyings-full.json` - the complete catalog (all fields).
- `card-onchain-mints.json` - full list of every on-chain vaulted card asset
  (Collector Crypt Core NFTs) per card underlying: {mint, owner, grade}.
- `images/` - artwork for all 68 underlyings.

## On-chain identifier fields
- `synth_collection_id` - the commas market key (deterministic; derives the market PDA).
- `market_pda` - the on-chain market address for that underlying.
- `onchain_collection` -
  - NFTs: the real verified Metaplex collection address.
  - Cards: Collector Crypt's Core collection `CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac`
    (every vaulted card lives under it; per-card mints are in card-onchain-mints.json).
- `vaulted_copies` - how many real graded copies are vaulted on-chain (cards).

68 underlyings = 57 graded cards + 11 NFT collections. 44 cards have live
on-chain vaulted copies (1,135 total).
