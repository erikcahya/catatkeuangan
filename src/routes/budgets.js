import { withTx } from '../db.js';
import { HttpError } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const amount = { type: ['integer', 'null'], minimum: 0, maximum: 999_999_999_999 };

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Pengaturan anggaran tidak tersedia untuk akun Anda.');
}

/**
 * Pengaturan anggaran:
 *  - Anggaran per kategori per siklus (budget_default): tampil di Laporan sebagai "terpakai / anggaran".
 *  - Batas budget harian (daily_budget): peringatan di Beranda dan saat mencatat pengeluaran.
 */
export default async function budgetRoutes(app) {
  const pool = app.pg;

  app.get('/api/budgets', async (req) => {
    requireReports(req);
    const { rows } = await pool.query(
      `select c.id as category_id, c.name, d.limit_amount as limit
         from category c
         left join budget_default d on d.category_id = c.id and d.household_id = c.household_id
        where c.household_id = $1 and c.kind = 'expense'
        order by (d.limit_amount is null), c.name`,
      [req.user.household_id],
    );
    return { items: rows, total: rows.reduce((s, r) => s + (r.limit ?? 0), 0) };
  });

  // Simpan semua anggaran sekaligus; limit null = hapus anggaran kategori itu.
  app.put('/api/budgets', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array', maxItems: 100,
            items: { type: 'object', additionalProperties: false, required: ['category_id', 'limit'],
              properties: { category_id: uuid, limit: amount } },
          },
        },
      },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    await withTx(pool, async (c) => {
      const valid = new Set((await c.query(
        `select id from category where household_id = $1 and kind = 'expense'`, [u.household_id])).rows.map((r) => r.id));
      for (const it of req.body.items) {
        if (!valid.has(it.category_id)) throw new HttpError(400, 'Kategori tidak valid.');
        if (it.limit == null) {
          await c.query('delete from budget_default where household_id = $1 and category_id = $2', [u.household_id, it.category_id]);
        } else {
          await c.query(
            `insert into budget_default (household_id, category_id, limit_amount) values ($1, $2, $3)
             on conflict (household_id, category_id) do update set limit_amount = excluded.limit_amount`,
            [u.household_id, it.category_id, it.limit],
          );
        }
      }
    });
    return { ok: true };
  });

  app.get('/api/budgets/daily', async (req) => {
    requireReports(req);
    const { rows } = await pool.query(
      `select c.id as category_id, c.name,
              max(b.limit_amount) filter (where b.day_type = 'weekday') as weekday,
              max(b.limit_amount) filter (where b.day_type = 'weekend') as weekend
         from daily_budget b join category c on c.id = b.category_id
        where b.household_id = $1
        group by c.id, c.name order by c.name`,
      [req.user.household_id],
    );
    return { items: rows };
  });

  // Atur batas harian satu kategori; keduanya null = hapus.
  app.put('/api/budgets/daily', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['category_id', 'weekday', 'weekend'],
        properties: { category_id: uuid, weekday: amount, weekend: amount },
      },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const b = req.body;
    await withTx(pool, async (c) => {
      const cat = await c.query(`select 1 from category where id = $1 and household_id = $2 and kind = 'expense'`, [b.category_id, u.household_id]);
      if (!cat.rowCount) throw new HttpError(400, 'Kategori tidak valid.');
      for (const [type, limit] of [['weekday', b.weekday], ['weekend', b.weekend]]) {
        if (limit == null) {
          await c.query('delete from daily_budget where household_id = $1 and category_id = $2 and day_type = $3', [u.household_id, b.category_id, type]);
        } else {
          await c.query(
            `insert into daily_budget (household_id, category_id, day_type, limit_amount) values ($1, $2, $3, $4)
             on conflict (household_id, category_id, day_type) do update set limit_amount = excluded.limit_amount`,
            [u.household_id, b.category_id, type, limit],
          );
        }
      }
    });
    return { ok: true };
  });
}
