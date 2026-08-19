# AI4Food

Bien manger. Moins gaspiller. — a marketplace for Dakar's unsold food: shops
list what they have left at the end of service, customers collect it cheap
instead of it going in the bin.

Two pieces:

| | |
| --- | --- |
| **`ai4food-app.html`** | The app in one file — the customer side and the merchant counter. Runs from a file:// double-click or behind any static host. |
| **`ai4food-admin.html`** | The internal console: applications, shops, orders, payouts, refunds, audit. |
| **`server/`** | The backend: catalogue, orders, pickup validation, dashboards, and the admin API. Node + Express + SQLite. |

## Run it

**Just the app** — open `ai4food-app.html` in a browser. It opens on the
marketplace: no sign-in, no account, no onboarding. Browse, search, filter, open
the map, open a bag, put a heart on it. The first thing that needs a name is
Réserver. With no server in reach it runs against a demo catalogue in
`localStorage`, and says so in the header. Nothing to install.

**App plus backend:**

```bash
cd server
npm install
npm run seed -- --fresh     # 78 Dakar shops, 16 baskets, two weeks of history
npm start                   # http://localhost:4000

# then serve the page and point it at the API
npx http-server -p 8080 ..
open 'http://localhost:8080/ai4food-app.html?api=http://localhost:4000'
open 'http://localhost:8080/ai4food-admin.html?api=http://localhost:4000'
```

**Tests** — `npm test` at the root runs both: the API suite, and the app driven
in a real browser against a seeded server and a stand-in for Wave.

```bash
npm install                 # playwright, for the browser suite
npm test                    # 88 API tests + 28 browser tests
```

**Deploying** — `docker build -t ai4food-api .`, then
**[docs/DEPLOY.md](docs/DEPLOY.md)** for the volume, the backups, the wallet
callbacks and the restore drill.

The `?api=` parameter is remembered in `localStorage`; drop it once set, or
pass `?api=` (empty) to force demo mode. Served from the same origin as the
API, the app finds it on its own.

**Swapping in a real photo** — drop it in `photos/` named after the image key
the offer uses (`photos/pastels.jpg`), then
`python3 tools/grade-photos.py photos/ > blob.js` and paste the `const P = {…}`
block it prints over the one in `ai4food-app.html`. It applies the same crop,
grade and sharpening as everything else, so a new photo joins the set instead
of standing out from it. Needs Pillow.

**Behind a host that supplies its own page wrapper** (an embed, a docs site),
`node tools/build-artifact.mjs` writes `ai4food-artifact.html`: the same app
with our `<!doctype>`, `<html>` and `<body>` stripped and the charset, title,
font links and stylesheet kept. It is a build output, not a source file.

Sign-in accounts are printed by the seed:

| Role | Credentials |
| --- | --- |
| Customer | `+221771234567` — a 6-digit code, sent by SMS; the development gateway prints it to the log and the API returns it |
| Merchant | `+221770000002` / `boulangerie-2026` |
| Admin | `+221770000001` / `admin-dakar-2026` — for the API; the app turns this account away |

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
  on both sides, the shop pipeline from prospect to partner, applications from
  shops that want in, the people directory, payouts, failed refunds, and an
  audit log of who did what. Never a password hash, never an unmasked phone
  number in a list view. It has its own page, **`ai4food-admin.html`** — an
  admin account that signs in to the customer app is told so and shown the door,
  and the pipeline never appears on a customer's map.

## The app

Three languages (French, English, Wolof), light and dark themes, live pickup
countdowns, distance from your neighbourhood, an explainable six-factor
recommender, and offline demo mode.

### How it behaves in the hand

- **The market comes first, the account comes later.** Opening AI4Food shows
  food, not a login. A visitor with no account browses, searches, filters, uses
  the map, reads a bag, and hearts one — the heart stays on the device and
  follows them into their account when they eventually sign in. Réserver is the
  first thing that genuinely needs a name, so that is where the app asks, and
  the bag goes with the question: phone, code, and straight back to the same
  basket. If the last one sold while the code was being typed, the stock still
  decides and they are told plainly.
- **It never pretends to take money.** The payment screen lists what the server
  can actually charge — cash always, a wallet only once it has credentials — so
  there is no balance on screen that belongs to nobody. Choosing a wallet sends
  you to the wallet; the bag is held, with the time left on it, until you come
  back. Walk away and it goes back on sale, and nothing was charged.

- **Two doors, no costume box.** The first screen asks who you are: a customer
  signs in with a phone number and a code, a shop with the password AI4Food
  gave it. Which side you land on comes from the account, not from a toggle —
  there is no button that turns a customer into a merchant.
- **The back button works.** Hardware or browser back closes the open sheet,
  then returns to the feed, and only then leaves the app. Sheets also drag down
  to dismiss, and every tab remembers where you had scrolled to.
- **It never shows an empty screen.** Skeleton cards while the first load runs,
  the catalogue stays on screen if the network drops, and a banner with a retry
  appears instead of a blank list. Pull the feed down to refresh it.
- **The pickup code is a real QR**, encoded on the device (no library, no
  network) and readable by any scanner — tap it for a full-screen version to
  show at a noisy counter. Merchants with a supported browser scan it with the
  camera; everyone else types four characters into a field that prefixes
  `AI4-`, uppercases, and validates on the fourth keystroke.
- **Destructive things ask first.** Cancelling an order, pulling an offer and
  suspending a shop all confirm; removing a favourite offers an undo instead.
- **It answers with the phone.** A short vibration on reserve, pickup
  validation and confirmations, screen transitions and press states throughout,
  all of it disabled under `prefers-reduced-motion`.
- **It asks where you are before it asks anything else.** The last step of the
  first run is the neighbourhood — ten Dakar areas or the GPS — so the very
  first feed is sorted around you rather than around a default pin. Choose an
  area, sign in later, and the choice you just made travels to the account
  instead of being overwritten by it.
- **The photography is graded as one set.** Fifteen stock frames shot by
  different people under different lights read as clip art side by side, so
  they get one white balance, one contrast curve and one level of sharpening,
  and crops that put the subject where it belongs. A shop with no photo does
  not borrow someone else's: it gets a house tile with its initials, which
  never pretends to be a photograph of food you are not getting.
- **Numbers hold still.** Prices, codes, distances and countdowns are set in
  tabular figures, so a ticking countdown does not shove the line around it.
  An open pickup window shows how much of itself is left.
- **Every row opens something.** A shop row opens the shop and its bags, a past
  order opens its receipt, and on the counter every bag and every pickup has a
  detail sheet behind it. Every figure on a dashboard opens a sentence
  explaining how it is computed. Rows are real buttons: they take keyboard focus and answer Enter,
  and a button inside a row does its own job without opening the row.
- **A bag you cannot collect can go to a friend.** Send the link, and whoever
  opens it gets the shop, the window and the code — a bearer view with no
  amount paid and no phone number in it, because they only need to walk in and
  collect. No account needed; signing in and accepting just puts the bag in
  their own list. The counter sees that a friend is coming, so a name that does
  not match the booking is expected rather than a problem. Take it back at any
  time and the link you already sent stops working.
- **You follow a shop, not a basket.** A basket exists for one evening; the
  shop is what you come back for, and following one is what gets you told when
  it puts something online. Saved items are split in two — *Paniers* and
  *Commerces* — and each empty state offers the way out: widen the area, or go
  find shops to follow.

## The backend

Full documentation in **[server/README.md](server/README.md)** and
**[server/docs/API.md](server/docs/API.md)**. Highlights: phone codes for
customers and passwords for staff, JWT with rotating refresh tokens, stock
decremented by a conditional UPDATE inside a transaction so two customers
cannot take the same last basket, a 2-hour cancellation window, pickup codes
that validate once at the owning shop only, and 88 end-to-end tests — most of
them trying cross-role reads that must fail.

**Sign-in codes are sent, not printed.** The gateway is configured rather than
coded — Orange, Twilio, or any endpoint that takes a POST — and production
refuses to start without one, because a code nobody receives is a customer who
cannot sign in. Every attempt is logged, delivery failures included; the code
itself is never stored.

**A wallet payment is not a sale until the wallet says so.** Reserving with Wave
or Orange Money holds the bag and leaves the order *pending payment*: not
collectable, not on the shop's counter, not in anyone's takings. It becomes a
booking when the provider's signed callback lands — or the bag goes back on sale
when the payment window runs out. Cash is the other half: nothing is owed up
front, so it is a booking from the start and settles at the counter. A wallet
with no credentials configured is not offered at all.

**Owed and paid are different questions.** What a shop is due is computed from
collected orders. What has actually left our account is a payout row with a
state, an event trail and a transfer reference — and marking one paid without
that reference is refused, because a payout nobody can reconcile against a bank
statement is not evidence of anything.

**Nothing is closed off without a way back.** A shop that lost its password can
reset it over SMS. A customer can export everything we hold on them and close
their account, which empties the person out of the row and keeps the order
amounts, because those are half a shop's books.

```bash
cd server && npm test
```

---

Commerces cités à titre d'illustration, sans partenariat existant.
