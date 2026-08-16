-- AI4Food schema (SQLite). Money is stored in whole FCFA (no cents in XOF).
-- Timestamps are unix epoch milliseconds so the API and the browser agree.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,          -- E.164, e.g. +221771234567
  email         TEXT UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer','merchant','admin')),
  password_hash TEXT,                          -- staff only (merchant/admin); customers use OTP
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended')),
  zone          TEXT NOT NULL DEFAULT 'Plateau',
  lat           REAL,
  lng           REAL,
  locale        TEXT NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr','en','wo')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS merchants (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT UNIQUE NOT NULL,
  category       TEXT NOT NULL
                 CHECK (category IN ('Restaurants','Hôtels','Supermarchés','Boulangeries','Marchés')),
  zone           TEXT NOT NULL,
  address        TEXT NOT NULL DEFAULT '',
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  rating         REAL NOT NULL DEFAULT 0,
  reviews_count  INTEGER NOT NULL DEFAULT 0,
  phone          TEXT,
  -- prospect: mapped but never contacted. pending: applied, waiting on admin.
  -- active: may publish. suspended: blocked by admin.
  status         TEXT NOT NULL DEFAULT 'prospect'
                 CHECK (status IN ('prospect','pending','active','suspended')),
  commission_bps INTEGER NOT NULL DEFAULT 1500, -- 15.00%
  created_at     INTEGER NOT NULL,
  approved_at    INTEGER,
  approved_by    TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status);
CREATE INDEX IF NOT EXISTS idx_merchants_zone   ON merchants(zone);

-- A user may run several shops; a shop may have several staff accounts.
CREATE TABLE IF NOT EXISTS merchant_users (
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_users_user ON merchant_users(user_id);

CREATE TABLE IF NOT EXISTS offers (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  image_key     TEXT NOT NULL DEFAULT 'pain',   -- key into the client image set
  category      TEXT NOT NULL,
  price_cfa     INTEGER NOT NULL CHECK (price_cfa > 0),
  was_cfa       INTEGER NOT NULL CHECK (was_cfa > 0),
  qty_total     INTEGER NOT NULL CHECK (qty_total > 0),
  qty_left      INTEGER NOT NULL CHECK (qty_left >= 0),
  pickup_date   TEXT NOT NULL,                  -- YYYY-MM-DD, Africa/Dakar
  pickup_from   TEXT NOT NULL,                  -- HH:MM
  pickup_to     TEXT NOT NULL,                  -- HH:MM
  pickup_start  INTEGER NOT NULL,               -- epoch ms, derived on write
  pickup_end    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'live'
                CHECK (status IN ('draft','live','sold_out','expired','cancelled')),
  created_by    TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (was_cfa > price_cfa),
  CHECK (qty_left <= qty_total)
);
CREATE INDEX IF NOT EXISTS idx_offers_status_end ON offers(status, pickup_end);
CREATE INDEX IF NOT EXISTS idx_offers_merchant   ON offers(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,        -- AI4-XXXX shown to the customer
  user_id          TEXT NOT NULL REFERENCES users(id),
  offer_id         TEXT NOT NULL REFERENCES offers(id),
  merchant_id      TEXT NOT NULL REFERENCES merchants(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cfa   INTEGER NOT NULL,
  total_cfa        INTEGER NOT NULL,
  was_total_cfa    INTEGER NOT NULL,
  commission_cfa   INTEGER NOT NULL,
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('wave','om','cash')),
  payment_status   TEXT NOT NULL DEFAULT 'pending'
                   CHECK (payment_status IN ('pending','paid','refunded')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','picked_up','expired','cancelled')),
  pickup_start     INTEGER NOT NULL,
  pickup_end       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  picked_up_at     INTEGER,
  picked_up_by     TEXT REFERENCES users(id),   -- the merchant staff who scanned it
  cancelled_at     INTEGER,
  cancel_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user     ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status, pickup_end);

CREATE TABLE IF NOT EXISTS favourites (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id   TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, offer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                     -- welcome | new_offer | pickup_soon | order_ok | ...
  payload    TEXT NOT NULL DEFAULT '{}',        -- JSON, rendered client-side so it stays translatable
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- Following a shop, not a bag: a surprise bag exists for one evening, the
-- shop is what a customer actually comes back for.
CREATE TABLE IF NOT EXISTS merchant_follows (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, merchant_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_merchant ON merchant_follows(merchant_id);

-- Customers asking AI4Food to onboard a shop that is not a partner yet.
CREATE TABLE IF NOT EXISTS merchant_invites (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  UNIQUE (merchant_id, user_id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,                     -- never store the code itself
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Every privileged action lands here. Admin-readable only.
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_role    TEXT,
  action        TEXT NOT NULL,
  entity        TEXT,
  entity_id     TEXT,
  meta          TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- Passing a reservation on. Someone books a bag and then cannot make the
-- window; rather than lose it, they hand it to a friend. The link carries a
-- token rather than an account, because that is how it will actually travel:
-- pasted into WhatsApp. One live transfer per order; re-issuing mints a new
-- token so the previous link stops working.
CREATE TABLE IF NOT EXISTS order_transfers (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_name    TEXT,
  note       TEXT,
  claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_claimed ON order_transfers(claimed_by);
