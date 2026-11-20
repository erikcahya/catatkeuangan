// Menguji komponen pilihan (public/picker.js) dengan DOM tiruan (jsdom): klik dan ketik sungguhan.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let window;
let document;
let enhanceSelect;

before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  window = dom.window;
  document = window.document;
  // jsdom belum mengimplementasikan showModal/close pada <dialog>.
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  for (const [k, v] of Object.entries({ window, document, MutationObserver: window.MutationObserver, Event: window.Event })) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  ({ enhanceSelect } = await import('../public/picker.js'));
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const CATS = [['a', 'Belanja', 2], ['b', 'Makan dan Minum', 9, true], ['c', 'Transportasi', 5], ['d', 'Hiburan', 0], ['e', 'Tagihan', 7], ['f', 'Kesehatan', 1], ['g', 'Lainnya', 0]];

function fixture(items = CATS) {
  document.body.innerHTML = '<div class="row"><label for="cat">Kategori</label><select id="cat"></select></div>';
  const select = document.getElementById('cat');
  fill(select, items);
  return select;
}
const fill = (select, items) => {
  select.innerHTML = items.map(([v, t, uses, sel]) => `<option value="${v}" data-uses="${uses ?? 0}"${sel ? ' selected' : ''}>${t}</option>`).join('');
};
const grid = { title: 'Pilih kategori', mode: 'grid', searchable: true, badge: (o) => `<i class="b">${o.textContent[0]}</i>`,
  keywords: (o) => (o.textContent === 'Makan dan Minum' ? ['kopi', 'warung'] : []) };
const dlg = () => document.querySelector('dialog.picker-sheet');

test('mengganti select dengan tombol: nilai terpilih tampil, label menunjuk tombol', () => {
  const select = fixture();
  enhanceSelect(select, grid);
  assert.equal(select.hidden, true);
  const btn = document.querySelector('.picker-btn');
  assert.ok(btn);
  assert.match(btn.textContent, /Makan dan Minum/);
  assert.equal(btn.getAttribute('aria-label'), 'Pilih kategori: Makan dan Minum');
  assert.equal(document.querySelector('label').htmlFor, btn.id); // klik label membuka pilihan
  enhanceSelect(select, grid); // dipanggil dua kali tidak menggandakan
  assert.equal(document.querySelectorAll('.picker-btn').length, 1);
});

test('buka, bagian "Sering dipakai" urut menurut pemakaian, pilih mengubah nilai dan menutup', async () => {
  const select = fixture();
  enhanceSelect(select, grid);
  let changed = 0;
  select.addEventListener('change', () => changed++);
  document.querySelector('.picker-btn').click();
  assert.ok(dlg().hasAttribute('open'));

  const frequent = [...dlg().querySelectorAll('section[aria-label="Sering dipakai"] .pick-label')].map((x) => x.textContent);
  assert.deepEqual(frequent, ['Makan dan Minum', 'Tagihan', 'Transportasi', 'Belanja']); // 9, 7, 5, 2; yang 0-1 tidak ikut
  const all = [...dlg().querySelectorAll('section[aria-label="Semua"] .pick-label')].map((x) => x.textContent);
  assert.equal(all.length, 7);
  assert.deepEqual(all, [...all].sort((a, b) => a.localeCompare(b))); // abjad
  assert.equal(dlg().querySelector('.pick-tile.on .pick-label').textContent, 'Makan dan Minum');

  dlg().querySelector('section[aria-label="Semua"] [data-value="c"]').click();
  assert.equal(select.value, 'c');
  assert.equal(changed, 1);
  assert.equal(dlg().hasAttribute('open'), false);
  assert.match(document.querySelector('.picker-btn').textContent, /Transportasi/);
});

test('pencarian: nama, kata kunci, tidak peka huruf besar, dan "tidak ditemukan"', () => {
  const select = fixture();
  enhanceSelect(select, grid);
  document.querySelector('.picker-btn').click();
  const search = dlg().querySelector('.picker-search');
  const labels = () => [...dlg().querySelectorAll('.pick-label')].map((x) => x.textContent);
  const type = (v) => { search.value = v; search.dispatchEvent(new window.Event('input', { bubbles: true })); };

  type('tran'); assert.deepEqual(labels(), ['Transportasi']);
  type('KOPI'); assert.deepEqual(labels(), ['Makan dan Minum']); // lewat kata kunci
  type('  warung '); assert.deepEqual(labels(), ['Makan dan Minum']);
  type('zzz'); assert.deepEqual(labels(), []); assert.match(dlg().textContent, /Tidak ditemukan/);
  type(''); assert.equal(labels().length, 4 + 7); // kembali ke tampilan semula
  assert.equal(dlg().querySelectorAll('section[aria-label="Sering dipakai"]').length, 1);
});

test('mengisi ulang <option> (ganti jenis transaksi) memperbarui tombol; select dinonaktifkan menonaktifkan tombol', async () => {
  const select = fixture();
  enhanceSelect(select, grid);
  fill(select, [['x', 'Gaji', 0, true], ['y', 'Bonus', 0]]);
  await tick();
  assert.match(document.querySelector('.picker-btn').textContent, /Gaji/);
  fill(select, []);
  await tick();
  assert.match(document.querySelector('.picker-btn').textContent, /Pilih/);
  assert.equal(document.querySelector('.picker-btn').getAttribute('aria-label'), 'Pilih kategori: belum dipilih');
  fill(select, CATS);
  select.disabled = true;
  await tick();
  assert.equal(document.querySelector('.picker-btn').disabled, true);
});

test('mode daftar: keterangan, tanda terpilih, pilihan kosong dilewati', () => {
  const select = fixture([['', 'Pilih…', 0], ['1', 'Rek. utama', 0, true], ['2', 'Kripto', 0]]);
  enhanceSelect(select, { title: 'Pilih rekening', mode: 'list', badge: () => '<i class="b"></i>',
    subtitle: (o) => (o.textContent === 'Kripto' ? 'Tabungan dan investasi' : 'Rekening bank') });
  document.querySelector('.picker-btn').click();
  const rows = [...dlg().querySelectorAll('.pick-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.pick-name').textContent), ['Rek. utama', 'Kripto']); // "Pilih…" dilewati
  assert.equal(rows[1].querySelector('.pick-sub').textContent, 'Tabungan dan investasi');
  assert.ok(rows[0].querySelector('.check')); // tanda terpilih
  assert.equal(rows[1].querySelector('.check'), null);
  assert.equal(dlg().querySelector('.picker-search'), null); // tanpa kolom cari
  rows[1].click();
  assert.equal(select.value, '2');
});

test('menutup lewat tombol dan lewat tekan di luar lembar; nama aneh tidak menyisipkan HTML', () => {
  const select = fixture([]);
  // Lewat DOM sebagai teks murni (HTML parser membuang tag di dalam <option>), seperti data dari server.
  select.append(new window.Option('<img src=x onerror=alert(1)>', '1', false, true), new window.Option('Biasa', '2'));
  enhanceSelect(select, { title: 'Pilih', mode: 'list' });
  const btn = document.querySelector('.picker-btn');
  btn.click();
  assert.equal(dlg().querySelector('img'), null);
  assert.equal(btn.querySelector('img'), null);
  assert.match(dlg().textContent, /<img src=x/); // tampil sebagai teks
  dlg().querySelector('[data-close]').click();
  assert.equal(dlg().hasAttribute('open'), false);
  btn.click();
  dlg().click(); // tekan pada latar dialog (bukan isinya)
  assert.equal(dlg().hasAttribute('open'), false);
  assert.equal(select.value, '1'); // tidak berubah
});
