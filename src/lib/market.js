// Harga pasar dalam Rupiah per satu unit, dari API publik gratis tanpa kunci.
// Yang dikirim ke luar hanya kode aset (mis. "bitcoin", "CHF"); tidak ada data pribadi.
//   crypto: CoinGecko, harga per koin.
//   gold:   emas dunia (token PAX Gold, 1 token = 1 troy ounce) dibagi 31,1035 = harga per gram.
//           Ini harga pasar internasional, bukan harga jual-beli Antam/Pegadaian (biasanya lebih tinggi).
//   fx:     kurs mata uang ke Rupiah dari open.er-api.com (diperbarui sekali sehari).
//   stock:  saham BEI (kode seperti BBCA) dari Yahoo Finance, harga per lembar. Sumber tidak resmi: bisa tertunda
//           atau berubah tanpa pemberitahuan; bila gagal, harga terakhir dipakai.

export const GRAMS_PER_OUNCE = 31.1034768;
export const SOURCES = ['crypto', 'gold', 'fx', 'stock'];
const TIMEOUT_MS = 6000;

const COINS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', DOGE: 'dogecoin',
  ADA: 'cardano', USDT: 'tether', USDC: 'usd-coin', TON: 'the-open-network', TRX: 'tron', DOT: 'polkadot',
  AVAX: 'avalanche-2', LINK: 'chainlink', LTC: 'litecoin', SHIB: 'shiba-inu', PEPE: 'pepe', MATIC: 'matic-network',
};

/** Kode umum (BTC) -> id CoinGecko; selain itu dianggap sudah berupa id CoinGecko (mis. "chainlink"). */
export function coinId(symbol) {
  const s = String(symbol).trim();
  return COINS[s.toUpperCase()] ?? s.toLowerCase();
}

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  } catch {
    throw new Error('Sumber harga tidak bisa dihubungi.');
  }
  if (!res.ok) throw new Error(`Sumber harga menolak permintaan (kode ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new Error('Jawaban sumber harga tidak terbaca.');
  }
}

async function coinPriceIdr(id, fetchImpl, label) {
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=idr`, fetchImpl);
  const price = data?.[id]?.idr;
  if (!(price > 0)) throw new Error(`Kode "${label}" tidak ditemukan di CoinGecko.`);
  return price;
}

/**
 * Harga Rupiah per satu unit. Gagal = melempar Error berpesan bahasa Indonesia.
 * @param source 'crypto' | 'gold' | 'fx'
 */
export async function quote(source, symbol, fetchImpl = fetch) {
  if (source === 'crypto') return coinPriceIdr(coinId(symbol), fetchImpl, symbol);
  if (source === 'gold') return (await coinPriceIdr('pax-gold', fetchImpl, 'emas')) / GRAMS_PER_OUNCE;
  if (source === 'fx') {
    const code = String(symbol).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new Error('Kode mata uang harus 3 huruf, mis. CHF atau USD.');
    const data = await getJson(`https://open.er-api.com/v6/latest/${code}`, fetchImpl);
    const price = data?.result === 'success' ? data.rates?.IDR : undefined;
    if (!(price > 0)) throw new Error(`Kurs ${code} ke Rupiah tidak ditemukan.`);
    return price;
  }
  if (source === 'stock') {
    const code = String(symbol).trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,12}(\.[A-Z]{1,3})?$/.test(code)) throw new Error('Kode saham tidak valid, mis. BBCA atau TLKM.');
    const ticker = code.includes('.') ? code : `${code}.JK`;
    const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`, fetchImpl);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!(meta?.regularMarketPrice > 0)) throw new Error(`Saham "${code}" tidak ditemukan.`);
    if (meta.currency && meta.currency !== 'IDR') throw new Error(`Saham "${code}" tidak berharga Rupiah.`);
    return meta.regularMarketPrice;
  }
  throw new Error('Jenis sumber harga tidak dikenal.');
}
