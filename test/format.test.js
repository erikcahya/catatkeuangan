import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rupiah, parseRupiah, tanggal, esc } from '../public/format.js';

test('rupiah memakai titik sebagai pemisah ribuan', () => {
  assert.equal(rupiah(520000), 'Rp 520.000');
  assert.equal(rupiah(0), 'Rp 0');
  assert.equal(rupiah(10000000), 'Rp 10.000.000');
  assert.equal(rupiah(-1200000), 'Rp 1.200.000');
});

test('parseRupiah membaca input yang sudah diformat', () => {
  assert.equal(parseRupiah('Rp 520.000'), 520000);
  assert.equal(parseRupiah('1.200.000'), 1200000);
  assert.equal(parseRupiah(''), 0);
  assert.equal(parseRupiah('abc'), 0);
});

test('tanggal Indonesia singkat', () => {
  assert.equal(tanggal('2026-12-16'), '16 Des 2026');
  assert.equal(tanggal('2026-08-04'), '4 Agu 2026');
});

test('esc menetralkan HTML', () => {
  assert.equal(esc('<b>"a" & \'b\'</b>'), '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;');
  assert.equal(esc(null), '');
});

import { tanggalPendek, selisihHari } from '../public/format.js';

test('tanggalPendek dan selisihHari', () => {
  assert.equal(tanggalPendek('2026-12-22'), '22 Des');
  assert.equal(selisihHari('2026-11-16', '2026-11-22'), 6);
  assert.equal(selisihHari('2026-12-30', '2027-01-02'), 3);
  assert.equal(selisihHari('2026-11-16', '2026-11-10'), -6);
});

import { rupiahSingkat } from '../public/format.js';

test('rupiahSingkat seperti di desain laporan', () => {
  assert.equal(rupiahSingkat(25000000), 'Rp 25 jt');
  assert.equal(rupiahSingkat(15550000), 'Rp 15,6 jt');
  assert.equal(rupiahSingkat(9450000), 'Rp 9,5 jt');
  assert.equal(rupiahSingkat(450000), 'Rp 450 rb');
  assert.equal(rupiahSingkat(1250000000), 'Rp 1,3 M');
  assert.equal(rupiahSingkat(500), 'Rp 500');
  assert.equal(rupiahSingkat(-2000000), 'Rp 2 jt');
});

import { siklusTerakhir, labelSiklus } from '../public/format.js';

test('siklusTerakhir dan labelSiklus', () => {
  assert.deepEqual(siklusTerakhir('2026-01-25', 3), ['2026-01-25', '2025-12-25', '2025-11-25']);
  assert.equal(labelSiklus('2026-11-25'), '25 Nov – 24 Des');
  assert.equal(labelSiklus('2026-12-25'), '25 Des – 24 Jan');
});
