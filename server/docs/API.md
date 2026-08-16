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
| 409 | Business conflict: `out_of_stock`, `already_picked_up`, `cancel_window_closed`, `below_sold`, `self_lockout` |
| 429 `rate_limited` | Too many requests |

Authenticate with `Authorization: Bearer <access_token>`. Access tokens last
15 minutes; refresh tokens last 30 days and rotate on every use.

---

## Auth

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/auth/otp/request` | anyone | `{phone}`. Returns `dev_code` outside production |
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
| POST | `/orders` | `{offer_id, qty, payment_method}` → 201 with the pickup code |
| GET | `/orders` | `status?` — always scoped to the caller |
| GET | `/orders/:id` | 404 if it is not theirs |
| POST | `/orders/:id/cancel` | Free until 2h before pickup |
| GET | `/me/impact` | Meals, CO₂e, money saved |
| GET | `/notifications` | Also generates due pickup reminders |
| POST | `/notifications/read` | `{ids?}`, or all |

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

# 3. Reserve, and read back the pickup code
curl -s localhost:4000/api/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"offer_id\":\"$OFFER\",\"qty\":1,\"payment_method\":\"wave\"}" | jq '.order.code'

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
