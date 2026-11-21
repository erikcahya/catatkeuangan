import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, coinId, GRAMS_PER_OUNCE } from '../src/lib/market.js';

const json = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
const urls = [];
const spy = (body) => async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => body }; };

test('coinId: kode umum dipetakan, selain itu dianggap id CoinGecko', () => {
  assert.equal(coinId('btc'), 'bitcoin');
  assert.equal(coinId(' ETH '), 'ethereum');
  assert.equal(coinId('Chainlink'), 'chainlink');
});

test('quote crypto: harga Rupiah per koin, kode dikirim apa adanya ke CoinGecko', async () => {
  urls.length = 0;
  assert.equal(await quote('crypto', 'BTC', spy({ bitcoin: { idr: 1_000_000_000 } })), 1_000_000_000);
  assert.match(urls[0], /coingecko\.com.*ids=bitcoin&vs_currencies=idr$/);
});

test('quote crypto: kode tidak dikenal memberi pesan jelas', async () => {
  await assert.rejects(quote('crypto', 'XYZ', json({})), /Kode "XYZ" tidak ditemukan/);
});

test('quote gold: harga per gram = harga per troy ounce / 31,1035', async () => {
  const perGram = await quote('gold', 'XAU', json({ 'pax-gold': { idr: 62_000_000 } }));
  assert.ok(Math.abs(perGram - 62_000_000 / GRAMS_PER_OUNCE) < 1e-6);
  assert.ok(perGram > 1_900_000 && perGram < 2_100_000);
});

test('quote fx: kurs ke Rupiah; kode harus 3 huruf', async () => {
  urls.length = 0;
  assert.equal(await quote('fx', 'chf', spy({ result: 'success', rates: { IDR: 20_000 } })), 20_000);
  assert.match(urls[0], /open\.er-api\.com\/v6\/latest\/CHF$/);
  await assert.rejects(quote('fx', 'CH/../x', json({})), /3 huruf/);
  await assert.rejects(quote('fx', 'CHF', json({ result: 'error' })), /tidak ditemukan/);
});

test('quote: jaringan putus, HTTP gagal, dan jenis tak dikenal semuanya jadi galat berbahasa Indonesia', async () => {
  await assert.rejects(quote('crypto', 'BTC', async () => { throw new Error('ECONNRESET'); }), /tidak bisa dihubungi/);
  await assert.rejects(quote('crypto', 'BTC', json({}, false, 429)), /kode 429/);
  await assert.rejects(quote('saham', 'BBCA', json({})), /tidak dikenal/);
});

test('quote stock: harga per lembar dari Yahoo, kode BEI diberi akhiran .JK', async () => {
  urls.length = 0;
  const body = { chart: { result: [{ meta: { currency: 'IDR', regularMarketPrice: 5550 } }] } };
  assert.equal(await quote('stock', 'bbca', spy(body)), 5550);
  assert.match(urls[0], /chart\/BBCA\.JK\?/);
  await assert.rejects(quote('stock', 'BB CA', json({})), /tidak valid/);
  await assert.rejects(quote('stock', 'ZZZZ', json({ chart: { result: null } })), /tidak ditemukan/);
  await assert.rejects(quote('stock', 'AAPL.US', json({ chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 10 } }] } })), /tidak berharga Rupiah/);
});
