import { HttpError } from '../lib/errors.js';
import { cycleEnd, cycleLabel, cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';

const uuid = { type: 'string', format: 'uuid' };

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Halaman ini tidak tersedia untuk akun Anda.');
}

function assetType(name) {
  const n = name.toLowerCase();
  for (const t of ['kripto', 'saham', 'emas']) if (n.includes(t)) return t;
  return 'lainnya';
}

/**
 * Tabungan dan investasi = rekening berjenis 'asset'.
 * Setoran = transfer ke rekening aset; penarikan = transfer dari rekening aset.
 * Total setoran bersih = semua setoran - semua penarikan (sepanjang waktu).
 * Nilai sekarang diisi manual dan boleh kosong.
 */
export default async function savingsRoutes(app) {
  const pool = app.pg;

  app.get('/api/savings', {
    schema: { querystring: { type: 'object', properties: { cycle: { type: 'string' } } } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const current = cycleStart(todayJakarta(), u.payday_dom);
    const start = req.query.cycle ?? current;
    if (!isValidDate(start) || cycleStart(start, u.payday_dom) !== start) throw new HttpError(400, 'Siklus tidak valid.');

    const [assets, investExpense] = await Promise.all([
      pool.query(
        `select a.id as account_id, a.name,
                coalesce(sum(t.amount) filter (where t.to_account_id = a.id), 0) as total_in,
                coalesce(sum(t.amount) filter (where t.account_id = a.id), 0)    as total_out,
                coalesce(sum(t.amount) filter (where t.to_account_id = a.id and pc.start_date = $2), 0) as cycle_in,
                coalesce(sum(t.amount) filter (where t.account_id = a.id and pc.start_date = $2), 0)    as cycle_out,
                h.current_value, h.as_of_date
           from account a
           left join trx t on (t.to_account_id = a.id or t.account_id = a.id)
                          and t.kind = 'transfer' and t.deleted_at is null
           left join pay_cycle pc on pc.id = t.cycle_id
           left join savings_holding h on h.account_id = a.id
          where a.household_id = $1 and a.kind = 'asset'
          group by a.id, a.name, h.current_value, h.as_of_date
          order by a.name`,
        [u.household_id, start],
      ),
      // Catatan lama mungkin mencatat setoran sebagai pengeluaran kategori Investasi.
      pool.query(
        `select coalesce(sum(t.amount), 0) as amount, count(*)::int as count
           from trx t
           join category c on c.id = t.category_id
           join pay_cycle pc on pc.id = t.cycle_id
          where pc.household_id = $1 and pc.start_date = $2 and c.name = 'Investasi'
            and t.kind = 'expense' and t.deleted_at is null`,
        [u.household_id, start],
      ),
    ]);

    const items = assets.rows.map((r) => {
      const net = r.total_in - r.total_out;
      return {
        ...r,
        net_invested: net,
        cycle_net: r.cycle_in - r.cycle_out,
        gain: r.current_value == null ? null : r.current_value - net,
      };
    });
    return {
      cycle: { start, end: cycleEnd(start), label: cycleLabel(start) },
      deposited_cycle: items.reduce((s, x) => s + x.cycle_in, 0),
      withdrawn_cycle: items.reduce((s, x) => s + x.cycle_out, 0),
      assets: items,
      investasi_expense: investExpense.rows[0],
    };
  });

  app.put('/api/savings/:accountId/value', {
    schema: {
      params: { type: 'object', properties: { accountId: uuid }, required: ['accountId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['current_value'],
        properties: {
          current_value: { type: ['integer', 'null'], minimum: 0, maximum: 999_999_999_999 },
          as_of_date: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const { rows } = await pool.query(
      `select id, name from account where id = $1 and household_id = $2 and kind = 'asset'`,
      [req.params.accountId, u.household_id],
    );
    const acc = rows[0];
    if (!acc) throw new HttpError(404, 'Rekening aset tidak ditemukan.');
    const value = req.body.current_value;
    const asOf = value == null ? null : (req.body.as_of_date || todayJakarta());
    if (asOf && !isValidDate(asOf)) throw new HttpError(400, 'Tanggal tidak valid.');
    await pool.query(
      `insert into savings_holding (account_id, asset_type, name, current_value, as_of_date)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id) do update set current_value = excluded.current_value, as_of_date = excluded.as_of_date`,
      [acc.id, assetType(acc.name), acc.name, value, asOf],
    );
    return { ok: true };
  });
}
