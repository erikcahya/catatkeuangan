import { HttpError } from '../lib/errors.js';
import { dailyBudgets } from '../lib/budget.js';
import { ensureBillOccurrences } from '../lib/cycles.js';
import { billCycleSummary } from './bills.js';
import { balanceReminder } from './balance.js';
import { cycleEnd, cycleLabel, cycleStart, daysBetween, isValidDate, todayJakarta } from '../lib/dates.js';

/**
 * Ringkasan untuk Beranda.
 *
 * Tafsiran angka (lihat SPEC.md, bagian Beranda):
 * - Anggaran siklus = total pemasukan siklus itu; sisa = pemasukan - pengeluaran.
 * - Transfer tidak dihitung sebagai pemasukan maupun pengeluaran.
 * - Rekening darurat terisi = target - utang yang belum lunas.
 * - Tabungan disetor = transfer ke rekening berjenis asset pada siklus itu.
 *
 * Anggota yang tidak boleh melihat laporan (anak) hanya mendapat budget harian.
 */
export default async function summaryRoutes(app) {
  const pool = app.pg;

  app.get('/api/summary', {
    schema: {
      querystring: { type: 'object', properties: { cycle: { type: 'string' } } },
    },
  }, async (req) => {
    const u = req.user;
    const today = todayJakarta();
    const currentStart = cycleStart(today, u.payday_dom);
    const start = req.query.cycle ?? currentStart;
    if (!isValidDate(start) || cycleStart(start, u.payday_dom) !== start) {
      throw new HttpError(400, 'Siklus tidak valid.');
    }
    const end = cycleEnd(start);
    const status = start === currentStart ? 'current' : start < currentStart ? 'past' : 'future';
    const cycle = {
      start, end, label: cycleLabel(start), status,
      days_left: status === 'current' ? daysBetween(today, end) : null,
    };

    const daily = await dailyBudgets(pool, u.household_id, today);
    if (!u.can_view_reports) return { today, cycle, daily_budgets: daily, restricted: true };

    const [totals, emergency, bills, savings, cycles] = await Promise.all([
      pool.query(
        `select coalesce(sum(t.amount) filter (where t.kind = 'income'), 0)  as income,
                coalesce(sum(t.amount) filter (where t.kind = 'expense'), 0) as expense
           from trx t
           join pay_cycle pc on pc.id = t.cycle_id
          where pc.household_id = $1 and pc.start_date = $2 and t.deleted_at is null`,
        [u.household_id, start],
      ),
      pool.query(
        `select a.name, a.monthly_target as target,
                coalesce((select sum(d.amount)
                            from emergency_debt d join trx t on t.id = d.withdrawal_trx_id
                           where d.status = 'open' and t.account_id = a.id and t.deleted_at is null), 0) as open_debt
           from account a where a.household_id = $1 and a.is_emergency`,
        [u.household_id],
      ),
      (status === 'future'
        ? Promise.resolve()
        : ensureBillOccurrences(pool, u.household_id, start, u.payday_dom))
        .then(() => billCycleSummary(pool, u.household_id, start, status === 'current')),
      pool.query(
        `select coalesce(sum(t.amount), 0) as deposited,
                -- nilai semua aset sekarang (harga pasar atau diisi manual), bukan per siklus
                (select coalesce(sum(h.current_value), 0) from savings_holding h join account a on a.id = h.account_id
                  where a.household_id = $1 and a.kind = 'asset') as value,
                (select count(h.current_value)::int from savings_holding h join account a on a.id = h.account_id
                  where a.household_id = $1 and a.kind = 'asset') as valued
           from trx t
           join pay_cycle pc on pc.id = t.cycle_id
           join account ta on ta.id = t.to_account_id
          where pc.household_id = $1 and pc.start_date = $2
            and t.kind = 'transfer' and ta.kind = 'asset' and t.deleted_at is null`,
        [u.household_id, start],
      ),
      pool.query(
        `select start_date as start, label from pay_cycle
          where household_id = $1 order by start_date desc limit 120`,
        [u.household_id],
      ),
    ]);

    const { income, expense } = totals.rows[0];
    const em = emergency.rows[0];
    // Siklus berjalan selalu bisa dipilih walau belum ada transaksinya.
    const list = cycles.rows.some((c) => c.start === currentStart)
      ? cycles.rows
      : [{ start: currentStart, label: cycleLabel(currentStart) }, ...cycles.rows];

    return {
      today,
      cycle,
      cycles: list.sort((a, b) => (a.start < b.start ? 1 : -1)),
      totals: { income, expense, remaining: income - expense },
      daily_budgets: daily,
      emergency: em
        ? { name: em.name, target: em.target, open_debt: em.open_debt, filled: Math.max(0, (em.target ?? 0) - em.open_debt) }
        : null,
      bills,
      savings: savings.rows[0],
      balance_reminder: await balanceReminder(pool, u.household_id, today),
      restricted: false,
    };
  });
}
