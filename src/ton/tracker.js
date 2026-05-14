// ============================================================================
//  Transaction tracker — post-broadcast confirmation polling
//
//  When TON Connect returns from sendTransaction(), the wallet has signed
//  the external-in message and forwarded it to the network — but it isn't
//  yet confirmed on-chain. There's a 5-30 second window where the user
//  doesn't know if their swap succeeded.
//
//  This module:
//    1. Takes the BOC returned by sendTransaction
//    2. Normalizes the external-in message hash (TEP-467) — wallets may
//       have mutated parts of the msg, so the raw cell hash won't reliably
//       match what's on-chain
//    3. Polls TonAPI's /v2/traces/{hash} with exponential backoff
//    4. Surfaces confirmed / failed / timeout to the UI
//
//  TonAPI public endpoint: https://tonapi.io  (no key needed)
//  This is *informational* — if it fails (CORS, network), we degrade
//  gracefully to "broadcast, check your wallet" without breaking the
//  user's perception of the swap.
// ============================================================================

import { Cell, beginCell } from '@ton/core';

const TONAPI_BASE = 'https://tonapi.io/v2';

/**
 * Normalize an external-in message hash per TEP-467.
 *
 * Wallets and relayers may modify some fields of the external-in message
 * before it lands on-chain (e.g. import_fee, src). To find the resulting
 * transaction, we re-encode just the canonical fields (dest, body).
 *
 * @param {string} bocBase64
 * @returns {string|null} hex-encoded normalized hash, or null if parsing fails
 */
export function normalizeExternalHash(bocBase64) {
  try {
    const cell = Cell.fromBase64(bocBase64);
    const slice = cell.beginParse();

    // ext_in_msg_info$10 — tag 10 binary
    const tag = slice.loadUint(2);
    if (tag !== 2) {
      // Not an external-in; fall back to raw hash
      return cell.hash().toString('hex');
    }

    // src is MsgAddressExt — NOT a standard MsgAddressInt. The SDK's
    // loadAddress() crashes on this. We parse the tag manually:
    //   addr_none$00            = MsgAddressExt
    //   addr_extern$01 len:9 ...= MsgAddressExt
    const srcTag = slice.loadUint(2);
    if (srcTag === 1) {
      // addr_extern: read len, skip that many bits
      const len = slice.loadUint(9);
      slice.loadBits(len);  // discard external address payload
    }
    // (srcTag === 0 = addr_none, nothing to skip)

    const dest = slice.loadAddress();   // dest IS a MsgAddressInt — loadAddress works
    slice.loadCoins();                   // import_fee (discard, normalized to 0)

    // After CommonMsgInfo: init_flag bit, then body
    if (slice.loadBit()) {
      // Has StateInit — too complex to canonicalize reliably; fall back
      return cell.hash().toString('hex');
    }
    let body;
    if (slice.loadBit()) {
      body = slice.loadRef();  // body as ref
    } else {
      const bb = beginCell();
      bb.storeBits(slice.loadBits(slice.remainingBits));
      while (slice.remainingRefs > 0) bb.storeRef(slice.loadRef());
      body = bb.endCell();
    }

    const normalized = beginCell()
      .storeUint(2, 2)         // ext_in_msg tag
      .storeUint(0, 2)         // src = addr_none
      .storeAddress(dest)
      .storeCoins(0n)          // import_fee = 0
      .storeBit(false)         // no StateInit
      .storeBit(true)          // body as ref
      .storeRef(body)
      .endCell();

    return normalized.hash().toString('hex');
  } catch (e) {
    console.warn('[tracker] normalization failed:', e.message);
    try {
      return Cell.fromBase64(bocBase64).hash().toString('hex');
    } catch (_) {
      return null;
    }
  }
}

async function fetchTrace(normalizedHash) {
  const url = `${TONAPI_BASE}/traces/${normalizedHash}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;   // not yet indexed
    if (!res.ok) throw new Error(`TonAPI ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspect a trace to determine success/failure.
 *
 * For swaps: if DeDust's slippage protection kicks in, the vault sends
 * the TON BACK to the user. We detect this by walking the trace and
 * checking each transaction's compute/action phase status.
 */
function summarizeTrace(trace) {
  if (!trace || !trace.transaction) {
    return { confirmed: false, success: false, reason: 'No trace data' };
  }
  const tx = trace.transaction;
  let anyFailed =
    (tx.compute_phase && tx.compute_phase.success === false) ||
    (tx.action_phase && tx.action_phase.success === false);

  const walk = (node) => {
    if (!node || !node.children) return;
    for (const child of node.children) {
      const ct = child.transaction;
      if (ct) {
        if (ct.compute_phase && ct.compute_phase.success === false) anyFailed = true;
        if (ct.action_phase && ct.action_phase.success === false) anyFailed = true;
      }
      walk(child);
    }
  };
  walk(trace);

  return {
    confirmed: true,
    success: !anyFailed,
    reason: anyFailed
      ? 'On-chain execution failed (likely slippage exceeded or pool reverted)'
      : null,
    traceId: tx.hash || null,
  };
}

/**
 * Track a transaction to confirmation. Calls onUpdate with status changes:
 *   'normalizing' → 'polling' → 'confirmed' | 'failed' | 'timeout'
 */
export async function trackTransaction(bocBase64, {
  onUpdate = () => {},
  maxWaitMs = 60_000,
} = {}) {
  onUpdate('normalizing', {});
  const normalizedHash = normalizeExternalHash(bocBase64);
  if (!normalizedHash) {
    return { status: 'unknown', reason: 'Could not normalize message hash' };
  }
  onUpdate('polling', { hash: normalizedHash });

  let delay = 2000;
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < maxWaitMs) {
    attempt++;
    await sleep(delay);
    try {
      const trace = await fetchTrace(normalizedHash);
      if (trace) {
        const summary = summarizeTrace(trace);
        if (summary.confirmed) {
          const status = summary.success ? 'confirmed' : 'failed';
          onUpdate(status, { ...summary, hash: normalizedHash });
          return { status, summary, hash: normalizedHash };
        }
      }
    } catch (e) {
      console.warn('[tracker] poll attempt', attempt, 'failed:', e.message);
    }
    onUpdate('polling', { attempt, hash: normalizedHash, elapsedMs: Date.now() - startedAt });
    delay = Math.min(delay + 1000, 8000);
  }

  onUpdate('timeout', { hash: normalizedHash });
  return { status: 'timeout', hash: normalizedHash };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
//  Compatibility exports — match what coins/ui.js already calls
// ============================================================================

/**
 * Build a TonViewer URL for a transaction hash (hex string).
 */
export function tonviewerTxLink(hashHex) {
  if (!hashHex) return null;
  return `https://tonviewer.com/transaction/${hashHex}`;
}

/**
 * Track a transaction with a single callback (status, details).
 * Wraps trackTransaction in the API the UI expects.
 *
 * Status values emitted to callback:
 *   'pending'  — still polling; details = { elapsedMs, attempt, msgHash }
 *   'success'  — confirmed and succeeded; details = { msgHash, elapsedMs }
 *   'failed'   — confirmed but reverted; details = { msgHash, reason }
 *   'timeout'  — gave up; details = { msgHash }
 */
export function track(bocBase64, callback) {
  const startedAt = Date.now();
  return trackTransaction(bocBase64, {
    onUpdate: (status, detail) => {
      const elapsedMs = Date.now() - startedAt;
      const msgHash = detail.hash;
      if (status === 'polling') callback('pending', { elapsedMs, attempt: detail.attempt, msgHash });
      else if (status === 'confirmed') callback('success', { msgHash, elapsedMs, ...detail });
      else if (status === 'failed') callback('failed', { msgHash, reason: detail.reason });
      else if (status === 'timeout') callback('timeout', { msgHash });
    },
    maxWaitMs: 90_000,
  });
}
