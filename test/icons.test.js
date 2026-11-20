import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryBadge, accountBadge, accountSubtitle, categoryKeywords, hasCategoryIcon, transferBadge } from '../public/icons.js';

// Nama kategori bawaan diambil langsung dari data awal, supaya kategori baru di sana tidak lolos tanpa ikon.
const seed = readFileSync(new URL('../db/migrations/002_seed.sql', import.meta.url), 'utf8');
const names = [...seed.matchAll(/\(h,\s*'([^']+)',\s*'(?:expense|income)'/g)].map((m) => m[1]);

test('semua kategori bawaan punya ikon sendiri', () => {
  assert.equal(names.length, 23);
  const missing = names.filter((n) => !hasCategoryIcon(n));
  assert.deepEqual(missing, [], `tanpa ikon: ${missing.join(', ')}`);
});

test('badge kategori: SVG, tema, tidak peka huruf besar-kecil, ikon cadangan untuk nama tak dikenal', () => {
  const food = categoryBadge('Makan dan Minum');
  assert.match(food, /^<span class="ico ico-md t-orange"[^>]*><svg/);
  assert.equal(categoryBadge('  makan DAN minum '), food);
  assert.match(categoryBadge('Kategori Buatan Sendiri'), /t-gray/); // cadangan
  assert.match(categoryBadge('Gaji', 'sm'), /ico-sm t-green/);
  assert.ok(!categoryBadge('Gaji').includes('<script'));
});

test('setiap ikon berisi bentuk gambar yang valid dan unik per kategori', () => {
  const seen = new Map();
  for (const n of names) {
    const html = categoryBadge(n);
    assert.match(html, /<(path|circle|rect)\b/, n);
    seen.set(html.replace(/t-\w+/, ''), [...(seen.get(html.replace(/t-\w+/, '')) ?? []), n]);
  }
  // Tiap kategori punya gambar berbeda (kategori sejenis boleh satu warna, tapi gambarnya tidak kembar).
  for (const [, group] of seen) assert.equal(group.length, 1, `gambar kembar: ${group.join(', ')}`);
});

test('badge rekening menurut nama dan jenis', () => {
  assert.match(accountBadge('Rek. utama', { kind: 'bank' }), /t-green/);
  assert.match(accountBadge('Rekening darurat', { kind: 'bank', emergency: true }), /t-amber/);
  assert.match(accountBadge('Kripto', { kind: 'asset' }), /t-violet/);
  assert.match(accountBadge('Saham', { kind: 'asset' }), /t-blue/);
  assert.match(accountBadge('Emas', { kind: 'asset' }), /t-amber/);
  assert.match(accountBadge('GoPay', { kind: 'ewallet' }), /t-orange/);
  assert.match(transferBadge(), /t-slate/);
  assert.equal(accountSubtitle('asset'), 'Tabungan dan investasi');
  assert.equal(accountSubtitle('bank', true), 'Rekening darurat');
  assert.equal(accountSubtitle('tidak-ada'), '');
});

test('kata kunci pencarian: "kopi" menemukan Makan dan Minum, "grab" Transportasi, "listrik" Tagihan', () => {
  const find = (word) => names.filter((n) => categoryKeywords(n).includes(word));
  assert.deepEqual(find('kopi'), ['Makan dan Minum']);
  assert.deepEqual(find('grab'), ['Transportasi']);
  assert.deepEqual(find('listrik'), ['Tagihan']);
  assert.deepEqual(categoryKeywords('tidak ada'), []);
});
