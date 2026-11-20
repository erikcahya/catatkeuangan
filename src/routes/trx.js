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
         t.account_id, t.to_account_id, t.category_id,
         a.name  as account_name,
         a.kind  as account_kind,
         ta.name as to_account_name,
         ta.kind as to_account_kind,
         c.name  as category_name,
         u.name  as recorded_by,
         ub.name as updated_by,
         (ed.id is not null) as is_emergency_withdrawal,
         ed.status as debt_status,
         exists (select 1 from emergency_debt r where r.repayment_trx_id = t.id) as is_repayment,
         exists (select 1 from bill_occurrence o where o.transaction_id = t.id) as is_bill_payment
    from trx t
    join account a       on a.id = t.account_id
    left join account ta on ta.id = t.to_account_id
    left join category c on c.id = t.category_id
    join app_user u      on u.id = t.user_id
    left join app_user ub on ub.id = t.updated_by
    left join emergency_debt ed on ed.withdrawal_trx_id = t.id
   where a.household_id = $1 and t.deleted_at is null`;

const trxBody = {
  kind: { enum: ['income', 'expense', 'transfer'] },
  amount: { type: 'integer', minimum: 1, maximum: 999_999_999_999 },
  trx_date: { type: 'string' },
  account_id: nullableUuid,
  to_account_id: nullableUuid,
  category_id: nullableUuid,
  note: { type: ['string', 'null'], maxLength: 300 },
  is_one_off: { type: 'boolean', default: false },
};

/**
 * Validasi rekening dan kategori sebuah transaksi (dipakai catat dan ubah).
 * forcedAccountId / forcedToAccountId: rekening yang dikunci (penarikan darurat).
 */
async function resolveTarget(c, u, b, { forcedAccountId = null, forcedToAccountId = null } = {}) {
  const accounts = (await c.query('select id from account where household_id = $1', [u.household_id])).rows;
  const known = new Set(accounts.map((a) => a.id));
  const accountId = forcedAccountId ?? b.account_id;
  if (!known.has(accountId)) throw new HttpError(400, 'Pilih rekening.');

  if (b.kind === 'transfer') {
    const toAccountId = forcedToAccountId ?? b.to_account_id;
    if (!known.has(toAccountId)) throw new HttpError(400, 'Pilih rekening tujuan.');
    if (toAccountId === accountId) throw new HttpError(400, 'Rekening asal dan tujuan harus berbeda.');
    return { accountId, toAccountId, categoryId: null, category: null };
  }
  const cat = (await c.query(
    'select id, name, kind from category where id = $1 and household_id = $2',
    [b.category_id, u.household_id],
  )).rows[0];
  if (!cat) throw new HttpError(400, 'Pilih kategori.');
  if (cat.kind !== b.kind) throw new HttpError(400, 'Kategori tidak cocok dengan jenis transaksi.');
  return { accountId, toAccountId: null, categoryId: cat.id, category: cat };
}

/** Awal siklus untuk sebuah transaksi: gaji ke siklus gajian terdekat, lainnya menurut tanggal. */
function cycleFor(date, category, payday) {
  return category?.name === SALARY_CATEGORY ? salaryCycleStart(date, payday) : cycleStart(date, payday);
}

export default async function trxRoutes(app) {
  const pool = app.pg;

  app.get('/api/trx', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          cycle: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, // awal siklus, opsional
          category_id: uuid, // opsional
          offset: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 0 }, // untuk "muat lebih banyak"
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, // tanggal transaksi, opsional, inklusif
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  }, async (req) => {
    const q = req.query;
    if ((q.from && !isValidDate(q.from)) || (q.to && !isValidDate(q.to))) throw new HttpError(400, 'Tanggal tidak valid.');
    if (q.from && q.to && q.from > q.to) throw new HttpError(400, 'Tanggal awal harus sebelum tanggal akhir.');
    const { rows } = await pool.query(
      `${LIST_SQL}
         and ($3::date is null or t.cycle_id in
              (select id from pay_cycle where household_id = $1 and start_date = $3::date))
         and ($4::uuid is null or t.category_id = $4::uuid)
         and ($6::date is null or t.trx_date >= $6::date)
         and ($7::date is null or t.trx_date <= $7::date)
       order by t.trx_date desc, t.created_at desc, t.id desc
       limit $2 offset $5`,
      [req.user.household_id, q.limit, q.cycle ?? null, q.category_id ?? null, q.offset, q.from ?? null, q.to ?? null],
    );
    return { items: rows };
  });

  app.get('/api/trx/:id', {
    schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
  }, async (req) => {
    const { rows } = await pool.query(`${LIST_SQL} and t.id = $2`, [req.user.household_id, req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Transaksi tidak ditemukan.');
    return { item: rows[0] };
  });

  app.post('/api/trx', {
    schema: {
      body: {
        type: 'object',
        required: ['kind', 'amount', 'trx_date'],
        additionalProperties: false,
        properties: { ...trxBody, from_emergency: { type: 'boolean', default: false } },
      },
    },
  }, async (req, reply) => {
    const u = req.user;
    const b = req.body;
    if (!isValidDate(b.trx_date)) throw new HttpError(400, 'Tanggal tidak valid.');

    const result = await withTx(pool, async (c) => {
      let forcedAccountId = null;
      if (b.from_emergency) {
        if (b.kind !== 'expense') throw new HttpError(400, 'Hanya pengeluaran yang bisa diambil dari rekening darurat.');
        const em = (await c.query('select id from account where household_id = $1 and is_emergency', [u.household_id])).rows[0];
        if (!em) throw new HttpError(400, 'Rekening darurat belum diatur.');
        forcedAccountId = em.id;
      }
      const { accountId, toAccountId, categoryId, category } = await resolveTarget(c, u, b, { forcedAccountId });
      const start = cycleFor(b.trx_date, category, u.payday_dom);
      const cycleId = await ensureCycle(c, u.household_id, start);

      const { rows } = await c.query(
        `insert into trx (account_id, to_account_id, category_id, cycle_id, user_id,
                          trx_date, kind, amount, note, is_one_off)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [accountId, toAccountId, categoryId, cycleId, u.id,
          b.trx_date, b.kind, b.amount, b.note?.trim() || null, b.kind === 'expense' && b.is_one_off],
      );
      const id = rows[0].id;
      if (b.from_emergency) {
        await c.query('insert into emergency_debt (withdrawal_trx_id, amount) values ($1, $2)', [id, b.amount]);
      }

      const daily = b.kind === 'expense'
        ? (await dailyBudgets(c, u.household_id, b.trx_date, categoryId))[0] ?? null
        : null;
      const item = (await c.query(`${LIST_SQL} and t.id = $2`, [u.household_id, id])).rows[0];
      return { item, cycle: { start, label: cycleLabel(start) }, daily_budget: daily };
    });

    return reply.code(201).send(result);
  });

  // Ubah transaksi. Semua anggota boleh (SPEC); pengubah terakhir dicatat.
  //  - Penarikan rekening darurat (punya utang) dan pembayaran tagihan: jenisnya terkunci;
  //    penarikan juga terkunci rekeningnya. Jumlah penarikan yang utangnya sudah lunas terkunci.
  //  - Transfer pelunasan utang darurat tidak bisa diubah (batalkan dari layar Rekening darurat).
  app.put('/api/trx/:id', {
    schema: {
      params: { type: 'object', properties: { id: uuid }, required: ['id'] },
      body: { type: 'object', required: ['kind', 'amount', 'trx_date'], additionalProperties: false, properties: trxBody },
    },
  }, async (req) => {
    const u = req.user;
    const b = req.body;
    if (!isValidDate(b.trx_date)) throw new HttpError(400, 'Tanggal tidak valid.');

    return withTx(pool, async (c) => {
      const { rows } = await c.query(
        `select t.id, t.kind, t.amount, t.account_id, t.to_account_id,
                ed.id as debt_id, ed.status as debt_status, ed.amount as debt_amount,
                (select count(*) from emergency_debt r where r.repayment_trx_id = t.id)::int as repays,
                o.id as occ_id, opc.start_date as occ_cycle_start
           from trx t
           join account a on a.id = t.account_id
           left join emergency_debt ed on ed.withdrawal_trx_id = t.id
           left join bill_occurrence o on o.transaction_id = t.id
           left join pay_cycle opc on opc.id = o.cycle_id
          where t.id = $1 and a.household_id = $2 and t.deleted_at is null
          for update of t`,
        [req.params.id, u.household_id],
      );
      const t = rows[0];
      if (!t) throw new HttpError(404, 'Transaksi tidak ditemukan.');
      if (t.repays > 0) throw new HttpError(409, 'Ini pelunasan utang darurat. Batalkan lalu catat ulang dari layar Rekening darurat.');

      const withdrawal = !!t.debt_id;
      if ((withdrawal || t.occ_id) && b.kind !== t.kind) throw new HttpError(400, 'Jenis transaksi ini tidak bisa diubah.');
      if (withdrawal && t.debt_status === 'paid' && b.amount !== t.amount) {
        throw new HttpError(409, 'Utang darurat ini sudah dilunasi, jadi jumlahnya tidak bisa diubah. Batalkan pelunasannya dulu.');
      }

      const { accountId, toAccountId, categoryId, category } = await resolveTarget(c, u, b, withdrawal
        ? { forcedAccountId: t.account_id, forcedToAccountId: t.to_account_id } : {});

      let start = cycleFor(b.trx_date, category, u.payday_dom);
      // Pembayaran tagihan tetap di siklus tagihannya bila dibayar lebih awal (sama seperti saat membayar).
      if (t.occ_id && t.occ_cycle_start > start) start = t.occ_cycle_start;
      const cycleId = await ensureCycle(c, u.household_id, start);

      await c.query(
        `update trx set account_id = $2, to_account_id = $3, category_id = $4, cycle_id = $5, trx_date = $6,
                kind = $7, amount = $8, note = $9, is_one_off = $10, updated_by = $11, updated_at = now()
          where id = $1`,
        [t.id, accountId, toAccountId, categoryId, cycleId, b.trx_date, b.kind, b.amount,
          b.note?.trim() || null, b.kind === 'expense' && b.is_one_off, u.id],
      );

      // Utang yang masih terbuka ikut berubah sebesar selisih jumlahnya.
      if (withdrawal && t.debt_status === 'open' && b.amount !== t.amount) {
        const next = t.debt_amount + (b.amount - t.amount);
        if (next <= 0) throw new HttpError(400, 'Jumlah terlalu kecil: sebagian utang ini sudah dilunasi.');
        await c.query('update emergency_debt set amount = $2 where id = $1', [t.debt_id, next]);
      }

      const daily = b.kind === 'expense'
        ? (await dailyBudgets(c, u.household_id, b.trx_date, categoryId))[0] ?? null
        : null;
      const item = (await c.query(`${LIST_SQL} and t.id = $2`, [u.household_id, t.id])).rows[0];
      return { item, cycle: { start, label: cycleLabel(start) }, daily_budget: daily };
    });
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
