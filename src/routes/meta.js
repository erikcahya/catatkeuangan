import { cycleEnd, cycleLabel, cycleStart, todayJakarta } from '../lib/dates.js';

/** Data yang dibutuhkan form: pengguna yang login, rekening, kategori, siklus berjalan. */
export default async function metaRoutes(app) {
  const pool = app.pg;

  app.get('/api/meta', async (req) => {
    const u = req.user;
    const [accounts, categories] = await Promise.all([
      pool.query(
        // price_source/symbol/unit_price: aset yang nilainya mengikuti harga pasar (form Tabung/Tarik menawarkan jumlah unit).
        `select a.id, a.name, a.kind, a.is_emergency, h.price_source, h.symbol, h.unit_price
           from account a left join savings_holding h on h.account_id = a.id
          where a.household_id = $1 order by a.is_emergency, a.kind, a.name`,
        [u.household_id],
      ),
      pool.query(
        // uses = berapa kali dipakai 180 hari terakhir: untuk bagian "Sering dipakai" di pilihan kategori.
        `select c.id, c.name, c.kind, c.counts_as_bill,
                (select count(*)::int from trx t
                  where t.category_id = c.id and t.deleted_at is null
                    and t.trx_date >= current_date - 180) as uses
           from category c
          where c.household_id = $1 order by c.kind, c.name`,
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
