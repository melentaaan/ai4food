# Who sees what

Three audiences share one database. This page is the contract between them:
what each role is shown, what they are deliberately not shown, and where that
is enforced. Every line here is covered by a test in `test/api.test.js`
(`describe('who sees what')`).

Enforcement happens in three layers, and a leak has to get through all three:

1. **Routing** — `requireAuth`, `requireRole('admin')`, `requireMerchant`
   (`src/middleware/auth.js`). A customer token cannot reach `/api/admin/*`.
2. **Query scoping** — customer queries are filtered by `user_id`, merchant
   queries by `merchant_id`. There is no unfiltered "all orders" query outside
   the admin routes.
3. **Presenters** — `src/presenters.js` decides which columns become JSON.
   Routes never return a raw database row, so a new column cannot leak by
   being added to a table.

---

## The customer (`role: customer`)

Signs in with a phone number and a 6-digit code. Sees the marketplace and
their own history, nothing else.

### Sees

| Area | Detail |
| --- | --- |
| Catalogue | Every live basket from an **approved** shop: name, photo key, price, shop value, discount, stock left, pickup window, shop name, address, rating, distance |
| Ranking | Their own match score, the six factors and the reasons behind it (`GET /api/offers/:id` → `why`) |
| Shops | The map of all 78 shops, partner or not, with a live-offer count; may invite a shop that is not a partner yet |
| Their orders | Full detail: **pickup code**, quantity, amount paid, shop value, saving, status, pickup window, payment method |
| Their impact | Meals saved, CO₂e avoided, money saved — computed from their collected orders only |
| Their notifications | Order confirmations, pickup reminders, new baskets from shops they follow |
| Their profile | Their own phone number in full, zone, language |

### Does not see

- Anyone else's orders. Fetching another customer's order id returns **404**,
  not 403 — a stranger's id is indistinguishable from one that does not exist.
- Commission or payout figures. The word `commission` never appears in a
  customer response; the split between AI4Food and the shop is not their business.
- Any shop's takings, stock history, forecast, or customer list.
- Platform totals, user counts, the merchant pipeline, the audit log.
- Draft or cancelled offers, or offers from shops that are not approved.

---

## The merchant (`role: merchant`)

Signs in with a password. Attached to exactly one shop through
`merchant_users`; `requireMerchant` resolves it from the token, so the shop id
is never taken from the request body.

### Sees

| Area | Detail |
| --- | --- |
| Their offers | Everything, including drafts, cancelled ones, quantity published, quantity sold, revenue per offer |
| Their orders | Pickup code, quantity, amount, status, and a **masked customer**: `Aïssatou N.` and `••• 45 67` |
| Their money | Gross, AI4Food commission, and their payout — per order and per day |
| Their day | Baskets reserved, awaiting pickup, collected, cash taken, stock left |
| Their forecast | Tomorrow's predicted surplus, a suggested price and window, model confidence and what it is based on |
| Their pickup rate | Collected ÷ (collected + expired), for their shop |

### Does not see

- Any other shop's offers, orders, revenue or forecast. Editing another shop's
  offer returns **404**.
- The customer's full phone number, id, email, or their orders anywhere else.
  A merchant learns nothing about a customer beyond the basket in front of them.
- Platform-wide figures, the shop pipeline, other merchants' commission rates.
- The audit log, the user directory, payouts for anyone but themselves.

### Cannot do

- Publish while the shop is `pending`, `prospect` or `suspended` — **403**
  until an admin approves it.
- Validate a code issued by another shop — **404**.
- Reduce an offer's quantity below what customers already reserved — **409**.
- Delete an offer with live reservations. Pulling an offer sets `qty_left = 0`
  and marks it cancelled; existing codes stay valid and the response says how
  many still have to be honoured.

---

## The admin (`role: admin`)

AI4Food staff. Signs in with a password. Sees the whole platform, and every
privileged action they take is written to the audit log with their name on it.

### Sees

| Area | Detail |
| --- | --- |
| Today | Baskets sold, orders, gross volume, commission earned, active users |
| All time | Meals saved, CO₂e avoided, pickup rate, retail value of food rescued |
| Trend | Baskets, gross and commission per day for the last *n* days |
| Every order | Both sides: shop, offer, code, money, commission, payout, and a masked customer with their id (support needs to link an order to an account) |
| The pipeline | All shops by status — `prospect` → `pending` → `active` → `suspended` — with customer invite counts, live offers and lifetime gross |
| People | Every user: role, status, orders placed, lifetime spend, last seen — phone numbers **masked**, as they are for merchants |
| Money | Payouts per shop for a period: gross, commission, what AI4Food owes them |
| Moderation | Every offer including drafts and cancelled, and the ability to pull any of them |
| The paper trail | Who approved which shop, who suspended whom, who cancelled which order and why |

### Can do

- Approve, suspend, or re-price (commission) a shop. Suspending pulls its live
  stock in the same transaction.
- Create a shop and its first staff account.
- Suspend a user or change a role — which revokes their refresh tokens, so
  sessions already handed out die immediately.
- Cancel an order outside the customer's 2-hour window (a support call), which
  refunds it, restores the stock and requires a written reason.

### Does not see, ever

- **Password hashes and OTP codes.** No endpoint at any role serialises
  `password_hash` or `code_hash`; there is a test asserting the strings never
  appear in a response body.
- **Full phone numbers** in list views. Admins get the same `••• 45 67` mask as
  merchants. If your jurisdiction requires staff to see a full number for
  support, add a single audited endpoint for it rather than widening the lists.

### Cannot do

- Lock themselves out: demoting or suspending your own admin account is a
  **409**.

---

## Anonymous visitors

Can browse: `GET /api/offers`, `/api/offers/:id`, `/api/merchants`,
`/api/merchants/:id`, `/api/meta`. Ranking still works, using distance and
timing only — there is no history to personalise with.

Cannot: order, favourite, invite a shop, or read anything under `/api/orders`,
`/api/me`, `/api/notifications`, `/api/merchant`, `/api/admin` — all **401**.

---

## The rules that are not about roles

These apply to everyone and live in `src/services/orders.js`:

- **Stock is decremented with a conditional UPDATE inside a transaction.** Two
  customers reaching for the last basket produce one `201` and one `409`; the
  count never goes negative.
- **Cancellation is free until 2 hours before pickup** (`CANCEL_WINDOW_MINUTES`),
  after which only an admin can do it.
- **A code can be validated once.** A second attempt is `409 already_picked_up`.
- **Cash orders are `pending` until collected**, then `paid`. Wallet payments
  are `paid` on reservation and `refunded` on cancellation.
- **Uncollected orders expire** one hour after the window closes
  (`PICKUP_GRACE_MINUTES`), which is what makes the pickup rate meaningful.
