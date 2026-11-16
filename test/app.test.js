// Tes server tanpa database sungguhan: pool palsu hanya mengenali query sesi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  household_id: '22222222-2222-4222-8222-222222222222',
  name: 'Erik', role: 'suami', can_view_reports: true, email: 'erik@contoh.id', payday_dom: 25,
};

function fakePool() {
  return {
    async query(sql) {
      if (sql.includes('from session s')) return { rows: [USER] };
      throw new Error(`query tak terduga: ${sql.slice(0, 60)}`);
    },
  };
}

async function make() {
  const app = buildApp({ pool: fakePool(), logger: false });
  await app.ready();
  return app;
}

test('halaman aplikasi tersaji', async () => {
  const app = await make();
  const res = await app.inject({ url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<main id="app"/);
  const sw = await app.inject({ url: '/sw.js' });
  assert.equal(sw.statusCode, 200);
  await app.close();
});

test('rute yang tidak dikenal kembali ke aplikasi, API tidak', async () => {
  const app = await make();
  assert.equal((await app.inject({ url: '/apa-saja' })).statusCode, 200);
  const api = await app.inject({ url: '/api/tidak-ada', cookies: { sid: 'x' } });
  assert.equal(api.statusCode, 404);
  await app.close();
});

test('API menolak tanpa sesi', async () => {
  const app = await make();
  const res = await app.inject({ url: '/api/meta' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'Silakan login dulu.');
  await app.close();
});

test('POST /api/trx menolak input salah sebelum menyentuh database', async () => {
  const app = await make();
  const post = (payload) => app.inject({ method: 'POST', url: '/api/trx', cookies: { sid: 'x' }, payload });

  const noAmount = await post({ kind: 'expense', trx_date: '2026-11-16' });
  assert.equal(noAmount.statusCode, 400);

  const badKind = await post({ kind: 'utang', amount: 1000, trx_date: '2026-11-16' });
  assert.equal(badKind.statusCode, 400);

  const negative = await post({ kind: 'expense', amount: -5, trx_date: '2026-11-16' });
  assert.equal(negative.statusCode, 400);

  const badDate = await post({ kind: 'expense', amount: 1000, trx_date: '2026-02-30' });
  assert.equal(badDate.statusCode, 400);
  assert.equal(badDate.json().error, 'Tanggal tidak valid.');
  // Catatan: properti tambahan (mis. user_id) dibuang diam-diam oleh Fastify;
  // pencatat selalu diambil dari sesi login, bukan dari body.
  await app.close();
});
