# Running AI4Food in production

One process, one file, one volume. The file is the part that has to outlive
everything else.

## What you need first

| | Why | Without it |
| --- | --- | --- |
| A domain with TLS | wallets call back to it, browsers demand it | no wallet payments |
| An SMS gateway account | sign-in codes | **nobody can sign in at all** |
| A Wave and/or Orange Money merchant account | taking money | cash only, which still works |
| A volume that survives restarts | the database is a file | every order lost on deploy |

The server refuses to start in production without `JWT_SECRET`,
`PUBLIC_API_URL`, a real `SMS_PROVIDER`, and a `CORS_ORIGINS` that is not `*`.
That is deliberate: each of those silently breaks something a customer can see.

## Build and run

```bash
docker build -t ai4food-api .

docker run -d --name ai4food \
  -v ai4food-data:/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_API_URL="https://api.ai4food.sn" \
  -e PUBLIC_APP_URL="https://ai4food.sn/ai4food-app.html" \
  -e CORS_ORIGINS="https://ai4food.sn" \
  -e SMS_PROVIDER=orange \
  -e ORANGE_CLIENT_ID=... -e ORANGE_CLIENT_SECRET=... -e ORANGE_SENDER_ADDRESS=+221... \
  -e WAVE_API_KEY=... -e WAVE_WEBHOOK_SECRET=... \
  -p 4000:4000 ai4food-api
```

First run only, to create the tables and the first admin:

```bash
docker exec ai4food node src/seed.js --fresh    # demo data, for a staging box
```

For a real deployment you want the schema without the demo shops. The schema is
applied automatically at boot; create your admin account directly:

```bash
docker exec -it ai4food node -e "
  const { db } = await import('./src/db.js');
  const { hashPassword } = await import('./src/lib/auth.js');
  const { uid } = await import('./src/lib/util.js');
  db.prepare('INSERT INTO users (id,phone,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(uid(), '+221770000001', 'Admin', 'admin', hashPassword(process.env.PW), Date.now());
"
```

## The app itself

`ai4food-app.html` is a static file. Put it behind any host — the same origin as
the API if you can, which lets the app find it without a query parameter.

```bash
node tools/build-artifact.mjs   # if your host supplies its own page wrapper
```

## Wallet callbacks

Point each provider's webhook at:

```
https://api.ai4food.sn/api/payments/wave/webhook
https://api.ai4food.sn/api/payments/om/webhook
```

Wave's signature is checked against `WAVE_WEBHOOK_SECRET`; Orange Money is
matched against the per-payment token it issues at checkout. A callback that
fails either is refused.

**Before you take real money**, run one transaction in each provider's sandbox.
The clients are written against published documentation, not against an account
we hold, and every endpoint is overridable by environment for exactly that
reason (`WAVE_BASE_URL`, `OM_BASE_URL`).

## Health

| Path | Answers | Use it for |
| --- | --- | --- |
| `/health` | always, while the process lives | liveness — restart on failure |
| `/ready` | only while the database answers | readiness — stop routing traffic |

They differ exactly when the volume is gone, which is the case where restarting
is the wrong move.

## Backups

```bash
# nightly, on the host
docker exec ai4food node ops/backup.mjs
```

Takes a consistent copy with SQLite's own backup API — not `cp`, which on a
write-ahead database gives you a file that is not a database. It then **opens
the copy, checks its integrity and counts the orders in it** before gzipping,
because a backup nobody has read is a hope rather than a backup.

Set `BACKUP_REMOTE` to a mounted path somewhere else. A copy on the same disk as
the original is not a backup from the point of view of that disk failing.
`BACKUP_KEEP` (default 14) is how many are kept.

A crontab line:

```
0 3 * * * docker exec ai4food node ops/backup.mjs >> /var/log/ai4food-backup.log 2>&1
```

### Restoring

```bash
docker stop ai4food
docker run --rm -v ai4food-data:/data ai4food-api \
  node ops/restore.mjs /data/backups/ai4food-20260819T030000Z.db.gz
docker start ai4food
curl -fsS https://api.ai4food.sn/ready
```

It verifies the archive before touching anything, and moves the database it
replaces aside rather than deleting it. **Do this once, on purpose, before you
need it** — an untested restore is not a restore procedure.

## Logs

One JSON line per request, with a request id that also comes back in every
error response. No bodies, no tokens, no phone numbers — ids in paths are
replaced with `:id` so a log is something you can hand to a colleague.

Watch for:

| Line | Means |
| --- | --- |
| `"msg":"unhandled"` | a 500 — the `id` matches the one the customer was shown |
| `[sms] delivery failed` | codes are not arriving; **nobody can sign in** |
| `[payments] could not check a hold` | a wallet is unreachable; holds are being kept, not dropped |
| `[scheduler] failed` | expiry and reminders have stopped |

An alert on the first two is the smallest monitoring worth having.

## When SQLite stops being the right answer

Not yet. It is a single file with WAL, and it will carry this product well past
its first city. Move when you need concurrent writers on more than one machine
— several API nodes, or a separate worker doing the scheduling. Everything goes
through `db.js` and the `services/` layer, so that is a driver swap and a data
migration, not a rewrite.

The other reason to move is backup windows: past a few gigabytes, `.backup`
starts taking long enough to matter.
