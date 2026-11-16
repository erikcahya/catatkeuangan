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
  await pool.query(`truncate emergency_debt, bill_occurrence, budget, trx, pay_cycle, session restart identity cascade`);
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
  assert.deepEqual(a.json().daily_budget, { date: '2026-11-16', day_type: 'weekday', limit: 300000, total: 250000, over: 0 });
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
