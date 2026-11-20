import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { ensureCycle } from '../lib/cycles.js';
import { cycleStart, daysBetween, todayJakarta } from '../lib/dates.js';

const uuid = { type: 'string', format: 'uuid' };
const ADJUST_NOTE = 'Selisih saldo (belum tercatat)';

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Cek saldo tidak tersedia untuk akun Anda.');
}

/**
 * Uang masuk dan keluar sebuah rekening di antara dua cek saldo (prev, cur].
 * Batas ditentukan tanggal transaksi, dan pada hari yang sama oleh waktu pencatatan:
 *  - catatan bertanggal sebelum cek sebelumnya sudah tercermin di saldonya, jadi tidak dihitung;
 *  - catatan bertanggal hari cek yang dicatat sesudah cek itu dianggap terjadi sesudahnya;
 *  - transaksi penyeimbang milik sebuah cek hanya dihitung pada selang cek itu.
 */
async function flowBetween(db, accountId, prev, cur) {
  const { rows } = await db.query(
    `select coalesce(sum(case when t.kind = 'income' and t.account_id = $1 then t.amount
                              when t.kind = 'transfer' and t.to_account_id = $1 then t.amount else 0 end), 0) as masuk,
            coalesce(sum(case when t.kind = 'expense' and t.account_id = $1 then t.amount
                              when t.kind = 'transfer' and t.account_id = $1 then t.amount else 0 end), 0) as keluar
       from trx t
      where t.deleted_at is null and (t.account_id = $1 or t.to_account_id = $1)
        and (t.trx_date > $2::date or (t.trx_date = $2::date and t.created_at > $3::timestamptz))
        and (t.trx_date < $4::date or (t.trx_date = $4::date and (t.created_at <= $5::timestamptz or t.balance_check_id = $6::uuid)))
        and (t.balance_check_id is null or t.balance_check_id = $6::uuid)`,
    [accountId, prev.check_date, prev.created_at, cur.check_date, cur.created_at, cur.id],
  );
  return rows[0];
}

/** Semua cek sebuah rekening (terlama dulu) lengkap dengan perkiraan dan selisihnya. */
async function describeChecks(db, accountId) {
  const { rows } = await db.query(
    `select b.id, b.account_id, b.check_date, b.created_at, b.actual, u.name as user_name,
            (select count(*) from trx t where t.balance_check_id = b.id and t.deleted_at is null)::int as adjusted_n
       from balance_check b join app_user u on u.id = b.user_id
      where b.account_id = $1 order by b.created_at, b.id`,
    [accountId],
  );
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const prev = rows[i - 1] ?? null;
    const base = {
      id: cur.id, account_id: cur.account_id, check_date: cur.check_date, created_at: cur.created_at,
      actual: cur.actual, user_name: cur.user_name, adjusted: cur.adjusted_n > 0,
    };
    if (!prev) { out.push({ ...base, baseline: true, prev: null, masuk: 0, keluar: 0, expected: null, diff: 0 }); continue; }
    const f = await flowBetween(db, cur.account_id, prev, cur);
    const expected = prev.actual + f.masuk - f.keluar;
    out.push({
      ...base, baseline: false, prev: { check_date: prev.check_date, actual: prev.actual },
      masuk: f.masuk, keluar: f.keluar, expected, diff: cur.actual - expected,
    });
  }
  return out;
}

async function loadAccount(db, householdId, accountId) {
  const { rows } = await db.query(
    'select id, name, kind, is_emergency from account where id = $1 and household_id = $2',
    [accountId, householdId],
  );
  if (!rows[0]) throw new HttpError(404, 'Rekening tidak ditemukan.');
  if (rows[0].kind === 'asset') throw new HttpError(400, 'Cek saldo hanya untuk rekening biasa, bukan tabungan/aset.');
  return rows[0];
}

/** Status pengingat cek saldo untuk seluruh rumah tangga (dipakai Beranda). */
export async function balanceReminder(db, householdId, today = todayJakarta()) {
  const { rows } = await db.query(
    `select h.balance_check_days as days,
            (select b.check_date from balance_check b join account a on a.id = b.account_id
              where a.household_id = h.id order by b.created_at desc limit 1) as last_date
       from household h where h.id = $1`,
    [householdId],
  );
  const { days, last_date: lastDate } = rows[0];
  const since = lastDate ? daysBetween(lastDate, today) : null;
  return { days, last_date: lastDate, days_since: since, due: days != null && (since == null || since >= days) };
}

export default async function balanceRoutes(app) {
  const pool = app.pg;

  app.get('/api/balance-checks', {
    schema: { querystring: { type: 'object', properties: { account_id: uuid } } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const accounts = (await pool.query(
      `select id, name, is_emergency from account where household_id = $1 and kind <> 'asset'
        order by is_emergency, kind, name`, [u.household_id])).rows;
    if (!accounts.length) throw new HttpError(404, 'Belum ada rekening.');
    const account = req.query.account_id ? await loadAccount(pool, u.household_id, req.query.account_id) : accounts[0];
    const all = await describeChecks(pool, account.id);
    return {
      today: todayJakarta(),
      account: { id: account.id, name: account.name },
      accounts,
      reminder: await balanceReminder(pool, u.household_id),
      checks: all.slice(-30).reverse(), // terbaru dulu
      total_diff: all.filter((c) => !c.baseline && !c.adjusted && c.diff < 0).reduce((s, c) => s - c.diff, 0),
    };
  });

  app.post('/api/balance-checks', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['account_id', 'actual'],
        properties: { account_id: uuid, actual: { type: 'integer', minimum: 0, maximum: 999_999_999_999 } },
      },
    },
  }, async (req, reply) => {
    requireReports(req);
    const u = req.user;
    const check = await withTx(pool, async (c) => {
      const acc = await loadAccount(c, u.household_id, req.body.account_id);
      const ins = await c.query(
        'insert into balance_check (account_id, user_id, check_date, actual) values ($1, $2, $3, $4) returning id',
        [acc.id, u.id, todayJakarta(), req.body.actual],
      );
      return (await describeChecks(c, acc.id)).find((x) => x.id === ins.rows[0].id);
    });
    return reply.code(201).send({ check });
  });

  // Catat selisih cek TERBARU sebuah rekening sebagai pengeluaran (kurang) atau pemasukan (lebih).
  app.post('/api/balance-checks/:id/adjust', {
    schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    return withTx(pool, async (c) => {
      const found = (await c.query(
        `select b.id, b.account_id from balance_check b join account a on a.id = b.account_id
          where b.id = $1 and a.household_id = $2 for update of b`, [req.params.id, u.household_id])).rows[0];
      if (!found) throw new HttpError(404, 'Cek saldo tidak ditemukan.');
      const all = await describeChecks(c, found.account_id);
      const check = all.find((x) => x.id === found.id);
      if (all.at(-1).id !== check.id) throw new HttpError(409, 'Hanya cek saldo terbaru yang bisa dicatat selisihnya.');
      if (check.baseline) throw new HttpError(400, 'Cek pertama hanya mencatat saldo awal, belum ada selisih.');
      if (check.adjusted) throw new HttpError(409, 'Selisih cek ini sudah dicatat.');
      if (check.diff === 0) throw new HttpError(400, 'Tidak ada selisih untuk dicatat.');

      const kind = check.diff < 0 ? 'expense' : 'income';
      const cat = (await c.query('select id from category where household_id = $1 and name = $2 and kind = $3',
        [u.household_id, kind === 'expense' ? 'Lainnya' : 'Pemasukan Lainnya', kind])).rows[0];
      if (!cat) throw new HttpError(400, `Kategori ${kind === 'expense' ? 'Lainnya' : 'Pemasukan Lainnya'} tidak ada.`);
      const cycleId = await ensureCycle(c, u.household_id, cycleStart(check.check_date, u.payday_dom));
      const t = await c.query(
        `insert into trx (account_id, category_id, cycle_id, user_id, trx_date, kind, amount, note, balance_check_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [check.account_id, cat.id, cycleId, u.id, check.check_date, kind, Math.abs(check.diff), ADJUST_NOTE, check.id],
      );
      const after = (await describeChecks(c, check.account_id)).find((x) => x.id === check.id);
      return { check: after, trx_id: t.rows[0].id };
    });
  });

  // Hitung ulang: setelah menambah catatan yang terlewat, saldo yang sama dianggap berlaku sekarang.
  // Hanya cek terbaru yang dibuat hari ini (selain itu saldonya sudah berubah: lakukan cek baru).
  app.post('/api/balance-checks/:id/recheck', {
    schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    return withTx(pool, async (c) => {
      const found = (await c.query(
        `select b.id, b.account_id, b.check_date from balance_check b join account a on a.id = b.account_id
          where b.id = $1 and a.household_id = $2 for update of b`, [req.params.id, u.household_id])).rows[0];
      if (!found) throw new HttpError(404, 'Cek saldo tidak ditemukan.');
      const all = await describeChecks(c, found.account_id);
      if (all.at(-1).id !== found.id) throw new HttpError(409, 'Hanya cek saldo terbaru yang bisa dihitung ulang.');
      if (found.check_date !== todayJakarta()) throw new HttpError(409, 'Cek ini dibuat di hari lain. Lakukan cek saldo baru dengan uang yang ada sekarang.');
      await c.query('update balance_check set created_at = now() where id = $1', [found.id]);
      return { check: (await describeChecks(c, found.account_id)).find((x) => x.id === found.id) };
    });
  });

  app.put('/api/balance-settings', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['days'],
        properties: { days: { type: ['integer', 'null'], minimum: 1, maximum: 90 } },
      },
    },
  }, async (req) => {
    requireReports(req);
    await pool.query('update household set balance_check_days = $2 where id = $1', [req.user.household_id, req.body.days]);
    return { ok: true, reminder: await balanceReminder(pool, req.user.household_id) };
  });
}
