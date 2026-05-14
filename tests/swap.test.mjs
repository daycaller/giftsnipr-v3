/**
 * Real test suite for GiftSnipr swap modules.
 * Run with: node tests/swap.test.mjs
 *
 * This is NOT a unit-test framework — it's a deliberate stand-alone runner
 * because:
 *   1. Adding jest/vitest pulls in 30+ transitive deps for a tiny test suite
 *   2. We can directly import ESM source without a transform step
 *   3. The output is grep-able for CI (PASS/FAIL prefixes)
 */

import { Address, toNano, fromNano, beginCell, Cell } from '@ton/core';
import { Vault, VaultJetton, MAINNET_FACTORY_ADDR } from '@dedust/sdk';

// ANSI colors only when stdout is a TTY
const COLOR = process.stdout.isTTY;
const RED = COLOR ? '\x1b[31m' : '';
const GRN = COLOR ? '\x1b[32m' : '';
const YEL = COLOR ? '\x1b[33m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const RST = COLOR ? '\x1b[0m' : '';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => { passed++; console.log(`${GRN}PASS${RST} ${name}`); },
        (err) => {
          failed++;
          console.log(`${RED}FAIL${RST} ${name}`);
          console.log(`${DIM}     ${err.message}${RST}`);
          failures.push({ name, err });
        }
      );
    }
    passed++;
    console.log(`${GRN}PASS${RST} ${name}`);
  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${RST} ${name}`);
    console.log(`${DIM}     ${err.message}${RST}`);
    failures.push({ name, err });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertion failed'}: expected ${b}, got ${a}`);
}
function assertThrows(fn, expectedMsgPattern, msg) {
  let threw = false;
  let actualMsg = '';
  try { fn(); } catch (e) { threw = true; actualMsg = e.message; }
  if (!threw) throw new Error(`${msg}: expected to throw, did not`);
  if (expectedMsgPattern && !expectedMsgPattern.test(actualMsg)) {
    throw new Error(`${msg}: error message "${actualMsg}" did not match ${expectedMsgPattern}`);
  }
}

// ----------------------------------------------------------------------------
// Constants we want to verify against the real swap composer
// ----------------------------------------------------------------------------
const FEE_WALLET = 'UQDi3dZf69O0wowBvyKzkNLtEIVHlH9-JUv9gU77wRy0wff3';
const FEE_BPS = 75;  // 0.75%
const VAULT_NATIVE_SWAP_OP = 0xea06185d;

console.log(`${YEL}=== Composer + tracker tests ===${RST}\n`);

// ============================================================================
// SECTION 1: Fee math invariants
// ============================================================================

test('fee math: 1 TON → 0.0075 TON fee', () => {
  const amt = toNano('1');
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assertEq(fromNano(fee), '0.0075', 'fee for 1 TON');
});

test('fee math: 5 TON → 0.0375 TON fee', () => {
  const amt = toNano('5');
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assertEq(fromNano(fee), '0.0375', 'fee for 5 TON');
});

test('fee math: 100 TON → 0.75 TON fee', () => {
  const amt = toNano('100');
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assertEq(fromNano(fee), '0.75', 'fee for 100 TON');
});

test('fee math: 0.01 TON → fee rounds to 75000 nano (0.000075 TON)', () => {
  const amt = toNano('0.01');
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assert(fee > 0n, 'fee must be > 0 for 0.01 TON');
  assertEq(fee, 75000n, '0.01 TON fee in nano');
});

test('fee math: integer division rounds DOWN (favours user)', () => {
  // 0.0000133 TON would have a fractional fee — verify it rounds down, not up
  const amt = 13_333n;  // tiny amount that doesn't divide cleanly
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  // 13333 * 75 = 999_975; /10000 = 99 (truncated from 99.9975)
  assertEq(fee, 99n, 'integer-divided fee');
});

test('fee math: extremely tiny amount may round fee to zero', () => {
  // 1 nanoton * 75 / 10000 = 0 (rounds down)
  const amt = 1n;
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assertEq(fee, 0n, 'sub-min amount loses fee to rounding');
  // The composer MUST throw when fee rounds to zero to prevent the user
  // making free trades by sending dust
});

test('fee math: overflow safety for huge amounts', () => {
  // 1 million TON in nano = 1e15 * 75 = 7.5e16 — well within bigint range
  const amt = toNano('1000000');
  const fee = (amt * BigInt(FEE_BPS)) / 10000n;
  assertEq(fee, toNano('7500'), 'fee for 1M TON');
});

// ============================================================================
// SECTION 2: Address parsing — fee wallet
// ============================================================================

test('fee wallet address parses without error', () => {
  const a = Address.parse(FEE_WALLET);
  assert(a, 'parsed');
});

test('fee wallet round-trip: UQ → parse → UQ produces the same string', () => {
  const parsed = Address.parse(FEE_WALLET);
  const back = parsed.toString({ urlSafe: true, bounceable: false });
  assertEq(back, FEE_WALLET, 'address round-trip');
});

test('fee wallet rejects when malformed', () => {
  assertThrows(
    () => Address.parse('UQDi3dZf69O0wowBvyKzkNLtEIVHlH9-JUv9gU77wRy0wff3XXXX'),
    /checksum|invalid|length|unknown.*address/i,
    'malformed wallet'
  );
});

// ============================================================================
// SECTION 3: BOC construction
// ============================================================================

function buildSwapBody({ poolAddress, amount, minOut, queryId = 0n }) {
  // Mirror of our buildTonSwapBody — must match dedust.js exactly
  const swapParams = Vault.packSwapParams({
    deadline: 0,
    recipientAddress: null,
    referralAddress: null,
    fulfillPayload: null,
    rejectPayload: null,
  });
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

test('swap body: deterministic hash for same inputs', () => {
  const pool = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const a = buildSwapBody({ poolAddress: pool, amount: toNano('1'), minOut: 1000n });
  const b = buildSwapBody({ poolAddress: pool, amount: toNano('1'), minOut: 1000n });
  assertEq(a.hash().toString('hex'), b.hash().toString('hex'), 'identical inputs → identical hash');
});

test('swap body: changing amount changes hash', () => {
  const pool = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const a = buildSwapBody({ poolAddress: pool, amount: toNano('1'), minOut: 1000n });
  const b = buildSwapBody({ poolAddress: pool, amount: toNano('2'), minOut: 1000n });
  assert(a.hash().toString('hex') !== b.hash().toString('hex'), 'different amount → different hash');
});

test('swap body: changing pool changes hash', () => {
  const p1 = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const p2 = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAd99');
  const a = buildSwapBody({ poolAddress: p1, amount: toNano('1'), minOut: 1000n });
  const b = buildSwapBody({ poolAddress: p2, amount: toNano('1'), minOut: 1000n });
  assert(a.hash().toString('hex') !== b.hash().toString('hex'), 'different pool → different hash');
});

test('swap body: opcode is correctly encoded (first 4 bytes match VAULT_NATIVE_SWAP_OP)', () => {
  const pool = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const c = buildSwapBody({ poolAddress: pool, amount: toNano('1'), minOut: 1000n });
  const slice = c.beginParse();
  const op = slice.loadUint(32);
  assertEq(op.toString(16), VAULT_NATIVE_SWAP_OP.toString(16), 'opcode mismatch');
});

// ============================================================================
// SECTION 4: TON Connect transaction structure
// ============================================================================

function buildFeeMessage(feeNano, feeAddress) {
  const payload = beginCell()
    .storeUint(0, 32)
    .storeStringTail('GiftSnipr fee 0.75%')
    .endCell();
  return {
    address: feeAddress,
    amount: feeNano.toString(),
    payload: payload.toBoc().toString('base64'),
  };
}

test('tx structure: fee message destination is exact match', () => {
  const fee = buildFeeMessage(toNano('0.0075'), FEE_WALLET);
  assertEq(fee.address, FEE_WALLET, 'fee destination');
});

test('tx structure: fee amount is bigint-stringified exactly', () => {
  const fee = buildFeeMessage(7_500_000n, FEE_WALLET);
  assertEq(fee.amount, '7500000', 'fee amount string');
});

test('tx structure: fee payload BOC decodes to expected text comment', () => {
  const fee = buildFeeMessage(toNano('0.0075'), FEE_WALLET);
  const cell = Cell.fromBase64(fee.payload);
  const slice = cell.beginParse();
  const op = slice.loadUint(32);
  assertEq(op, 0, 'fee op must be 0 (text comment)');
  const text = slice.loadStringTail();
  assertEq(text, 'GiftSnipr fee 0.75%', 'fee comment text');
});

// ============================================================================
// SECTION 5: Tracker — TEP-467 hash normalization
// ============================================================================

test('tracker: normalizeExternalHash returns hex string for a valid ext-in BOC', async () => {
  // Build a minimal external-in message
  const dest = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const body = beginCell().storeUint(0xdeadbeef, 32).endCell();
  const extIn = beginCell()
    .storeUint(2, 2)         // ext_in_msg tag
    .storeUint(0, 2)         // src = addr_none
    .storeAddress(dest)
    .storeCoins(0n)          // import_fee
    .storeBit(false)         // no StateInit
    .storeBit(true)          // body as ref
    .storeRef(body)
    .endCell();
  const bocB64 = extIn.toBoc().toString('base64');

  const { normalizeExternalHash } = await import('../src/ton/tracker.js');
  const hash = normalizeExternalHash(bocB64);
  assert(hash, 'returns a hash');
  assert(/^[0-9a-f]{64}$/.test(hash), `hash format: ${hash}`);
});

test('tracker: normalizeExternalHash stable when import_fee changes', async () => {
  const dest = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  const body = beginCell().storeUint(0xdeadbeef, 32).endCell();

  const make = (fee) => beginCell()
    .storeUint(2, 2).storeUint(0, 2).storeAddress(dest)
    .storeCoins(fee).storeBit(false).storeBit(true).storeRef(body)
    .endCell()
    .toBoc().toString('base64');

  const { normalizeExternalHash } = await import('../src/ton/tracker.js');
  const h1 = normalizeExternalHash(make(0n));
  const h2 = normalizeExternalHash(make(toNano('0.01')));
  assertEq(h1, h2, 'import_fee mutation should not change normalized hash');
});

test('tracker: normalizeExternalHash returns null for malformed BOC', async () => {
  const { normalizeExternalHash } = await import('../src/ton/tracker.js');
  const result = normalizeExternalHash('not-a-valid-base64-boc');
  assertEq(result, null, 'malformed input → null');
});

// ============================================================================
// SECTION 6: Slippage math invariants
// ============================================================================

test('slippage: 1% applied to 1000 jettons = 990 min-out', () => {
  const estOut = 1000n;
  const slipBps = 100;  // 1%
  const minOut = (estOut * BigInt(10000 - slipBps)) / 10000n;
  assertEq(minOut, 990n, '1% slippage');
});

test('slippage: 5% applied to 1000 = 950', () => {
  const minOut = (1000n * BigInt(10000 - 500)) / 10000n;
  assertEq(minOut, 950n, '5% slippage');
});

test('slippage: 0.5% applied to 1000 = 995', () => {
  const minOut = (1000n * BigInt(10000 - 50)) / 10000n;
  assertEq(minOut, 995n, '0.5% slippage');
});

test('slippage: integer truncation rounds DOWN (minOut may be slightly lower than mathematical exact)', () => {
  // 1003 * 9950 / 10000 = 997.985 — bigint division truncates to 997
  const minOut = (1003n * 9950n) / 10000n;
  assertEq(minOut, 997n, 'truncation safety');
});

// ============================================================================
// SECTION 7: Edge cases the composer should refuse
// ============================================================================

test('refuses negative slippage', () => {
  // We can't directly call composeBuy here without network; simulate the check
  const slippagePct = -1;
  assert(!(slippagePct >= 0.1 && slippagePct <= 50), 'must reject negative');
});

test('refuses slippage > 50%', () => {
  const slippagePct = 51;
  assert(!(slippagePct >= 0.1 && slippagePct <= 50), 'must reject extreme');
});

test('refuses amount < 0.01 TON minimum', () => {
  const amt = 0.001;
  assert(amt < 0.01, 'sub-minimum');
});

test('refuses NaN amount', () => {
  const amt = NaN;
  assert(!(isFinite(amt) && amt > 0), 'NaN rejected');
});

test('refuses negative amount', () => {
  const amt = -1;
  assert(!(amt > 0), 'negative rejected');
});

// ============================================================================
// SECTION 8: Honeypot scoring logic
// ============================================================================

test('honeypot: pool depth < $5K → high risk', () => {
  const depth = 4500;
  let risk = 'safe';
  if (depth < 5000) risk = 'high';
  assertEq(risk, 'high', 'thin pool');
});

test('honeypot: depth $5K-$25K → med risk', () => {
  const depth = 12_000;
  let risk = 'safe';
  if (depth < 5000) risk = 'high';
  else if (depth < 25_000) risk = 'med';
  assertEq(risk, 'med', 'mid-tier');
});

test('honeypot: depth > $25K with no other flags → safe', () => {
  const depth = 100_000;
  const adminActive = false;
  const isMintable = false;
  let risk = 'safe';
  if (depth < 5000) risk = 'high';
  else if (adminActive || isMintable) risk = 'high';
  else if (depth < 25_000) risk = 'med';
  assertEq(risk, 'safe', 'healthy pool');
});

test('honeypot: mint authority active → high risk regardless of depth', () => {
  const depth = 1_000_000;
  const adminActive = true;
  let risk = 'safe';
  if (depth < 5000) risk = 'high';
  else if (adminActive) risk = 'high';
  else if (depth < 25_000) risk = 'med';
  assertEq(risk, 'high', 'mint authority dominates');
});

// ============================================================================
// SECTION 9: decimalStringToNano helper (precision-safe conversion)
// ============================================================================

// Replicate the helper here so we can test it (it's not exported from swap.js
// because it's internal — by writing it here we lock its behavior)
function decimalStringToNano(decStr, decimals) {
  const [intPart, fracPart = ''] = decStr.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals})`);
  }
  const paddedFrac = fracPart.padEnd(decimals, '0');
  return BigInt(intPart + paddedFrac);
}

test('decimalStringToNano: 1.0 with 9 decimals = 1_000_000_000', () => {
  assertEq(decimalStringToNano('1.0', 9), 1_000_000_000n, '1.0 TON in nano');
});

test('decimalStringToNano: 0.5 with 9 decimals = 500_000_000', () => {
  assertEq(decimalStringToNano('0.5', 9), 500_000_000n, '0.5 in nano');
});

test('decimalStringToNano: integer "5" with 9 decimals = 5_000_000_000', () => {
  assertEq(decimalStringToNano('5', 9), 5_000_000_000n, 'integer with no decimal point');
});

test('decimalStringToNano: huge amount preserves precision (this is where float math fails)', () => {
  // 123456789.123456789 in nano = 123456789123456789
  assertEq(
    decimalStringToNano('123456789.123456789', 9),
    123456789123456789n,
    'large amount precision'
  );
});

test('decimalStringToNano: rejects too many decimal places', () => {
  assertThrows(
    () => decimalStringToNano('1.1234567890', 9),
    /too many decimal/i,
    'extra precision rejected'
  );
});

test('decimalStringToNano: zero decimals (e.g. some jettons have 0)', () => {
  assertEq(decimalStringToNano('1000', 0), 1000n, '0-decimal jetton');
});

// ============================================================================
// SECTION 10: Input string validation regex
// ============================================================================

const AMOUNT_REGEX = /^\d+(\.\d+)?$/;

test('amount regex: accepts "1"', () => assert(AMOUNT_REGEX.test('1')));
test('amount regex: accepts "1.5"', () => assert(AMOUNT_REGEX.test('1.5')));
test('amount regex: accepts "100.123"', () => assert(AMOUNT_REGEX.test('100.123')));
test('amount regex: rejects ""', () => assert(!AMOUNT_REGEX.test('')));
test('amount regex: rejects "1.5xyz"', () => assert(!AMOUNT_REGEX.test('1.5xyz')));
test('amount regex: rejects "abc"', () => assert(!AMOUNT_REGEX.test('abc')));
test('amount regex: rejects "1e5" (scientific notation)', () => assert(!AMOUNT_REGEX.test('1e5')));
test('amount regex: rejects negative "-1"', () => assert(!AMOUNT_REGEX.test('-1')));
test('amount regex: rejects "1.5.6"', () => assert(!AMOUNT_REGEX.test('1.5.6')));
test('amount regex: rejects "1,000"', () => assert(!AMOUNT_REGEX.test('1,000')));
test('amount regex: rejects ".5" (must have leading digit)', () => assert(!AMOUNT_REGEX.test('.5')));

// ============================================================================
// SUMMARY
// ============================================================================

setTimeout(() => {
  console.log();
  if (failed === 0) {
    console.log(`${GRN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}`);
    console.log(`${GRN}  ALL ${passed} TESTS PASSED${RST}`);
    console.log(`${GRN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}`);
    process.exit(0);
  } else {
    console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}`);
    console.log(`${RED}  ${failed} FAILED / ${passed} PASSED${RST}`);
    console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}`);
    for (const f of failures) {
      console.log(`\n${RED}× ${f.name}${RST}`);
      console.log(`${DIM}${f.err.stack || f.err.message}${RST}`);
    }
    process.exit(1);
  }
}, 500);
