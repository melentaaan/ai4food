# AI4Food

Bien manger. Moins gaspiller. — a marketplace for Dakar's unsold food: shops
list what they have left at the end of service, customers collect it cheap
instead of it going in the bin.

Two pieces:

| | |
| --- | --- |
| **`ai4food-app.html`** | The whole app in one file — customer, merchant counter and AI4Food console. Runs from a file:// double-click or behind any static host. |
| **`server/`** | The backend: catalogue, orders, pickup validation, dashboards. Node + Express + SQLite. |

## Run it

**Just the app** — open `ai4food-app.html` in a browser. With no server in
reach it runs in demo mode: a seeded Dakar catalogue, local ranking, and state
kept in `localStorage`. Nothing to install.

**App plus backend:**

```bash
cd server
npm install
npm run seed -- --fresh     # 78 Dakar shops, 16 baskets, two weeks of history
npm start                   # http://localhost:4000

# then serve the page and point it at the API
npx http-server -p 8080 ..
open 'http://localhost:8080/ai4food-app.html?api=http://localhost:4000'
```

The `?api=` parameter is remembered in `localStorage`; drop it once set, or
pass `?api=` (empty) to force demo mode. Served from the same origin as the
API, the app finds it on its own.

Sign-in accounts are printed by the seed:

| Role | Credentials |
| --- | --- |
| Customer | `+221771234567` — a 6-digit code, returned in the API response outside production |
| Merchant | `+221770000002` / `boulangerie-2026` |
| Admin | `+221770000001` / `admin-dakar-2026` |

## What each role sees

Short version — the long version, with what each role is deliberately denied,
is in **[server/docs/ROLES.md](server/docs/ROLES.md)**.

- **Customer** — the ranked catalogue with a "why this basket" breakdown, their
  own orders and pickup codes, their impact, their notifications. Never another
  customer's order, never a shop's takings, never the commission split.
- **Merchant** — their own offers, the orders to hand over with a masked
  customer (`Aïssatou N.`, `••• 45 67`), their takings, commission and payout,
  tomorrow's surplus forecast. Never another shop, never a full phone number,
  and no publishing until AI4Food approves them.
- **Admin** — the whole platform: the day's volume and commission, every order
  on both sides, the shop pipeline from prospect to partner, the people
  directory, payouts per shop, and an audit log of who did what. Never a
  password hash, never an unmasked phone number in a list view.

## The app

Three languages (French, English, Wolof), light and dark themes, live pickup
countdowns, distance from your neighbourhood, an explainable six-factor
recommender, and offline demo mode. See the commit history for the details.

## The backend

Full documentation in **[server/README.md](server/README.md)** and
**[server/docs/API.md](server/docs/API.md)**. Highlights: phone codes for
customers and passwords for staff, JWT with rotating refresh tokens, stock
decremented by a conditional UPDATE inside a transaction so two customers
cannot take the same last basket, a 2-hour cancellation window, pickup codes
that validate once at the owning shop only, and 50 end-to-end tests — most of
them trying cross-role reads that must fail.

```bash
cd server && npm test
```

---

Commerces cités à titre d'illustration, sans partenariat existant.
