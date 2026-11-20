// Reset TRANSAKSI saja. Yang tetap ada: rekening, kategori, anggota dan login, definisi tagihan,
// anggaran, batas harian, dan nilai tabungan yang diisi manual.
//
//   node scripts/reset-transactions.js --semua                     simulasi: hanya menghitung, tidak menghapus
//   node scripts/reset-transactions.js --semua --commit            hapus SEMUA transaksi (mulai dari nol)
//   node scripts/reset-transactions.js --sejak 2026-11-01          simulasi: transaksi bertanggal 1 Nov 2026 ke atas
//   node scripts/reset-transactions.js --sejak 2026-11-01 --commit hapus yang itu saja, riwayat lama tetap
//
// Di Docker: docker compose exec app node scripts/reset-transactions.js --semua
// Buat cadangan dulu (deploy/backup.sh). Penghapusan bersifat permanen (bukan hapus lunak).
//
// Yang ikut terhapus: utang rekening darurat yang tertaut (penarikan atau pelunasannya ikut hilang),
// jadwal tagihan yang belum dibayar atau tertaut ke transaksi itu (dibuat ulang otomatis saat layar
// Tagihan dibuka), dan siklus gajian yang jadi kosong.
import { parseArgs } from 'node:util';
import { createPool } from '../src/db.js';
import { isValidDate } from '../src/lib/dates.js';

const { values: opt } = parseArgs({
  options: {
    semua: { type: 'boolean', default: false },
    sejak: { type: 'string' },
    commit: { type: 'boolean', default: false },
  },
});

function fail(msg) {
  console.error(`Gagal: ${msg}\n\nPakai tepat satu: --semua  atau  --sejak YYYY-MM-DD   (tambahkan --commit untuk benar-benar menghapus)`);
  process.exit(1);
}
if (opt.semua === Boolean(opt.sejak)) fail('pilih --semua atau --sejak, tidak keduanya dan tidak kosong');
if (opt.sejak && !isValidDate(opt.sejak)) fail(`tanggal tidak valid: ${opt.sejak}`);

const where = opt.semua ? 'true' : 'trx_date >= $1::date';
const params = opt.semua ? [] : [opt.sejak];
const ids = `(select id from trx where ${where})`;
const rp = (n) => `Rp ${String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const pool = createPool();
const c = await pool.connect();
try {
  await c.query('begin');
  const q = async (sql, p = params) => (await c.query(sql, p)).rows;

  const before = (await q(`select count(*)::int as n, count(*) filter (where ${where})::int as hapus,
      min(trx_date) filter (where ${where}) as dari, max(trx_date) filter (where ${where}) as sampai from trx`))[0];
  const byKind = await q(`select kind, count(*)::int n, sum(amount) total from trx where ${where} group by kind order by kind`);
  const imported = (await q(`select count(*)::int n from trx where ${where} and import_batch is not null`))[0].n;

  // Urutan penting: yang bergantung pada transaksi dihapus lebih dulu.
  const debts = (await c.query(`delete from emergency_debt where withdrawal_trx_id in ${ids} or repayment_trx_id in ${ids}`, params)).rowCount;
  const occ = (await c.query(opt.semua
    ? 'delete from bill_occurrence'
    : `delete from bill_occurrence where status = 'pending' or transaction_id in ${ids}`, params)).rowCount;
  const trx = (await c.query(`delete from trx where ${where}`, params)).rowCount;
  const cycles = (await c.query(`delete from pay_cycle pc
     where not exists (select 1 from trx t where t.cycle_id = pc.id)
       and not exists (select 1 from bill_occurrence o where o.cycle_id = pc.id)
       and not exists (select 1 from budget b where b.cycle_id = pc.id)`)).rowCount;

  const left = (await c.query('select count(*)::int n from trx')).rows[0].n;
  console.log(`\n=== ${opt.commit ? 'RESET' : 'SIMULASI (tidak ada yang dihapus)'} · ${opt.semua ? 'semua transaksi' : `transaksi sejak ${opt.sejak}`} ===`);
  console.log(`Transaksi sekarang : ${before.n}`);
  console.log(`Akan dihapus       : ${trx}${before.dari ? ` (tanggal ${before.dari} s.d. ${before.sampai})` : ''}, ${imported} di antaranya hasil impor`);
  for (const k of byKind) console.log(`  ${k.kind.padEnd(9)} ${String(k.n).padStart(5)} baris, ${rp(k.total)}`);
  console.log(`Utang darurat      : ${debts} dihapus`);
  console.log(`Jadwal tagihan     : ${occ} dihapus (dibuat ulang otomatis saat layar Tagihan dibuka)`);
  console.log(`Siklus kosong      : ${cycles} dihapus`);
  console.log(`Transaksi tersisa  : ${left}`);

  if (opt.commit) {
    await c.query('commit');
    console.log('\nSelesai. Perubahan sudah permanen.');
  } else {
    await c.query('rollback');
    console.log('\nSimulasi selesai, database tidak berubah. Tambahkan --commit untuk menghapus.');
  }
} catch (err) {
  await c.query('rollback').catch(() => {});
  console.error(`Gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
