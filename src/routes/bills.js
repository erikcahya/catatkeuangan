import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { ensureBillOccurrences, ensureCycle, retractIntervalAfter } from '../lib/cycles.js';
import { cycleEnd, cycleLabel, cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] };
const nullableInt = (min, max) => ({ type: ['integer', 'null'], minimum: min, maximum: max });

// Jadwal: isi due_dom (tanggal tetap tiap bulan) ATAU interval_days + anchor_date
// (tiap N hari sejak pembayaran terakhir; anchor_date = pembayaran terakhir sebelum dicatat).
const billBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'category_id', 'account_id', 'default_amount'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    category_id: uuid,
    account_id: uuid,
    default_amount: { type: 'integer', minimum: 0, maximum: 999_999_999_999 },
    is_variable: { type: 'boolean', default: false },
    due_dom: nullableInt(1, 31),
    interval_days: nullableInt(7, 366),
    anchor_date: { type: ['string', 'null'] },
    remind_days_before: { type: 'integer', minimum: 0, maximum: 28, default: 3 },
    is_active: { type: 'boolean', default: true },
  },
};

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Halaman ini tidak tersedia untuk akun Anda.');
}

/** Normalkan jadwal dari body; lempar 400 bila tidak lengkap. */
function schedule(b) {
  if (b.interval_days != null) {
    if (!b.anchor_date || !isValidDate(b.anchor_date)) throw new HttpError(400, 'Isi tanggal pembayaran terakhir.');
    return { due_dom: null, interval_days: b.interval_days, anchor_date: b.anchor_date };
  }
  if (b.due_dom == null) throw new HttpError(400, 'Pilih tanggal jatuh tempo.');
  return { due_dom: b.due_dom, interval_days: null, anchor_date: null };
}

// Tagihan di siklus `start`; untuk siklus berjalan ($3 = true) ikut tagihan
// yang belum dibayar dari siklus sebelumnya (terlambat).
const IN_CYCLE = `pc.household_id = $1
  and (pc.start_date = $2 or ($3 and o.status = 'pending' and pc.start_date < $2))`;

/** Ringkasan tagihan satu siklus. Yang sudah dibayar dihitung dengan nominal transaksinya. */
export async function billCycleSummary(db, householdId, start, isCurrent) {
  const { rows } = await db.query(
    `select count(*)::int as count,
            (count(*) filter (where o.status = 'paid'))::int as paid_count,
            (count(*) filter (where o.status = 'pending'))::int as unpaid_count,
            coalesce(sum(case when o.status = 'paid' then t.amount else o.expected_amount end), 0) as total,
            coalesce(sum(o.expected_amount) filter (where o.status = 'pending'), 0) as unpaid_amount
       from bill_occurrence o
       join pay_cycle pc on pc.id = o.cycle_id
       left join trx t on t.id = o.transaction_id
      where ${IN_CYCLE} and o.status <> 'skipped'`,
    [householdId, start, isCurrent],
  );
  return rows[0];
}

/** Cek kategori pengeluaran dan rekening milik rumah tangga ini. */
async function checkRefs(db, householdId, { category_id, account_id }) {
  const { rows } = await db.query(
    `select (select kind from category where id = $2 and household_id = $1) as cat_kind,
            (select kind from account where id = $3 and household_id = $1) as acc_kind`,
    [householdId, category_id, account_id],
  );
  if (rows[0].cat_kind !== 'expense') throw new HttpError(400, 'Pilih kategori pengeluaran.');
  if (!rows[0].acc_kind) throw new HttpError(400, 'Pilih rekening.');
}

export default async function billRoutes(app) {
  const pool = app.pg;

  app.get('/api/bills', {
    schema: { querystring: { type: 'object', properties: { cycle: { type: 'string' } } } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const today = todayJakarta();
    const current = cycleStart(today, u.payday_dom);
    const start = req.query.cycle ?? current;
    if (!isValidDate(start) || cycleStart(start, u.payday_dom) !== start) throw new HttpError(400, 'Siklus tidak valid.');
    // Siklus mendatang tidak dibuatkan tagihan bulanan dulu, supaya perubahan nominal masih terbawa.
    if (start <= current) await ensureBillOccurrences(pool, u.household_id, start, u.payday_dom);
    const isCurrent = start === current;

    const [items, bills, summary] = await Promise.all([
      pool.query(
        `select o.id, o.bill_id, b.name, b.is_variable, b.remind_days_before, b.is_active,
                b.category_id, b.account_id, b.interval_days,
                o.due_date, o.expected_amount, o.status,
                t.id as trx_id, t.amount as paid_amount, t.trx_date as paid_date
           from bill_occurrence o
           join recurring_bill b on b.id = o.bill_id
           join pay_cycle pc on pc.id = o.cycle_id
           left join trx t on t.id = o.transaction_id
          where ${IN_CYCLE}
          order by o.due_date, b.name`,
        [u.household_id, start, isCurrent],
      ),
      pool.query(
        `select b.id, b.name, b.category_id, c.name as category_name, b.account_id, a.name as account_name,
                b.default_amount, b.is_variable, b.due_dom, b.interval_days, b.anchor_date,
                b.remind_days_before, b.is_active,
                (select min(o.due_date) from bill_occurrence o
                  where o.bill_id = b.id and o.status = 'pending') as next_due
           from recurring_bill b
           join category c on c.id = b.category_id
           join account a on a.id = b.account_id
          where b.household_id = $1
          order by b.is_active desc, b.name`,
        [u.household_id],
      ),
      billCycleSummary(pool, u.household_id, start, isCurrent),
    ]);

    return {
      today,
      cycle: {
        start, end: cycleEnd(start), label: cycleLabel(start),
        status: isCurrent ? 'current' : start < current ? 'past' : 'future',
      },
      summary,
      items: items.rows,
      bills: bills.rows,
    };
  });

  app.post('/api/bills', { schema: { body: billBody } }, async (req, reply) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    const sch = schedule(b);
    const out = await withTx(pool, async (c) => {
      await checkRefs(c, u.household_id, b);
      const { rows } = await c.query(
        `insert into recurring_bill (household_id, category_id, account_id, name, default_amount,
                                     is_variable, due_dom, interval_days, anchor_date,
                                     remind_days_before, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [u.household_id, b.category_id, b.account_id, b.name.trim(), b.default_amount,
          b.is_variable, sch.due_dom, sch.interval_days, sch.anchor_date, b.remind_days_before, b.is_active],
      );
      await ensureBillOccurrences(c, u.household_id, cycleStart(todayJakarta(), u.payday_dom), u.payday_dom);
      return { id: rows[0].id };
    });
    return reply.code(201).send(out);
  });

  // Ubah tagihan. Tagihan yang belum dibayar di siklus berjalan (dan, untuk tagihan
  // berinterval, jatuh tempo berikutnya) dibuat ulang dari pengaturan baru.
  // Yang sudah dibayar, dilewati, atau terlambat dari siklus lama tidak berubah.
  app.put('/api/bills/:id', { schema: { params: idParams, body: billBody } }, async (req) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    const sch = schedule(b);
    await withTx(pool, async (c) => {
      await checkRefs(c, u.household_id, b);
      const { rowCount } = await c.query(
        `update recurring_bill
            set category_id = $3, account_id = $4, name = $5, default_amount = $6, is_variable = $7,
                due_dom = $8, interval_days = $9, anchor_date = $10,
                remind_days_before = $11, is_active = $12
          where id = $1 and household_id = $2`,
        [req.params.id, u.household_id, b.category_id, b.account_id, b.name.trim(), b.default_amount,
          b.is_variable, sch.due_dom, sch.interval_days, sch.anchor_date, b.remind_days_before, b.is_active],
      );
      if (!rowCount) throw new HttpError(404, 'Tagihan tidak ditemukan.');

      const start = cycleStart(todayJakarta(), u.payday_dom);
      await c.query(
        `delete from bill_occurrence o using pay_cycle pc
          where o.bill_id = $1 and pc.id = o.cycle_id and o.status = 'pending'
            and (pc.start_date >= $2 or $3)`,
        [req.params.id, start, sch.interval_days != null],
      );
      if (b.is_active) await ensureBillOccurrences(c, u.household_id, start, u.payday_dom);
    });
    return { ok: true };
  });

  // Bayar: buat transaksi pengeluaran dan tautkan ke tagihan.
  // Siklus transaksi = yang lebih akhir antara siklus tagihan dan siklus tanggal bayar:
  // bayar lebih awal tetap masuk siklus tagihannya, bayar terlambat masuk siklus saat dibayar.
  app.post('/api/bills/occurrences/:id/pay', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'trx_date', 'account_id'],
        properties: {
          amount: { type: 'integer', minimum: 1, maximum: 999_999_999_999 },
          trx_date: { type: 'string' },
          account_id: uuid,
          note: { type: ['string', 'null'], maxLength: 300 },
        },
      },
    },
  }, async (req, reply) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    if (!isValidDate(b.trx_date)) throw new HttpError(400, 'Tanggal tidak valid.');
    const out = await withTx(pool, async (c) => {
      const { rows } = await c.query(
        `select o.id, o.status, pc.start_date as cycle_start, rb.name, rb.category_id
           from bill_occurrence o
           join recurring_bill rb on rb.id = o.bill_id
           join pay_cycle pc on pc.id = o.cycle_id
          where o.id = $1 and rb.household_id = $2
          for update of o`,
        [req.params.id, u.household_id],
      );
      const o = rows[0];
      if (!o) throw new HttpError(404, 'Tagihan tidak ditemukan.');
      if (o.status === 'paid') throw new HttpError(409, 'Tagihan ini sudah dibayar.');
      const acc = await c.query('select 1 from account where id = $1 and household_id = $2', [b.account_id, u.household_id]);
      if (!acc.rowCount) throw new HttpError(400, 'Pilih rekening.');

      const payCycle = cycleStart(b.trx_date, u.payday_dom);
      const cycleId = await ensureCycle(c, u.household_id, payCycle > o.cycle_start ? payCycle : o.cycle_start);
      const t = await c.query(
        `insert into trx (account_id, category_id, cycle_id, user_id, trx_date, kind, amount, note)
         values ($1, $2, $3, $4, $5, 'expense', $6, $7) returning id`,
        [b.account_id, o.category_id, cycleId, u.id, b.trx_date, b.amount, b.note?.trim() || o.name],
      );
      await c.query(`update bill_occurrence set status = 'paid', transaction_id = $2 where id = $1`, [o.id, t.rows[0].id]);
      // Tagihan berinterval: jatuh tempo berikutnya dihitung dari tanggal bayar ini.
      await ensureBillOccurrences(c, u.household_id, cycleStart(todayJakarta(), u.payday_dom), u.payday_dom);
      return { trx_id: t.rows[0].id };
    });
    return reply.code(201).send(out);
  });

  // Lewati tagihan sekali (mis. pembantu libur), atau batalkan lewati.
  app.post('/api/bills/occurrences/:id/skip', {
    schema: {
      params: idParams,
      body: { type: 'object', required: ['skipped'], properties: { skipped: { type: 'boolean' } } },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    await withTx(pool, async (c) => {
      const { rowCount } = await c.query(
        `update bill_occurrence o set status = $3
           from recurring_bill rb
          where o.id = $1 and rb.id = o.bill_id and rb.household_id = $2 and o.status <> 'paid'`,
        [req.params.id, u.household_id, req.body.skipped ? 'skipped' : 'pending'],
      );
      if (!rowCount) throw new HttpError(409, 'Tagihan tidak ditemukan atau sudah dibayar.');
      if (req.body.skipped) {
        await ensureBillOccurrences(c, u.household_id, cycleStart(todayJakarta(), u.payday_dom), u.payday_dom);
      } else {
        await retractIntervalAfter(c, req.params.id);
      }
    });
    return { ok: true };
  });
}
