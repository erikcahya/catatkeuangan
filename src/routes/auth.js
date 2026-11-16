import { SESSION_COOKIE, SESSION_DAYS, hashToken, newSessionToken, verifyPassword } from '../auth.js';

// Hash acak untuk menyamakan waktu respons saat email tidak terdaftar.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

export default async function authRoutes(app) {
  const pool = app.pg;
  const cookieOpts = () => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400,
  });

  app.post('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 200 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { rows } = await pool.query(
      'select id, name, password_hash from app_user where email = lower($1)',
      [req.body.email.trim()],
    );
    const user = rows[0];
    const ok = await verifyPassword(req.body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: 'Email atau kata sandi salah.' });

    const token = newSessionToken();
    await pool.query(
      `insert into session (token_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(days => $3))`,
      [hashToken(token), user.id, SESSION_DAYS],
    );
    await pool.query('delete from session where expires_at < now()');
    reply.setCookie(SESSION_COOKIE, token, cookieOpts());
    return { ok: true, name: user.name };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await pool.query('delete from session where token_hash = $1', [hashToken(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
