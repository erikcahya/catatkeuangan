import { addDays, billDueDate, cycleEnd, cycleLabel, cycleStart } from './dates.js';

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
 * Pastikan tagihan aktif punya bill_occurrence.
 *
 * - Bulanan (due_dom): satu per siklus, dibuat untuk siklus `start`.
 * - Berinterval (interval_days): selalu tepat satu yang belum dibayar. Jatuh temponya
 *   = tanggal terakhir dibayar (atau dilewati, atau anchor_date) + interval_days,
 *   ditaruh di siklus yang memuat tanggal itu.
 *
 * Aman dipanggil berulang (unique bill_id + due_date).
 * @returns id pay_cycle untuk `start`
 */
export async function ensureBillOccurrences(db, householdId, start, payday) {
  const cycleId = await ensureCycle(db, householdId, start);

  const { rows: monthly } = await db.query(
    `select b.id, b.due_dom, b.default_amount
       from recurring_bill b
      where b.household_id = $1 and b.is_active and b.due_dom is not null
        and not exists (select 1 from bill_occurrence o where o.bill_id = b.id and o.cycle_id = $2)`,
    [householdId, cycleId],
  );
  for (const b of monthly) {
    await db.query(
      `insert into bill_occurrence (bill_id, cycle_id, due_date, expected_amount)
       values ($1, $2, $3, $4)
       on conflict (bill_id, due_date) do nothing`,
      [b.id, cycleId, billDueDate(start, b.due_dom, payday), b.default_amount],
    );
  }

  const { rows: interval } = await db.query(
    `select b.id, b.interval_days, b.default_amount,
            greatest(
              b.anchor_date,
              (select max(t.trx_date) from bill_occurrence o join trx t on t.id = o.transaction_id
                where o.bill_id = b.id and o.status = 'paid'),
              (select max(o.due_date) from bill_occurrence o
                where o.bill_id = b.id and o.status = 'skipped')
            ) as base
       from recurring_bill b
      where b.household_id = $1 and b.is_active and b.interval_days is not null
        and not exists (select 1 from bill_occurrence o where o.bill_id = b.id and o.status = 'pending')`,
    [householdId],
  );
  for (const b of interval) {
    const due = addDays(b.base, b.interval_days);
    const dueCycle = await ensureCycle(db, householdId, cycleStart(due, payday));
    await db.query(
      `insert into bill_occurrence (bill_id, cycle_id, due_date, expected_amount)
       values ($1, $2, $3, $4)
       on conflict (bill_id, due_date) do nothing`,
      [b.id, dueCycle, due, b.default_amount],
    );
  }
  return cycleId;
}

/**
 * Setelah tagihan berinterval kembali belum dibayar (pembayaran dihapus / batal lewati),
 * hapus jatuh tempo berikutnya yang sempat dibuat darinya, supaya tetap satu yang belum dibayar.
 */
export async function retractIntervalAfter(db, occurrenceId) {
  await db.query(
    `delete from bill_occurrence nxt
      using bill_occurrence cur, recurring_bill b
      where cur.id = $1 and b.id = cur.bill_id and b.interval_days is not null
        and nxt.bill_id = cur.bill_id and nxt.id <> cur.id
        and nxt.status = 'pending' and nxt.due_date > cur.due_date`,
    [occurrenceId],
  );
}
