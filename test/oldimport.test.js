import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, classify, reviewReasons, planEmergency, buildPlan } from '../src/lib/oldimport.js';

const row = (category, note, amount, date = '2025-01-10', line = 2) => ({ line, date, category, note, source: 'kas', amount });

test('parseCsv: kutip, koma di dalam kolom, CRLF', () => {
  const csv = 'tanggal,kategori,keterangan,sumber,jumlah\r\n'
    + '2025-01-02,Pemasukan Lainnya,"hasanah, kiki, bunda",kas,150000\r\n'
    + '2025-01-03,Belanja,"kata ""x""",kas,-2000\n';
  const r = parseCsv(csv);
  assert.equal(r.length, 2);
  assert.equal(r[0].note, 'hasanah, kiki, bunda');
  assert.equal(r[1].note, 'kata "x"');
  assert.equal(r[1].amount, -2000);
  assert.equal(r[1].line, 3);
  assert.throws(() => parseCsv('tanggal,kategori,keterangan,sumber,jumlah\n10-01-2025,A,b,kas,1'), /tidak valid/);
  assert.throws(() => parseCsv('a,b\n1,2'), /Kolom/);
});

test('classify: penarikan dan pelunasan rekening darurat', () => {
  for (const n of ['utang octo', 'pinjam permata iin', 'Pinjem octo', 'utang tabungan', 'pinjam tabungan octo',
    'pinjam octo iin 1,5 juta', 'utang octo selama ini', 'pinjam permata iin buat berobat', 'pinjam tabungan iin']) {
    assert.equal(classify(row('Pemasukan Lainnya', n, 1000)), 'tarik', n);
  }
  for (const n of ['bayar utang octo', 'bayar utang permata iin', 'ganti utang iin', 'bayar utang tabungan iin',
    'bayar utang tabungan permata iin', 'ganti utang permata iin', 'bayar utang permata']) {
    assert.equal(classify(row('Tagihan', n, -1000)), 'lunas', n);
  }
});

test('classify: yang mirip tapi bukan tabungan sendiri tidak ikut', () => {
  assert.equal(classify(row('Pemasukan Lainnya', 'pinjam tko 25 jt', 1000)), 'income');
  assert.equal(classify(row('Pemasukan Lainnya', 'mamah bayar utang', 1000)), 'income');
  assert.equal(classify(row('Pemasukan Lainnya', 'nia bayar utang fm minggu lalu', 1000)), 'income');
  assert.equal(classify(row('Tagihan', 'bayar utang pasar uang(masuk ke rekening iin)', -1000)), 'expense');
  assert.equal(classify(row('Tagihan', 'bayar utang crypto', -1000)), 'expense');
  assert.equal(classify(row('Tagihan', 'bayar utang fm wilona', -1000)), 'expense');
  assert.equal(classify(row('Tagihan', 'bayar kos octo', -1000)), 'expense');
  assert.equal(classify(row('Makan dan Minum', 'tomoro utang octo', -1000)), 'expense');
  assert.equal(classify(row('Keluarga dan Teman', 'tf mamah papah', -1000)), 'expense'); // bukan rekening sendiri
  assert.equal(classify(row('Gaji', 'gaji erick', 5000)), 'income');
});

test('reviewReasons: baris yang harus ditinjau, bukan diperbaiki diam-diam', () => {
  const r = (c, n, a) => reviewReasons(row(c, n, a), classify(row(c, n, a)));
  assert.ok(r('Makan dan Minum', 'nabung bibit', -50000).some((x) => /tabungan\/investasi/.test(x))); // contoh di SPEC
  assert.ok(r('Hasil Investasi', 'wd tokocrypto', 1000000).length >= 1);
  assert.ok(r('Investasi', 'reksa', -1000000).length >= 1);
  assert.ok(r('Keluarga dan Teman', 'pinjami mamah 50 jt', -50_000_000).some((x) => /utang/.test(x)));
  assert.ok(r('Keluarga dan Teman', 'pinjami mamah 50 jt', -50_000_000).some((x) => /Nominal besar/.test(x)));
  assert.ok(r('Pemasukan Lainnya', 'nia bayar utang fm', 100000).length >= 1);
  assert.ok(r('Makan dan Minum', 'paket data iin', -50000).some((x) => /Kategori mungkin salah/.test(x)));
  assert.ok(r('Tagihan', 'bayar utang pasar uang(masuk ke rekening iin)', -1000000).length >= 1);
  // Bukan tinjauan:
  assert.deepEqual(r('Makan dan Minum', 'tomoro utang octo', -50000), []); // dibayar dari tabungan = pengeluaran biasa
  assert.deepEqual(r('Belanja', 'beli tabung gas', -25000), []);
  assert.deepEqual(r('Gaji', 'gaji erick', 30_000_000), []);
  assert.deepEqual(r('Pemasukan Lainnya', 'utang octo', 2_000_000), []); // tarik: ditangani pemasangan utang
});

test('planEmergency: pelunasan FIFO, sebagian, dan melebihi utang', () => {
  const ev = (idx, date, type, amount) => ({ idx, date, type, amount });
  // Dua penarikan, satu pelunasan yang menutup yang pertama dan sebagian yang kedua.
  let p = planEmergency([ev(0, '2025-01-01', 'tarik', 1000), ev(1, '2025-01-05', 'tarik', 2000), ev(2, '2025-01-25', 'lunas', 1500)]);
  assert.deepEqual(p.debts, [
    { tarikIdx: 0, date: '2025-01-01', status: 'paid', repayIdx: 2, amount: 1000 },
    { tarikIdx: 1, date: '2025-01-05', status: 'open', repayIdx: null, amount: 1500 }, // sisa, bukan 2000
  ]);
  assert.equal(p.openTotal, 1500);
  assert.equal(p.creditLeft, 0);

  // Pelunasan sebagian dua kali: yang melunasi sepenuhnya tercatat sebagai pelunasnya.
  p = planEmergency([ev(0, '2025-01-01', 'tarik', 1000), ev(1, '2025-01-10', 'lunas', 400), ev(2, '2025-01-20', 'lunas', 600)]);
  assert.deepEqual(p.debts, [{ tarikIdx: 0, date: '2025-01-01', status: 'paid', repayIdx: 2, amount: 1000 }]);

  // Pelunasan melebihi utang: sisanya jadi kredit untuk penarikan berikutnya.
  p = planEmergency([ev(0, '2025-02-01', 'lunas', 5000), ev(1, '2025-02-02', 'tarik', 3000), ev(2, '2025-02-03', 'tarik', 4000)]);
  assert.deepEqual(p.surplus, [{ idx: 0, date: '2025-02-01', amount: 5000 }]);
  assert.deepEqual(p.debts, [
    { tarikIdx: 1, date: '2025-02-02', status: 'paid', repayIdx: 0, amount: 3000 },
    { tarikIdx: 2, date: '2025-02-03', status: 'open', repayIdx: null, amount: 2000 },
  ]);
  assert.equal(p.openTotal, 2000);

  // Hari yang sama: penarikan dulu, jadi pelunasan di hari gajian menutupnya.
  p = planEmergency([ev(0, '2025-03-25', 'lunas', 1200), ev(1, '2025-03-25', 'tarik', 1200)]);
  assert.equal(p.openTotal, 0);
  assert.equal(p.surplus.length, 0);
});

test('planEmergency: sisa akhir = total penarikan - total pelunasan', () => {
  const ev = [];
  let sumT = 0, sumL = 0;
  for (let i = 0; i < 60; i++) {
    const type = i % 3 === 2 ? 'lunas' : 'tarik';
    const amount = 100 + ((i * 37) % 900);
    ev.push({ idx: i, date: `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, type, amount });
    if (type === 'tarik') sumT += amount; else sumL += amount;
  }
  const p = planEmergency(ev);
  assert.equal(p.openTotal - p.creditLeft, sumT - sumL);
  assert.ok(p.debts.every((d) => (d.status === 'paid') === (d.repayIdx !== null)));
});

test('buildPlan: transfer, siklus gaji, dan hitungan', () => {
  const rows = [
    row('Makan dan Minum', 'kantin iin', -25000, '2025-08-24', 2),
    row('Gaji', 'gaji erick', 20_000_000, '2025-08-24', 3), // cair sehari lebih awal -> siklus 25 Agu
    row('Gaji', 'gajian', 20_000_000, '2025-10-04', 4), // terlambat -> siklus 25 Sep
    row('Pemasukan Lainnya', 'utang octo', 2_000_000, '2025-08-26', 5),
    row('Tagihan', 'bayar utang octo', -2_000_000, '2025-09-25', 6),
  ];
  const p = buildPlan(rows);
  assert.deepEqual(p.trx.map((t) => t.kind), ['expense', 'income', 'income', 'transfer', 'transfer']);
  assert.deepEqual(p.trx.map((t) => t.cycleStart), ['2025-07-25', '2025-08-25', '2025-09-25', '2025-08-25', '2025-09-25']);
  assert.deepEqual([p.trx[3].from, p.trx[3].to], ['emergency', 'main']);
  assert.deepEqual([p.trx[4].from, p.trx[4].to], ['main', 'emergency']);
  assert.ok(p.trx.every((t) => t.amount > 0 && t.isOneOff === false));
  assert.equal(p.debts.length, 1);
  assert.equal(p.debts[0].status, 'paid');
  assert.equal(p.emergency.openTotal, 0);
  assert.equal(p.review.length, 0);
});
