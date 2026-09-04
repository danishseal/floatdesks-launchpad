import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Floorlaunch } from "../target/types/floorlaunch";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createMint,
  mintTo,
  createAssociatedTokenAccount,
  transfer as splTransfer,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { assert } from "chai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("floorlaunch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Floorlaunch as Program<Floorlaunch>;
  const payer = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  // Base units per NFT is 1e12 (1M tokens, 6 decimals).
  const SOL = LAMPORTS_PER_SOL;
  const FUNDING_ONE = new BN("1000000000000");
  // Floor index: 100 SOL per NFT.
  const INDEX0 = new BN(100).mul(new BN(SOL));

  const params = {
    indexWindowSecs: 1,
    minPushIntervalSecs: 0,
    breakerBps: 5000,
    maxIndexAgeSecs: 3600,
    markWindowSecs: 1,
    fundingKBps: 10000,
    maxFundingBpsPerDay: 10000,
    minCrankIntervalSecs: 1,
    initialCrBps: 15000,
    maintenanceCrBps: 12000,
    liqBonusBps: 500,
    maxOpenInterest: new BN("500000000000000"),
    itemReserve: new BN("100000000000000"),
    unitsPerItemMicro: new BN(1_000_000),
    curveFeeBps: 100,
    ammFeeBps: 100,
    graduationTargetSol: new BN(10).mul(new BN(SOL)),
    insuranceShareBps: 1000,
    // 10 SOL virtual against 100k tokens: starting price 0.1 lamport per
    // base unit, i.e. 100 SOL per NFT, at parity with the index.
    curveVirtualSol: new BN(10).mul(new BN(SOL)),
    curveVirtualTokens: new BN("100000000000"),
  };

  const collection = Keypair.generate().publicKey;
  const oracle = Keypair.generate();
  const shorter = Keypair.generate();

  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    program.programId
  );
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()],
    program.programId
  );
  const [mintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketPda.toBuffer()],
    program.programId
  );
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), marketPda.toBuffer()],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    program.programId
  );
  const [itemReservePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("items"), marketPda.toBuffer()],
    program.programId
  );
  const shortPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("short"), marketPda.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  const payerAta = getAssociatedTokenAddressSync(mintPda, payer.publicKey);
  const shorterAta = getAssociatedTokenAddressSync(mintPda, shorter.publicKey);

  const market = () => program.account.market.fetch(marketPda);

  const pushIndex = (price: BN) =>
    program.methods
      .pushIndex(price)
      .accountsPartial({
        global: globalPda,
        oracleAuthority: oracle.publicKey,
        market: marketPda,
      })
      .signers([oracle])
      .rpc();

  before(async () => {
    for (const kp of [oracle, shorter]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 200 * SOL);
      await connection.confirmTransaction(sig);
    }
  });

  it("initializes global config", async () => {
    await program.methods
      .initGlobal(oracle.publicKey, params)
      .accountsPartial({ global: globalPda, admin: payer.publicKey })
      .rpc();
    const g = await program.account.global.fetch(globalPda);
    assert.ok(g.admin.equals(payer.publicKey));
    assert.ok(g.oracleAuthority.equals(oracle.publicKey));
  });

  it("creates a market", async () => {
    await program.methods
      .createMarket(collection, null)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
        synthMint: mintPda,
        poolToken: poolPda,
        itemReserve: itemReservePda,
        solVault: vaultPda,
      })
      .rpc();
    const m = await market();
    assert.ok(m.collection.equals(collection));
    assert.deepEqual(m.status, { bootstrap: {} });
    assert.equal(m.fundingIndex.toString(), FUNDING_ONE.toString());
    // Fixed supply: full allocation preminted, mint authority revoked.
    const mint = await getMint(connection, mintPda);
    assert.isNull(mint.mintAuthority);
    assert.equal(
      mint.supply.toString(),
      params.curveVirtualTokens.add(params.maxOpenInterest).add(params.itemReserve).toString()
    );
    const pool = await connection.getTokenAccountBalance(poolPda);
    assert.equal(pool.value.amount, params.curveVirtualTokens.toString());
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), marketPda.toBuffer()],
      program.programId
    );
    const treasury = await connection.getTokenAccountBalance(treasuryPda);
    assert.equal(treasury.value.amount, params.maxOpenInterest.toString());
  });

  it("accepts an oracle push and seeds the TWAP", async () => {
    await pushIndex(INDEX0);
    const m = await market();
    assert.equal(m.indexTwap.toString(), INDEX0.toString());
  });

  it("buys on the curve", async () => {
    await program.methods
      .curveBuy(new BN(5).mul(new BN(SOL)), new BN(0))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        user: payer.publicKey,
        userAta: payerAta,
      })
      .rpc();
    const m = await market();
    assert.isTrue(m.curveSolRaised.gt(new BN(4).mul(new BN(SOL))));
    const bal = await connection.getTokenAccountBalance(payerAta);
    assert.isTrue(new BN(bal.value.amount).gt(new BN(0)));
    const rentBuffer = await connection.getMinimumBalanceForRentExemption(0);
    const vaultLamports = await connection.getBalance(vaultPda);
    assert.equal(vaultLamports, 5 * SOL + rentBuffer);
  });

  it("sells back into the curve", async () => {
    const before = await market();
    const sellAmount = new BN("1000000000"); // 1000 tokens
    await program.methods
      .curveSell(sellAmount, new BN(0))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        user: payer.publicKey,
        userAta: payerAta,
      })
      .rpc();
    const after = await market();
    assert.isTrue(after.curveSolRaised.lt(before.curveSolRaised));
    assert.isTrue(after.curveTokensSold.lt(before.curveTokensSold));
  });

  it("graduates once the target is raised", async () => {
    await program.methods
      .curveBuy(new BN(9).mul(new BN(SOL)), new BN(0))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        user: payer.publicKey,
        userAta: payerAta,
      })
      .rpc();
    await program.methods
      .graduate()
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        poolToken: poolPda,
      })
      .rpc();
    const m = await market();
    assert.deepEqual(m.status, { live: {} });
    assert.isTrue(m.insuranceLamports.gt(new BN(0)));
    assert.isTrue(m.ammSolReserve.gt(new BN(0)));
    const pool = await connection.getTokenAccountBalance(poolPda);
    assert.equal(pool.value.amount, m.ammTokenReserve.toString());
    // insurance is 10% of raised
    const expectedInsurance = m.curveSolRaised.muln(1000).divn(10000);
    assert.equal(m.insuranceLamports.toString(), expectedInsurance.toString());
    // Excess curve allocation burned: supply = sold + AMM seed + reserve.
    const mint = await getMint(connection, mintPda);
    assert.equal(
      mint.supply.toString(),
      m.curveTokensSold
        .add(m.ammTokenReserve)
        .add(params.maxOpenInterest)
        .add(params.itemReserve)
        .toString()
    );
  });

  it("trades on the AMM after graduation", async () => {
    const before = await market();
    await program.methods
      .ammBuy(new BN(1).mul(new BN(SOL)), new BN(0))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        poolToken: poolPda,
        solVault: vaultPda,
        user: payer.publicKey,
        userAta: payerAta,
      })
      .rpc();
    let m = await market();
    assert.isTrue(m.ammSolReserve.gt(before.ammSolReserve));
    assert.isTrue(m.ammTokenReserve.lt(before.ammTokenReserve));

    await program.methods
      .ammSell(new BN("500000000"), new BN(0))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        poolToken: poolPda,
        solVault: vaultPda,
        user: payer.publicKey,
        userAta: payerAta,
      })
      .rpc();
    m = await market();
    assert.isTrue(m.ammTokenReserve.gt(new BN(0)));
  });

  it("opens a short (mint against collateral)", async () => {
    // 100k tokens = 1e11 base units, worth 10 SOL at the index.
    // 150% CR needs 15 SOL, post 20 SOL.
    const mintAmount = new BN("100000000000");
    await program.methods
      .openShort(new BN(20).mul(new BN(SOL)), mintAmount)
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
        ownerAta: shorterAta,
      })
      .signers([shorter])
      .rpc();
    const p = await program.account.shortPosition.fetch(
      shortPda(shorter.publicKey)
    );
    assert.equal(p.collateral.toString(), (20 * SOL).toString());
    const bal = await connection.getTokenAccountBalance(shorterAta);
    assert.equal(bal.value.amount, mintAmount.toString());
    const m = await market();
    assert.isTrue(m.totalDebtScaled.gt(new BN(0)));
  });

  it("rejects an undercollateralized open", async () => {
    try {
      await program.methods
        .openShort(new BN(1).mul(new BN(SOL)), new BN("100000000000"))
        .accountsPartial({
          market: marketPda,
          synthMint: mintPda,
          solVault: vaultPda,
          position: shortPda(shorter.publicKey),
          owner: shorter.publicKey,
          ownerAta: shorterAta,
        })
        .signers([shorter])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientCollateral");
    }
  });

  it("withdraws collateral within the CR limit and blocks beyond it", async () => {
    await program.methods
      .withdrawCollateral(new BN(2).mul(new BN(SOL)))
      .accountsPartial({
        market: marketPda,
        solVault: vaultPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
      })
      .signers([shorter])
      .rpc();
    try {
      await program.methods
        .withdrawCollateral(new BN(10).mul(new BN(SOL)))
        .accountsPartial({
          market: marketPda,
          solVault: vaultPda,
          position: shortPda(shorter.publicKey),
          owner: shorter.publicKey,
        })
        .signers([shorter])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientCollateral");
    }
  });

  it("repays and burns", async () => {
    const repay = new BN("50000000000");
    await program.methods
      .repayBurn(repay)
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
        ownerAta: shorterAta,
      })
      .signers([shorter])
      .rpc();
    const bal = await connection.getTokenAccountBalance(shorterAta);
    assert.equal(bal.value.amount, "50000000000");
  });

  it("accrues funding toward the index", async () => {
    await sleep(2500);
    await program.methods
      .accrueFunding()
      .accountsPartial({ market: marketPda })
      .rpc();
    const m = await market();
    // Curve ended above the starting price, so mark > index: shorts get
    // paid and the funding index must tick down from one.
    assert.isTrue(m.markEma.gt(m.indexTwap));
    assert.isTrue(m.fundingIndex.lt(FUNDING_ONE));
  });

  it("trips the circuit breaker on a wild push and admin unfreezes", async () => {
    await sleep(1200);
    await pushIndex(INDEX0.muln(5));
    let m = await market();
    assert.isTrue(m.frozen);
    // twap must not have absorbed the outlier
    assert.equal(m.indexTwap.toString(), INDEX0.toString());
    // and further pushes are refused until the admin unfreezes
    try {
      await pushIndex(INDEX0.muln(120).divn(100));
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "Frozen");
    }
    await program.methods
      .setFrozen(false)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
      })
      .rpc();
    m = await market();
    assert.isFalse(m.frozen);
  });

  it("liquidates an underwater short", async () => {
    // Fresh victim: open at exactly 150% CR, then push the index up ~96%.
    const victim = Keypair.generate();
    const sig = await connection.requestAirdrop(victim.publicKey, 20 * SOL);
    await connection.confirmTransaction(sig);
    const victimAta = getAssociatedTokenAddressSync(mintPda, victim.publicKey);
    // 10k tokens = 1e10 base units, worth 1 SOL at the index. 150% = 1.5 SOL.
    const mintAmount = new BN("10000000000");
    await program.methods
      .openShort(new BN("1500000000"), mintAmount)
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        position: shortPda(victim.publicKey),
        owner: victim.publicKey,
        ownerAta: victimAta,
      })
      .signers([victim])
      .rpc();

    // Two +40% pushes; each within the 50% breaker, waiting out the EMA window.
    await sleep(1200);
    await pushIndex(INDEX0.muln(140).divn(100));
    await sleep(1200);
    await pushIndex(INDEX0.muln(196).divn(100));
    const m = await market();
    // index is now ~1.96x, debt value ~1.96 SOL vs 1.5 SOL collateral
    assert.isTrue(m.indexTwap.gt(INDEX0.muln(190).divn(100)));

    // Liquidator (payer) holds curve tokens; burns victim debt, takes collateral.
    const liqBalanceBefore = await connection.getBalance(payer.publicKey);
    await program.methods
      .liquidate()
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        position: shortPda(victim.publicKey),
        positionOwner: victim.publicKey,
        liquidator: payer.publicKey,
        liquidatorAta: payerAta,
      })
      .rpc();
    const p = await program.account.shortPosition.fetch(
      shortPda(victim.publicKey)
    );
    assert.equal(p.debtScaled.toString(), "0");
    assert.equal(p.collateral.toString(), "0");
    const liqBalanceAfter = await connection.getBalance(payer.publicKey);
    assert.isTrue(liqBalanceAfter > liqBalanceBefore);
  });

  it("closes an emptied position", async () => {
    // Shorter repays the rest, withdraws everything, closes.
    const pBefore = await program.account.shortPosition.fetch(
      shortPda(shorter.publicKey)
    );
    const m = await market();
    const debt = pBefore.debtScaled
      .mul(m.fundingIndex)
      .div(FUNDING_ONE);
    await program.methods
      .repayBurn(debt)
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
        ownerAta: shorterAta,
      })
      .signers([shorter])
      .rpc();
    const p = await program.account.shortPosition.fetch(
      shortPda(shorter.publicKey)
    );
    await program.methods
      .withdrawCollateral(p.collateral)
      .accountsPartial({
        market: marketPda,
        solVault: vaultPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
      })
      .signers([shorter])
      .rpc();
    await program.methods
      .closePosition()
      .accountsPartial({
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
      })
      .signers([shorter])
      .rpc();
    const gone = await program.account.shortPosition.fetchNullable(
      shortPda(shorter.publicKey)
    );
    assert.isNull(gone);
  });

  it("enforces the staleness guard and param immutability", async () => {
    // Tighten max index age to 1 second, let the index go stale, and
    // confirm index-priced operations refuse to run.
    await program.methods
      .updateMarketParams({ ...params, maxIndexAgeSecs: 1 })
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
      })
      .rpc();
    await sleep(2500);
    try {
      await program.methods
        .openShort(new BN(2).mul(new BN(SOL)), new BN("1000000000"))
        .accountsPartial({
          market: marketPda,
          synthMint: mintPda,
          solVault: vaultPda,
          position: shortPda(shorter.publicKey),
          owner: shorter.publicKey,
          ownerAta: shorterAta,
        })
        .signers([shorter])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "IndexStale");
    }
    // A fresh push revives the market.
    const m = await market();
    await pushIndex(m.indexLastRaw);
    await program.methods
      .openShort(new BN(2).mul(new BN(SOL)), new BN("1000000000"))
      .accountsPartial({
        market: marketPda,
        synthMint: mintPda,
        solVault: vaultPda,
        position: shortPda(shorter.publicKey),
        owner: shorter.publicKey,
        ownerAta: shorterAta,
      })
      .signers([shorter])
      .rpc();
    // Restore the relaxed params; curve virtuals must be immutable.
    await program.methods
      .updateMarketParams(params)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
      })
      .rpc();
    try {
      await program.methods
        .updateMarketParams({
          ...params,
          curveVirtualSol: new BN(99).mul(new BN(SOL)),
        })
        .accountsPartial({
          global: globalPda,
          admin: payer.publicKey,
          market: marketPda,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ImmutableParam");
    }
  });

  it("runs an external-venue market off a treasury reserve", async () => {
    // Externally launched token (DBC-style): plain SPL mint, fixed supply,
    // authority not held by the program.
    const extCollection = Keypair.generate().publicKey;
    const [extMarket] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), extCollection.toBuffer()],
      program.programId
    );
    const [extTreasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), extMarket.toBuffer()],
      program.programId
    );
    const [extVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), extMarket.toBuffer()],
      program.programId
    );
    const extMint = await createMint(
      connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );
    const adminAta = await createAssociatedTokenAccount(
      connection,
      payer.payer,
      extMint,
      payer.publicKey
    );
    // 1M tokens of reserve supply.
    await mintTo(
      connection,
      payer.payer,
      extMint,
      adminAta,
      payer.payer,
      1_000_000_000_000n
    );

    await program.methods
      .createExternalMarket(extCollection, null)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: extMarket,
        synthMint: extMint,
        treasury: extTreasury,
        solVault: extVault,
      })
      .rpc();
    let em = await program.account.market.fetch(extMarket);
    assert.deepEqual(em.status, { live: {} });
    assert.deepEqual(em.venue, { external: {} });

    // Fund the treasury reserve with a plain SPL transfer.
    await splTransfer(
      connection,
      payer.payer,
      adminAta,
      extTreasury,
      payer.payer,
      500_000_000_000n
    );

    // Oracle pushes both legs: index and (external-only) mark.
    await program.methods
      .pushIndex(INDEX0)
      .accountsPartial({
        global: globalPda,
        oracleAuthority: oracle.publicKey,
        market: extMarket,
      })
      .signers([oracle])
      .rpc();
    await program.methods
      .pushMark(INDEX0.muln(102).divn(100))
      .accountsPartial({
        global: globalPda,
        oracleAuthority: oracle.publicKey,
        market: extMarket,
      })
      .signers([oracle])
      .rpc();
    em = await program.account.market.fetch(extMarket);
    assert.equal(em.markEma.toString(), INDEX0.muln(102).divn(100).toString());

    // Internal-AMM trading is unavailable on an external market.
    try {
      await program.methods
        .ammBuy(new BN(SOL), new BN(0))
        .accountsPartial({
          market: extMarket,
          synthMint: extMint,
          poolToken: PublicKey.findProgramAddressSync(
            [Buffer.from("pool"), extMarket.toBuffer()],
            program.programId
          )[0],
          solVault: extVault,
          user: payer.publicKey,
          userAta: getAssociatedTokenAddressSync(extMint, payer.publicKey),
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "AccountNotInitialized");
    }

    // Short opens by drawing the treasury reserve, not minting.
    const treasuryBefore = (await getAccount(connection, extTreasury)).amount;
    const [extShort] = PublicKey.findProgramAddressSync(
      [Buffer.from("short"), extMarket.toBuffer(), shorter.publicKey.toBuffer()],
      program.programId
    );
    const shorterExtAta = await createAssociatedTokenAccount(
      connection,
      payer.payer,
      extMint,
      shorter.publicKey
    );
    const mintAmount = new BN("10000000000"); // 10k tokens = 1 SOL at index
    await program.methods
      .openShort(new BN(2).mul(new BN(SOL)), mintAmount)
      .accountsPartial({
        market: extMarket,
        synthMint: extMint,
        treasury: extTreasury,
        solVault: extVault,
        position: extShort,
        owner: shorter.publicKey,
        ownerAta: shorterExtAta,
      })
      .signers([shorter])
      .rpc();
    const treasuryAfterOpen = (await getAccount(connection, extTreasury)).amount;
    assert.equal(
      (treasuryBefore - treasuryAfterOpen).toString(),
      mintAmount.toString()
    );

    // Funding runs off the pushed mark (2% premium pays shorts).
    await sleep(2000);
    await program.methods
      .accrueFunding()
      .accountsPartial({ market: extMarket })
      .rpc();
    em = await program.account.market.fetch(extMarket);
    assert.isTrue(em.fundingIndex.lt(FUNDING_ONE));

    // Repay returns tokens to the treasury instead of burning.
    const p = await program.account.shortPosition.fetch(extShort);
    const debt = p.debtScaled.mul(em.fundingIndex).div(FUNDING_ONE);
    await program.methods
      .repayBurn(debt)
      .accountsPartial({
        market: extMarket,
        synthMint: extMint,
        treasury: extTreasury,
        position: extShort,
        owner: shorter.publicKey,
        ownerAta: shorterExtAta,
      })
      .signers([shorter])
      .rpc();
    const treasuryAfterRepay = (await getAccount(connection, extTreasury)).amount;
    assert.equal(
      (treasuryAfterRepay - treasuryAfterOpen).toString(),
      debt.toString()
    );
  });

  it("swaps items in and out at card value", async () => {
    // A demo vaulted-card copy: 0-decimals mint, supply 1, owned by shorter.
    const itemMint = await createMint(connection, payer.payer, payer.publicKey, null, 0);
    const shorterItemAta = await createAssociatedTokenAccount(
      connection, payer.payer, itemMint, shorter.publicKey
    );
    await mintTo(connection, payer.payer, itemMint, shorterItemAta, payer.payer, 1);

    const [reg] = PublicKey.findProgramAddressSync(
      [Buffer.from("item"), marketPda.toBuffer(), itemMint.toBuffer()],
      program.programId
    );
    await program.methods
      .registerItem()
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
        itemMint,
        registration: reg,
      })
      .rpc();

    const [itemReserve] = PublicKey.findProgramAddressSync(
      [Buffer.from("items"), marketPda.toBuffer()],
      program.programId
    );
    const m0 = await market();
    const expectedTokens = new BN(m0.indexTwap.toString())
      .mul(new BN("1000000000000"))
      .div(new BN(m0.markEma.toString()));

    const balBefore = new BN(
      (await connection.getTokenAccountBalance(shorterAta)).value.amount
    );
    await program.methods
      .depositItem()
      .accountsPartial({
        market: marketPda,
        itemMint,
        registration: reg,
        itemReserve,
        user: shorter.publicKey,
        userItem: shorterItemAta,
        synthMint: mintPda,
        userToken: shorterAta,
      })
      .signers([shorter])
      .rpc();
    const balAfter = new BN(
      (await connection.getTokenAccountBalance(shorterAta)).value.amount
    );
    const received = balAfter.sub(balBefore);
    // received tokens = index/mark of one card, within EMA-drift tolerance
    const diff = received.sub(expectedTokens).abs();
    assert.isTrue(
      diff.mul(new BN(100)).lt(expectedTokens),
      `received ${received} vs expected ~${expectedTokens}`
    );
    assert.equal((await market()).itemsDeposited, 1);
    assert.equal(
      (await connection.getTokenAccountBalance(shorterItemAta)).value.amount,
      "0"
    );

    // withdraw the copy back: pay tokens worth the card
    await program.methods
      .withdrawItem()
      .accountsPartial({
        market: marketPda,
        itemMint,
        registration: reg,
        itemReserve,
        user: shorter.publicKey,
        userItem: shorterItemAta,
        synthMint: mintPda,
        userToken: shorterAta,
      })
      .signers([shorter])
      .rpc();
    assert.equal((await market()).itemsDeposited, 0);
    assert.equal(
      (await connection.getTokenAccountBalance(shorterItemAta)).value.amount,
      "1"
    );

    // unregistered mints are rejected
    const rogue = await createMint(connection, payer.payer, payer.publicKey, null, 0);
    const rogueAta = await createAssociatedTokenAccount(
      connection, payer.payer, rogue, shorter.publicKey
    );
    await mintTo(connection, payer.payer, rogue, rogueAta, payer.payer, 1);
    try {
      await program.methods
        .depositItem()
        .accountsPartial({
          market: marketPda,
          itemMint: rogue,
          registration: reg,
          itemReserve,
          user: shorter.publicKey,
          userItem: rogueAta,
          synthMint: mintPda,
          userToken: shorterAta,
        })
        .signers([shorter])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintSeeds");
    }
  });

  it("swaps items during bootstrap off the curve-fed mark", async () => {
    // Fresh market that never graduates: item swaps must work on the
    // curve too, priced off the mark EMA seeded from the curve spot.
    const coll2 = Keypair.generate().publicKey;
    const [m2] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), coll2.toBuffer()],
      program.programId
    );
    const [mint2] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint"), m2.toBuffer()],
      program.programId
    );
    const [pool2] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), m2.toBuffer()],
      program.programId
    );
    const [vault2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), m2.toBuffer()],
      program.programId
    );
    const [items2] = PublicKey.findProgramAddressSync(
      [Buffer.from("items"), m2.toBuffer()],
      program.programId
    );
    await program.methods
      .createMarket(coll2, null)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: m2,
        synthMint: mint2,
        poolToken: pool2,
        itemReserve: items2,
        solVault: vault2,
      })
      .rpc();
    await program.methods
      .pushIndex(INDEX0)
      .accountsPartial({ global: globalPda, oracleAuthority: oracle.publicKey, market: m2 })
      .signers([oracle])
      .rpc();
    const created: any = await program.account.market.fetch(m2);
    assert.deepEqual(created.status, { bootstrap: {} });
    // Mark seeded at the curve's opening spot.
    const openSpot = new BN(created.curveVirtualSol.toString())
      .mul(new BN("1000000000000"))
      .div(new BN(created.curveVirtualTokens.toString()));
    assert.equal(created.markEma.toString(), openSpot.toString());

    const itemMint2 = await createMint(connection, payer.payer, payer.publicKey, null, 0);
    const userItem2 = await createAssociatedTokenAccount(
      connection, payer.payer, itemMint2, shorter.publicKey
    );
    await mintTo(connection, payer.payer, itemMint2, userItem2, payer.payer, 1);
    const [reg2] = PublicKey.findProgramAddressSync(
      [Buffer.from("item"), m2.toBuffer(), itemMint2.toBuffer()],
      program.programId
    );
    await program.methods
      .registerItem()
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: m2,
        itemMint: itemMint2,
        registration: reg2,
      })
      .rpc();

    const userToken2 = await createAssociatedTokenAccount(
      connection, payer.payer, mint2, shorter.publicKey
    );
    const mPre: any = await program.account.market.fetch(m2);
    const expected = new BN(mPre.indexTwap.toString())
      .mul(new BN("1000000000000"))
      .div(new BN(mPre.markEma.toString()));
    await program.methods
      .depositItem()
      .accountsPartial({
        market: m2,
        itemMint: itemMint2,
        registration: reg2,
        itemReserve: items2,
        user: shorter.publicKey,
        userItem: userItem2,
        synthMint: mint2,
        userToken: userToken2,
      })
      .signers([shorter])
      .rpc();
    const got = new BN(
      (await connection.getTokenAccountBalance(userToken2)).value.amount
    );
    const drift = got.sub(expected).abs();
    assert.isTrue(
      drift.mul(new BN(100)).lt(expected),
      `bootstrap deposit ${got} vs expected ~${expected}`
    );
    assert.equal((await program.account.market.fetch(m2)).itemsDeposited, 1);

    await program.methods
      .withdrawItem()
      .accountsPartial({
        market: m2,
        itemMint: itemMint2,
        registration: reg2,
        itemReserve: items2,
        user: shorter.publicKey,
        userItem: userItem2,
        synthMint: mint2,
        userToken: userToken2,
      })
      .signers([shorter])
      .rpc();
    assert.equal((await program.account.market.fetch(m2)).itemsDeposited, 0);
    assert.equal(
      (await connection.getTokenAccountBalance(userItem2)).value.amount,
      "1"
    );
  });

  it("holds and releases an identity fee escrow PDA", async () => {
    const idHash = Array.from(
      require("crypto").createHash("sha256").update("youtube:testbreaker").digest()
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), Buffer.from(idHash)],
      program.programId
    );
    // Fees accrue via plain transfers from anyone.
    const fund = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: escrowPda,
      lamports: 3 * SOL,
    });
    await provider.sendAndConfirm(new (require("@solana/web3.js").Transaction)().add(fund));
    assert.equal(await connection.getBalance(escrowPda), 3 * SOL);

    // Only the admin can release, and only via the instruction.
    const recipient = Keypair.generate().publicKey;
    try {
      await program.methods
        .releaseEscrow(idHash as any, null)
        .accountsPartial({
          global: globalPda,
          admin: shorter.publicKey,
          escrow: escrowPda,
          recipient,
        })
        .signers([shorter])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintHasOne");
    }
    await program.methods
      .releaseEscrow(idHash as any, null)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        escrow: escrowPda,
        recipient,
      })
      .rpc();
    assert.equal(await connection.getBalance(escrowPda), 0);
    assert.equal(await connection.getBalance(recipient), 3 * SOL);
  });

  it("lets the admin withdraw accumulated fees", async () => {
    const m = await market();
    assert.isTrue(m.feeLamports.gt(new BN(0)));
    await program.methods
      .withdrawFees(m.feeLamports)
      .accountsPartial({
        global: globalPda,
        admin: payer.publicKey,
        market: marketPda,
        solVault: vaultPda,
        recipient: payer.publicKey,
      })
      .rpc();
    const after = await market();
    assert.equal(after.feeLamports.toString(), "0");
  });
});
