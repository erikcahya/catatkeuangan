import { cycleEnd, cycleLabel, cycleStart, todayJakarta } from '../lib/dates.js';

/** Data yang dibutuhkan form: pengguna yang login, rekening, kategori, siklus berjalan. */
export default async function metaRoutes(app) {
  const pool = app.pg;

  app.get('/api/meta', async (req) => {
    const u = req.user;
    const [accounts, categories] = await Promise.all([
      pool.query(
        `select id, name, kind, is_emergency from account
          where household_id = $1 order by is_emergency, kind, name`,
        [u.household_id],
      ),
      pool.query(
        `select id, name, kind, counts_as_bill from category
          where household_id = $1 order by kind, name`,
        [u.household_id],
      ),
    ]);
    const today = todayJakarta();
    const start = cycleStart(today, u.payday_dom);
    return {
      user: { id: u.id, name: u.name, role: u.role, can_view_reports: u.can_view_reports },
      today,
      cycle: { start, end: cycleEnd(start), label: cycleLabel(start) },
      accounts: accounts.rows,
      categories: categories.rows,
    };
  });
}
