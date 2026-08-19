# AI4Food API

The backend behind the AI4Food app: the Dakar surplus-food catalogue, the
customer's orders, the shop's counter, and AI4Food's own operations console.

Node 20+, Express 5, SQLite. It runs as a process and a file; the two things it
does need from the outside world — an SMS gateway to deliver sign-in codes, and
a wallet to take money — are configured, not coded, and it tells you at boot
when production is missing them.

```bash
cd server
npm install
cp .env.example .env          # optional; every value has a working default
npm run seed -- --fresh       # 78 Dakar shops, 16 baskets, 2 weeks of history
npm start                     # http://localhost:4000
npm test                      # 87 end-to-end tests against a throwaway database
```

Seeding prints the demo accounts:

| Role | Sign in with |
| --- | --- |
| Admin | `+221770000001` / `admin-dakar-2026` |
| Merchant (Boulangerie Jaune) | `+221770000002` / `boulangerie-2026` |
| Customer | `+221771234567` — phone code, printed by the console gateway and returned in the API response outside production |

## Documentation

- **[docs/ROLES.md](docs/ROLES.md)** — what an admin sees, what a merchant sees,
  what a customer sees, and what each one is deliberately denied.
- **[docs/API.md](docs/API.md)** — every endpoint, with a worked example that
  runs a basket from browse to counter to dashboard.

## How it is laid out

```
src/
  schema.sql        one file, the whole data model
  config.js         environment with sane defaults; refuses bad production setups
  db.js             connection, WAL, migrations
  presenters.js     the only place that turns database rows into JSON
  lib/              auth (OTP, scrypt, JWT), ranking, audit, notifications, time and geo
  lib/sms/          the gateways that carry a sign-in code, and the log of what went out
  lib/payments/     the wallets, each one four functions: checkout, status, callback, refund
  middleware/       auth and role guards, validation, rate limits, error shape
  routes/           auth · catalog · orders · merchant · admin · payments (callbacks)
  services/         offers, orders, payments, stats — the business rules live here
  jobs/scheduler.js expiry, abandoned checkouts and pickup reminders, every minute
  seed.js           the Dakar dataset and demo accounts
test/api.test.js       happy paths, race conditions, and every cross-role leak we refuse
test/payments.test.js  the wallet flow, against a stand-in that speaks Wave's checkout API
test/sms.test.js       the code that goes out, and what happens when it cannot
test/migrate.test.js   rebuilding orders on an older database without losing anything
```

## Decisions worth knowing

**SQLite, not Postgres.** One file, no server, WAL mode, and it will carry this
product well past its first city. Everything goes through `db.js` and the
`services/` layer, so the move to Postgres is a driver swap and a migration —
not a rewrite. Move when you need concurrent writers across machines.

**Phone codes for customers, passwords for staff.** Dakar runs on mobile
numbers and mobile money; asking a customer for an email and a password would
lose people at the door. Staff accounts get passwords because they are handed
out deliberately. The code is delivered by a configured gateway — Orange,
Twilio, or any endpoint that takes a POST — and `OTP_ECHO` additionally returns
it in the response in development. Production refuses to boot with `OTP_ECHO`
on, and refuses to boot without a real `SMS_PROVIDER`: an undelivered code is a
customer who cannot sign in at all.

**A wallet payment is not a sale until the wallet says so.** Reserving takes the
bag out of the catalogue and writes an order in `pending_payment` — held, not
booked. It cannot be collected, cannot be handed to a friend, does not reach the
merchant's counter and does not count as revenue. It becomes real when the
provider's signed callback arrives, or when the app asks and the provider
confirms; otherwise the payment window runs out and the bag goes straight back
on sale. Cash is the other half of the rule: nothing is owed up front, so a cash
order is a booking from the start and settles at the counter.

**Only wallets that exist are offered.** `/api/meta` lists the payment methods
that have a configured provider behind them, and `POST /api/orders` refuses any
other. An uncredentialed wallet is invisible rather than broken, which is why
there is no way for the app to show a payment route that cannot take money.

**The ranker lives here, not only in the app.** The six-factor score the app
explains in its "why this offer" sheet is computed server-side
(`lib/rank.js`), so every client — and any future one — orders the feed the
same way. The client keeps its own copy for offline browsing.

**Notifications carry data, not sentences.** The app speaks French, English and
Wolof; the server stores `{kind, payload}` and lets the client word it.

**Money is integers.** XOF has no minor unit. Commission is basis points per
shop (`commission_bps`, default 1500 = 15%), computed at reservation time and
frozen on the order, so changing a rate never rewrites history.

**Stock is decided by the database.** Reserving is a conditional `UPDATE`
inside a transaction — whoever loses the race gets a 409, never a basket that
is not there. There is a test that fires two customers at the last one.

## Production notes

- Set `JWT_SECRET` (`openssl rand -hex 32`). The server will not start without it.
- Put `DB_FILE` on a persistent volume and back it up: `sqlite3 ai4food.db ".backup 'out.db'"`.
- Terminate TLS in front of the process and set `CORS_ORIGINS` to your app's origin.
- Rate limits are in-process. Running more than one node means moving them, and
  the scheduler, to something shared (Redis, or a single worker).
- Set `SMS_PROVIDER` and its credentials, and `PUBLIC_API_URL` so wallets can
  reach the callback. Production will not start without either.
- Set `WAVE_API_KEY` + `WAVE_WEBHOOK_SECRET` (and/or the `OM_*` values) to turn
  those wallets on. Leave them unset and the app quietly offers cash only.
- The provider endpoints follow each vendor's published API and are overridable
  by environment. **Run one real transaction in each provider's sandbox before
  go-live** — the code is written against their documentation, not against an
  account we hold.
