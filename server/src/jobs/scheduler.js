import { expireStaleOrders, sendPickupReminders } from '../services/orders.js';
import { refreshOfferStates } from '../services/offers.js';

/**
 * Housekeeping the product depends on: windows close, unclaimed orders expire,
 * and customers get a nudge an hour before pickup. Runs in-process because one
 * node is plenty at this size; move it to a worker when you scale out.
 */
export function startScheduler({ intervalMs = 60_000 } = {}) {
  const tick = () => {
    try {
      refreshOfferStates();
      const expired = expireStaleOrders();
      const reminded = sendPickupReminders();
      if (expired || reminded) console.log(`[scheduler] expired=${expired} reminded=${reminded}`);
    } catch (err) {
      console.error('[scheduler] failed', err);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
