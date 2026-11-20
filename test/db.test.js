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

before(async () => {
  if (skip) return;
  pool = createPool(url);
  await pool.query(`truncate emergency_debt, bill_occurrence, recurring_bill, budget, savings_holding, trx, pay_cycle, session restart identity cascade`);
  erik = (await pool.query(`select * from app_user where name = 'Erik'`)).rows[0];
  acc = Object.fromEntries((await pool.query('select name, id from account')).rows.map((r) => [r.name, r.id]));
  cat = Object.fromEntries((await pool.query('select name, id from category')).rows.map((r) => [r.name, r.id]));
  sid = newSessionToken();
  await pool.query(`insert into session (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
    [hashToken(sid), erik.id]);
  app = buildApp({ pool, logger: false });
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
