import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { normalisePhone } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { validate, rateLimit } from '../middleware/common.js';

export const router = Router();

const CATEGORIES = ['Restaurants', 'Hôtels', 'Supermarchés', 'Boulangeries', 'Marchés'];

const applyBody = z.object({
  business_name: z.string().trim().min(2).max(80),
  category: z.enum(CATEGORIES),
  contact_name: z.string().trim().min(2).max(60),
  phone: z.string().trim().min(6).max(20),
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  zone: z.string().trim().min(2).max(60),
  address: z.string().trim().max(160).optional().or(z.literal('')),
  surplus_note: z.string().trim().max(300).optional().or(z.literal('')),
  pickup_note: z.string().trim().max(120).optional().or(z.literal('')),
});

// A form anyone can post to needs its own ceiling, well below the write limiter
// that signed-in customers share.
const applyLimiter = rateLimit({ key: 'apply', limit: 5, windowMs: 3600_000 });

/**
 * A shop asking to join. Public on purpose — the whole point is that a baker
 * who hears about us can raise their hand without knowing anybody here.
 *
 * What it creates is an application, never a merchant: nothing posted to this
 * endpoint can put a name on the customers' map. Turning one into a real shop
 * is a deliberate act by an admin, on the record.
 */
router.post('/apply', applyLimiter, validate(applyBody), (req, res) => {
  const b = req.body;
  const phone = normalisePhone(b.phone);

  // Asking twice is what a keen shop does, not an error to shout about.
  const open = db
    .prepare(`SELECT id FROM merchant_applications
               WHERE phone = ? AND status IN ('submitted','reviewing','needs_info')
               ORDER BY created_at DESC LIMIT 1`)
    .get(phone);
  if (open) {
    return res.status(202).json({ application: { id: open.id, status: 'submitted' }, duplicate: true });
  }

  const id = uid();
  db.prepare(
    `INSERT INTO merchant_applications
       (id, business_name, category, contact_name, phone, email, zone, address,
        surplus_note, pickup_note, status, created_at)
     VALUES (@id, @business_name, @category, @contact_name, @phone, @email, @zone, @address,
             @surplus_note, @pickup_note, 'submitted', @created_at)`,
  ).run({
    id,
    business_name: b.business_name,
    category: b.category,
    contact_name: b.contact_name,
    phone,
    email: b.email || null,
    zone: b.zone,
    address: b.address || null,
    surplus_note: b.surplus_note || null,
    pickup_note: b.pickup_note || null,
    created_at: now(),
  });
  audit(req, 'application.create', 'application', id, { zone: b.zone, category: b.category });
  res.status(201).json({ application: { id, status: 'submitted' } });
});

/** The categories the form offers, so the app never invents one. */
router.get('/categories', (_req, res) => res.json({ categories: CATEGORIES }));
