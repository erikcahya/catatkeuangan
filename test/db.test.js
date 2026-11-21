// Tes integrasi dengan PostgreSQL sungguhan. Jalan hanya bila TEST_DATABASE_URL diisi
// (lihat .env.example) — database itu DIKOSONGKAN dari transaksi setiap kali tes jalan.
// Jalankan: npm run test:db
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { hashPassword, hashToken, newSessionToken } from '../src/auth.js';
import { cycleStart } from '../src/lib/dates.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL belum diisi';
if (url && url === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL tidak boleh sama dengan DATABASE_URL');

let pool, app, sid, erik, acc, cat;
const quoteCalls = [];

before(async () => {
  if (skip) return;
  pool = createPool(url);
  await pool.query(`truncate emergency_debt, bill_occurrence, recurring_bill, budget, budget_default, savings_holding, balance_check, trx, pay_cycle, session restart identity cascade`);
  erik = (await pool.query(`select * from app_user where name = 'Erik'`)).rows[0];
  acc = Object.fromEntries((await pool.query('select name, id from account')).rows.map((r) => [r.name, r.id]));
  cat = Object.fromEntries((await pool.query('select name, id from category')).rows.map((r) => [r.name, r.id]));
  sid = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
    [hashToken(sid), erik.id]);
  // Harga pasar palsu: tes tidak boleh memanggil internet. Mengisi `calls` untuk memeriksa jumlah panggilan.
  const prices = { 'crypto:BTC': 1_000_000_000, 'gold:XAU': 2_000_000, 'fx:CHF': 20_000, 'stock:BBCA': 5_550 };
  app = buildApp({ pool, logger: false, quote: async (source, symbol) => {
    quoteCalls.push(`${source}:${symbol}`);
    if (!(`${source}:${symbol}` in prices)) throw new Error(`Kode "${symbol}" tidak ditemukan.`);
    return prices[`${source}:${symbol}`];
  } });
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/trx', cookies: { sid }, payload });

test('fungsi SQL cycle_start sama dengan versi JS', { skip }, async () => {
  const { rows } = await pool.query(
    `select d::date::text as d, cycle_start(d::date, 25)::text as s
       from generate_series('2025-12-01'::date, '2027-02-28'::date, interval '1 day') d`,
  );
  for (const r of rows) assert.equal(r.s, cycleStart(r.d), r.d);
});

test('login: sandi benar dapat cookie, sandi salah ditolak', { skip }, async () => {
  await pool.query(`update app_user set email = 'erik@tes.local', password_hash = $1 where id = $2`,
    [await hashPassword('sandi-yang-benar'), erik.id]);
  const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ERIK@tes.local', password: 'sandi-yang-benar' } });
  assert.equal(ok.statusCode, 200);
  const cookie = ok.cookies.find((c) => c.name === 'sid');
  assert.ok(cookie?.httpOnly);
  const me = await app.inject({ url: '/api/meta', cookies: { sid: cookie.value } });
  assert.equal(me.json().user.name, 'Erik');

  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'erik@tes.local', password: 'salah' } });
  assert.equal(bad.statusCode, 401);
  const nobody = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@tes.local', password: 'salah' } });
  assert.equal(nobody.statusCode, 401);
});

test('meta berisi rekening, kategori, dan siklus berjalan', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  assert.equal(m.accounts.length, 5);
  assert.equal(m.categories.length, 23);
  assert.ok(m.categories.every((c) => Number.isInteger(c.uses) && c.uses >= 0)); // untuk "Sering dipakai"
  assert.equal(m.cycle.start, cycleStart(m.today));
});

test('pengeluaran makan: siklus dibuat otomatis, peringatan budget harian', { skip }, async () => {
  // 2026-11-16 Senin -> batas hari kerja Rp300.000
  const a = await post({ kind: 'expense', amount: 250000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], category_id: cat['Makan dan Minum'], note: 'Makan siang' });
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(a.json().cycle.start, '2026-10-25');
  assert.deepEqual(a.json().daily_budget, {
    category_id: cat['Makan dan Minum'], category_name: 'Makan dan Minum',
    date: '2026-11-16', day_type: 'weekday', limit: 300000, total: 250000, over: 0,
  });
  assert.equal(a.json().item.recorded_by, 'Erik');

  const b = await post({ kind: 'expense', amount: 100000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], category_id: cat['Makan dan Minum'] });
  assert.equal(b.json().daily_budget.over, 50000);

  // Sabtu -> batas akhir pekan Rp200.000
  const c = await post({ kind: 'expense', amount: 210000, trx_date: '2026-11-21',
    account_id: acc['Rek. utama'], category_id: cat['Makan dan Minum'] });
  assert.equal(c.json().daily_budget.day_type, 'weekend');
  assert.equal(c.json().daily_budget.over, 10000);

  const cycles = await pool.query(`select label from pay_cycle where start_date = '2026-10-25'`);
  assert.deepEqual(cycles.rows, [{ label: '25 Okt – 24 Nov 2026' }]);
});

test('gaji yang cair sehari lebih awal masuk siklus bulan gajiannya', { skip }, async () => {
  const r = await post({ kind: 'income', amount: 25000000, trx_date: '2025-08-24',
    account_id: acc['Rek. utama'], category_id: cat['Gaji'] });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().cycle.start, '2025-08-25');
  assert.equal(r.json().daily_budget, null);

  const bonus = await post({ kind: 'income', amount: 1000000, trx_date: '2025-08-24',
    account_id: acc['Rek. utama'], category_id: cat['Bonus'] });
  assert.equal(bonus.json().cycle.start, '2025-07-25');
});

test('ambil dari rekening darurat: dicatat sebagai utang', { skip }, async () => {
  const r = await post({ kind: 'expense', amount: 1200000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], from_emergency: true });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().item.account_name, 'Rekening darurat');
  assert.equal(r.json().item.is_emergency_withdrawal, true);
  const debt = await pool.query('select amount, status from emergency_debt where withdrawal_trx_id = $1', [r.json().item.id]);
  assert.deepEqual(debt.rows, [{ amount: 1200000, status: 'open' }]);

  // Hapus: utang yang belum lunas ikut terhapus.
  const del = await app.inject({ method: 'DELETE', url: `/api/trx/${r.json().item.id}`, cookies: { sid } });
  assert.equal(del.statusCode, 200);
  assert.equal((await pool.query('select 1 from emergency_debt where withdrawal_trx_id = $1', [r.json().item.id])).rowCount, 0);
  const t = await pool.query('select deleted_at, updated_by from trx where id = $1', [r.json().item.id]);
  assert.ok(t.rows[0].deleted_at);
  assert.equal(t.rows[0].updated_by, erik.id);
  const again = await app.inject({ method: 'DELETE', url: `/api/trx/${r.json().item.id}`, cookies: { sid } });
  assert.equal(again.statusCode, 404);
});

test('transfer ke rekening sendiri tanpa kategori', { skip }, async () => {
  const r = await post({ kind: 'transfer', amount: 500000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], to_account_id: acc['Emas'], category_id: cat['Investasi'] });
  assert.equal(r.statusCode, 201, r.body);
  const row = await pool.query('select category_id, to_account_id from trx where id = $1', [r.json().item.id]);
  assert.equal(row.rows[0].category_id, null);
  assert.equal(row.rows[0].to_account_id, acc['Emas']);

  const same = await post({ kind: 'transfer', amount: 1, trx_date: '2026-11-16',
    account_id: acc['Emas'], to_account_id: acc['Emas'] });
  assert.equal(same.statusCode, 400);
});

test('input yang tidak konsisten ditolak', { skip }, async () => {
  const mismatch = await post({ kind: 'expense', amount: 1000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], category_id: cat['Gaji'] });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error, 'Kategori tidak cocok dengan jenis transaksi.');

  const emIncome = await post({ kind: 'income', amount: 1000, trx_date: '2026-11-16',
    account_id: acc['Rek. utama'], category_id: cat['Gaji'], from_emergency: true });
  assert.equal(emIncome.statusCode, 400);

  const foreign = await post({ kind: 'expense', amount: 1000, trx_date: '2026-11-16',
    account_id: '00000000-0000-4000-8000-000000000000', category_id: cat['Belanja'] });
  assert.equal(foreign.statusCode, 400);
});

test('daftar transaksi terbaru, yang terhapus tidak tampil', { skip }, async () => {
  const { items } = (await app.inject({ url: '/api/trx?limit=50', cookies: { sid } })).json();
  assert.ok(items.length >= 5);
  assert.ok(items.every((t) => t.recorded_by === 'Erik'));
  assert.ok(!items.some((t) => t.is_emergency_withdrawal));
  const dates = items.map((t) => t.trx_date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('ringkasan beranda: pemasukan, pengeluaran, darurat, tabungan', { skip }, async () => {
  const start = '2026-10-25'; // siklus yang memuat 16 Nov 2026
  const em = await post({ kind: 'expense', amount: 1200000, trx_date: '2026-11-17',
    account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], from_emergency: true });
  assert.equal(em.statusCode, 201);
  const gaji = await post({ kind: 'income', amount: 25000000, trx_date: '2026-10-24',
    account_id: acc['Rek. utama'], category_id: cat['Gaji'] });
  assert.equal(gaji.json().cycle.start, start);

  const s = (await app.inject({ url: `/api/summary?cycle=${start}`, cookies: { sid } })).json();
  assert.equal(s.restricted, false);
  assert.equal(s.cycle.label, '25 Okt – 24 Nov 2026');
  // Pengeluaran siklus ini: 250rb + 100rb + 210rb (makan) + 1,2jt (darurat). Transfer 500rb tidak dihitung.
  assert.deepEqual(s.totals, { income: 25000000, expense: 1760000, remaining: 23240000 });
  assert.deepEqual(s.emergency, { name: 'Rekening darurat', target: 10000000, open_debt: 1200000, filled: 8800000 });
  assert.equal(s.savings.deposited, 500000); // transfer ke Emas
  assert.equal(s.bills.count, 0);
  assert.ok(s.cycles.some((c) => c.start === start));

  const list = (await app.inject({ url: `/api/trx?cycle=${start}&limit=50`, cookies: { sid } })).json();
  assert.ok(list.items.every((t) => t.trx_date >= '2026-10-24' && t.trx_date <= '2026-11-24'));
  const other = (await app.inject({ url: '/api/trx?cycle=2025-08-25', cookies: { sid } })).json();
  assert.deepEqual(other.items.map((t) => t.trx_date), ['2025-08-24']);

  const bad = await app.inject({ url: '/api/summary?cycle=2026-11-03', cookies: { sid } });
  assert.equal(bad.statusCode, 400);
});

test('anak tidak mendapat angka laporan, saldo, darurat, tabungan', { skip }, async () => {
  const anak = (await pool.query(`select id from app_user where role = 'anak'`)).rows[0];
  const token = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
    [hashToken(token), anak.id]);
  const s = (await app.inject({ url: '/api/summary', cookies: { sid: token } })).json();
  assert.equal(s.restricted, true);
  for (const k of ['totals', 'emergency', 'savings', 'bills', 'cycles']) assert.equal(s[k], undefined, k);
  assert.ok(Array.isArray(s.daily_budgets));
});

test('tagihan berulang: tambah, muncul di siklus berjalan, bayar, hapus bayaran, lewati', { skip }, async () => {
  const today = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const current = today.cycle.start;
  const mk = (payload) => app.inject({ method: 'POST', url: '/api/bills', cookies: { sid }, payload });

  const kontrakan = await mk({ name: 'Kontrakan', category_id: cat['Tagihan'], account_id: acc['Rek. utama'],
    default_amount: 3500000, due_dom: 22 });
  assert.equal(kontrakan.statusCode, 201, kontrakan.body);
  const listrik = await mk({ name: 'Listrik', category_id: cat['Tagihan'], account_id: acc['Rek. utama'],
    default_amount: 500000, is_variable: true, due_dom: 15 });
  assert.equal(listrik.statusCode, 201);
  const salah = await mk({ name: 'X', category_id: cat['Gaji'], account_id: acc['Rek. utama'], default_amount: 1, due_dom: 1 });
  assert.equal(salah.statusCode, 400);

  const get = async () => (await app.inject({ url: '/api/bills', cookies: { sid } })).json();
  let b = await get();
  assert.equal(b.cycle.start, current);
  assert.equal(b.items.length, 2);
  assert.ok(b.items.every((o) => o.status === 'pending' && o.due_date >= current && o.due_date <= b.cycle.end));
  assert.deepEqual(b.summary, { count: 2, paid_count: 0, unpaid_count: 2, total: 4000000, unpaid_amount: 4000000 });

  // Dipanggil ulang tidak menggandakan.
  b = await get();
  assert.equal(b.items.length, 2);

  // Bayar listrik dengan nominal sebenarnya.
  const occ = b.items.find((o) => o.name === 'Listrik');
  const pay = await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/pay`, cookies: { sid },
    payload: { amount: 520000, trx_date: today.today, account_id: acc['Rek. utama'] } });
  assert.equal(pay.statusCode, 201, pay.body);
  const twice = await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/pay`, cookies: { sid },
    payload: { amount: 520000, trx_date: today.today, account_id: acc['Rek. utama'] } });
  assert.equal(twice.statusCode, 409);

  b = await get();
  assert.deepEqual(b.summary, { count: 2, paid_count: 1, unpaid_count: 1, total: 4020000, unpaid_amount: 3500000 });
  const paidTrx = await pool.query('select kind, category_id, note, cycle_id from trx where id = $1', [pay.json().trx_id]);
  assert.equal(paidTrx.rows[0].note, 'Listrik');
  assert.equal(paidTrx.rows[0].category_id, cat['Tagihan']);

  // Beranda ikut.
  const s = (await app.inject({ url: '/api/summary', cookies: { sid } })).json();
  assert.equal(s.bills.unpaid_count, 1);

  // Hapus transaksinya -> tagihan kembali belum dibayar.
  await app.inject({ method: 'DELETE', url: `/api/trx/${pay.json().trx_id}`, cookies: { sid } });
  b = await get();
  assert.equal(b.items.find((o) => o.name === 'Listrik').status, 'pending');

  // Lewati kontrakan -> tidak dihitung.
  const k = b.items.find((o) => o.name === 'Kontrakan');
  await app.inject({ method: 'POST', url: `/api/bills/occurrences/${k.id}/skip`, cookies: { sid }, payload: { skipped: true } });
  b = await get();
  assert.equal(b.summary.count, 1);
  assert.equal(b.summary.unpaid_amount, 500000);

  // Ubah nominal listrik -> tagihan siklus berjalan yang belum dibayar ikut berubah.
  const bill = b.bills.find((x) => x.name === 'Listrik');
  const put = await app.inject({ method: 'PUT', url: `/api/bills/${bill.id}`, cookies: { sid },
    payload: { name: 'Listrik PLN', category_id: cat['Tagihan'], account_id: acc['Rek. utama'],
      default_amount: 600000, is_variable: true, due_dom: 15, remind_days_before: 3, is_active: true } });
  assert.equal(put.statusCode, 200, put.body);
  b = await get();
  assert.equal(b.items.find((o) => o.bill_id === bill.id).expected_amount, 600000);

  // Nonaktifkan -> hilang dari siklus berjalan.
  await app.inject({ method: 'PUT', url: `/api/bills/${bill.id}`, cookies: { sid },
    payload: { name: 'Listrik PLN', category_id: cat['Tagihan'], account_id: acc['Rek. utama'],
      default_amount: 600000, is_variable: true, due_dom: 15, remind_days_before: 3, is_active: false } });
  b = await get();
  assert.ok(!b.items.some((o) => o.bill_id === bill.id));
  assert.equal(b.bills.find((x) => x.id === bill.id).is_active, false);
});

test('anak tidak bisa membuka tagihan', { skip }, async () => {
  const anak = (await pool.query(`select id from app_user where role = 'anak'`)).rows[0];
  const token = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
    [hashToken(token), anak.id]);
  assert.equal((await app.inject({ url: '/api/bills', cookies: { sid: token } })).statusCode, 403);
});

import { addDays } from '../src/lib/dates.js';

test('tagihan tiap 28 hari dihitung dari pembayaran terakhir', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const today = m.today;
  const get = async () => (await app.inject({ url: '/api/bills', cookies: { sid } })).json();
  const pending = async (billId) => (await pool.query(
    `select id, due_date from bill_occurrence where bill_id = $1 and status = 'pending' order by due_date`, [billId])).rows;

  // Jadwal tidak lengkap ditolak.
  const noAnchor = await app.inject({ method: 'POST', url: '/api/bills', cookies: { sid },
    payload: { name: 'Wifi', category_id: cat['Tagihan'], account_id: acc['Rek. utama'], default_amount: 450000, interval_days: 28 } });
  assert.equal(noAnchor.statusCode, 400);

  // Terakhir beli 20 hari lalu -> jatuh tempo 8 hari lagi.
  const r = await app.inject({ method: 'POST', url: '/api/bills', cookies: { sid },
    payload: { name: 'Wifi', category_id: cat['Tagihan'], account_id: acc['Rek. utama'], default_amount: 450000,
      interval_days: 28, anchor_date: addDays(today, -20) } });
  assert.equal(r.statusCode, 201, r.body);
  const wifiId = r.json().id;
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, 8)]);

  // Bayar hari ini (lebih awal) -> berikutnya hari ini + 28.
  let occ = (await pending(wifiId))[0];
  const pay = await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/pay`, cookies: { sid },
    payload: { amount: 450000, trx_date: today, account_id: acc['Rek. utama'] } });
  assert.equal(pay.statusCode, 201, pay.body);
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, 28)]);
  let bills = await get();
  assert.equal(bills.bills.find((x) => x.id === wifiId).next_due, addDays(today, 28));

  // Hapus pembayaran -> kembali ke jatuh tempo semula, yang berikutnya ditarik.
  await app.inject({ method: 'DELETE', url: `/api/trx/${pay.json().trx_id}`, cookies: { sid } });
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, 8)]);

  // Lewati -> berikutnya dihitung dari jatuh tempo yang dilewati; batal lewati -> kembali.
  occ = (await pending(wifiId))[0];
  await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/skip`, cookies: { sid }, payload: { skipped: true } });
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, 36)]);
  await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/skip`, cookies: { sid }, payload: { skipped: false } });
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, 8)]);

  // Ganti jadwal: terakhir beli 40 hari lalu -> terlambat 12 hari, tetap tampil di siklus berjalan.
  const put = await app.inject({ method: 'PUT', url: `/api/bills/${wifiId}`, cookies: { sid },
    payload: { name: 'Wifi (Biznet)', category_id: cat['Tagihan'], account_id: acc['Rek. utama'], default_amount: 450000,
      interval_days: 28, anchor_date: addDays(today, -40), remind_days_before: 3, is_active: true } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual((await pending(wifiId)).map((o) => o.due_date), [addDays(today, -12)]);
  bills = await get();
  const late = bills.items.find((o) => o.bill_id === wifiId);
  assert.equal(late.status, 'pending');
  assert.equal(late.due_date, addDays(today, -12));

  // Bayar terlambat: transaksi masuk siklus saat dibayar.
  const latePay = await app.inject({ method: 'POST', url: `/api/bills/occurrences/${late.id}/pay`, cookies: { sid },
    payload: { amount: 450000, trx_date: today, account_id: acc['Rek. utama'] } });
  assert.equal(latePay.statusCode, 201);
  const cyc = await pool.query(
    'select pc.start_date from trx t join pay_cycle pc on pc.id = t.cycle_id where t.id = $1', [latePay.json().trx_id]);
  assert.equal(cyc.rows[0].start_date, m.cycle.start);

  // Ubah ke bulanan: jatuh tempo berinterval yang belum dibayar diganti tanggal tetap.
  await app.inject({ method: 'PUT', url: `/api/bills/${wifiId}`, cookies: { sid },
    payload: { name: 'Wifi (Biznet)', category_id: cat['Tagihan'], account_id: acc['Rek. utama'], default_amount: 450000,
      due_dom: 10, remind_days_before: 3, is_active: true } });
  const after = (await pool.query(
    `select o.due_date, pc.start_date from bill_occurrence o join pay_cycle pc on pc.id = o.cycle_id
      where o.bill_id = $1 and o.status = 'pending'`, [wifiId])).rows;
  assert.ok(after.every((o) => o.start_date === m.cycle.start), JSON.stringify(after));
});

test('rekening darurat: lunasi beberapa utang sekaligus, lalu batalkan', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const withdraw = (amount, note) => post({ kind: 'expense', amount, trx_date: m.today, note,
    account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], from_emergency: true });
  await withdraw(300000, 'Obat');
  await withdraw(200000, 'Dokter');
  const get = async () => (await app.inject({ url: '/api/emergency', cookies: { sid } })).json();

  let e = await get();
  const before = e.open_debt;
  const mine = e.open.filter((d) => ['Obat', 'Dokter'].includes(d.note));
  assert.equal(mine.length, 2);
  assert.equal(e.filled, 10000000 - before);
  assert.equal(mine[0].recorded_by, 'Erik');

  // Dari rekening darurat sendiri ditolak.
  const self = await app.inject({ method: 'POST', url: '/api/emergency/repay', cookies: { sid },
    payload: { debt_ids: mine.map((d) => d.id), account_id: acc['Rekening darurat'], trx_date: m.today } });
  assert.equal(self.statusCode, 400);

  const r = await app.inject({ method: 'POST', url: '/api/emergency/repay', cookies: { sid },
    payload: { debt_ids: mine.map((d) => d.id), account_id: acc['Rek. utama'], trx_date: m.today } });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual({ amount: r.json().amount, count: r.json().count }, { amount: 500000, count: 2 });
  const t = (await pool.query('select kind, account_id, to_account_id, amount from trx where id = $1', [r.json().trx_id])).rows[0];
  assert.deepEqual(t, { kind: 'transfer', account_id: acc['Rek. utama'], to_account_id: acc['Rekening darurat'], amount: 500000 });

  e = await get();
  assert.equal(e.open_debt, before - 500000);
  const g = e.repayments.find((x) => x.trx_id === r.json().trx_id);
  assert.equal(g.amount, 500000);
  assert.equal(g.debts.length, 2);

  // Dilunasi dua kali ditolak.
  const again = await app.inject({ method: 'POST', url: '/api/emergency/repay', cookies: { sid },
    payload: { debt_ids: [mine[0].id], account_id: acc['Rek. utama'], trx_date: m.today } });
  assert.equal(again.statusCode, 409);

  // Transfer pelunasan tidak bisa dihapus dari daftar transaksi biasa; penarikannya juga tidak.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trx/${r.json().trx_id}`, cookies: { sid } })).statusCode, 409);

  // Pelunasan tidak menambah pengeluaran siklus (transfer).
  const s = (await app.inject({ url: '/api/summary', cookies: { sid } })).json();
  assert.equal(s.emergency.open_debt, before - 500000);

  // Batalkan -> utang kembali terbuka.
  const undo = await app.inject({ method: 'DELETE', url: `/api/emergency/repayments/${r.json().trx_id}`, cookies: { sid } });
  assert.equal(undo.statusCode, 200);
  e = await get();
  assert.equal(e.open_debt, before);
  assert.ok(!e.repayments.some((x) => x.trx_id === r.json().trx_id));
  assert.ok((await pool.query('select deleted_at from trx where id = $1', [r.json().trx_id])).rows[0].deleted_at);
});

test('tabungan: setoran per aset, nilai sekarang manual', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const get = async () => (await app.inject({ url: '/api/savings', cookies: { sid } })).json();
  const before = await get();
  const kripto0 = before.assets.find((a) => a.name === 'Kripto');

  const tf = (from, to, amount) => post({ kind: 'transfer', amount, trx_date: m.today,
    account_id: acc[from], to_account_id: acc[to] });
  assert.equal((await tf('Rek. utama', 'Kripto', 4000000)).statusCode, 201);
  assert.equal((await tf('Rek. utama', 'Kripto', 1000000)).statusCode, 201);
  assert.equal((await tf('Kripto', 'Rek. utama', 500000)).statusCode, 201); // jual sebagian

  let s = await get();
  const k = s.assets.find((a) => a.name === 'Kripto');
  assert.equal(k.cycle_in - kripto0.cycle_in, 5000000);
  assert.equal(k.net_invested - kripto0.net_invested, 4500000);
  assert.equal(k.current_value, null);
  assert.equal(k.gain, null);
  assert.equal(s.deposited_cycle - before.deposited_cycle, 5000000);
  assert.deepEqual(s.assets.map((a) => a.name), ['Emas', 'Kripto', 'Saham']);

  // Isi nilai sekarang, lalu kosongkan lagi.
  const put = (accountId, current_value) => app.inject({ method: 'PUT', url: `/api/savings/${accountId}/value`,
    cookies: { sid }, payload: { current_value } });
  assert.equal((await put(acc['Kripto'], 7000000)).statusCode, 200);
  s = await get();
  const k2 = s.assets.find((a) => a.name === 'Kripto');
  assert.equal(k2.current_value, 7000000);
  assert.equal(k2.gain, 7000000 - k2.net_invested);
  assert.equal(k2.as_of_date, m.today);
  assert.equal((await put(acc['Kripto'], null)).statusCode, 200);
  assert.equal((await get()).assets.find((a) => a.name === 'Kripto').current_value, null);
  assert.equal((await pool.query('select count(*)::int n from savings_holding')).rows[0].n, 1);

  // Bukan rekening aset ditolak.
  assert.equal((await put(acc['Rek. utama'], 1)).statusCode, 404);
});

test('tabungan: nilai dari jumlah unit x harga pasar, harga disimpan dan disegarkan', { skip }, async () => {
  const get = async () => (await app.inject({ method: 'GET', url: '/api/savings', cookies: { sid } })).json();
  const put = (name, payload) => app.inject({ method: 'PUT', url: `/api/savings/${acc[name]}/holding`, cookies: { sid }, payload });
  const asset = async (name) => (await get()).assets.find((a) => a.name === name);

  // Kripto: 0,05 BTC x Rp1 miliar = Rp50 juta.
  quoteCalls.length = 0;
  let r = await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0.05 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().price_error, null);
  let k = await asset('Kripto');
  assert.equal(k.current_value, 50_000_000);
  assert.equal(k.quantity, 0.05);
  assert.equal(k.unit_price, 1_000_000_000);
  assert.equal(k.price_source, 'crypto');
  assert.equal(k.gain, 50_000_000 - k.net_invested);
  // Beranda menampilkan nilai aset sekarang (bukan hanya setoran siklus ini).
  const sm = (await app.inject({ method: 'GET', url: '/api/summary', cookies: { sid } })).json();
  assert.equal(sm.savings.value, 50_000_000);
  assert.equal(sm.savings.valued, 1);

  // Harga masih segar: membuka layar lagi tidak memanggil sumber harga.
  quoteCalls.length = 0;
  await get();
  assert.deepEqual(quoteCalls, []);

  // Harga basi (> 30 menit) disegarkan otomatis; harga berubah -> nilai ikut berubah.
  await pool.query(`update savings_holding set price_at = now() - interval '2 hours'`);
  quoteCalls.length = 0;
  await get();
  assert.deepEqual(quoteCalls, ['crypto:BTC']);

  // Emas dalam gram, valas dengan kode.
  assert.equal((await put('Emas', { price_source: 'gold', quantity: 10 })).statusCode, 200);
  assert.equal((await asset('Emas')).current_value, 20_000_000);
  assert.equal((await put('Saham', { price_source: 'fx', symbol: 'chf', quantity: 1000 })).statusCode, 200);
  assert.equal((await asset('Saham')).current_value, 20_000_000);
  // Saham: 100 lembar x Rp5.550; kode huruf kecil disimpan kapital.
  assert.equal((await put('Saham', { price_source: 'stock', symbol: 'bbca', quantity: 100 })).statusCode, 200);
  assert.equal((await asset('Saham')).current_value, 555_000);
  assert.equal((await asset('Saham')).symbol, 'BBCA');
  assert.equal((await put('Saham', { price_source: 'stock', symbol: 'BB CA', quantity: 1 })).statusCode, 400);
  assert.equal((await put('Saham', { price_source: 'fx', symbol: 'chf', quantity: 1000 })).statusCode, 200);

  // Kode tidak dikenal: tersimpan tapi nilai tidak berubah dan pesan galat ikut dikembalikan.
  r = await put('Kripto', { price_source: 'crypto', symbol: 'NOPE', quantity: 1 });
  assert.equal(r.statusCode, 200);
  assert.match(r.json().price_error, /NOPE/);
  assert.equal((await asset('Kripto')).current_value, 50_000_000, 'nilai lama dipertahankan saat harga gagal');

  // Sumber gagal saat segarkan otomatis: harga lama tetap dipakai, galat dilaporkan.
  await pool.query(`update savings_holding set price_at = now() - interval '2 hours' where account_id = $1`, [acc['Kripto']]);
  k = await asset('Kripto');
  assert.equal(k.current_value, 50_000_000);
  assert.match(k.price_error, /NOPE/);

  // Isian tidak valid ditolak.
  assert.equal((await put('Kripto', { price_source: 'crypto', symbol: '', quantity: 1 })).statusCode, 400);
  assert.equal((await put('Kripto', { price_source: 'fx', symbol: 'CHFX', quantity: 1 })).statusCode, 400);
  assert.equal((await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0 })).statusCode, 400);
  assert.equal((await put('Kripto', { price_source: 'saham', symbol: 'BBCA', quantity: 1 })).statusCode, 400);
  assert.equal((await put('Rek. utama', { price_source: 'crypto', symbol: 'BTC', quantity: 1 })).statusCode, 404);

  // Tombol "Perbarui harga" memaksa ambil ulang semua.
  quoteCalls.length = 0;
  await pool.query(`update savings_holding set symbol = 'BTC' where account_id = $1`, [acc['Kripto']]);
  const refresh = await app.inject({ method: 'POST', url: '/api/savings/refresh', cookies: { sid } });
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().errors, 0);
  assert.deepEqual(quoteCalls.sort(), ['crypto:BTC', 'fx:CHF', 'gold:XAU']);

  // Mengisi nilai manual mematikan pelacakan harga.
  const manual = await app.inject({ method: 'PUT', url: `/api/savings/${acc['Kripto']}/value`, cookies: { sid }, payload: { current_value: 7_000_000 } });
  assert.equal(manual.statusCode, 200);
  k = await asset('Kripto');
  assert.equal(k.current_value, 7_000_000);
  assert.equal(k.price_source, null);
  assert.equal(k.quantity, null);
  quoteCalls.length = 0;
  await get();
  assert.ok(!quoteCalls.includes('crypto:BTC'));

  // Tabung/Tarik dengan jumlah unit: menambah/mengurangi jumlah yang dilacak, dan ubah/hapus membatalkannya.
  const today = (await app.inject({ method: 'GET', url: '/api/meta', cookies: { sid } })).json().today;
  const trx = (method, url, payload) => app.inject({ method, url, cookies: { sid }, payload });
  const move = (from, to, amount, asset_quantity) => trx('POST', '/api/trx', { kind: 'transfer', amount, trx_date: today,
    account_id: acc[from], to_account_id: acc[to], asset_quantity });
  const qty = async (name) => (await asset(name)).quantity;
  assert.equal(await qty('Emas'), 10);

  const buy = await move('Rek. utama', 'Emas', 4_100_000, 2);
  assert.equal(buy.statusCode, 201);
  assert.equal(buy.json().item.asset_quantity, 2);
  assert.equal(await qty('Emas'), 12);
  assert.equal((await asset('Emas')).current_value, 24_000_000);

  assert.equal((await move('Emas', 'Rek. utama', 9_900_000, 5)).statusCode, 201);
  assert.equal(await qty('Emas'), 7);

  const tooMuch = await move('Emas', 'Rek. utama', 1, 100);
  assert.equal(tooMuch.statusCode, 409);
  assert.equal(await qty('Emas'), 7, 'penolakan tidak mengubah jumlah');

  // Jumlah unit tanpa rekening aset, atau pada aset yang tidak dilacak, ditolak.
  assert.equal((await move('Rek. utama', 'Rekening darurat', 1000, 1)).statusCode, 400);
  assert.equal((await move('Rek. utama', 'Kripto', 1000, 1)).statusCode, 400);
  assert.equal((await post({ kind: 'expense', amount: 1000, trx_date: today, account_id: acc['Rek. utama'],
    category_id: cat['Makan dan Minum'], asset_quantity: 1 })).statusCode, 400);

  // Ubah: jumlah unit diganti (2 -> 3 gram) = tambah 1; hapus = kembali.
  const id = buy.json().item.id;
  const edit = await trx('PUT', `/api/trx/${id}`, { kind: 'transfer', amount: 6_200_000, trx_date: today,
    account_id: acc['Rek. utama'], to_account_id: acc['Emas'], asset_quantity: 3 });
  assert.equal(edit.statusCode, 200);
  assert.equal(await qty('Emas'), 8);
  assert.equal((await trx('DELETE', `/api/trx/${id}`)).statusCode, 200);
  assert.equal(await qty('Emas'), 5);

  // Setelah pelacakan dimatikan, menghapus transaksi bersejarah tetap bisa.
  const buy2 = await move('Rek. utama', 'Emas', 2_000_000, 1);
  assert.equal(await qty('Emas'), 6);
  await app.inject({ method: 'PUT', url: `/api/savings/${acc['Emas']}/value`, cookies: { sid }, payload: { current_value: 1 } });
  assert.equal((await trx('DELETE', `/api/trx/${buy2.json().item.id}`)).statusCode, 200);

  // Mulai melacak aset yang sudah dimiliki: 0,1 BTC dicatat juga sebagai Tabung senilai pasar (Rp100 juta) dari Rek. utama,
  // tanpa menambah jumlah unit lagi.
  const depBefore = (await pool.query(`select count(*)::int n from trx where kind = 'transfer' and to_account_id = $1`, [acc['Kripto']])).rows[0].n;
  const start = await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0.1, record_deposit: true });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().deposit.amount, 100_000_000);
  assert.equal(await qty('Kripto'), 0.1);
  const dep = (await pool.query(`select amount, account_id, asset_quantity from trx where kind = 'transfer' and to_account_id = $1 and deleted_at is null`, [acc['Kripto']])).rows;
  assert.equal(dep.length, depBefore + 1);
  assert.equal(dep.at(-1).amount, 100_000_000);
  assert.equal(dep.at(-1).account_id, acc['Rek. utama']);
  assert.equal(dep.at(-1).asset_quantity, null);
  // Mengubah jumlah saat sudah dilacak tidak mencatat Tabung lagi.
  const again = await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0.1, record_deposit: true });
  assert.equal(again.json().deposit, null);

  // Jumlah unit dikosongkan: dihitung dari Rupiah / harga pasar terakhir. Rp50 juta = 0,05 BTC.
  const auto = await move('Rek. utama', 'Kripto', 50_000_000, undefined);
  assert.equal(auto.statusCode, 201);
  assert.equal(auto.json().item.asset_quantity, 0.05);
  assert.equal(await qty('Kripto'), 0.15);
  assert.equal((await asset('Kripto')).current_value, 150_000_000);
  // Menjual senilai seluruh aset = menjual semua unit (nol, tetap dilacak).
  assert.equal((await move('Kripto', 'Rek. utama', 150_000_000, undefined)).statusCode, 201);
  assert.equal(await qty('Kripto'), 0);

  // Total dikoreksi turun sendiri, lalu transaksi Tabung lama dihapus: tetap bisa (jumlah dipangkas ke 0), bukan galat 409.
  const old1 = await move('Rek. utama', 'Kripto', 100_000_000, undefined);
  assert.equal(old1.statusCode, 201);
  await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0.0000001 });
  assert.equal((await trx('DELETE', `/api/trx/${old1.json().item.id}`)).statusCode, 200);
  assert.equal(await qty('Kripto'), 0);
  // Tarik melebihi jumlah tercatat tetap ditolak.
  await put('Kripto', { price_source: 'crypto', symbol: 'BTC', quantity: 0.01 });
  assert.equal((await move('Kripto', 'Rek. utama', 50_000_000, 0.05)).statusCode, 409);

  await pool.query('delete from savings_holding');
});

test('laporan siklus: per kategori, transfer tidak dihitung, anggaran bila ada', { skip }, async () => {
  const start = '2026-10-25';
  const get = async () => (await app.inject({ url: `/api/report?cycle=${start}`, cookies: { sid } })).json();
  const r = await get();
  const s = (await app.inject({ url: `/api/summary?cycle=${start}`, cookies: { sid } })).json();
  assert.deepEqual(r.totals, s.totals); // sama dengan Beranda
  assert.equal(r.totals.expense, r.expense_by_category.reduce((a, c) => a + c.total, 0));
  const makan = r.expense_by_category.find((c) => c.name === 'Makan dan Minum');
  assert.equal(makan.total, 560000);
  assert.equal(makan.count, 3);
  assert.equal(makan.budget, null);
  assert.ok(r.income_by_category.some((c) => c.name === 'Gaji'));
  // Urut dari terbesar.
  const totals = r.expense_by_category.map((c) => c.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  assert.ok(r.extra.saved >= 500000);

  // Anggaran per kategori bila ada.
  const pc = (await pool.query(`select id from pay_cycle where start_date = $1`, [start])).rows[0];
  await pool.query('insert into budget (cycle_id, category_id, limit_amount) values ($1, $2, 6000000)', [pc.id, cat['Makan dan Minum']]);
  await pool.query('insert into budget (cycle_id, category_id, limit_amount) values ($1, $2, 1000000)', [pc.id, cat['Olahraga']]);
  const r2 = await get();
  assert.equal(r2.expense_by_category.find((c) => c.name === 'Makan dan Minum').budget, 6000000);
  const olahraga = r2.expense_by_category.find((c) => c.name === 'Olahraga');
  assert.deepEqual([olahraga.total, olahraga.budget], [0, 1000000]); // anggaran tanpa pengeluaran tetap tampil

  // Rincian per kategori.
  const list = (await app.inject({ url: `/api/trx?cycle=${start}&category_id=${cat['Makan dan Minum']}&limit=200`, cookies: { sid } })).json();
  assert.equal(list.items.length, 3);
  assert.ok(list.items.every((t) => t.category_name === 'Makan dan Minum'));
});

test('daftar transaksi per halaman (offset) tanpa duplikat', { skip }, async () => {
  const all = (await app.inject({ url: '/api/trx?limit=200', cookies: { sid } })).json().items;
  const pages = [];
  for (let off = 0; off < all.length; off += 3) {
    pages.push(...(await app.inject({ url: `/api/trx?limit=3&offset=${off}`, cookies: { sid } })).json().items);
  }
  assert.deepEqual(pages.map((t) => t.id), all.map((t) => t.id));
  assert.ok(all.length > 3);
});

test('daftar transaksi per rentang tanggal', { skip }, async () => {
  const get = (q) => app.inject({ url: `/api/trx?limit=200&${q}`, cookies: { sid } });
  const r = (await get('from=2026-11-16&to=2026-11-17')).json().items;
  assert.ok(r.length > 0);
  assert.ok(r.every((t) => t.trx_date >= '2026-11-16' && t.trx_date <= '2026-11-17'));
  const onlyFrom = (await get('from=2026-11-21')).json().items;
  assert.ok(onlyFrom.every((t) => t.trx_date >= '2026-11-21'));
  const onlyTo = (await get('to=2025-12-31')).json().items;
  assert.ok(onlyTo.length > 0 && onlyTo.every((t) => t.trx_date <= '2025-12-31'));
  assert.equal((await get('from=2026-11-20&to=2026-11-10')).statusCode, 400);
  assert.equal((await get('from=2026-02-30')).statusCode, 400);
});

test('anggota: tambah, atur login, izin, ganti kata sandi sendiri', { skip }, async () => {
  const as = (token) => ({ cookies: { sid: token } });
  const login = (email, password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  let list = (await app.inject({ url: '/api/members', ...as(sid) })).json();
  assert.equal(list.can_manage, true);
  assert.equal(list.members[0].role, 'suami');

  // Tambah anggota baru, atur login, lalu masuk.
  const add = await app.inject({ method: 'POST', url: '/api/members', ...as(sid),
    payload: { name: 'Nenek', role: 'istri', email: 'Nenek@Tes.Local' } });
  assert.equal(add.statusCode, 201, add.body);
  const nenekId = add.json().id;
  const dup = await app.inject({ method: 'POST', url: '/api/members', ...as(sid),
    payload: { name: 'X', role: 'anak', email: 'nenek@tes.local' } });
  assert.equal(dup.statusCode, 409);
  const setPw = await app.inject({ method: 'PUT', url: `/api/members/${nenekId}/password`, ...as(sid),
    payload: { password: 'sandi-nenek-123' } });
  assert.equal(setPw.statusCode, 200, setPw.body);
  assert.equal((await login('nenek@tes.local', 'sandi-nenek-123')).statusCode, 200);

  // Ubah jadi anak -> tidak bisa lihat laporan.
  const put = await app.inject({ method: 'PUT', url: `/api/members/${nenekId}`, ...as(sid),
    payload: { name: 'Nenek', role: 'anak', email: 'nenek@tes.local' } });
  assert.equal(put.statusCode, 200);
  const nenekLogin = await login('nenek@tes.local', 'sandi-nenek-123');
  const nsid = nenekLogin.cookies.find((c) => c.name === 'sid').value;
  assert.equal((await app.inject({ url: '/api/report', ...as(nsid) })).statusCode, 403);

  // Anak tidak bisa mengatur anggota lain, tapi bisa ganti kata sandinya sendiri.
  list = (await app.inject({ url: '/api/members', ...as(nsid) })).json();
  assert.equal(list.can_manage, false);
  assert.ok(list.members.filter((x) => x.id !== nenekId).every((x) => x.email === null)); // email orang lain tersembunyi
  assert.equal((await app.inject({ method: 'POST', url: '/api/members', ...as(nsid), payload: { name: 'Y', role: 'anak' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/members/${erik.id}/password`, ...as(nsid), payload: { password: 'xxxxxxxx' } })).statusCode, 403);
  const wrongOld = await app.inject({ method: 'PUT', url: `/api/members/${nenekId}/password`, ...as(nsid),
    payload: { password: 'sandi-baru-456', current_password: 'salah' } });
  assert.equal(wrongOld.statusCode, 400);
  const own = await app.inject({ method: 'PUT', url: `/api/members/${nenekId}/password`, ...as(nsid),
    payload: { password: 'sandi-baru-456', current_password: 'sandi-nenek-123' } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal((await app.inject({ url: '/api/members', ...as(nsid) })).statusCode, 200); // sesi sendiri tetap
  assert.equal((await login('nenek@tes.local', 'sandi-baru-456')).statusCode, 200);

  // Email dihapus -> sesi dicabut.
  await app.inject({ method: 'PUT', url: `/api/members/${nenekId}`, ...as(sid), payload: { name: 'Nenek', role: 'anak', email: null } });
  assert.equal((await app.inject({ url: '/api/members', ...as(nsid) })).statusCode, 401);

  // Minimal satu suami/istri.
  await pool.query(`update app_user set role = 'anak', can_view_reports = false where name = 'Istri'`);
  const last = await app.inject({ method: 'PUT', url: `/api/members/${erik.id}`, ...as(sid),
    payload: { name: 'Erik', role: 'anak', email: 'erik@tes.local' } });
  assert.equal(last.statusCode, 409);
  await pool.query(`update app_user set role = 'istri', can_view_reports = true where name = 'Istri'`);
  await pool.query(`delete from session where user_id = $1`, [nenekId]);
  await pool.query(`delete from app_user where id = $1`, [nenekId]);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('impor catatan lama: tulis, hitung, tolak ganda, batalkan tanpa menyentuh transaksi lain', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'impor-'));
  const file = join(dir, 'lama.csv');
  writeFileSync(file, [
    'tanggal,kategori,keterangan,sumber,jumlah',
    '2024-08-24,Gaji,gaji erick,kas,20000000',
    '2024-08-26,Pemasukan Lainnya,utang octo,kas,2000000',
    '2024-08-27,Makan dan Minum,"kantin, iin",kas,-50000',
    '2024-08-27,Makan dan Minum,nabung bibit,kas,-100000',
    '2024-09-25,Tagihan,bayar utang octo,kas,-1500000',
  ].join('\n'));
  const run = (...args) => execFileSync(process.execPath, ['scripts/import-old.js', ...args],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;
  const before = await count('select count(*)::int n from trx');

  // Simulasi tidak menulis apa pun.
  const dry = run(file, '--batch', 'tes-impor');
  assert.match(dry, /SIMULASI/);
  assert.equal(await count('select count(*)::int n from trx'), before);

  run(file, '--batch', 'tes-impor', '--commit');
  assert.equal(await count(`select count(*)::int n from trx where import_batch = 'tes-impor'`), 5);
  const kinds = (await pool.query(`select kind, count(*)::int n, sum(amount)::bigint t from trx where import_batch = 'tes-impor' group by kind order by kind`)).rows;
  assert.deepEqual(kinds.map((k) => [k.kind, k.n, Number(k.t)]), [['expense', 2, 150000], ['income', 1, 20000000], ['transfer', 2, 3500000]]);
  const gaji = (await pool.query(`select pc.start_date from trx t join pay_cycle pc on pc.id = t.cycle_id where t.import_batch = 'tes-impor' and t.kind = 'income'`)).rows[0];
  assert.equal(gaji.start_date, '2024-08-25'); // gaji cair 24 Agu masuk siklus bulan gajiannya
  const debt = (await pool.query(`select d.status, d.amount from emergency_debt d join trx w on w.id = d.withdrawal_trx_id where w.import_batch = 'tes-impor'`)).rows;
  assert.deepEqual(debt, [{ status: 'open', amount: 500000 }]); // 2jt ditarik, 1,5jt dilunasi: sisa 500rb terbuka

  // Muncul di laporan tinjauan, tidak diubah diam-diam.
  const review = readFileSync(join(dir, 'laporan-tinjau.csv'), 'utf8');
  assert.match(review, /nabung bibit/);
  assert.doesNotMatch(review, /kantin/);

  // Impor ganda ditolak.
  assert.throws(() => run(file, '--batch', 'tes-impor', '--commit'), /sudah ada/);

  // Rollback hanya menghapus gelombang itu.
  run('--rollback', '--batch', 'tes-impor');
  assert.equal(await count('select count(*)::int n from trx'), before);
  assert.equal(await count(`select count(*)::int n from emergency_debt d join trx w on w.id = d.withdrawal_trx_id where w.import_batch = 'tes-impor'`), 0);
});

test('ubah transaksi: bidang, siklus, jejak pengubah, dan yang dikunci', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const put = (id, payload, token = sid) => app.inject({ method: 'PUT', url: `/api/trx/${id}`, cookies: { sid: token }, payload });
  const get = async (id) => (await app.inject({ url: `/api/trx/${id}`, cookies: { sid } })).json().item;

  // Pengeluaran biasa: ubah jumlah, tanggal (pindah siklus), kategori, catatan, sekali bayar.
  const made = await post({ kind: 'expense', amount: 100000, trx_date: '2026-11-16', account_id: acc['Rek. utama'],
    category_id: cat['Belanja'], note: 'salah' });
  const id = made.json().item.id;
  const edited = await put(id, { kind: 'expense', amount: 150000, trx_date: '2026-11-26', account_id: acc['Rek. utama'],
    category_id: cat['Hiburan'], note: 'benar', is_one_off: true });
  assert.equal(edited.statusCode, 200, edited.body);
  const it = edited.json().item;
  assert.deepEqual([it.amount, it.trx_date, it.category_name, it.note, it.is_one_off, it.updated_by],
    [150000, '2026-11-26', 'Hiburan', 'benar', true, 'Erik']);
  assert.ok(it.updated_at);
  assert.equal(edited.json().cycle.start, '2026-11-25'); // tanggal baru ada di siklus berikutnya
  assert.equal(it.recorded_by, 'Erik'); // pencatat awal tetap

  // Jenis boleh pindah: pengeluaran -> Tabung (transfer ke rekening aset) -> pemasukan.
  const toSaving = await put(id, { kind: 'transfer', amount: 150000, trx_date: '2026-11-26', account_id: acc['Rek. utama'], to_account_id: acc['Saham'] });
  assert.equal(toSaving.statusCode, 200, toSaving.body);
  const sv = await get(id);
  assert.deepEqual([sv.kind, sv.category_id, sv.to_account_name, sv.is_one_off], ['transfer', null, 'Saham', false]);
  const toIncome = await put(id, { kind: 'income', amount: 150000, trx_date: '2026-11-26', account_id: acc['Rek. utama'], category_id: cat['Bonus'] });
  assert.equal(toIncome.statusCode, 200);
  assert.equal((await get(id)).to_account_id, null);

  // Validasi sama seperti saat mencatat.
  assert.equal((await put(id, { kind: 'expense', amount: 1, trx_date: '2026-11-26', account_id: acc['Rek. utama'], category_id: cat['Gaji'] })).statusCode, 400);
  assert.equal((await put(id, { kind: 'income', amount: 1, trx_date: '2026-02-30', account_id: acc['Rek. utama'], category_id: cat['Gaji'] })).statusCode, 400);
  assert.equal((await put('00000000-0000-4000-8000-000000000000', { kind: 'income', amount: 1, trx_date: '2026-11-26', account_id: acc['Rek. utama'], category_id: cat['Gaji'] })).statusCode, 404);

  // Gaji yang diubah tanggalnya tetap masuk siklus gajiannya.
  const gaji = await post({ kind: 'income', amount: 1000, trx_date: '2026-09-25', account_id: acc['Rek. utama'], category_id: cat['Gaji'] });
  const gaji2 = await put(gaji.json().item.id, { kind: 'income', amount: 1000, trx_date: '2026-10-24', account_id: acc['Rek. utama'], category_id: cat['Gaji'] });
  assert.equal(gaji2.json().cycle.start, '2026-10-25');

  // Penarikan darurat: jumlah ikut mengubah utang yang terbuka; jenis dan rekening terkunci.
  const wd = await post({ kind: 'expense', amount: 300000, trx_date: m.today, account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], from_emergency: true });
  const wdId = wd.json().item.id;
  const wdPut = await put(wdId, { kind: 'expense', amount: 450000, trx_date: m.today, account_id: acc['Rek. utama'], category_id: cat['Kesehatan'] });
  assert.equal(wdPut.statusCode, 200, wdPut.body);
  assert.equal(wdPut.json().item.account_name, 'Rekening darurat'); // rekening tetap, walau body mengirim Rek. utama
  assert.equal((await pool.query('select amount from emergency_debt where withdrawal_trx_id = $1', [wdId])).rows[0].amount, 450000);
  assert.equal((await put(wdId, { kind: 'income', amount: 450000, trx_date: m.today, account_id: acc['Rek. utama'], category_id: cat['Bonus'] })).statusCode, 400);

  // Utang yang sudah lunas: jumlah terkunci, catatan masih bisa; pelunasan itu sendiri tidak bisa diubah.
  const debtId = (await pool.query('select id from emergency_debt where withdrawal_trx_id = $1', [wdId])).rows[0].id;
  const repay = await app.inject({ method: 'POST', url: '/api/emergency/repay', cookies: { sid },
    payload: { debt_ids: [debtId], account_id: acc['Rek. utama'], trx_date: m.today } });
  assert.equal(repay.statusCode, 201, repay.body);
  assert.equal((await put(wdId, { kind: 'expense', amount: 1000, trx_date: m.today, account_id: acc['Rek. utama'], category_id: cat['Kesehatan'] })).statusCode, 409);
  assert.equal((await put(wdId, { kind: 'expense', amount: 450000, trx_date: m.today, account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], note: 'obat' })).statusCode, 200);
  const repayPut = await put(repay.json().trx_id, { kind: 'transfer', amount: 1, trx_date: m.today, account_id: acc['Rek. utama'], to_account_id: acc['Rekening darurat'] });
  assert.equal(repayPut.statusCode, 409);
  await app.inject({ method: 'DELETE', url: `/api/emergency/repayments/${repay.json().trx_id}`, cookies: { sid } });

  // Anak boleh mengubah (SPEC: semua anggota boleh ubah dan hapus).
  const anak = (await pool.query(`select id from app_user where role = 'anak'`)).rows[0];
  const token = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`, [hashToken(token), anak.id]);
  const byKid = await put(id, { kind: 'income', amount: 200000, trx_date: '2026-11-26', account_id: acc['Rek. utama'], category_id: cat['Bonus'] }, token);
  assert.equal(byKid.statusCode, 200);
  assert.equal(byKid.json().item.updated_by, (await pool.query('select name from app_user where id = $1', [anak.id])).rows[0].name);
});

test('anggaran: standar per kategori tampil di laporan, batas harian bisa diatur', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const putBudgets = (items) => app.inject({ method: 'PUT', url: '/api/budgets', cookies: { sid }, payload: { items } });
  await pool.query('delete from budget'); // sisa anggaran siklus dari tes laporan di atas

  // Mulai tanpa anggaran; semua kategori pengeluaran terdaftar.
  let b = (await app.inject({ url: '/api/budgets', cookies: { sid } })).json();
  assert.equal(b.items.length, 19);
  assert.equal(b.total, 0);

  assert.equal((await putBudgets([{ category_id: cat['Makan dan Minum'], limit: 6000000 }, { category_id: cat['Transportasi'], limit: 3500000 }])).statusCode, 200);
  assert.equal((await putBudgets([{ category_id: cat['Gaji'], limit: 1 }])).statusCode, 400); // bukan kategori pengeluaran
  b = (await app.inject({ url: '/api/budgets', cookies: { sid } })).json();
  assert.equal(b.total, 9500000);
  assert.deepEqual(b.items.slice(0, 2).map((x) => x.name), ['Makan dan Minum', 'Transportasi']); // yang berisi tampil duluan

  // Berlaku di semua siklus, termasuk yang belum punya pengeluaran di kategori itu.
  const rep = (await app.inject({ url: `/api/report?cycle=${m.cycle.start}`, cookies: { sid } })).json();
  const trans = rep.expense_by_category.find((c) => c.name === 'Transportasi');
  assert.equal(trans.budget, 3500000);
  const old = (await app.inject({ url: '/api/report?cycle=2026-10-25', cookies: { sid } })).json();
  assert.equal(old.expense_by_category.find((c) => c.name === 'Makan dan Minum').budget, 6000000);

  // Anggaran khusus satu siklus (tabel budget) menimpa yang standar.
  const pc = (await pool.query(`select id from pay_cycle where start_date = '2026-10-25'`)).rows[0];
  await pool.query('insert into budget (cycle_id, category_id, limit_amount) values ($1, $2, 8000000)', [pc.id, cat['Makan dan Minum']]);
  const over = (await app.inject({ url: '/api/report?cycle=2026-10-25', cookies: { sid } })).json();
  assert.equal(over.expense_by_category.find((c) => c.name === 'Makan dan Minum').budget, 8000000);
  await pool.query('delete from budget where cycle_id = $1', [pc.id]);

  // Hapus anggaran.
  await putBudgets([{ category_id: cat['Transportasi'], limit: null }]);
  assert.equal((await app.inject({ url: '/api/budgets', cookies: { sid } })).json().total, 6000000);
  await putBudgets([{ category_id: cat['Makan dan Minum'], limit: null }]);

  // Batas harian: awalnya dari data awal (300rb kerja, 200rb akhir pekan).
  const putDaily = (payload) => app.inject({ method: 'PUT', url: '/api/budgets/daily', cookies: { sid }, payload });
  let d = (await app.inject({ url: '/api/budgets/daily', cookies: { sid } })).json().items;
  assert.deepEqual(d.map((x) => [x.name, x.weekday, x.weekend]), [['Makan dan Minum', 300000, 200000]]);
  assert.equal((await putDaily({ category_id: cat['Makan dan Minum'], weekday: 100000, weekend: 150000 })).statusCode, 200);
  // Pengeluaran berikutnya diperiksa terhadap batas baru (Senin 16 Nov 2026).
  const spend = await post({ kind: 'expense', amount: 120000, trx_date: '2026-11-16', account_id: acc['Rek. utama'], category_id: cat['Makan dan Minum'] });
  assert.equal(spend.json().daily_budget.limit, 100000);
  assert.ok(spend.json().daily_budget.over > 0);
  // Tambah batas untuk kategori lain, hapus sebagian, lalu kembalikan.
  assert.equal((await putDaily({ category_id: cat['Hiburan'], weekday: null, weekend: 400000 })).statusCode, 200);
  d = (await app.inject({ url: '/api/budgets/daily', cookies: { sid } })).json().items;
  assert.deepEqual(d.find((x) => x.name === 'Hiburan'), { category_id: cat['Hiburan'], name: 'Hiburan', weekday: null, weekend: 400000 });
  await putDaily({ category_id: cat['Hiburan'], weekday: null, weekend: null });
  assert.equal((await app.inject({ url: '/api/budgets/daily', cookies: { sid } })).json().items.length, 1);
  await putDaily({ category_id: cat['Makan dan Minum'], weekday: 300000, weekend: 200000 });
  assert.equal((await putDaily({ category_id: cat['Gaji'], weekday: 1, weekend: 1 })).statusCode, 400);

  // Anak tidak bisa mengatur.
  const anak = (await pool.query(`select id from app_user where role = 'anak'`)).rows[0];
  const token = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`, [hashToken(token), anak.id]);
  assert.equal((await app.inject({ url: '/api/budgets', cookies: { sid: token } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/budgets/daily', cookies: { sid: token },
    payload: { category_id: cat['Hiburan'], weekday: 1, weekend: 1 } })).statusCode, 403);
});

test('tarik tabungan: transfer dari rekening aset, bisa diubah dari pemasukan', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const before = (await app.inject({ url: '/api/savings', cookies: { sid } })).json().assets.find((a) => a.name === 'Kripto');

  // Penarikan lama yang tercatat sebagai pemasukan "Hasil Investasi" diubah menjadi Tarik dari Kripto.
  const asIncome = await post({ kind: 'income', amount: 900000, trx_date: m.today, account_id: acc['Rek. utama'],
    category_id: cat['Hasil Investasi'], note: 'tarik tabungan btc' });
  const id = asIncome.json().item.id;
  const sum0 = (await app.inject({ url: `/api/summary?cycle=${m.cycle.start}`, cookies: { sid } })).json().totals.income;
  const put = await app.inject({ method: 'PUT', url: `/api/trx/${id}`, cookies: { sid },
    payload: { kind: 'transfer', amount: 900000, trx_date: m.today, account_id: acc['Kripto'], to_account_id: acc['Rek. utama'], note: 'tarik tabungan btc' } });
  assert.equal(put.statusCode, 200, put.body);
  const item = put.json().item;
  assert.deepEqual([item.kind, item.account_kind, item.account_name, item.to_account_name, item.category_id], ['transfer', 'asset', 'Kripto', 'Rek. utama', null]);

  // Bukan lagi pemasukan, dan mengurangi total setoran bersih Kripto.
  const sum1 = (await app.inject({ url: `/api/summary?cycle=${m.cycle.start}`, cookies: { sid } })).json().totals.income;
  assert.equal(sum0 - sum1, 900000);
  const after = (await app.inject({ url: '/api/savings', cookies: { sid } })).json().assets.find((a) => a.name === 'Kripto');
  assert.equal(before.net_invested - after.net_invested, 900000);
  assert.equal(after.cycle_net - before.cycle_net, -900000);
});

test('reset transaksi: simulasi tidak mengubah apa pun, --sejak dan --semua menghapus yang tepat', { skip }, async () => {
  const run = (...args) => execFileSync(process.execPath, ['scripts/reset-transactions.js', ...args],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const n = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();

  // Data uji: transaksi lama (dipertahankan oleh --sejak) dan baru, penarikan darurat berutang, tagihan terbayar.
  const old = await post({ kind: 'expense', amount: 1000, trx_date: '2024-03-10', account_id: acc['Rek. utama'], category_id: cat['Belanja'] });
  assert.equal(old.statusCode, 201);
  const wd = await post({ kind: 'expense', amount: 5000, trx_date: '2026-11-12', account_id: acc['Rek. utama'], category_id: cat['Kesehatan'], from_emergency: true });
  assert.equal(wd.statusCode, 201);
  await pool.query('delete from bill_occurrence'); await pool.query('delete from recurring_bill');
  const bill = await app.inject({ method: 'POST', url: '/api/bills', cookies: { sid }, payload: {
    name: 'Reset Tes', category_id: cat['Tagihan'], account_id: acc['Rek. utama'], default_amount: 7000, due_dom: 20 } });
  assert.equal(bill.statusCode, 201);
  const occ = (await app.inject({ url: '/api/bills', cookies: { sid } })).json().items.find((o) => o.name === 'Reset Tes');
  const paid = await app.inject({ method: 'POST', url: `/api/bills/occurrences/${occ.id}/pay`, cookies: { sid },
    payload: { amount: 7000, trx_date: '2026-11-18', account_id: acc['Rek. utama'] } });
  assert.equal(paid.statusCode, 201, paid.body);

  const total0 = await n('select count(*)::int n from trx');
  const recent0 = await n(`select count(*)::int n from trx where trx_date >= '2026-11-01'`);
  assert.ok(recent0 >= 2 && total0 > recent0);

  // Salah argumen ditolak; simulasi tidak mengubah apa pun.
  assert.throws(() => run(), /Gagal/);
  assert.throws(() => run('--semua', '--sejak', '2026-11-01'), /Gagal/);
  assert.throws(() => run('--sejak', '2026-02-30'), /tidak valid/);
  assert.match(run('--sejak', '2026-11-01'), /SIMULASI/);
  assert.match(run('--semua'), /SIMULASI/);
  assert.equal(await n('select count(*)::int n from trx'), total0);
  assert.ok(await n('select count(*)::int n from emergency_debt') >= 1);

  // --sejak: yang baru hilang beserta utangnya dan tagihan terbayarnya, yang lama tetap.
  assert.match(run('--sejak', '2026-11-01', '--commit'), /Selesai/);
  assert.equal(await n(`select count(*)::int n from trx where trx_date >= '2026-11-01'`), 0);
  assert.equal(await n('select count(*)::int n from trx'), total0 - recent0);
  assert.equal(await n(`select count(*)::int n from trx where trx_date = '2024-03-10'`), 1);
  assert.equal(await n('select count(*)::int n from emergency_debt d join trx w on w.id = d.withdrawal_trx_id where w.trx_date >= $1', ['2026-11-01']), 0);
  assert.equal(await n(`select count(*)::int n from bill_occurrence where status = 'paid'`), 0);

  // Tagihan dibuat ulang otomatis sebagai belum dibayar.
  const again = (await app.inject({ url: '/api/bills', cookies: { sid } })).json();
  assert.equal(again.items.find((o) => o.name === 'Reset Tes').status, 'pending');

  // --semua: tidak ada transaksi, utang, jadwal, maupun siklus; data master tetap.
  const masters = [await n('select count(*)::int n from account'), await n('select count(*)::int n from category'),
    await n('select count(*)::int n from app_user'), await n('select count(*)::int n from recurring_bill')];
  assert.match(run('--semua', '--commit'), /Selesai/);
  for (const t of ['trx', 'emergency_debt', 'bill_occurrence', 'pay_cycle']) assert.equal(await n(`select count(*)::int n from ${t}`), 0, t);
  assert.deepEqual([await n('select count(*)::int n from account'), await n('select count(*)::int n from category'),
    await n('select count(*)::int n from app_user'), await n('select count(*)::int n from recurring_bill')], masters);
  // Aplikasi tetap jalan di database kosong.
  const s = (await app.inject({ url: '/api/summary', cookies: { sid } })).json();
  assert.deepEqual([s.totals.income, s.totals.expense, s.emergency.open_debt, s.emergency.filled], [0, 0, 0, 10000000]);
  assert.equal(m.user.name, 'Erik');
});

test('cek saldo: saldo awal, selisih, catat selisih tanpa hitung ganda, pengingat', { skip }, async () => {
  const m = (await app.inject({ url: '/api/meta', cookies: { sid } })).json();
  const today = m.today;
  const A = acc['Rek. utama'];
  const check = (actual, account_id = A, token = sid) => app.inject({ method: 'POST', url: '/api/balance-checks', cookies: { sid: token }, payload: { account_id, actual } });
  const list = async () => (await app.inject({ url: `/api/balance-checks?account_id=${A}`, cookies: { sid } })).json();
  const spend = (amount, date = today, category = 'Belanja') => post({ kind: 'expense', amount, trx_date: date, account_id: A, category_id: cat[category] });
  await pool.query('delete from trx where balance_check_id is not null'); await pool.query('delete from balance_check');

  // Cek pertama = saldo awal, belum ada selisih.
  const first = await check(1000000);
  assert.equal(first.statusCode, 201, first.body);
  assert.deepEqual([first.json().check.baseline, first.json().check.diff, first.json().check.expected], [true, 0, null]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/balance-checks/${first.json().check.id}/adjust`, cookies: { sid } })).statusCode, 400);

  // Sesudahnya: pengeluaran 100rb, pemasukan 50rb, tabung 20rb. Uang sekarang 800rb -> perkiraan 930rb, kurang 130rb.
  await spend(100000);
  await post({ kind: 'income', amount: 50000, trx_date: today, account_id: A, category_id: cat['Bonus'] });
  await post({ kind: 'transfer', amount: 20000, trx_date: today, account_id: A, to_account_id: acc['Saham'] });
  // Catatan terlambat bertanggal SEBELUM cek pertama tidak ikut: sudah tercermin di saldonya.
  await spend(999000, '2020-01-01');
  const second = (await check(800000)).json().check;
  assert.deepEqual([second.prev.actual, second.masuk, second.keluar, second.expected, second.diff],
    [1000000, 50000, 120000, 930000, -130000]);
  assert.equal(second.adjusted, false);

  // Catatan susulan bertanggal hari cek, dicatat SESUDAH cek, dianggap terjadi sesudahnya (belum mengurangi selisih)...
  const found = await spend(30000);
  assert.equal((await list()).checks[0].diff, -130000);
  // ...sampai "Hitung ulang": saldo yang sama dianggap berlaku sekarang, jadi catatan itu ikut dihitung.
  const re = await app.inject({ method: 'POST', url: `/api/balance-checks/${second.id}/recheck`, cookies: { sid } });
  assert.equal(re.statusCode, 200, re.body);
  assert.equal(re.json().check.diff, -100000);
  assert.equal(re.json().check.keluar, 150000);
  // Dihapus lagi -> selisih kembali (dihitung ulang dari transaksi).
  await app.inject({ method: 'DELETE', url: `/api/trx/${found.json().item.id}`, cookies: { sid } });
  assert.equal((await list()).checks[0].diff, -130000);
  // Catatan bertanggal hari-hari sebelumnya langsung mengurangi selisih tanpa hitung ulang.
  const earlier = await spend(40000, '2020-06-01');
  assert.equal((await list()).checks[0].diff, -130000); // sebelum cek pertama: tidak ikut
  await app.inject({ method: 'DELETE', url: `/api/trx/${earlier.json().item.id}`, cookies: { sid } });

  // Catat selisih sebagai pengeluaran "Lainnya": selisih jadi 0.
  const adj = await app.inject({ method: 'POST', url: `/api/balance-checks/${second.id}/adjust`, cookies: { sid } });
  assert.equal(adj.statusCode, 200, adj.body);
  assert.deepEqual([adj.json().check.diff, adj.json().check.adjusted], [0, true]);
  const t = (await pool.query('select kind, amount, note, category_id, trx_date from trx where id = $1', [adj.json().trx_id])).rows[0];
  assert.deepEqual([t.kind, Number(t.amount), t.category_id, t.trx_date], ['expense', 130000, cat['Lainnya'], today]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/balance-checks/${second.id}/adjust`, cookies: { sid } })).statusCode, 409);

  // Cek ketiga tanpa catatan baru: penyeimbang tidak dihitung dua kali; kurang 300rb murni.
  const third = (await check(500000)).json().check;
  assert.deepEqual([third.masuk, third.keluar, third.expected, third.diff], [0, 0, 800000, -300000]);
  // Cek lama tidak bisa disesuaikan lagi (bukan yang terbaru); yang terbaru bisa, termasuk "lebih".
  assert.equal((await app.inject({ method: 'POST', url: `/api/balance-checks/${second.id}/adjust`, cookies: { sid } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/balance-checks/${second.id}/recheck`, cookies: { sid } })).statusCode, 409); // bukan yang terbaru
  const fourth = (await check(520000)).json().check; // perkiraan 500rb -> lebih 20rb
  assert.equal(fourth.diff, 20000);
  const inc = await app.inject({ method: 'POST', url: `/api/balance-checks/${fourth.id}/adjust`, cookies: { sid } });
  assert.equal(inc.statusCode, 200);
  assert.equal((await pool.query('select kind from trx where id = $1', [inc.json().trx_id])).rows[0].kind, 'income');

  // Riwayat terbaru dulu; total yang terlewat hanya dari cek yang selisihnya belum dicatat.
  const hist = await list();
  assert.deepEqual(hist.checks.map((c) => c.actual), [520000, 500000, 800000, 1000000]);
  assert.equal(hist.total_diff, 300000);

  // Validasi dan izin.
  assert.equal((await check(1, acc['Kripto'])).statusCode, 400); // aset ditolak
  assert.equal((await app.inject({ method: 'POST', url: '/api/balance-checks', cookies: { sid }, payload: { account_id: A, actual: -5 } })).statusCode, 400);
  const anak = (await pool.query(`select id from app_user where role = 'anak'`)).rows[0];
  const kid = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`, [hashToken(kid), anak.id]);
  assert.equal((await check(1, A, kid)).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/balance-checks', cookies: { sid: kid } })).statusCode, 403);

  // Pengingat: mingguan, sudah dicek hari ini -> belum waktunya; cek 8 hari lalu -> waktunya; null -> mati.
  assert.deepEqual([(await list()).reminder.days, (await list()).reminder.due], [7, false]);
  await pool.query(`update balance_check set check_date = check_date - 8`);
  const old = (await list()).reminder;
  assert.deepEqual([old.days_since, old.due], [8, true]);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/balance-settings', cookies: { sid }, payload: { days: 30 } })).json().reminder.due, false);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/balance-settings', cookies: { sid }, payload: { days: null } })).json().reminder.due, false);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/balance-settings', cookies: { sid }, payload: { days: 0 } })).statusCode, 400);
  await app.inject({ method: 'PUT', url: '/api/balance-settings', cookies: { sid }, payload: { days: 7 } });
  // Beranda membawa status pengingat; belum pernah cek sama sekali -> waktunya.
  assert.equal((await app.inject({ url: '/api/summary', cookies: { sid } })).json().balance_reminder.due, true);
  await pool.query('delete from trx where balance_check_id is not null'); await pool.query('delete from balance_check');
  const none = (await app.inject({ url: '/api/summary', cookies: { sid } })).json().balance_reminder;
  assert.deepEqual([none.last_date, none.days_since, none.due], [null, null, true]);
});

test('reset transaksi ikut menghapus cek saldo (termasuk transaksi penyeimbang)', { skip }, async () => {
  const A = acc['Rek. utama'];
  await pool.query('delete from trx where balance_check_id is not null'); await pool.query('delete from balance_check');
  const mk = (actual) => app.inject({ method: 'POST', url: '/api/balance-checks', cookies: { sid }, payload: { account_id: A, actual } });
  await mk(100000);
  const c2 = (await mk(40000)).json().check;
  const adj = await app.inject({ method: 'POST', url: `/api/balance-checks/${c2.id}/adjust`, cookies: { sid } });
  assert.equal(adj.statusCode, 200, adj.body);
  assert.equal((await pool.query('select count(*)::int n from balance_check')).rows[0].n, 2);
  const out = execFileSync(process.execPath, ['scripts/reset-transactions.js', '--semua', '--commit'],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Cek saldo\s+: 2 dihapus/);
  assert.equal((await pool.query('select count(*)::int n from balance_check')).rows[0].n, 0);
  assert.equal((await pool.query('select count(*)::int n from trx')).rows[0].n, 0);
});
