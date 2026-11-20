// Impor catatan lama (CSV dari scripts/xlsx-to-csv.py).
//
//   npm run import-old -- <berkas.csv>                  simulasi: tidak menulis apa pun ke database
//   npm run import-old -- <berkas.csv> --commit         tulis ke database (satu transaksi)
//   npm run import-old -- --rollback                    batalkan seluruh gelombang impor
//
// Opsi: --user <nama>   pencatat semua transaksi lama (default: anggota pertama bernama Erik, atau suami)
//       --batch <nama>  penanda gelombang impor (default: catatan-lama)
//
// Aturan: SPEC.md "Impor catatan lama". Baris yang meragukan TIDAK diubah; semuanya ditulis ke
// laporan-tinjau.csv di samping berkas CSV untuk diperiksa manusia.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool, withTx } from '../src/db.js';
import { ensureCycle } from '../src/lib/cycles.js';
import { buildPlan, parseCsv } from '../src/lib/oldimport.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    commit: { type: 'boolean', default: false },
    rollback: { type: 'boolean', default: false },
    user: { type: 'string' },
    batch: { type: 'string', default: 'catatan-lama' },
  },
});

const rp = (n) => `Rp ${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const pool = createPool();

async function rollback() {
  const out = await withTx(pool, async (c) => {
    const ids = `(select id from trx where import_batch = $1)`;
    const debts = await c.query(`delete from emergency_debt where withdrawal_trx_id in ${ids} or repayment_trx_id in ${ids}`, [opt.batch]);
    const trx = await c.query('delete from trx where import_batch = $1', [opt.batch]);
    // Siklus kosong yang tersisa (tanpa transaksi, tagihan, atau anggaran) ikut dibersihkan.
    const cycles = await c.query(`delete from pay_cycle pc
       where not exists (select 1 from trx t where t.cycle_id = pc.id)
         and not exists (select 1 from bill_occurrence o where o.cycle_id = pc.id)
         and not exists (select 1 from budget b where b.cycle_id = pc.id)`);
    return { debts: debts.rowCount, trx: trx.rowCount, cycles: cycles.rowCount };
  });
  console.log(`Dibatalkan (batch "${opt.batch}"): ${out.trx} transaksi, ${out.debts} utang darurat, ${out.cycles} siklus kosong.`);
}

async function run() {
  const file = positionals[0];
  if (!file) throw new Error('Sebutkan berkas CSV. Lihat komentar di atas scripts/import-old.js.');
  const rows = parseCsv(await readFile(file, 'utf8'));

  // Data referensi dari database.
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const users = await q(`select u.id, u.name, u.role, u.household_id, h.payday_dom from app_user u
                           join household h on h.id = u.household_id order by u.name`);
  const user = opt.user ? users.find((u) => u.name === opt.user)
    : users.find((u) => u.name === 'Erik') ?? users.find((u) => u.role === 'suami');
  if (!user) throw new Error(`Pengguna tidak ditemukan. Yang ada: ${users.map((u) => u.name).join(', ')}`);
  const accounts = await q('select id, name, is_emergency from account where household_id = $1', [user.household_id]);
  const main = accounts.find((a) => a.name === 'Rek. utama');
  const emergency = accounts.find((a) => a.is_emergency);
  if (!main || !emergency) throw new Error('Rekening "Rek. utama" atau rekening darurat tidak ada.');
  const categories = new Map((await q('select id, name from category where household_id = $1', [user.household_id])).map((c) => [c.name, c.id]));
  const unknown = [...new Set(rows.map((r) => r.category))].filter((c) => !categories.has(c));
  if (unknown.length) throw new Error(`Kategori belum ada di aplikasi: ${unknown.join(', ')}`);
  const sources = [...new Set(rows.map((r) => r.source))];

  const plan = buildPlan(rows, { payday: user.payday_dom });

  // Pemeriksaan: setelah transfer dikeluarkan, jumlahnya harus utuh.
  const sum = (f) => plan.trx.filter(f).reduce((s, t) => s + t.amount, 0);
  const rawIncome = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const rawExpense = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const incomeAfter = sum((t) => t.kind === 'income');
  const expenseAfter = sum((t) => t.kind === 'expense');
  const tarik = sum((t) => t.kind === 'transfer' && t.from === 'emergency');
  const lunas = sum((t) => t.kind === 'transfer' && t.from === 'main');
  if (incomeAfter + tarik !== rawIncome || expenseAfter + lunas !== rawExpense) throw new Error('Jumlah tidak cocok setelah pemisahan transfer (bug).');

  const em = plan.emergency;
  const byReason = new Map();
  for (const r of plan.review) for (const why of r.reasons) byReason.set(why, (byReason.get(why) ?? 0) + 1);
  const dates = rows.map((r) => r.date).sort();
  const cycles = [...new Set(plan.trx.map((t) => t.cycleStart))].sort();

  console.log(`\n=== ${opt.commit ? 'IMPOR' : 'SIMULASI (tidak menulis apa pun)'} · batch "${opt.batch}" ===`);
  console.log(`Berkas        : ${rows.length} baris, ${dates[0]} s.d. ${dates.at(-1)}, sumber: ${sources.join(', ')} -> semua ke "${main.name}"`);
  console.log(`Pencatat      : ${user.name} (${user.role}) untuk semua transaksi lama`);
  console.log(`Siklus gajian : ${cycles.length} siklus (${cycles[0]} s.d. ${cycles.at(-1)})`);
  console.log(`Pemasukan     : ${plan.trx.filter((t) => t.kind === 'income').length} baris, ${rp(incomeAfter)}`);
  console.log(`Pengeluaran   : ${plan.trx.filter((t) => t.kind === 'expense').length} baris, ${rp(expenseAfter)}`);
  console.log(`Transfer      : ${plan.trx.filter((t) => t.kind === 'transfer').length} baris (bukan pemasukan/pengeluaran): penarikan darurat ${rp(tarik)}, pelunasan ${rp(lunas)}`);
  console.log(`  cocok dengan berkas: pemasukan ${rp(rawIncome)} = ${rp(incomeAfter)} + ${rp(tarik)}; pengeluaran ${rp(rawExpense)} = ${rp(expenseAfter)} + ${rp(lunas)}`);
  console.log(`Utang darurat : ${plan.debts.length} penarikan -> ${plan.debts.filter((d) => d.status === 'paid').length} lunas, ${plan.debts.filter((d) => d.status === 'open').length} masih terbuka`);
  console.log(`  sisa utang terbuka per ${dates.at(-1)}: ${rp(em.openTotal)}`);
  console.log(`  pelunasan melebihi utang terbuka: ${em.surplus.length} kali, total ${rp(em.surplus.reduce((s, x) => s + x.amount, 0))}; kredit tersisa di akhir ${rp(em.creditLeft)}`);
  console.log(`Info          : ${plan.info.fromSavingsExpense} pengeluaran bertuliskan "utang/pinjam octo|permata" tetap dihitung pengeluaran biasa`);
  console.log(`Perlu ditinjau: ${plan.review.length} baris`);
  for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);

  const reportPath = join(dirname(file), 'laporan-tinjau.csv');
  const lines = ['baris,tanggal,kategori,keterangan,jumlah,alasan', ...plan.review.map((r) =>
    [r.line, r.date, csvCell(r.category), csvCell(r.note), r.amount, csvCell(r.reasons.join(' | '))].join(','))];
  await writeFile(reportPath, `﻿${lines.join('\n')}\n`, 'utf8');
  console.log(`\nLaporan tinjauan: ${reportPath}`);

  if (!opt.commit) { console.log('Simulasi selesai. Tambahkan --commit untuk menulis ke database.'); return; }

  await withTx(pool, async (c) => {
    const existing = await c.query('select count(*)::int as n from trx where import_batch = $1', [opt.batch]);
    if (existing.rows[0].n) throw new Error(`Batch "${opt.batch}" sudah ada (${existing.rows[0].n} transaksi). Jalankan --rollback dulu.`);

    const cycleId = new Map();
    for (const s of cycles) cycleId.set(s, await ensureCycle(c, user.household_id, s));
    const acc = { main: main.id, emergency: emergency.id };
    const ids = plan.trx.map(() => randomUUID());
    const col = (f) => plan.trx.map(f);
    await c.query(
      `insert into trx (id, account_id, to_account_id, category_id, cycle_id, user_id, trx_date, kind, amount, note, is_one_off, import_batch)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::date[], $8::text[], $9::numeric[], $10::text[], $11::bool[], $12::text[])`,
      [ids, col((t) => acc[t.from]), col((t) => (t.to ? acc[t.to] : null)), col((t) => (t.category ? categories.get(t.category) : null)),
        col((t) => cycleId.get(t.cycleStart)), col(() => user.id), col((t) => t.date), col((t) => t.kind), col((t) => t.amount),
        col((t) => t.note), col((t) => t.isOneOff), col(() => opt.batch)],
    );
    if (plan.debts.length) {
      await c.query(
        `insert into emergency_debt (withdrawal_trx_id, repayment_trx_id, amount, status)
         select * from unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::text[])`,
        [plan.debts.map((d) => ids[d.tarikIdx]), plan.debts.map((d) => (d.repayIdx == null ? null : ids[d.repayIdx])),
          plan.debts.map((d) => d.amount), plan.debts.map((d) => d.status)],
      );
    }
    console.log(`Tertulis: ${plan.trx.length} transaksi, ${plan.debts.length} utang darurat.`);
  });
}

try {
  if (opt.rollback) await rollback(); else await run();
} catch (err) {
  console.error(`\nGagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
