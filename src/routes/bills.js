import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { ensureBillOccurrences, ensureCycle } from '../lib/cycles.js';
import { billDueDate, cycleEnd, cycleLabel, cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] };

const billBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'category_id', 'account_id', 'default_amount', 'due_dom'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    category_id: uuid,
    account_id: uuid,
    default_amount: { type: 'integer', minimum: 0, maximum: 999_999_999_999 },
    is_variable: { type: 'boolean', default: false },
    due_dom: { type: 'integer', minimum: 1, maximum: 31 },
    remind_days_before: { type: 'integer', minimum: 0, maximum: 28, default: 3 },
    is_active: { type: 'boolean', default: true },
  },
};

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Halaman ini tidak tersedia untuk akun Anda.');
}

/** Ringkasan tagihan satu siklus. Yang sudah dibayar dihitung dengan nominal transaksinya. */
export async function billCycleSummary(db, householdId, start) {
  const { rows } = await db.query(
    `select count(*)::int as count,
            (count(*) filter (where o.status = 'paid'))::int as paid_count,
            (count(*) filter (where o.status = 'pending'))::int as unpaid_count,
            coalesce(sum(case when o.status = 'paid' then t.amount else o.expected_amount end), 0) as total,
            coalesce(sum(o.expected_amount) filter (where o.status = 'pending'), 0) as unpaid_amount
       from bill_occurrence o
       join pay_cycle pc on pc.id = o.cycle_id
       left join trx t on t.id = o.transaction_id
      where pc.household_id = $1 and pc.start_date = $2 and o.status <> 'skipped'`,
    [householdId, start],
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
    // Siklus mendatang tidak dibuatkan tagihan dulu, supaya perubahan nominal masih terbawa.
    if (start <= current) await ensureBillOccurrences(pool, u.household_id, start, u.payday_dom);

    const [items, bills, summary] = await Promise.all([
      pool.query(
        `select o.id, o.bill_id, b.name, b.is_variable, b.remind_days_before, b.is_active,
                b.category_id, b.account_id,
                o.due_date, o.expected_amount, o.status,
                t.id as trx_id, t.amount as paid_amount, t.trx_date as paid_date
           from bill_occurrence o
           join recurring_bill b on b.id = o.bill_id
           join pay_cycle pc on pc.id = o.cycle_id
           left join trx t on t.id = o.transaction_id
          where pc.household_id = $1 and pc.start_date = $2
          order by o.due_date, b.name`,
        [u.household_id, start],
      ),
      pool.query(
        `select b.id, b.name, b.category_id, c.name as category_name, b.account_id, a.name as account_name,
                b.default_amount, b.is_variable, b.due_dom, b.remind_days_before, b.is_active
           from recurring_bill b
           join category c on c.id = b.category_id
           join account a on a.id = b.account_id
          where b.household_id = $1
          order by b.is_active desc, b.due_dom, b.name`,
        [u.household_id],
      ),
      billCycleSummary(pool, u.household_id, start),
    ]);

    return {
      today,
      cycle: {
        start, end: cycleEnd(start), label: cycleLabel(start),
        status: start === current ? 'current' : start < current ? 'past' : 'future',
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
    const out = await withTx(pool, async (c) => {
      await checkRefs(c, u.household_id, b);
      const { rows } = await c.query(
        `insert into recurring_bill (household_id, category_id, account_id, name, default_amount,
                                     is_variable, due_dom, remind_days_before, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [u.household_id, b.category_id, b.account_id, b.name.trim(), b.default_amount,
          b.is_variable, b.due_dom, b.remind_days_before, b.is_active],
      );
      // Tagihan baru langsung muncul di siklus berjalan.
      await ensureBillOccurrences(c, u.household_id, cycleStart(todayJakarta(), u.payday_dom), u.payday_dom);
      return { id: rows[0].id };
    });
    return reply.code(201).send(out);
  });

  // Ubah tagihan. Tagihan siklus berjalan yang belum dibayar ikut diperbarui;
  // siklus lama dan yang sudah dibayar tidak berubah.
  app.put('/api/bills/:id', { schema: { params: idParams, body: billBody } }, async (req) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    await withTx(pool, async (c) => {
      await checkRefs(c, u.household_id, b);
      const { rowCount } = await c.query(
        `update recurring_bill
            set category_id = $3, account_id = $4, name = $5, default_amount = $6,
                is_variable = $7, due_dom = $8, remind_days_before = $9, is_active = $10
          where id = $1 and household_id = $2`,
        [req.params.id, u.household_id, b.category_id, b.account_id, b.name.trim(), b.default_amount,
          b.is_variable, b.due_dom, b.remind_days_before, b.is_active],
      );
      if (!rowCount) throw new HttpError(404, 'Tagihan tidak ditemukan.');

      const start = cycleStart(todayJakarta(), u.payday_dom);
      const cycleId = await ensureCycle(c, u.household_id, start);
      if (b.is_active) {
        await c.query(
          `update bill_occurrence set expected_amount = $3, due_date = $4
            where bill_id = $1 and cycle_id = $2 and status = 'pending'`,
          [req.params.id, cycleId, b.default_amount, billDueDate(start, b.due_dom, u.payday_dom)],
        );
        await ensureBillOccurrences(c, u.household_id, start, u.payday_dom);
      } else {
        await c.query(
          `delete from bill_occurrence where bill_id = $1 and cycle_id = $2 and status <> 'paid'`,
          [req.params.id, cycleId],
        );
      }
    });
    return { ok: true };
  });

  // Bayar: buat transaksi pengeluaran dan tautkan ke tagihan siklus itu.
  // Transaksi masuk siklus tagihannya walau dibayar sebelum siklus mulai.
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
          note: { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] },
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
        `select o.id, o.status, o.cycle_id, rb.name, rb.category_id
           from bill_occurrence o
           join recurring_bill rb on rb.id = o.bill_id
          where o.id = $1 and rb.household_id = $2
          for update of o`,
        [req.params.id, u.household_id],
      );
      const o = rows[0];
      if (!o) throw new HttpError(404, 'Tagihan tidak ditemukan.');
      if (o.status === 'paid') throw new HttpError(409, 'Tagihan ini sudah dibayar.');
      const acc = await c.query('select 1 from account where id = $1 and household_id = $2', [b.account_id, u.household_id]);
      if (!acc.rowCount) throw new HttpError(400, 'Pilih rekening.');

      const t = await c.query(
        `insert into trx (account_id, category_id, cycle_id, user_id, trx_date, kind, amount, note)
         values ($1, $2, $3, $4, $5, 'expense', $6, $7) returning id`,
        [b.account_id, o.category_id, o.cycle_id, u.id, b.trx_date, b.amount, b.note?.trim() || o.name],
      );
      await c.query(
        `update bill_occurrence set status = 'paid', transaction_id = $2 where id = $1`,
        [o.id, t.rows[0].id],
      );
      return { trx_id: t.rows[0].id };
    });
    return reply.code(201).send(out);
  });

  // Lewati tagihan untuk siklus ini (mis. pembantu libur), atau batalkan lewati.
  app.post('/api/bills/occurrences/:id/skip', {
    schema: {
      params: idParams,
      body: { type: 'object', required: ['skipped'], properties: { skipped: { type: 'boolean' } } },
    },
  }, async (req) => {
    requireReports(req);
    const { rowCount } = await pool.query(
      `update bill_occurrence o set status = $3
         from recurring_bill rb
        where o.id = $1 and rb.id = o.bill_id and rb.household_id = $2 and o.status <> 'paid'`,
      [req.params.id, req.user.household_id, req.body.skipped ? 'skipped' : 'pending'],
    );
    if (!rowCount) throw new HttpError(409, 'Tagihan tidak ditemukan atau sudah dibayar.');
    return { ok: true };
  });
}
