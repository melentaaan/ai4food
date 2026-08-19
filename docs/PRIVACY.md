# Privacy, in practice

The customer-facing text lives in the app (Profil → Confidentialité, and
Conditions d'utilisation). This file is the engineering side of the same
promises: where each one is enforced, and what is still owed.

**This has not been reviewed by a Senegalese lawyer.** The text is accurate
about what the software does, which is the part we can be accurate about. Loi
n° 2008-12 brings a registration duty with the Commission de protection des
données personnelles that no amount of code discharges. That is an external
step, and it is not done.

## What is collected, and where it is enforced

| Data | Why | Where |
| --- | --- | --- |
| Phone number | signing in, pickup reminders | `users.phone`, unique |
| Name | greeting, and the counter recognising you | `users.name`, optional at signup |
| Neighbourhood / coordinates | sorting bags by distance | `users.zone`, `lat`, `lng` |
| Orders | showing you your bags, paying the shops | `orders` |
| Favourites, follows, notifications | the app working | own tables |
| SMS delivery attempts | answering "no code arrived" | `sms_messages` — **never the code itself** |

Not collected: email for customers, contacts, device identifiers, any
third-party analytics. There is no tracking script in the app; there is no
third party in the app at all.

## What a merchant can see

A merchant sees `Aïssatou N.` and `••• 45 67` — first name plus the last four
digits. Enforced in `presenters.js` (`shortName`, `maskPhone`), not in the UI,
so no client can ask for more. Tested in `api.test.js`, in the block that
tries every cross-role read we intend to fail.

## Deletion

`DELETE /api/auth/me` (Profil → Mes données → Supprimer mon compte).

Deleted: name, phone, email, coordinates, sessions, notifications, favourites,
follows, sign-in codes. Bearer links the person sent are revoked.

Kept: the order rows, with the person removed from them. An order is half a
shop's accounting — their takings, their commission, the payout owed to them —
and deleting it would quietly rewrite somebody else's books. The row survives
attached to a subject who is no longer anyone: status `deleted`, phone replaced
with `deleted:<id>` so the number is neither recognisable nor blocking for
whoever is issued it next.

Refused while an order is still live, with an explanation: collect or cancel
first, so nobody deletes their way out of a bag a shop has set aside.

## Export

`GET /api/auth/me/export` (Profil → Mes données → Exporter). JSON: account,
orders with the shops they were from, favourites, follows, notifications, and
the delivery record of sign-in messages. Scoped to the caller by user id; no
other customer appears in it.

## Retention

Nothing expires automatically yet. Worth deciding before there is much of it:

- `sms_messages` — an operational log; months, not years.
- `audit_log` — the record of who did what; keep longer, deliberately.
- `otp_codes`, `password_resets` — spent within minutes; safe to prune weekly.
- `payments` — financial records; keep as long as the orders they settle.

## Still owed

- [ ] CDP registration (external — a lawyer, not a commit)
- [ ] Legal review of both customer-facing texts
- [ ] A real address and a working `privacy@ai4food.sn`
- [ ] A retention job for the tables above
- [ ] Photo licensing — see [PHOTOS.md](PHOTOS.md)
