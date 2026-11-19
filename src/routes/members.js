import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { SESSION_COOKIE, hashPassword, hashToken, verifyPassword } from '../auth.js';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] };
const ADULT = new Set(['suami', 'istri']);
const memberBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'role'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    role: { enum: ['suami', 'istri', 'anak'] },
    email: { type: ['string', 'null'], maxLength: 200 },
  },
};

/** Hanya suami/istri yang boleh menambah dan mengatur anggota lain. */
function requireAdult(req) {
  if (!ADULT.has(req.user.role)) throw new HttpError(403, 'Hanya suami atau istri yang bisa mengatur anggota.');
}

function cleanEmail(email) {
  const e = email?.trim().toLowerCase() || null;
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Email tidak valid.');
  return e;
}

async function emailTaken(db, email, exceptId = null) {
  if (!email) return false;
  const { rowCount } = await db.query(
    'select 1 from app_user where email = $1 and ($2::uuid is null or id <> $2)', [email, exceptId]);
  return rowCount > 0;
}

/**
 * Anggota keluarga. Peran menentukan izin: anak tidak melihat laporan, saldo,
 * rekening darurat, dan tabungan (can_view_reports = false).
 * Undangan lewat email belum ada; anggota dewasa mengatur email dan kata sandi langsung.
 */
export default async function memberRoutes(app) {
  const pool = app.pg;

  app.get('/api/members', async (req) => {
    const { rows } = await pool.query(
      `select id, name, role, can_view_reports, email, (password_hash is not null) as has_login
         from app_user where household_id = $1
        order by case role when 'suami' then 1 when 'istri' then 2 else 3 end, name`,
      [req.user.household_id],
    );
    const canManage = ADULT.has(req.user.role);
    return {
      me: req.user.id,
      can_manage: canManage,
      // Email anggota lain hanya untuk yang boleh mengatur.
      members: rows.map((r) => ({ ...r, email: canManage || r.id === req.user.id ? r.email : null })),
    };
  });

  app.post('/api/members', { schema: { body: memberBody } }, async (req, reply) => {
    requireAdult(req);
    const b = req.body;
    const email = cleanEmail(b.email);
    if (await emailTaken(pool, email)) throw new HttpError(409, 'Email sudah dipakai anggota lain.');
    const { rows } = await pool.query(
      `insert into app_user (household_id, name, role, can_view_reports, email)
       values ($1, $2, $3, $4, $5) returning id`,
      [req.user.household_id, b.name.trim(), b.role, b.role !== 'anak', email],
    );
    return reply.code(201).send({ id: rows[0].id });
  });

  app.put('/api/members/:id', { schema: { params: idParams, body: memberBody } }, async (req) => {
    requireAdult(req);
    const b = req.body;
    const email = cleanEmail(b.email);
    await withTx(pool, async (c) => {
      const { rows } = await c.query(
        'select id, role from app_user where id = $1 and household_id = $2 for update',
        [req.params.id, req.user.household_id],
      );
      if (!rows[0]) throw new HttpError(404, 'Anggota tidak ditemukan.');
      if (ADULT.has(rows[0].role) && !ADULT.has(b.role)) {
        const adults = await c.query(
          `select count(*)::int as n from app_user where household_id = $1 and role in ('suami', 'istri')`,
          [req.user.household_id],
        );
        if (adults.rows[0].n <= 1) throw new HttpError(409, 'Harus ada minimal satu suami atau istri.');
      }
      if (await emailTaken(c, email, req.params.id)) throw new HttpError(409, 'Email sudah dipakai anggota lain.');
      await c.query(
        'update app_user set name = $2, role = $3, can_view_reports = $4, email = $5 where id = $1',
        [req.params.id, b.name.trim(), b.role, b.role !== 'anak', email],
      );
      // Email dihapus -> tidak bisa login lagi; cabut sesinya.
      if (!email) await c.query('delete from session where user_id = $1', [req.params.id]);
    });
    return { ok: true };
  });

  // Kata sandi: anggota dewasa boleh mengatur kata sandi siapa pun; anggota lain
  // hanya kata sandinya sendiri, dengan kata sandi lama. Sesi lain anggota itu dicabut.
  app.put('/api/members/:id/password', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 8, maxLength: 200 },
          current_password: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req) => {
    const u = req.user;
    const self = req.params.id === u.id;
    if (!self) requireAdult(req);
    const { rows } = await pool.query(
      'select id, email, password_hash from app_user where id = $1 and household_id = $2',
      [req.params.id, u.household_id],
    );
    const target = rows[0];
    if (!target) throw new HttpError(404, 'Anggota tidak ditemukan.');
    if (!target.email) throw new HttpError(400, 'Isi email anggota ini dulu.');
    if (self && !(await verifyPassword(req.body.current_password ?? '', target.password_hash))) {
      throw new HttpError(400, 'Kata sandi lama salah.');
    }
    await pool.query('update app_user set password_hash = $2 where id = $1', [target.id, await hashPassword(req.body.password)]);
    const keep = self ? hashToken(req.cookies[SESSION_COOKIE] ?? '') : '';
    await pool.query('delete from session where user_id = $1 and token_hash <> $2', [target.id, keep]);
    return { ok: true };
  });
}
