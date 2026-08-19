import express from 'express';
import { config } from './config.js';
import { migrate } from './db.js';
import { loadUser } from './middleware/auth.js';
import { security, notFoundHandler, errorHandler } from './middleware/common.js';
import { router as authRoutes } from './routes/auth.js';
import { router as catalogRoutes } from './routes/catalog.js';
import { router as orderRoutes } from './routes/orders.js';
import { router as merchantRoutes } from './routes/merchant.js';
import { router as adminRoutes } from './routes/admin.js';
import { router as paymentRoutes } from './routes/payments.js';

export function createApp() {
  migrate();

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  // The raw bytes are kept because a wallet signs the body it sent, not the
  // object we parsed out of it.
  app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(security);
  app.use(loadUser);

  // The service name is not decoration: a client pointed at the wrong origin
  // needs to tell "AI4Food answered" from "something answered".
  app.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'ai4food', env: config.env, time: Date.now() }));

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);      // offers, merchants, meta  (public reads)
  app.use('/api', orderRoutes);        // orders, notifications    (signed-in customer)
  app.use('/api/merchant', merchantRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/payments', paymentRoutes);  // wallet callbacks, signature-checked

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
