// Menjalankan public/app.js yang sebenarnya di DOM tiruan (jsdom) dengan API palsu:
// form Tambah/Ubah dengan lembar pilihan, dan ikon di daftar transaksi.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const ID = {
  main: '11111111-1111-4111-8111-111111111111', em: '22222222-2222-4222-8222-222222222222', kr: '33333333-3333-4333-8333-333333333333',
  food: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', trans: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', bill: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  gaji: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', bonus: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', trx1: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
};
const META = {
  user: { id: 'u1', name: 'Erik', role: 'suami', can_view_reports: true },
  today: '2026-11-20', cycle: { start: '2026-10-25', end: '2026-11-24', label: '25 Okt – 24 Nov 2026' },
  accounts: [
    { id: ID.main, name: 'Rek. utama', kind: 'bank', is_emergency: false },
    { id: ID.em, name: 'Rekening darurat', kind: 'bank', is_emergency: true },
    { id: ID.kr, name: 'Kripto', kind: 'asset', is_emergency: false },
  ],
  categories: [
    { id: ID.food, name: 'Makan dan Minum', kind: 'expense', counts_as_bill: false, uses: 9 },
    { id: ID.trans, name: 'Transportasi', kind: 'expense', counts_as_bill: false, uses: 4 },
    { id: ID.bill, name: 'Tagihan', kind: 'expense', counts_as_bill: true, uses: 0 },
    { id: ID.gaji, name: 'Gaji', kind: 'income', counts_as_bill: false, uses: 3 },
    { id: ID.bonus, name: 'Bonus', kind: 'income', counts_as_bill: false, uses: 0 },
  ],
};
const SUMMARY = {
  today: '2026-11-20', cycle: { ...META.cycle, status: 'current', days_left: 4 }, cycles: [{ start: META.cycle.start, label: META.cycle.label }],
  totals: { income: 0, expense: 0, remaining: 0 }, daily_budgets: [], emergency: null,
  bills: { count: 0, paid_count: 0, unpaid_count: 0, total: 0, unpaid_amount: 0 }, savings: { deposited: 0 },
  balance_reminder: { due: false }, restricted: false,
};
const trx = (o) => ({
  id: ID.trx1, kind: 'expense', amount: 150000, trx_date: '2026-11-10', note: 'makan siang', is_one_off: false,
  account_id: ID.main, to_account_id: null, category_id: ID.food, account_name: 'Rek. utama', account_kind: 'bank',
  to_account_name: null, to_account_kind: null, category_name: 'Makan dan Minum', recorded_by: 'Erik', updated_by: null,
  is_emergency_withdrawal: false, debt_status: null, is_repayment: false, is_bill_payment: false, ...o,
});

let window;
let document;
let calls;
let routes;

before(async () => {
  const dom = new JSDOM('<!doctype html><body><main id="app"></main><div id="toast" hidden></div></body>', { url: 'http://localhost/#/' });
  window = dom.window;
  document = window.document;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // Browser mendukung form.namaKolom; jsdom belum. Kode form kita memakainya, jadi ditambahkan untuk tes.
  for (const name of ['amount', 'category', 'account', 'to_account', 'trx_date', 'note', 'is_one_off', 'from_emergency', 'email', 'password']) {
    Object.defineProperty(window.HTMLFormElement.prototype, name, { configurable: true, get() { return this.elements.namedItem(name); } });
  }
  const g = {
    window, document, location: window.location, history: window.history, localStorage: window.localStorage, navigator: window.navigator,
    MutationObserver: window.MutationObserver, Event: window.Event, confirm: () => true, prompt: () => '',
    fetch: async (path, opts = {}) => {
      const method = opts.method ?? 'GET';
      const url = new URL(path, 'http://localhost');
      calls.push({ method, path: url.pathname + url.search, body: opts.body ? JSON.parse(opts.body) : null });
      const handler = routes[`${method} ${url.pathname}`];
      const data = handler ? await handler(url, opts) : { error: `tak ada rute tiruan ${method} ${url.pathname}` };
      return { ok: Boolean(handler), status: handler ? 200 : 404, json: async () => data };
    },
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  routes = { 'GET /api/meta': () => META, 'GET /api/summary': () => SUMMARY, 'GET /api/trx': () => ({ items: [] }) };
  calls = [];
  await import('../public/app.js');
});

beforeEach(() => {
  calls = [];
  routes = { 'GET /api/meta': () => META, 'GET /api/summary': () => SUMMARY, 'GET /api/trx': () => ({ items: [] }) };
});

const until = async (fn, label, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`menunggu: ${label}\nisi halaman: ${document.getElementById('app').textContent.replace(/\s+/g, ' ').slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const go = async (hash, ready) => {
  document.getElementById('app').innerHTML = '';
  // Alamat sama tidak memicu hashchange; picu manual. Bila berbeda, jsdom yang memicunya.
  if (window.location.hash === hash) window.dispatchEvent(new window.Event('hashchange'));
  else window.location.hash = hash;
  await until(() => document.querySelector(ready), `${hash} -> ${ready}`);
};
const dlg = () => document.querySelector('dialog.picker-sheet');
const pickText = (id) => document.getElementById(id).textContent.replace(/\s+/g, ' ').trim();

test('form Tambah: tiga pilihan memakai lembar, kategori dipilih lewat kotak berikon, data terkirim benar', async () => {
  routes['POST /api/trx'] = () => ({ item: trx({}), cycle: { start: META.cycle.start, label: META.cycle.label }, daily_budget: null });
  await go('#/tambah', '#add-form .picker-btn');

  const buttons = [...document.querySelectorAll('#add-form .picker-btn')].map((b) => b.id);
  assert.deepEqual(buttons, ['category-picker', 'account-picker', 'to_account-picker']);
  assert.equal(document.getElementById('category').hidden, true);
  // Label "Kategori" menunjuk tombol (klik label membuka lembar).
  assert.equal(document.querySelector('label[for="category-picker"]').textContent, 'Kategori');
  assert.match(pickText('category-picker'), /Makan dan Minum/); // pilihan pertama menurut urutan server
  assert.match(pickText('account-picker'), /Rek\. utama/);

  // Buka kategori: "Sering dipakai" menampilkan yang paling sering lebih dulu, lengkap dengan ikon.
  document.getElementById('category-picker').click();
  assert.ok(dlg().hasAttribute('open'));
  const frequent = [...dlg().querySelectorAll('section[aria-label="Sering dipakai"] .pick-label')].map((x) => x.textContent);
  assert.deepEqual(frequent, ['Makan dan Minum', 'Transportasi']);
  assert.ok(dlg().querySelector('.pick-tile .ico svg'));
  dlg().querySelector('section[aria-label="Semua"] [data-value="' + ID.trans + '"]').click();
  assert.match(pickText('category-picker'), /Transportasi/);
  assert.equal(dlg().hasAttribute('open'), false);

  // Isi jumlah dan kirim.
  const form = document.getElementById('add-form');
  form.amount.value = '25000';
  form.amount.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(form.amount.value, 'Rp 25.000');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.some((c) => c.method === 'POST'), 'POST /api/trx');
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual([post.body.kind, post.body.amount, post.body.category_id, post.body.account_id, post.body.to_account_id],
    ['expense', 25000, ID.trans, ID.main, null]);
});

test('ganti jenis ke Pemasukan: pilihan kategori ikut berganti dan terkirim sebagai pemasukan', async () => {
  routes['POST /api/trx'] = () => ({ item: trx({}), cycle: { start: META.cycle.start, label: 'x' }, daily_budget: null });
  await go('#/tambah', '#add-form .picker-btn');
  document.querySelector('[data-kind="income"]').click();
  await until(() => /Gaji/.test(pickText('category-picker')), 'kategori pemasukan');
  document.getElementById('category-picker').click();
  const names = [...dlg().querySelectorAll('section[aria-label="Semua"] .pick-label')].map((x) => x.textContent);
  assert.deepEqual(names, ['Bonus', 'Gaji']); // hanya kategori pemasukan, abjad
  dlg().querySelector('[data-value="' + ID.bonus + '"]').click();
  assert.match(pickText('category-picker'), /Bonus/);
  assert.match(document.querySelector('label[for="account-picker"]').textContent, /Ke rekening/);

  const form = document.getElementById('add-form');
  form.amount.value = '1000000';
  form.amount.dispatchEvent(new window.Event('input', { bubbles: true }));
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.some((c) => c.method === 'POST'), 'POST');
  const { body } = calls.find((c) => c.method === 'POST');
  assert.deepEqual([body.kind, body.category_id, body.amount], ['income', ID.bonus, 1000000]);
});

test('jenis Tabung: tujuan hanya rekening aset, asal tanpa rekening aset', async () => {
  await go('#/tambah', '#add-form .picker-btn');
  document.querySelector('[data-kind="saving"]').click();
  await until(() => /Kripto/.test(pickText('to_account-picker')), 'tujuan tabungan');
  document.getElementById('to_account-picker').click();
  assert.deepEqual([...dlg().querySelectorAll('.pick-name')].map((x) => x.textContent), ['Kripto']);
  assert.equal(dlg().querySelector('.pick-sub').textContent, 'Tabungan dan investasi');
  dlg().querySelector('[data-close]').click();
  document.getElementById('account-picker').click();
  assert.deepEqual([...dlg().querySelectorAll('.pick-name')].map((x) => x.textContent), ['Rek. utama', 'Rekening darurat']);
  assert.ok([...dlg().querySelectorAll('.pick-sub')].some((x) => x.textContent === 'Rekening darurat'));
});

test('mode Ubah: form terisi dari transaksi, pilihan menampilkan kategori dan rekeningnya, simpan memakai PUT', async () => {
  routes[`GET /api/trx/${ID.trx1}`] = () => ({ item: trx({}) });
  routes[`PUT /api/trx/${ID.trx1}`] = () => ({ item: trx({}), cycle: { start: META.cycle.start, label: 'x' }, daily_budget: null });
  await go(`#/ubah/${ID.trx1}`, '#add-form .picker-btn');
  const form = document.getElementById('add-form');
  assert.match(pickText('category-picker'), /Makan dan Minum/);
  assert.match(pickText('account-picker'), /Rek\. utama/);
  assert.equal(form.amount.value, 'Rp 150.000');
  assert.equal(form.note.value, 'makan siang');
  assert.equal(form.trx_date.value, '2026-11-10');
  assert.ok(document.getElementById('del-trx'));

  document.getElementById('category-picker').click();
  dlg().querySelector('section[aria-label="Semua"] [data-value="' + ID.bill + '"]').click();
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.some((c) => c.method === 'PUT'), 'PUT');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, `/api/trx/${ID.trx1}`);
  assert.deepEqual([put.body.category_id, put.body.amount, put.body.note], [ID.bill, 150000, 'makan siang']);
  assert.equal('from_emergency' in put.body, false);
});

test('daftar transaksi: ikon kategori, ikon rekening untuk Tabung dan Tarik', async () => {
  routes['GET /api/trx'] = () => ({ items: [
    trx({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2' }),
    trx({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', kind: 'transfer', category_id: null, category_name: null, note: 'nabung', to_account_name: 'Kripto', to_account_kind: 'asset' }),
    trx({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', kind: 'transfer', category_id: null, category_name: null, note: 'jual', account_name: 'Kripto', account_kind: 'asset', to_account_name: 'Rek. utama', to_account_kind: 'bank' }),
    trx({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', kind: 'income', category_name: 'Gaji', note: 'gajian' }),
  ] });
  await go('#/transaksi', '.trx-item .ico');
  const rows = [...document.querySelectorAll('.trx-item')];
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.querySelector('.ico svg')));
  const theme = (r) => r.querySelector('.ico').className.match(/t-\w+/)[0];
  assert.deepEqual(rows.map(theme), ['t-orange', 't-violet', 't-violet', 't-green']); // makan, Tabung ke Kripto, Tarik dari Kripto, gaji
  assert.ok(rows.every((r) => r.querySelector('a.edit-link')));
});

test('form tagihan: kategori dan rekening dipilih lewat lembar, terkirim ke server', async () => {
  routes['POST /api/bills'] = () => ({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1' });
  routes['GET /api/bills'] = () => ({ today: '2026-11-20', cycle: { ...META.cycle, status: 'current' }, summary: { count: 0, paid_count: 0, unpaid_count: 0, total: 0, unpaid_amount: 0 }, items: [], bills: [] });
  await go('#/tagihan/baru', '#bill-form .picker-btn');
  assert.deepEqual([...document.querySelectorAll('#bill-form .picker-btn')].map((b) => b.id), ['b-cat-picker', 'b-acc-picker']);
  assert.match(pickText('b-cat-picker'), /Tagihan/); // kategori bertanda tagihan jadi bawaan
  assert.equal(document.querySelector('label[for="b-cat-picker"]').textContent, 'Kategori');

  document.getElementById('b-acc-picker').click();
  assert.ok([...dlg().querySelectorAll('.pick-sub')].some((x) => x.textContent === 'Rekening darurat'));
  dlg().querySelector('[data-value="' + ID.em + '"]').click();
  assert.match(pickText('b-acc-picker'), /Rekening darurat/);

  const f = document.getElementById('bill-form');
  f.querySelector('#b-name').value = 'Wifi';
  const amt = f.querySelector('#b-amount');
  amt.value = '450000';
  amt.dispatchEvent(new window.Event('input', { bubbles: true }));
  f.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.some((c) => c.method === 'POST'), 'POST /api/bills');
  const { body } = calls.find((c) => c.method === 'POST');
  assert.deepEqual([body.name, body.default_amount, body.category_id, body.account_id], ['Wifi', 450000, ID.bill, ID.em]);
});

test('batas harian: menambah kategori lewat lembar menggambar ulang halaman dan pilihan tetap berfungsi', async () => {
  routes['GET /api/budgets/daily'] = () => ({ items: [{ category_id: ID.food, name: 'Makan dan Minum', weekday: 300000, weekend: 200000 }] });
  await go('#/budget-harian', '#daily-form .picker-btn');
  assert.match(document.getElementById('daily-form').textContent, /Makan dan Minum/);
  document.getElementById('d-add-picker').click();
  const offered = [...dlg().querySelectorAll('section[aria-label="Semua"] .pick-label, .pick-grid:not(section .pick-grid) .pick-label')].map((x) => x.textContent);
  assert.ok(!offered.includes('Makan dan Minum')); // yang sudah punya batas tidak ditawarkan lagi
  assert.ok(offered.includes('Transportasi'));
  dlg().querySelector('[data-value="' + ID.trans + '"]').click();
  // Halaman digambar ulang: baris baru muncul dan tombol pilihan untuk kategori berikutnya masih bekerja.
  await until(() => /Transportasi/.test(document.getElementById('daily-form').textContent) && document.querySelector('#d-add-picker'), 'baris baru');
  assert.equal(document.querySelectorAll('#daily-form section.member').length, 2);
  document.getElementById('d-add-picker').click();
  assert.ok(dlg().hasAttribute('open'));
});

test('kategori awal = yang paling sering dipakai; rekening pengeluaran tanpa tabungan dan darurat', async () => {
  await go('#/tambah', '#add-form .picker-btn');
  assert.match(pickText('category-picker'), /Makan dan Minum/); // uses 9, bukan urutan pertama abjad
  document.getElementById('account-picker').click();
  assert.deepEqual([...dlg().querySelectorAll('.pick-name')].map((x) => x.textContent), ['Rek. utama']);
  dlg().querySelector('[data-close]').click();
  // Pemasukan: kategori awal Gaji (uses 3), rekening sama.
  document.querySelector('[data-kind="income"]').click();
  await until(() => /Gaji/.test(pickText('category-picker')), 'Gaji');
});

test('daftar yang dikelompokkan per tanggal tidak mengulang tanggal di tiap baris', async () => {
  routes['GET /api/trx'] = () => ({ items: [trx({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9' })] });
  await go('#/transaksi', '.trx-item .ico');
  const meta = document.querySelector('.trx-item .meta').textContent;
  assert.match(meta, /Makan dan Minum · Rek\. utama · oleh Erik/);
  assert.doesNotMatch(meta, /Nov 2026/);
});
