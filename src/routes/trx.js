import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { dailyBudgets } from '../lib/budget.js';
import { ensureCycle, retractIntervalAfter } from '../lib/cycles.js';
import { cycleLabel, cycleStart, isValidDate, salaryCycleStart } from '../lib/dates.js';

const SALARY_CATEGORY = 'Gaji';
const uuid = { type: 'string', format: 'uuid' };
// type array: Fastify hanya mengubah tipe bila nilai tidak cocok dengan tipe mana pun,
// jadi null tetap null (anyOf mengubah null menjadi "" atau 0 lebih dulu).
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };

export const LIST_SQL = `
  select t.id, t.kind, t.amount, t.trx_date, t.note, t.is_one_off, t.created_at, t.updated_at,
         a.name  as account_name,
         ta.name as to_account_name,
         c.name  as category_name,
         u.name  as recorded_by,
         ub.name as updated_by,
         (ed.id is not null) as is_emergency_withdrawal
    from trx t
    join account a       on a.id = t.account_id
    left join account ta on ta.id = t.to_account_id
    left join category c on c.id = t.category_id
    join app_user u      on u.id = t.user_id
    left join app_user ub on ub.id = t.updated_by
    left join emergency_debt ed on ed.withdrawal_trx_id = t.id
   where a.household_id = $1 and t.deleted_at is null`;

export default async function trxRoutes(app) {
  const pool = app.pg;

  app.get('/api/trx', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          cycle: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, // awal siklus, opsional
        },
      },
    },
  }, async (req) => {
    const { rows } = await pool.query(
      `${LIST_SQL}
         and ($3::date is null or t.cycle_id in
              (select id from pay_cycle where household_id = $1 and start_date = $3::date))
       order by t.trx_date desc, t.created_at desc limit $2`,
      [req.user.household_id, req.query.limit, req.query.cycle ?? null],
    );
    return { items: rows };
  });

  app.post('/api/trx', {
    schema: {
      body: {
        type: 'object',
        required: ['kind', 'amount', 'trx_date'],
        additionalProperties: false,
        properties: {
          kind: { enum: ['income', 'expense', 'transfer'] },
          amount: { type: 'integer', minimum: 1, maximum: 999_999_999_999 },
          trx_date: { type: 'string' },
          account_id: nullableUuid,
          to_account_id: nullableUuid,
          category_id: nullableUuid,
          note: { type: ['string', 'null'], maxLength: 300 },
          is_one_off: { type: 'boolean', default: false },
          from_emergency: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req, reply) => {
    const u = req.user;
    const b = req.body;
    if (!isValidDate(b.trx_date)) throw new HttpError(400, 'Tanggal tidak valid.');

    const result = await withTx(pool, async (c) => {
      const accounts = (await c.query(
        'select id, name, is_emergency from account where household_id = $1',
        [u.household_id],
      )).rows;
      const byId = new Map(accounts.map((a) => [a.id, a]));

      let accountId = b.account_id;
      let toAccountId = null;
      let categoryId = null;
      let category = null;

      if (b.from_emergency) {
        if (b.kind !== 'expense') throw new HttpError(400, 'Hanya pengeluaran yang bisa diambil dari rekening darurat.');
        const em = accounts.find((a) => a.is_emergency);
        if (!em) throw new HttpError(400, 'Rekening darurat belum diatur.');
        accountId = em.id;
      }
      if (!byId.has(accountId)) throw new HttpError(400, 'Pilih rekening.');

      if (b.kind === 'transfer') {
        toAccountId = b.to_account_id;
        if (!byId.has(toAccountId)) throw new HttpError(400, 'Pilih rekening tujuan.');
        if (toAccountId === accountId) throw new HttpError(400, 'Rekening asal dan tujuan harus berbeda.');
      } else {
        const cat = await c.query(
          'select id, name, kind from category where id = $1 and household_id = $2',
          [b.category_id, u.household_id],
        );
        category = cat.rows[0];
        if (!category) throw new HttpError(400, 'Pilih kategori.');
        if (category.kind !== b.kind) throw new HttpError(400, 'Kategori tidak cocok dengan jenis transaksi.');
        categoryId = category.id;
      }

      const start = category?.name === SALARY_CATEGORY
        ? salaryCycleStart(b.trx_date, u.payday_dom)
        : cycleStart(b.trx_date, u.payday_dom);
      const cycleId = await ensureCycle(c, u.household_id, start);

      const note = b.note?.trim() || null;
      const { rows } = await c.query(
        `insert into trx (account_id, to_account_id, category_id, cycle_id, user_id,
                          trx_date, kind, amount, note, is_one_off)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [accountId, toAccountId, categoryId, cycleId, u.id,
          b.trx_date, b.kind, b.amount, note, b.kind === 'expense' && b.is_one_off],
      );
      const id = rows[0].id;

      if (b.from_emergency) {
        await c.query(
          'insert into emergency_debt (withdrawal_trx_id, amount) values ($1, $2)',
          [id, b.amount],
        );
      }

      const daily = b.kind === 'expense'
        ? (await dailyBudgets(c, u.household_id, b.trx_date, categoryId))[0] ?? null
        : null;
      const item = (await c.query(`${LIST_SQL} and t.id = $2`, [u.household_id, id])).rows[0];
      return { item, cycle: { start, label: cycleLabel(start) }, daily_budget: daily };
    });

    return reply.code(201).send(result);
  });

  // Hapus lunak. Penarikan darurat yang belum lunas ikut menghapus utangnya;
  // tagihan yang sudah dibayar dengan transaksi ini kembali menjadi belum dibayar.
  app.delete('/api/trx/:id', {
    schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
  }, async (req) => {
    const u = req.user;
    await withTx(pool, async (c) => {
      const { rows } = await c.query(
        `select t.id,
                ed.id as debt_id, ed.status as debt_status,
                (select count(*) from emergency_debt r where r.repayment_trx_id = t.id)::int as repays
           from trx t
           join account a on a.id = t.account_id
           left join emergency_debt ed on ed.withdrawal_trx_id = t.id
          where t.id = $1 and a.household_id = $2 and t.deleted_at is null
          for update of t`,
        [req.params.id, u.household_id],
      );
      const t = rows[0];
      if (!t) throw new HttpError(404, 'Transaksi tidak ditemukan.');
      if (t.debt_status === 'paid') throw new HttpError(409, 'Utang darurat ini sudah dilunasi. Batalkan pelunasannya dulu.');
      if (t.repays > 0) throw new HttpError(409, 'Transaksi ini adalah pelunasan utang darurat. Batalkan dari layar Rekening darurat.');

      if (t.debt_id) await c.query('delete from emergency_debt where id = $1', [t.debt_id]);
      const reset = await c.query(
        `update bill_occurrence set status = 'pending', transaction_id = null where transaction_id = $1 returning id`,
        [t.id],
      );
      // Tagihan berinterval: jatuh tempo berikutnya yang dihitung dari pembayaran ini ikut ditarik.
      for (const r of reset.rows) await retractIntervalAfter(c, r.id);
      await c.query(
        'update trx set deleted_at = now(), updated_at = now(), updated_by = $2 where id = $1',
        [t.id, u.id],
      );
    });
    return { ok: true };
  });
}
