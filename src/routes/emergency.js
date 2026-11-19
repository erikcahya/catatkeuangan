import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { ensureCycle } from '../lib/cycles.js';
import { cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';

const uuid = { type: 'string', format: 'uuid' };

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Halaman ini tidak tersedia untuk akun Anda.');
}

async function emergencyAccount(db, householdId) {
  const { rows } = await db.query(
    'select id, name, monthly_target as target from account where household_id = $1 and is_emergency',
    [householdId],
  );
  if (!rows[0]) throw new HttpError(404, 'Rekening darurat belum diatur.');
  return rows[0];
}

/**
 * Rekening darurat: setiap penarikan = utang ke rekening sendiri (emergency_debt),
 * dilunasi dengan satu transfer ke rekening darurat. Satu transfer boleh melunasi beberapa utang.
 */
export default async function emergencyRoutes(app) {
  const pool = app.pg;

  app.get('/api/emergency', async (req) => {
    requireReports(req);
    const u = req.user;
    const acc = await emergencyAccount(pool, u.household_id);
    const { rows } = await pool.query(
      `select d.id, d.amount, d.status, d.repayment_trx_id,
              w.trx_date, w.note, c.name as category_name, wu.name as recorded_by,
              r.trx_date as repaid_date, ra.name as repaid_from, ru.name as repaid_by
         from emergency_debt d
         join trx w on w.id = d.withdrawal_trx_id and w.deleted_at is null
         left join category c on c.id = w.category_id
         join app_user wu on wu.id = w.user_id
         left join trx r on r.id = d.repayment_trx_id
         left join account ra on ra.id = r.account_id
         left join app_user ru on ru.id = r.user_id
        where w.account_id = $1
        order by w.trx_date desc, w.created_at desc`,
      [acc.id],
    );
    const open = rows.filter((d) => d.status === 'open');
    const openDebt = open.reduce((s, d) => s + d.amount, 0);

    // Pelunasan dikelompokkan per transfer (paling baru dulu, 20 terakhir).
    const groups = new Map();
    for (const d of rows.filter((x) => x.status === 'paid')) {
      const g = groups.get(d.repayment_trx_id) ?? {
        trx_id: d.repayment_trx_id, repaid_date: d.repaid_date, repaid_from: d.repaid_from,
        repaid_by: d.repaid_by, amount: 0, debts: [],
      };
      g.amount += d.amount;
      g.debts.push(d);
      groups.set(d.repayment_trx_id, g);
    }
    const repayments = [...groups.values()]
      .sort((a, b) => (a.repaid_date < b.repaid_date ? 1 : -1))
      .slice(0, 20);

    return {
      today: todayJakarta(),
      account: acc,
      open_debt: openDebt,
      filled: Math.max(0, (acc.target ?? 0) - openDebt),
      open,
      repayments,
      payday: u.payday_dom,
    };
  });

  // Catat pelunasan: transfer dari rekening lain ke rekening darurat sebesar jumlah utang terpilih.
  app.post('/api/emergency/repay', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['debt_ids', 'account_id', 'trx_date'],
        properties: {
          debt_ids: { type: 'array', items: uuid, minItems: 1, maxItems: 200, uniqueItems: true },
          account_id: uuid,
          trx_date: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    if (!isValidDate(b.trx_date)) throw new HttpError(400, 'Tanggal tidak valid.');
    const out = await withTx(pool, async (c) => {
      const acc = await emergencyAccount(c, u.household_id);
      if (b.account_id === acc.id) throw new HttpError(400, 'Pilih rekening asal selain rekening darurat.');
      const from = await c.query('select 1 from account where id = $1 and household_id = $2', [b.account_id, u.household_id]);
      if (!from.rowCount) throw new HttpError(400, 'Pilih rekening asal.');

      const { rows } = await c.query(
        `select d.id, d.amount
           from emergency_debt d
           join trx w on w.id = d.withdrawal_trx_id and w.deleted_at is null
          where d.id = any($1::uuid[]) and w.account_id = $2 and d.status = 'open'
          for update of d`,
        [b.debt_ids, acc.id],
      );
      if (rows.length !== b.debt_ids.length) throw new HttpError(409, 'Sebagian utang sudah lunas atau tidak ditemukan. Muat ulang halaman.');
      const total = rows.reduce((s, d) => s + d.amount, 0);

      const cycleId = await ensureCycle(c, u.household_id, cycleStart(b.trx_date, u.payday_dom));
      const t = await c.query(
        `insert into trx (account_id, to_account_id, cycle_id, user_id, trx_date, kind, amount, note)
         values ($1, $2, $3, $4, $5, 'transfer', $6, 'Pelunasan rekening darurat') returning id`,
        [b.account_id, acc.id, cycleId, u.id, b.trx_date, total],
      );
      await c.query(
        `update emergency_debt set status = 'paid', repayment_trx_id = $2 where id = any($1::uuid[])`,
        [b.debt_ids, t.rows[0].id],
      );
      return { trx_id: t.rows[0].id, amount: total, count: rows.length };
    });
    return reply.code(201).send(out);
  });

  // Batalkan pelunasan: utangnya kembali belum lunas, transfernya dihapus (lunak).
  app.delete('/api/emergency/repayments/:trxId', {
    schema: { params: { type: 'object', properties: { trxId: uuid }, required: ['trxId'] } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    await withTx(pool, async (c) => {
      const acc = await emergencyAccount(c, u.household_id);
      const { rows } = await c.query(
        `select id from trx where id = $1 and to_account_id = $2 and kind = 'transfer' and deleted_at is null for update`,
        [req.params.trxId, acc.id],
      );
      if (!rows[0]) throw new HttpError(404, 'Pelunasan tidak ditemukan.');
      const upd = await c.query(
        `update emergency_debt set status = 'open', repayment_trx_id = null where repayment_trx_id = $1`,
        [req.params.trxId],
      );
      if (!upd.rowCount) throw new HttpError(404, 'Transfer ini bukan pelunasan utang darurat.');
      await c.query(
        'update trx set deleted_at = now(), updated_at = now(), updated_by = $2 where id = $1',
        [req.params.trxId, u.id],
      );
    });
    return { ok: true };
  });
}
