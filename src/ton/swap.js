// ============================================================================
//  GiftSnipr swap composer
//
//  Takes a coin + amount + slippage and produces the EXACT two-message
//  TON Connect transaction payload that, when signed, executes:
//    Message 1: 0.75% fee → GiftSnipr fee wallet
//    Message 2: Swap on DeDust
//
//  Hard invariants (audited):
//    - Fee wallet address is hardcoded and Object.freeze'd; cannot be
//      reassigned at runtime.
//    - Fee rate is hardcoded at 75 basis points (0.75%).
//    - Every transaction MUST include exactly one fee message at index 0
//      that matches FEE_WALLET_ADDRESS exactly. The composer asserts this.
//    - Construct-only: this module does NOT call sendTransaction. The UI
//      layer does the actual broadcast after explicit user confirmation.
// ============================================================================

import { beginCell, Address, toNano } from '@ton/core';
import {
  buildTonSwapBody,
  _buildJettonTransferAndSwap,
  getNativeVault,
  getJettonVault,
  getUserJettonWalletAddress,
  getTonToJettonQuote,
  getJettonToTonQuote,
  SWAP_GAS,
} from './dedust.js';

// ---- Hardcoded fee config (CRITICAL: do not weaken) ----------------------

const FEE_WALLET_ADDRESS = Object.freeze({
  // The raw form supplied by the GiftSnipr operator. Frozen to prevent
  // any runtime mutation by other modules, malicious imports, or DOM
  // injection. Read by FEE_DESTINATION below.
  raw: 'UQDi3dZf69O0wowBvyKzkNLtEIVHlH9-JUv9gU77wRy0wff3',
});

const FEE_BPS = 75;          // 0.75%
const FEE_BPS_DENOMINATOR = 10000;

// Pre-parse the address once at module load. If this throws, the module
// fails to load — preferable to a wallet-typo silently sending fees to
// the wrong place.
const FEE_DESTINATION = Address.parse(FEE_WALLET_ADDRESS.raw);

// Friendly-encoded version we use in messages. The user's wallet will
// also display this string in their confirmation UI.
const FEE_DESTINATION_FRIENDLY = FEE_DESTINATION.toString({ urlSafe: true, bounceable: false });

// ---- Fee message builder --------------------------------------------------

/**
 * Build the fee-routing message.
 *
 * @param {bigint} feeAmountNano  Fee in nanotons (computed from the swap amount)
 * @returns {{address: string, amount: string, payload: string}} TON Connect message
 */
function buildFeeMessage(feeAmountNano) {
  if (typeof feeAmountNano !== 'bigint') {
    throw new Error('feeAmountNano must be a bigint');
  }
  if (feeAmountNano <= 0n) {
    throw new Error('feeAmountNano must be positive');
  }
  // A simple text-comment transfer, so the fee wallet's transaction history
  // is readable on TonViewer ("GiftSnipr fee — 0.75%"). Opcode 0 = simple
  // text message per TON convention.
  const payload = beginCell()
    .storeUint(0, 32)
    .storeStringTail('GiftSnipr fee 0.75%')
    .endCell();

  return {
    address: FEE_DESTINATION_FRIENDLY,
    amount: feeAmountNano.toString(),
    payload: payload.toBoc().toString('base64'),
  };
}

// ---- Public composer API --------------------------------------------------

/**
 * Compose a complete TON→jetton buy quote with fee, slippage, and the
 * exact transaction the user will sign.
 *
 * @param {object} params
 * @param {string} params.jettonAddress      Master address of the coin to buy
 * @param {string} params.amountTonStr       Human-readable amount, e.g. "5" or "0.5"
 * @param {number} params.slippagePct        e.g. 1.0 for 1%
 * @param {Address|null} params.recipient    Wallet address to receive jettons; null = sender
 * @returns {Promise<ComposedSwap>}
 *
 * @typedef {Object} ComposedSwap
 * @property {bigint} swapAmountNano        TON going to DeDust
 * @property {bigint} feeNano               TON going to GiftSnipr
 * @property {bigint} gasNano               Network gas
 * @property {bigint} totalNano             swap + fee + gas (what user's wallet shows)
 * @property {bigint} estOutNano            Expected jettons received
 * @property {bigint} minOutNano            Min jettons after slippage (slippage protection)
 * @property {number} priceImpact           0..1 (e.g. 0.0042 = 0.42%)
 * @property {Address} poolAddress
 * @property {Object} tcTransaction         The TON Connect transaction object
 *                                          (messages array with fee + swap)
 */
export async function composeBuy({
  jettonAddress,
  amountTonStr,
  slippagePct,
  recipient = null,
}) {
  // ---- Validate inputs ----
  if (!jettonAddress) throw new Error('jettonAddress required');
  // Validate the jetton address parses (catches API failures returning bad data)
  try { Address.parse(jettonAddress); }
  catch (_) { throw new Error('Invalid jetton address'); }
  if (typeof amountTonStr !== 'string' && typeof amountTonStr !== 'number') {
    throw new Error('Amount must be a string or number');
  }
  // Strict numeric check — parseFloat is too lenient (accepts "1.5xyz")
  const s = String(amountTonStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error('Amount must be a plain decimal number (e.g. "1.5")');
  }
  const amount = parseFloat(s);
  if (!isFinite(amount) || amount <= 0) {
    throw new Error('Invalid TON amount');
  }
  if (amount < 0.01) {
    throw new Error('Minimum swap is 0.01 TON');
  }
  if (amount > 1_000_000) {
    throw new Error('Maximum swap is 1,000,000 TON');
  }
  if (!isFinite(slippagePct) || slippagePct < 0.1 || slippagePct > 50) {
    throw new Error('Slippage must be between 0.1% and 50%');
  }

  const swapAmountNano = toNano(s);

  // ---- Compute fee (integer math; bigint) ----
  // fee = swapAmount * 75 / 10000   (truncates; the rest of the value
  // goes into the swap message).
  const feeNano = (swapAmountNano * BigInt(FEE_BPS)) / BigInt(FEE_BPS_DENOMINATOR);
  if (feeNano <= 0n) {
    throw new Error('Fee would round to zero — amount too small');
  }

  // The swap message gets the FULL user-entered amount (we don't deduct
  // the fee from it). The user signs for swap + fee + gas total. This
  // matches what Photon/Bananagun/Maestro do and is the clearest UX.
  // Their wallet shows: "Send 5.0375 TON" with two messages totalling that.

  // ---- Quote the swap ----
  const quote = await getTonToJettonQuote(jettonAddress, swapAmountNano);
  const estOutNano = quote.amountOut;

  // Apply slippage to compute min-out
  //   minOut = estOut * (1 - slippage/100)
  //         = estOut * (10000 - slippage*100) / 10000   (integer-safe)
  const slipBps = Math.round(slippagePct * 100);  // 1% → 100 bps
  const minOutNano = (estOutNano * BigInt(10000 - slipBps)) / 10000n;
  if (minOutNano <= 0n) {
    throw new Error('Slippage too high or pool too thin');
  }

  // ---- Build the swap message ----
  const { address: vaultAddress } = await getNativeVault();
  const swapBody = buildTonSwapBody({
    poolAddress: quote.poolAddress,
    amount: swapAmountNano,
    minOut: minOutNano,
    queryId: 0n,
    recipientAddress: recipient,
  });

  const swapMessage = {
    address: vaultAddress.toString({ urlSafe: true, bounceable: true }),
    amount: (swapAmountNano + SWAP_GAS).toString(),
    payload: swapBody.toBoc().toString('base64'),
  };

  // ---- Build the fee message ----
  const feeMessage = buildFeeMessage(feeNano);

  // ---- Build the TON Connect transaction ----
  const tcTransaction = {
    validUntil: Math.floor(Date.now() / 1000) + 300,  // 5 minutes
    messages: [
      feeMessage,   // index 0 — fee
      swapMessage,  // index 1 — swap
    ],
  };

  // ---- Hard invariants — assert before returning ----
  if (tcTransaction.messages.length !== 2) {
    throw new Error('Composer invariant violated: must produce exactly 2 messages');
  }
  if (tcTransaction.messages[0].address !== FEE_DESTINATION_FRIENDLY) {
    throw new Error(
      'Composer invariant violated: message[0].address is not the fee wallet'
    );
  }
  if (BigInt(tcTransaction.messages[0].amount) !== feeNano) {
    throw new Error('Composer invariant violated: fee amount mismatch');
  }

  return {
    swapAmountNano,
    feeNano,
    gasNano: SWAP_GAS,
    totalNano: swapAmountNano + feeNano + SWAP_GAS,
    estOutNano,
    minOutNano,
    priceImpact: quote.priceImpact,
    poolAddress: quote.poolAddress,
    tcTransaction,
  };
}

// ---- Helpers --------------------------------------------------------------

/**
 * Convert a decimal string like "123.456" with `decimals` decimal places to
 * a bigint nano-unit. Avoids JS float precision loss for large amounts.
 */
function decimalStringToNano(decStr, decimals) {
  const [intPart, fracPart = ''] = decStr.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals})`);
  }
  const paddedFrac = fracPart.padEnd(decimals, '0');
  return BigInt(intPart + paddedFrac);
}

// ---- Diagnostics ----------------------------------------------------------

export function getFeeConfig() {
  return {
    address: FEE_DESTINATION_FRIENDLY,
    bps: FEE_BPS,
    pct: FEE_BPS / 100,
  };
}

/**
 * Compose a SELL transaction: jetton → TON.
 *
 * For sells, the fee math is on the EXPECTED TON output (you pay 0.75% of
 * what you'll receive in TON). The fee comes from the user's TON balance,
 * NOT deducted from the swap output — keeping output predictable.
 *
 * The transaction has 2 messages:
 *   1. Fee message: 0.75% of estimated TON out → fee wallet (paid in TON)
 *   2. Sell message: jetton transfer to jetton vault with swap payload
 *
 * @param {object} params
 * @param {string} params.jettonAddress  Master address of jetton being sold
 * @param {string} params.userAddress    User's wallet (UQ... or EQ...)
 * @param {string} params.amountJettonStr  Amount of jettons to sell (human-readable)
 * @param {number} params.jettonDecimals  Decimals of the jetton (usually 9)
 * @param {number} params.slippagePct
 */
export async function composeSell({
  jettonAddress,
  userAddress,
  amountJettonStr,
  jettonDecimals = 9,
  slippagePct,
}) {
  if (!jettonAddress) throw new Error('jettonAddress required');
  if (!userAddress) throw new Error('userAddress required (wallet must be connected)');
  // Validate the user address parses (catches malformed wallet input early)
  try { Address.parse(userAddress); }
  catch (_) { throw new Error('Invalid user wallet address'); }

  if (typeof slippagePct !== 'number' || !isFinite(slippagePct) || slippagePct < 0.1 || slippagePct > 50) {
    throw new Error('Slippage must be between 0.1% and 50%');
  }
  if (!Number.isInteger(jettonDecimals) || jettonDecimals < 0 || jettonDecimals > 30) {
    throw new Error('Invalid jetton decimals');
  }

  // Strict numeric input check
  if (typeof amountJettonStr !== 'string' && typeof amountJettonStr !== 'number') {
    throw new Error('Amount must be a string or number');
  }
  const s = String(amountJettonStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error('Amount must be a plain decimal number');
  }
  // Convert decimal string to bigint nano without going through float (which
  // loses precision for amounts > ~15 significant digits).
  const amountJettonNano = decimalStringToNano(s, jettonDecimals);
  if (amountJettonNano <= 0n) {
    throw new Error('Invalid jetton amount');
  }

  // ---- Get TON-out quote ----
  const quote = await getJettonToTonQuote(jettonAddress, amountJettonNano);
  const estTonOutNano = quote.amountOut;

  if (estTonOutNano <= 0n) {
    throw new Error('Pool has insufficient liquidity for this trade');
  }

  // ---- Fee = 0.75% of expected TON output, paid in TON ----
  const feeNano = (estTonOutNano * BigInt(FEE_BPS)) / BigInt(FEE_BPS_DENOMINATOR);
  if (feeNano <= 0n) {
    throw new Error('Trade too small — fee would round to zero');
  }

  // ---- Min-out after slippage ----
  const slipBps = Math.round(slippagePct * 100);
  const minOutNano = (estTonOutNano * BigInt(10000 - slipBps)) / 10000n;
  if (minOutNano <= 0n) {
    throw new Error('Slippage too high or pool too thin');
  }

  // ---- Build the jetton-transfer + swap message ----
  const userJettonWallet = await getUserJettonWalletAddress(jettonAddress, userAddress);
  const sellMessage = await _buildJettonTransferAndSwap({
    jettonAddress,
    userJettonWallet,
    jettonAmount: amountJettonNano,
    poolAddress: quote.poolAddress,
    minOut: minOutNano,
    userAddress: Address.parse(userAddress),
  });

  // ---- Fee message ----
  const feeMessage = buildFeeMessage(feeNano);

  const tcTransaction = {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [feeMessage, sellMessage],
  };

  // Invariants
  if (tcTransaction.messages[0].address !== FEE_DESTINATION_FRIENDLY) {
    throw new Error('Composer invariant violated: fee address mismatch on sell');
  }
  if (BigInt(tcTransaction.messages[0].amount) !== feeNano) {
    throw new Error('Composer invariant violated: fee amount mismatch on sell');
  }

  return {
    direction: 'sell',
    sellAmountNano: amountJettonNano,
    feeNano,
    gasNano: BigInt(sellMessage.amount),  // jetton-transfer gas IS the message value
    totalTonNano: feeNano + BigInt(sellMessage.amount),
    estOutNano: estTonOutNano,            // TON output
    minOutNano,                            // TON minimum
    priceImpact: quote.priceImpact,
    poolAddress: quote.poolAddress,
    tcTransaction,
  };
}
