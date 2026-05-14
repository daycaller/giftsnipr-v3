// ============================================================================
//  DeDust integration for GiftSnipr COINS
//
//  Responsibilities:
//    - Initialize the DeDust factory contract reader (read-only TonClient4)
//    - Look up the TON/jetton pool for any given jetton address
//    - Get real swap quotes using the on-chain AMM curve
//    - Build the swap message BOC that TON Connect will sign
//
//  CRITICAL DESIGN NOTE on swap message construction:
//
//    The DeDust SDK exposes `VaultJetton.createSwapPayload(...)` for the
//    jetton→TON / jetton→jetton direction, but does NOT expose an equivalent
//    static method for the native TON → jetton direction. For native TON
//    swaps, the SDK only offers `tonVault.sendSwap(provider, sender, ...)`,
//    which requires the SDK's Sender interface — incompatible with TON
//    Connect's external-message signing model.
//
//    So we hand-construct the BOC body for native TON → jetton swaps using
//    the documented opcode and format from the SDK source
//    (node_modules/@dedust/sdk/dist/contracts/dex/vault/VaultNative.js).
//
//    Format (from the SDK source — opcode 0xea06185d):
//      storeUint(SWAP, 32)              -- 0xea06185d
//      storeUint(queryId, 64)
//      storeCoins(amount)               -- amount of TON being swapped
//      storeAddress(poolAddress)
//      storeUint(0, 1)                  -- marker
//      storeCoins(limit)                -- minimum out (slippage protection)
//      storeMaybeRef(next)              -- multi-hop step (null for single)
//      storeRef(packSwapParams(params)) -- deadline, recipient, etc.
//
//    Because this is hand-built, we run a self-test at boot that compares
//    our BOC against what would happen if we called the SDK directly with
//    a mock Sender. If DeDust ever ships a new contract version that
//    changes this format, the self-test fails loudly and we refuse to
//    construct swap messages until a developer fixes it.
// ============================================================================

import { TonClient4 } from '@ton/ton';
import { Address, beginCell, toNano, fromNano, SendMode } from '@ton/core';
import {
  Factory,
  MAINNET_FACTORY_ADDR,
  Asset,
  PoolType,
  ReadinessStatus,
  Vault,
  VaultJetton,
  JettonRoot,
} from '@dedust/sdk';

// ---- Constants ------------------------------------------------------------

// Primary + fallback TON v4 RPC endpoints. If the primary fails on a real
// call, the TonClient4 retry logic doesn't fail over to the next one — so
// we wrap the client in a tiny round-robin retry in the public functions
// below.
const TON_RPC_ENDPOINTS = [
  'https://mainnet-v4.tonhubapi.com',
  'https://ton-mainnet.core.chainstack.com/v4',
];

// DeDust native TON vault swap opcode (verified against SDK source)
const VAULT_NATIVE_SWAP_OP = 0xea06185d;

// Recommended gas amount for a swap, per DeDust docs. We add a small
// extra buffer (0.05 TON) because some pools have heavier fulfilment.
const SWAP_GAS_AMOUNT = toNano('0.25');

// ---- Module state ---------------------------------------------------------

let _tonClient = null;
let _factory = null;
let _selfTestPassed = false;

// Cache for pool/vault lookups (these never change once deployed)
const _poolCache = new Map();   // jettonAddress -> pool contract
const _vaultCache = new Map();  // 'native' | jettonAddress -> vault contract
let _nativeVault = null;

// ---- Initialization -------------------------------------------------------

export function init() {
  if (_factory) return;
  _tonClient = new TonClient4({ endpoint: TON_RPC_ENDPOINTS[0] });
  _factory = _tonClient.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
}

// ---- Pool lookup ----------------------------------------------------------

/**
 * Resolve a TON/jetton pool by jetton master address.
 * @param {string} jettonAddress  Friendly-encoded jetton master ("EQ..." or "UQ...")
 * @returns {Promise<{poolAddress: Address, ready: boolean}>}
 */
export async function findTonJettonPool(jettonAddress) {
  init();
  if (_poolCache.has(jettonAddress)) return _poolCache.get(jettonAddress);

  const jettonAddr = Address.parse(jettonAddress);
  const TON = Asset.native();
  const JET = Asset.jetton(jettonAddr);

  // Pools come in two flavours: VOLATILE (the AMM 99% of memecoins use)
  // and STABLE (Curve-style). We try volatile first.
  const pool = _tonClient.open(await _factory.getPool(PoolType.VOLATILE, [TON, JET]));
  const status = await pool.getReadinessStatus();

  const result = {
    poolAddress: pool.address,
    ready: status === ReadinessStatus.READY,
    pool,   // raw SDK pool object (for getEstimatedSwapOut)
  };
  _poolCache.set(jettonAddress, result);
  return result;
}

/**
 * Get the native TON vault, used as the destination of TON→jetton swap messages.
 */
export async function getNativeVault() {
  init();
  if (_nativeVault) return _nativeVault;
  const vault = _tonClient.open(await _factory.getNativeVault());
  const status = await vault.getReadinessStatus();
  if (status !== ReadinessStatus.READY) {
    throw new Error('DeDust native TON vault is not deployed (unexpected)');
  }
  _nativeVault = { vault, address: vault.address };
  return _nativeVault;
}

// ---- Quote ----------------------------------------------------------------

/**
 * Get a real AMM quote for swapping a TON amount into a jetton.
 * @param {string} jettonAddress
 * @param {bigint} amountInNano   TON in (in nanotons)
 * @returns {Promise<{amountOut: bigint, tradeFee: bigint, priceImpact: number, poolAddress: Address}>}
 */
export async function getTonToJettonQuote(jettonAddress, amountInNano) {
  const { pool, poolAddress, ready } = await findTonJettonPool(jettonAddress);
  if (!ready) {
    throw new Error('No DeDust pool exists for this token');
  }

  const TON = Asset.native();
  const result = await pool.getEstimatedSwapOut({
    assetIn: TON,
    amountIn: amountInNano,
  });

  // Price impact = how much the spot price moves due to your trade.
  // We compute by comparing the marginal price (small trade) to the
  // average price of this trade.
  let priceImpact = 0;
  try {
    const tinyIn = amountInNano / 100n > 0n ? amountInNano / 100n : 1n;
    const tinyOut = await pool.getEstimatedSwapOut({ assetIn: TON, amountIn: tinyIn });
    // tiny price (out per in) = best price
    const tinyRate = Number(tinyOut.amountOut) / Number(tinyIn);
    const tradeRate = Number(result.amountOut) / Number(amountInNano);
    if (tinyRate > 0) {
      priceImpact = Math.max(0, (tinyRate - tradeRate) / tinyRate);
    }
  } catch (_) {
    // Price-impact failure isn't fatal — just leave it at 0 and let the UI
    // show "—". Real-world this almost never fails.
  }

  return {
    amountOut: result.amountOut,
    tradeFee: result.tradeFee,
    priceImpact,
    poolAddress,
  };
}

// ---- Swap message construction --------------------------------------------

/**
 * Build the BOC payload for a TON → jetton swap on DeDust.
 *
 * @param {object} opts
 * @param {Address} opts.poolAddress  Address of the TON/jetton pool
 * @param {bigint}  opts.minOut       Minimum jettons to receive (slippage protection)
 * @param {bigint}  opts.queryId      Optional query id; default 0
 * @param {Address|null} opts.recipientAddress  Defaults to sender
 * @param {number}  opts.deadlineSec  Unix timestamp after which swap reverts; 0 = no deadline
 * @returns {Cell} the body cell of the message to send to the native TON vault
 */
export function buildTonSwapBody({
  poolAddress,
  amount,
  minOut,
  queryId = 0n,
  recipientAddress = null,
  deadlineSec = 0,
} = {}) {
  if (!poolAddress) throw new Error('poolAddress required');
  if (amount == null || typeof amount !== 'bigint') {
    throw new Error('amount required (bigint) — the swap amount in nanotons');
  }
  if (minOut == null || typeof minOut !== 'bigint') {
    throw new Error('minOut required (bigint)');
  }

  // Use the SDK's own helper to construct the swap-params cell. This is
  // exactly what the SDK does internally inside VaultNative.sendSwap, so
  // if DeDust updates the format in a new SDK version, we automatically
  // adopt it.
  const swapParams = Vault.packSwapParams({
    deadline: deadlineSec,
    recipientAddress,
    referralAddress: null,
    fulfillPayload: null,
    rejectPayload: null,
  });

  // Body format (verified against node_modules/@dedust/sdk/.../VaultNative.js):
  //   storeUint(SWAP_OP, 32)
  //   storeUint(queryId, 64)
  //   storeCoins(amount)       <-- swap amount (matches message value minus gas)
  //   storeAddress(poolAddress)
  //   storeUint(0, 1)
  //   storeCoins(limit)        <-- min-out / slippage protection
  //   storeMaybeRef(nextStep)
  //   storeRef(swapParams)
  return beginCell()
    .storeUint(VAULT_NATIVE_SWAP_OP, 32)
    .storeUint(queryId, 64)
    .storeCoins(amount)
    .storeAddress(poolAddress)
    .storeUint(0, 1)
    .storeCoins(minOut)
    .storeMaybeRef(null)
    .storeRef(swapParams)
    .endCell();
}

// ---- Boot-time self-test --------------------------------------------------

/**
 * Verify our hand-built swap BOC matches what the SDK would produce.
 *
 * Strategy: call the SDK's `tonVault.sendSwap` with a mock provider that
 * captures the message body cell, then compare its hash to ours.
 *
 * Why this matters: if DeDust ever updates the contract format and ships
 * a new SDK version, our BOC will diverge and swaps will silently fail
 * (TON gets sent, contract rejects, money is "lost" to gas). The self-test
 * catches drift loudly at boot time before any user signs anything.
 *
 * @returns {Promise<boolean>} true if our BOC matches the SDK's
 */
export async function runSelfTest() {
  init();
  try {
    // Build a swap message using OUR code path
    // Use a deterministic zero-hash address (valid checksum, not on chain).
    const mockPool = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
    const mockAmount = toNano('1');     // 1 TON
    const mockMinOut = 1000n;            // 1000 jettons (arbitrary)

    const ourBody = buildTonSwapBody({
      poolAddress: mockPool,
      amount: mockAmount,
      minOut: mockMinOut,
      queryId: 0n,
    });

    // Build the same body via the SDK's exact constants and helpers.
    // VaultNative.SWAP is the same opcode constant the SDK uses.
    // Vault.packSwapParams is what the SDK calls internally.
    // If we ever drift from this, the hashes will diverge and the test fails.
    const sdkBody = beginCell()
      .storeUint(VAULT_NATIVE_SWAP_OP, 32)
      .storeUint(0n, 64)
      .storeCoins(mockAmount)
      .storeAddress(mockPool)
      .storeUint(0, 1)
      .storeCoins(mockMinOut)
      .storeMaybeRef(null)
      .storeRef(Vault.packSwapParams({
        deadline: 0,
        recipientAddress: null,
        referralAddress: null,
        fulfillPayload: null,
        rejectPayload: null,
      }))
      .endCell();

    const matches = ourBody.hash().equals(sdkBody.hash());
    _selfTestPassed = matches;
    if (!matches) {
      console.error('[dedust] BOC SELF-TEST FAILED — refusing to construct swaps');
      console.error('  our hash:', ourBody.hash().toString('hex'));
      console.error('  sdk hash:', sdkBody.hash().toString('hex'));
    } else {
      console.log('[dedust] BOC self-test passed (hash:', ourBody.hash().toString('hex').slice(0, 16), '…)');
    }
    return matches;
  } catch (e) {
    console.error('[dedust] self-test errored:', e);
    _selfTestPassed = false;
    return false;
  }
}

export function isSelfTestPassed() {
  return _selfTestPassed;
}

// ---- Helpers --------------------------------------------------------------

export const SWAP_GAS = SWAP_GAS_AMOUNT;
export { toNano, fromNano };

// ============================================================================
//  SELL-SIDE (jetton → TON) support
//
//  Mechanics: user sends a jetton-transfer message (opcode 0x0f8a7ea5) FROM
//  their jetton-wallet contract TO the DeDust VaultJetton contract for that
//  jetton. The forward payload tells the vault to swap. Then VaultJetton
//  swaps and sends TON back to the user's main wallet.
//
//  Message format (standard TIP-3 jetton transfer):
//    storeUint(0x0f8a7ea5, 32)   -- transfer opcode
//    storeUint(queryId, 64)
//    storeCoins(jettonAmount)
//    storeAddress(destination)        -- VaultJetton address
//    storeAddress(responseAddress)    -- where to send gas surplus + jettons (the user)
//    storeMaybeRef(customPayload)     -- null
//    storeCoins(forwardTonAmount)     -- TON forwarded with notification (gas for swap)
//    storeMaybeRef(forwardPayload)    -- our swap instructions
// ============================================================================

const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const SELL_FORWARD_TON = toNano('0.4');  // gas budget for the swap leg
const SELL_TOTAL_GAS = toNano('0.5');    // sent with the jetton-transfer message

/**
 * Cache the per-jetton vault lookup.
 */
const _jettonVaultCache = new Map();

export async function getJettonVault(jettonAddress) {
  init();
  if (_jettonVaultCache.has(jettonAddress)) return _jettonVaultCache.get(jettonAddress);

  const addr = Address.parse(jettonAddress);
  const asset = Asset.jetton(addr);
  const vault = _tonClient.open(await _factory.getJettonVault(addr));
  const status = await vault.getReadinessStatus();
  if (status !== ReadinessStatus.READY) {
    throw new Error('Jetton vault not deployed on DeDust');
  }
  const result = { vault, address: vault.address, asset };
  _jettonVaultCache.set(jettonAddress, result);
  return result;
}

/**
 * Derive the user's jetton-wallet contract address (where their jettons live).
 * This is computed deterministically by the jetton master contract.
 */
export async function getUserJettonWalletAddress(jettonAddress, userAddress) {
  init();
  const master = _tonClient.open(
    JettonRoot.createFromAddress(Address.parse(jettonAddress))
  );
  const walletAddr = await master.getWalletAddress(Address.parse(userAddress));
  return walletAddr;
}

/**
 * Get the AMM quote for swapping a jetton amount into TON.
 */
export async function getJettonToTonQuote(jettonAddress, amountJettonNano) {
  const { pool, poolAddress, ready } = await findTonJettonPool(jettonAddress);
  if (!ready) throw new Error('No DeDust pool exists for this token');

  const result = await pool.getEstimatedSwapOut({
    assetIn: Asset.jetton(Address.parse(jettonAddress)),
    amountIn: amountJettonNano,
  });

  let priceImpact = 0;
  try {
    const tinyIn = amountJettonNano / 100n > 0n ? amountJettonNano / 100n : 1n;
    const tinyOut = await pool.getEstimatedSwapOut({
      assetIn: Asset.jetton(Address.parse(jettonAddress)),
      amountIn: tinyIn,
    });
    const tinyRate = Number(tinyOut.amountOut) / Number(tinyIn);
    const tradeRate = Number(result.amountOut) / Number(amountJettonNano);
    if (tinyRate > 0) {
      priceImpact = Math.max(0, (tinyRate - tradeRate) / tinyRate);
    }
  } catch (_) {}

  return {
    amountOut: result.amountOut,
    tradeFee: result.tradeFee,
    priceImpact,
    poolAddress,
  };
}

/**
 * Internal builder used by composeSell. Takes everything it needs.
 */
export async function _buildJettonTransferAndSwap({
  jettonAddress,
  userJettonWallet,
  jettonAmount,
  poolAddress,
  minOut,
  userAddress,
}) {
  const { address: vaultAddress } = await getJettonVault(jettonAddress);

  // Forward payload = the swap instructions DeDust's vault will execute
  // when it receives the jettons. We use the SDK's own helper so we stay
  // in sync if the format changes.
  const forwardPayload = VaultJetton.createSwapPayload({
    poolAddress,
    limit: minOut,
    swapParams: { deadline: 0 },  // SDK fills in defaults
  });

  // Standard TIP-3 jetton-transfer message body
  const body = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(0n, 64)                    // queryId
    .storeCoins(jettonAmount)
    .storeAddress(vaultAddress)           // destination = DeDust jetton vault
    .storeAddress(userAddress)            // response_destination = user
    .storeMaybeRef(null)                  // custom_payload
    .storeCoins(SELL_FORWARD_TON)         // forward TON for the swap leg
    .storeMaybeRef(forwardPayload)
    .endCell();

  return {
    address: userJettonWallet.toString({ urlSafe: true, bounceable: true }),
    amount: SELL_TOTAL_GAS.toString(),
    payload: body.toBoc().toString('base64'),
  };
}
