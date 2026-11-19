import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { SESSION_COOKIE, hashToken } from './auth.js';
import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import trxRoutes from './routes/trx.js';
import summaryRoutes from './routes/summary.js';
import billRoutes from './routes/bills.js';
import emergencyRoutes from './routes/emergency.js';
import savingsRoutes from './routes/savings.js';
import reportRoutes from './routes/report.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const OPEN_ROUTES = new Set(['/api/auth/login']);

export function buildApp({ pool, logger = true } = {}) {
  const app = Fastify({ logger, trustProxy: true });
  app.decorate('pg', pool);
  app.decorateRequest('user', null);

  app.register(cookie);
  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // Semua /api/* butuh sesi, kecuali login.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || OPEN_ROUTES.has(path)) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const { rows } = await pool.query(
        `select u.id, u.household_id, u.name, u.role, u.can_view_reports, u.email, h.payday_dom
           from session s
           join app_user u on u.id = s.user_id
           join household h on h.id = u.household_id
          where s.token_hash = $1 and s.expires_at > now()`,
        [hashToken(token)],
      );
      req.user = rows[0] ?? null;
    }
    if (!req.user) return reply.code(401).send({ error: 'Silakan login dulu.' });
  });

  app.register(authRoutes);
  app.register(metaRoutes);
  app.register(trxRoutes);
  app.register(summaryRoutes);
  app.register(billRoutes);
  app.register(emergencyRoutes);
  app.register(savingsRoutes);
  app.register(reportRoutes);

  app.setErrorHandler((err, req, reply) => {
    // Pelanggaran constraint database = input salah, bukan kesalahan server.
    if (err.code === '23514' || err.code === '23503' || err.code === '23505' || err.code === '22P02') {
      req.log.warn({ err }, 'constraint database');
      return reply.code(400).send({ error: 'Data tidak valid.' });
    }
    if (err.validation) return reply.code(400).send({ error: 'Data tidak lengkap atau tidak valid.' });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Terjadi kesalahan di server.' : err.message });
  });

  // Halaman yang tidak dikenal (bukan API) diarahkan ke aplikasi.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Tidak ditemukan.' });
    return reply.sendFile('index.html');
  });

  return app;
}
