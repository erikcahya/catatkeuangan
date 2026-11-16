import { dayType } from './dates.js';

/**
 * Status budget harian per kategori pada tanggal itu.
 * Total = jumlah pengeluaran kategori itu pada tanggal tersebut yang belum dihapus.
 * @param categoryId  null = semua kategori yang punya batas harian
 */
export async function dailyBudgets(db, householdId, date, categoryId = null) {
  const type = dayType(date);
  const { rows } = await db.query(
    `select c.id as category_id, c.name as category_name, b.limit_amount as limit,
            coalesce((select sum(t.amount)
                        from trx t join account a on a.id = t.account_id
                       where a.household_id = $1 and t.category_id = c.id
                         and t.trx_date = $2 and t.kind = 'expense'
                         and t.deleted_at is null), 0) as total
       from daily_budget b
       join category c on c.id = b.category_id
      where b.household_id = $1 and b.day_type = $3
        and ($4::uuid is null or b.category_id = $4)
      order by c.name`,
    [householdId, date, type, categoryId],
  );
  return rows.map((r) => ({ ...r, date, day_type: type, over: Math.max(0, r.total - r.limit) }));
}
