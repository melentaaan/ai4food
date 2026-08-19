import { expireStaleOrders, sendPickupReminders } from '../services/orders.js';
import { refreshOfferStates } from '../services/offers.js';
import { sweepExpiredHolds } from '../services/payments.js';

/**
 * Housekeeping the product depends on: windows close, unclaimed orders expire,
 * abandoned checkouts give their bag back, and customers get a nudge an hour
 * before pickup. Runs in-process because one node is plenty at this size; move
 * it to a worker when you scale out.
 */
export function startScheduler({ intervalMs = 60_000 } = {}) {
  const tick = async () => {
    try {
      refreshOfferStates();
      const expired = expireStaleOrders();
      const reminded = sendPickupReminders();
      // Talks to the wallets, so it is the one slow step here.
      const released = await sweepExpiredHolds();
      if (expired || reminded || released) {
        console.log(`[scheduler] expired=${expired} reminded=${reminded} holds_released=${released}`);
      }
    } catch (err) {
      console.error('[scheduler] failed', err);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
