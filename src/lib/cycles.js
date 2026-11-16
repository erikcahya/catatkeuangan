import { billDueDate, cycleEnd, cycleLabel } from './dates.js';

/** Ambil id pay_cycle untuk tanggal awal itu; buat bila belum ada. */
export async function ensureCycle(db, householdId, start) {
  const ins = await db.query(
    `insert into pay_cycle (household_id, start_date, end_date, label)
     values ($1, $2, $3, $4)
     on conflict (household_id, start_date) do nothing
     returning id`,
    [householdId, start, cycleEnd(start), cycleLabel(start)],
  );
  if (ins.rows.length) return ins.rows[0].id;
  const sel = await db.query(
    'select id from pay_cycle where household_id = $1 and start_date = $2',
    [householdId, start],
  );
  return sel.rows[0].id;
}

/**
 * Pastikan tiap tagihan aktif punya satu bill_occurrence di siklus itu.
 * Aman dipanggil berulang (unique bill_id + cycle_id). Tagihan yang dinonaktifkan
 * tidak dibuatkan lagi, tetapi occurrence yang sudah ada tetap.
 * @returns id pay_cycle
 */
export async function ensureBillOccurrences(db, householdId, start, payday) {
  const cycleId = await ensureCycle(db, householdId, start);
  const { rows: bills } = await db.query(
    `select b.id, b.due_dom, b.default_amount
       from recurring_bill b
      where b.household_id = $1 and b.is_active
        and not exists (select 1 from bill_occurrence o where o.bill_id = b.id and o.cycle_id = $2)`,
    [householdId, cycleId],
  );
  for (const b of bills) {
    await db.query(
      `insert into bill_occurrence (bill_id, cycle_id, due_date, expected_amount)
       values ($1, $2, $3, $4)
       on conflict (bill_id, cycle_id) do nothing`,
      [b.id, cycleId, billDueDate(start, b.due_dom, payday), b.default_amount],
    );
  }
  return cycleId;
}
