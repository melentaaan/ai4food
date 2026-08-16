# AI4Food API

The backend behind the AI4Food app: the Dakar surplus-food catalogue, the
customer's orders, the shop's counter, and AI4Food's own operations console.

Node 20+, Express 5, SQLite. No external services required to run it — the
whole thing is a process and a file.

```bash
cd server
npm install
cp .env.example .env          # optional; every value has a working default
npm run seed -- --fresh       # 78 Dakar shops, 16 baskets, 2 weeks of history
npm start                     # http://localhost:4000
npm test                      # 65 end-to-end tests against a throwaway database
```

Seeding prints the demo accounts:

| Role | Sign in with |
| --- | --- |
| Admin | `+221770000001` / `admin-dakar-2026` |
| Merchant (Boulangerie Jaune) | `+221770000002` / `boulangerie-2026` |
| Customer | `+221771234567` — phone code, returned in the API response outside production |

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
  middleware/       auth and role guards, validation, rate limits, error shape
  routes/           auth · catalog · orders · merchant · admin
  services/         offers, orders, stats — the business rules live here
  jobs/scheduler.js expiry and pickup reminders, every minute
  seed.js           the Dakar dataset and demo accounts
test/api.test.js    happy paths, race conditions, and every cross-role leak we refuse
```

## Decisions worth knowing

**SQLite, not Postgres.** One file, no server, WAL mode, and it will carry this
product well past its first city. Everything goes through `db.js` and the
`services/` layer, so the move to Postgres is a driver swap and a migration —
not a rewrite. Move when you need concurrent writers across machines.

**Phone codes for customers, passwords for staff.** Dakar runs on mobile
numbers and mobile money; asking a customer for an email and a password would
lose people at the door. Staff accounts get passwords because they are handed
out deliberately. `OTP_ECHO` returns the code in development so you can test
without an SMS gateway; the server refuses to boot in production with it on.

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
- Wire an SMS gateway in `routes/auth.js` where the code is currently logged,
  and a payment provider in `services/orders.js` where `payment_status` is set.
  Both are one function each; nothing else in the codebase needs to know.
