import { HttpError } from '../lib/errors.js';
import { cycleEnd, cycleLabel, cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';

/**
 * Laporan siklus: pemasukan, pengeluaran, sisa, dan rincian per kategori.
 * Transfer (Tabung, pelunasan darurat) tidak dihitung sebagai pemasukan maupun pengeluaran.
 * Anggaran per kategori diambil dari tabel budget bila ada; belum ada layar untuk mengaturnya.
 */
export default async function reportRoutes(app) {
  const pool = app.pg;

  app.get('/api/report', {
    schema: { querystring: { type: 'object', properties: { cycle: { type: 'string' } } } },
  }, async (req) => {
    const u = req.user;
    if (!u.can_view_reports) throw new HttpError(403, 'Laporan tidak tersedia untuk akun Anda.');
    const current = cycleStart(todayJakarta(), u.payday_dom);
    const start = req.query.cycle ?? current;
    if (!isValidDate(start) || cycleStart(start, u.payday_dom) !== start) throw new HttpError(400, 'Siklus tidak valid.');

    const [byCat, extra, cycles] = await Promise.all([
      pool.query(
        `with spent as (
           select t.category_id, t.kind, sum(t.amount) as total, count(*)::int as count
             from trx t join pay_cycle pc on pc.id = t.cycle_id
            where pc.household_id = $1 and pc.start_date = $2
              and t.kind in ('income', 'expense') and t.deleted_at is null
            group by t.category_id, t.kind
         ),
         planned as (
           -- anggaran siklus itu bila ada, kalau tidak anggaran standar kategori
           select c.id as category_id, coalesce(cb.limit_amount, d.limit_amount) as limit_amount
             from category c
             left join budget_default d on d.category_id = c.id and d.household_id = c.household_id
             left join (select b.category_id, b.limit_amount
                          from budget b join pay_cycle pc on pc.id = b.cycle_id
                         where pc.household_id = $1 and pc.start_date = $2) cb on cb.category_id = c.id
            where c.household_id = $1 and coalesce(cb.limit_amount, d.limit_amount) is not null
         )
         select c.id as category_id, c.name, c.kind,
                coalesce(s.total, 0) as total, coalesce(s.count, 0) as count,
                p.limit_amount as budget
           from category c
           left join spent s on s.category_id = c.id
           left join planned p on p.category_id = c.id
          where c.household_id = $1 and (s.total is not null or p.limit_amount is not null)
          order by c.kind, coalesce(s.total, 0) desc, c.name`,
        [u.household_id, start],
      ),
      pool.query(
        `select coalesce(sum(t.amount) filter (where t.kind = 'expense' and t.is_one_off), 0) as one_off,
                coalesce(sum(t.amount) filter (where t.kind = 'expense' and ed.id is not null), 0) as from_emergency,
                coalesce(sum(t.amount) filter (where t.kind = 'transfer' and ta.kind = 'asset'), 0) as saved
           from trx t
           join pay_cycle pc on pc.id = t.cycle_id
           left join account ta on ta.id = t.to_account_id
           left join emergency_debt ed on ed.withdrawal_trx_id = t.id
          where pc.household_id = $1 and pc.start_date = $2 and t.deleted_at is null`,
        [u.household_id, start],
      ),
      pool.query(
        `select start_date as start, label from pay_cycle
          where household_id = $1 order by start_date desc limit 120`,
        [u.household_id],
      ),
    ]);

    const expense = byCat.rows.filter((r) => r.kind === 'expense');
    const income = byCat.rows.filter((r) => r.kind === 'income');
    const sum = (rows) => rows.reduce((s, r) => s + r.total, 0);
    const totalIncome = sum(income);
    const totalExpense = sum(expense);
    const list = cycles.rows.some((c) => c.start === current)
      ? cycles.rows
      : [{ start: current, label: cycleLabel(current) }, ...cycles.rows];

    return {
      cycle: { start, end: cycleEnd(start), label: cycleLabel(start) },
      cycles: list.sort((a, b) => (a.start < b.start ? 1 : -1)),
      totals: { income: totalIncome, expense: totalExpense, remaining: totalIncome - totalExpense },
      // Nilai semua rekening aset sekarang (bukan per siklus): dari harga pasar atau nilai manual.
      extra: { ...extra.rows[0], ...(await pool.query(
        `select coalesce(sum(h.current_value), 0) as asset_value, count(h.current_value)::int as asset_valued
           from account a join savings_holding h on h.account_id = a.id
          where a.household_id = $1 and a.kind = 'asset'`,
        [u.household_id],
      )).rows[0] },
      expense_by_category: expense,
      income_by_category: income,
    };
  });
}
