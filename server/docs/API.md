# AI4Food API

Base URL `/api`. JSON in, JSON out. Money is whole FCFA. Timestamps are unix
epoch milliseconds. Errors look like:

```json
{ "error": { "code": "out_of_stock", "message": "Someone just took the last one",
             "details": [{ "field": "qty", "message": "…" }] } }
```

| Status | Meaning |
| --- | --- |
| 400 `bad_request` | Validation failed; `details` names the fields |
| 401 `unauthorized` | Missing or expired token |
| 403 `forbidden` | Signed in, wrong role or unapproved shop |
| 404 `not_found` | Missing — or not yours, which is deliberately the same answer |
| 409 | Business conflict: `out_of_stock`, `already_picked_up`, `cancel_window_closed`, `below_sold`, `self_lockout`, `not_paid`, `payment_unavailable` |
| 429 `rate_limited` | Too many requests |
| 502 `sms_failed` | The gateway would not take the sign-in code |

Authenticate with `Authorization: Bearer <access_token>`. Access tokens last
15 minutes; refresh tokens last 30 days and rotate on every use.

---

## Auth

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/auth/otp/request` | anyone | `{phone, locale?}`. Sends the code by SMS; returns `dev_code` outside production. 502 if the gateway refused, and the code is retired with it |
| POST | `/auth/otp/verify` | anyone | `{phone, code, name?}`. Creates the account on first use |
| POST | `/auth/login` | staff | `{identifier, password}` for merchant and admin accounts |
| POST | `/auth/refresh` | anyone | `{refresh_token}` → new pair, old one dies |
| POST | `/auth/logout` | anyone | Revokes the refresh token |
| GET | `/auth/me` | signed in | Profile, plus the shop for merchant accounts |
| PATCH | `/auth/me` | signed in | `{name?, zone?, lat?, lng?, locale?}` |

Phone numbers normalise to E.164: `77 123 45 67`, `00221771234567` and
`+221771234567` are the same account.

## Catalogue (public)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/offers` | `category, q, merchant_id, sort=recommended\|price\|distance\|pickup, include_sold_out, limit, offset` |
| GET | `/offers/:id` | Offer plus `why`: match, six factors, reasons |
| PUT | `/offers/:id/favourite` | Signed in |
| DELETE | `/offers/:id/favourite` | Signed in |
| GET | `/favourites` | Signed in |
| GET | `/merchants` | `category, zone, q, partners_only` |
| GET | `/merchants/:id` | Shop plus its live offers |
| PUT | `/merchants/:id/follow` | Signed in — `{ following, followers }` |
| DELETE | `/merchants/:id/follow` | Signed in — `{ following, followers }` |
| GET | `/follows` | Signed in — shops followed, the ones with baskets live first |
| POST | `/merchants/:id/invite` | Signed in — asks AI4Food to onboard a shop |
| GET | `/meta` | Categories, zones, payment methods, locales |

Every offer carries `rank: { match, reasons, distance_km }` so the app can show
"why this basket" without a second call. Signed-in callers get a personalised
ranking; anonymous ones get distance and timing only.

A basket exists for one evening; the shop is what someone comes back for, so
**following is on the shop, not the basket**. Every merchant object carries
`followers` (a count, never a list of who) and, for a signed-in caller,
`following`. Publishing a new basket notifies the shop's followers — plus
anyone holding one of its baskets as a favourite, who has shown the same
interest by another route.

## Customer

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/orders` | `{offer_id, qty, payment_method, return_url?}` → 201. Cash books outright; a wallet returns `payment.checkout_url` and an order in `pending_payment` |
| POST | `/orders/:id/payment/refresh` | Asks the wallet what happened and settles the order |
| GET | `/orders` | `status?` — always scoped to the caller; also returns `for_me` |
| GET | `/orders/:id` | 404 if it is not theirs |
| POST | `/orders/:id/cancel` | Free until 2h before pickup; a paid wallet order is refunded. An unpaid hold can be dropped at any time |
| POST | `/orders/:id/transfer` | `{to_name?, note?}` → a link a friend collects with |
| DELETE | `/orders/:id/transfer` | Revokes it; the link already sent stops working |
| GET | `/pickup/:token` | **Public** — the bearer view of a handed-over bag |
| POST | `/pickup/:token/claim` | Signed in — puts it in the friend's own list |
| GET | `/me/impact` | Meals, CO₂e, money saved |
| GET | `/notifications` | Also generates due pickup reminders |
| POST | `/notifications/read` | `{ids?}`, or all |

### Paying

`GET /meta` lists `payment_methods` — cash, plus every wallet that has a
configured provider. Anything else is refused by `POST /orders`, so the app
cannot offer a payment route that does not exist.

Cash is a booking from the start: `status: "active"`, settled at the counter.

A wallet is not. Reserving holds the bag out of the catalogue and writes
`status: "pending_payment"` with a `payment_due_at`, and answers with a
`payment` object:

```json
{ "order": { "id": "…", "status": "pending_payment", "payment_due_at": 1787… },
  "payment": { "provider": "wave", "status": "pending",
               "checkout_url": "https://pay.wave.com/…", "expires_at": 1787… } }
```

Send the customer to `checkout_url`. Until it settles, the order is not
collectable (`409 not_paid` at the counter), cannot be handed to a friend,
does not appear on the merchant's counter and is in nobody's revenue.

It settles by whichever of these arrives first:

- the provider's signed callback to `POST /api/payments/:provider/webhook`;
- `POST /orders/:id/payment/refresh`, which asks the provider directly — this
  is what the app calls when the customer lands back on `return_url`;
- the scheduler, once `payment_due_at` passes: one last check with the
  provider, then the hold is dropped and the bag goes back on sale.

Callbacks are the only unauthenticated write in the API. Wave's `Wave-Signature`
HMAC is verified before anything is read; Orange Money is matched against the
`notif_token` issued at checkout. A callback that fails either is a 401, and one
naming a payment we do not know is answered 200 and ignored.

### Handing a reservation over

Someone books a bag and then cannot make the window. Rather than lose it they
send a link, and a friend collects. The bag is already paid for, so the link is
a **bearer token**: no account is needed to use it, because the person
receiving it on WhatsApp may not have one. Signing in and calling `claim` only
adds convenience — the bag then appears under `for_me` in their own `/orders`.

`GET /pickup/:token` returns what someone needs to walk in and collect and
nothing else: shop, address, window, bag, quantity, the code, the sender's
first name and their note. No amount paid, no phone number, no order id. The
order itself stays 404 for the friend.

Re-issuing is idempotent while the link is still good, so tapping share twice
does not break the link already sent; revoking or a second claim mints a new
token instead. Only the person who booked can hand a bag on, only while it is
`active` and its window is still open, and only one friend can accept.
`GET /merchant/orders` carries `bearer` so the counter is not surprised when
the name does not match the booking.

## Merchant

All scoped to the caller's shop. An admin may pass `?merchant_id=` to act on a
shop for support.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/merchant/profile` | Shop, status, commission |
| GET | `/merchant/offers` | `status?` — includes drafts and sold-out |
| POST | `/merchant/offers` | Requires an approved shop |
| PATCH | `/merchant/offers/:id` | Cannot drop quantity below what is reserved |
| POST | `/merchant/offers/:id/cancel` | Pulls remaining stock, honours live codes |
| GET | `/merchant/orders` | `status?` — masked customers |
| POST | `/merchant/pickups/validate` | `{code}` — the counter action |
| GET | `/merchant/stats` | `days?` — today, all time, daily series |
| GET | `/merchant/forecast` | Tomorrow's surplus, price and window |
| POST | `/merchant/forecast/publish` | Turns the forecast into a live offer |

## Admin

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/overview` | `days?` — today, all time, network, users, series |
| GET | `/admin/orders` | `status, merchant_id, user_id, q, limit, offset` |
| POST | `/admin/orders/:id/cancel` | `{reason}` — outside the customer window |
| GET | `/admin/merchants` | `status, q` — the pipeline with invite counts |
| POST | `/admin/merchants` | Create a shop |
| PATCH | `/admin/merchants/:id` | Approve, suspend, set commission |
| POST | `/admin/merchants/:id/staff` | Create the account that runs the counter |
| GET | `/admin/users` | `role, status, q` — masked phones, orders, spend |
| PATCH | `/admin/users/:id` | Role or status; revokes their sessions |
| GET | `/admin/offers` | Moderation view, all statuses |
| POST | `/admin/offers/:id/cancel` | `{reason}` |
| GET | `/admin/payouts` | `days?` — gross, commission, payout per shop |
| GET | `/admin/audit` | `action, entity_id` — the paper trail |
| POST | `/admin/maintenance/expire` | Runs the housekeeping pass by hand |

---

## Worked example

```bash
# 1. A customer signs in (development returns the code)
CODE=$(curl -s localhost:4000/api/auth/otp/request \
  -H 'content-type: application/json' \
  -d '{"phone":"+221771234567"}' | jq -r .dev_code)

TOKEN=$(curl -s localhost:4000/api/auth/otp/verify \
  -H 'content-type: application/json' \
  -d "{\"phone\":\"+221771234567\",\"code\":\"$CODE\"}" | jq -r .access_token)

# 2. Browse, ranked for them
OFFER=$(curl -s "localhost:4000/api/offers?sort=recommended" \
  -H "authorization: Bearer $TOKEN" | jq -r '.items[0].id')

# 3. Reserve. Cash is a booking outright, so the code is there and then.
curl -s localhost:4000/api/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"offer_id\":\"$OFFER\",\"qty\":1,\"payment_method\":\"cash\"}" | jq '.order.code'

# 3b. With a wallet instead, the answer is a checkout to send them to, and an
#     order that is held rather than booked until the money lands.
curl -s localhost:4000/api/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"offer_id\":\"$OFFER\",\"qty\":1,\"payment_method\":\"wave\"}" \
  | jq '{status: .order.status, pay: .payment.checkout_url}'

# 4. The shop validates it at the counter
MT=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"+221770000002","password":"boulangerie-2026"}' | jq -r .access_token)

curl -s localhost:4000/api/merchant/pickups/validate -H "authorization: Bearer $MT" \
  -H 'content-type: application/json' -d '{"code":"AI4-XXXX"}' | jq

# 5. Admin sees it land in the day's numbers
AT=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"+221770000001","password":"admin-dakar-2026"}' | jq -r .access_token)

curl -s localhost:4000/api/admin/overview -H "authorization: Bearer $AT" | jq '.overview.today'
```
