import { HttpError } from '../lib/errors.js';
import { cycleEnd, cycleLabel, cycleStart, isValidDate, todayJakarta } from '../lib/dates.js';
import { SOURCES } from '../lib/market.js';
import { withTx } from '../db.js';
import { ensureCycle } from '../lib/cycles.js';

const PRICE_TTL_MS = 30 * 60 * 1000; // harga dianggap basi setelah 30 menit

const uuid = { type: 'string', format: 'uuid' };

function requireReports(req) {
  if (!req.user.can_view_reports) throw new HttpError(403, 'Halaman ini tidak tersedia untuk akun Anda.');
}

function assetType(name) {
  const n = name.toLowerCase();
  for (const t of ['kripto', 'saham', 'emas']) if (n.includes(t)) return t;
  return 'lainnya';
}

/**
 * Tabungan dan investasi = rekening berjenis 'asset'.
 * Setoran = transfer ke rekening aset; penarikan = transfer dari rekening aset.
 * Total setoran bersih = semua setoran - semua penarikan (sepanjang waktu).
 * Nilai sekarang diisi manual dan boleh kosong, atau dihitung otomatis: jumlah unit x harga pasar.
 */
export default async function savingsRoutes(app) {
  const pool = app.pg;

  /**
   * Perbarui harga aset yang mengikuti pasar. Gagal di satu aset tidak menghentikan yang lain:
   * harga lama tetap dipakai dan pesan galatnya dikembalikan per rekening.
   */
  async function refreshPrices(householdId, { force = false, accountId = null } = {}) {
    const { rows } = await pool.query(
      `select h.id, h.account_id, h.price_source, h.symbol, h.quantity, h.price_at
         from savings_holding h join account a on a.id = h.account_id
        where a.household_id = $1 and h.price_source is not null and h.quantity is not null
          and ($2::uuid is null or h.account_id = $2)`,
      [householdId, accountId],
    );
    const errors = {};
    const cache = new Map();
    await Promise.all(rows.map(async (h) => {
      if (!force && h.price_at && Date.now() - new Date(h.price_at).getTime() < PRICE_TTL_MS) return;
      const key = `${h.price_source}:${h.symbol ?? ''}`;
      try {
        if (!cache.has(key)) cache.set(key, app.quote(h.price_source, h.symbol));
        const price = await cache.get(key);
        await pool.query(
          `update savings_holding
              set unit_price = $2, price_at = now(), current_value = round(quantity * $2), as_of_date = $3
            where id = $1`,
          [h.id, price, todayJakarta()],
        );
      } catch (ex) {
        errors[h.account_id] = ex.message;
      }
    }));
    return errors;
  }

  app.get('/api/savings', {
    schema: { querystring: { type: 'object', properties: { cycle: { type: 'string' } } } },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const current = cycleStart(todayJakarta(), u.payday_dom);
    const start = req.query.cycle ?? current;
    if (!isValidDate(start) || cycleStart(start, u.payday_dom) !== start) throw new HttpError(400, 'Siklus tidak valid.');

    const priceErrors = await refreshPrices(u.household_id);
    const [assets, investExpense] = await Promise.all([
      pool.query(
        `select a.id as account_id, a.name,
                coalesce(sum(t.amount) filter (where t.to_account_id = a.id), 0) as total_in,
                coalesce(sum(t.amount) filter (where t.account_id = a.id), 0)    as total_out,
                coalesce(sum(t.amount) filter (where t.to_account_id = a.id and pc.start_date = $2), 0) as cycle_in,
                coalesce(sum(t.amount) filter (where t.account_id = a.id and pc.start_date = $2), 0)    as cycle_out,
                h.current_value, h.as_of_date,
                h.price_source, h.symbol, h.quantity, h.unit_price, h.price_at
           from account a
           left join trx t on (t.to_account_id = a.id or t.account_id = a.id)
                          and t.kind = 'transfer' and t.deleted_at is null
           left join pay_cycle pc on pc.id = t.cycle_id
           left join savings_holding h on h.account_id = a.id
          where a.household_id = $1 and a.kind = 'asset'
          group by a.id, a.name, h.current_value, h.as_of_date, h.price_source, h.symbol, h.quantity, h.unit_price, h.price_at
          order by a.name`,
        [u.household_id, start],
      ),
      // Catatan lama mungkin mencatat setoran sebagai pengeluaran kategori Investasi.
      pool.query(
        `select coalesce(sum(t.amount), 0) as amount, count(*)::int as count
           from trx t
           join category c on c.id = t.category_id
           join pay_cycle pc on pc.id = t.cycle_id
          where pc.household_id = $1 and pc.start_date = $2 and c.name = 'Investasi'
            and t.kind = 'expense' and t.deleted_at is null`,
        [u.household_id, start],
      ),
    ]);

    const items = assets.rows.map((r) => {
      const net = r.total_in - r.total_out;
      return {
        ...r,
        net_invested: net,
        cycle_net: r.cycle_in - r.cycle_out,
        gain: r.current_value == null ? null : r.current_value - net,
        price_error: priceErrors[r.account_id] ?? null,
      };
    });
    return {
      cycle: { start, end: cycleEnd(start), label: cycleLabel(start) },
      deposited_cycle: items.reduce((s, x) => s + x.cycle_in, 0),
      withdrawn_cycle: items.reduce((s, x) => s + x.cycle_out, 0),
      assets: items,
      investasi_expense: investExpense.rows[0],
    };
  });

  app.put('/api/savings/:accountId/value', {
    schema: {
      params: { type: 'object', properties: { accountId: uuid }, required: ['accountId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['current_value'],
        properties: {
          current_value: { type: ['integer', 'null'], minimum: 0, maximum: 999_999_999_999 },
          as_of_date: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const { rows } = await pool.query(
      `select id, name from account where id = $1 and household_id = $2 and kind = 'asset'`,
      [req.params.accountId, u.household_id],
    );
    const acc = rows[0];
    if (!acc) throw new HttpError(404, 'Rekening aset tidak ditemukan.');
    const value = req.body.current_value;
    const asOf = value == null ? null : (req.body.as_of_date || todayJakarta());
    if (asOf && !isValidDate(asOf)) throw new HttpError(400, 'Tanggal tidak valid.');
    await pool.query(
      `insert into savings_holding (account_id, asset_type, name, current_value, as_of_date)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id) do update set current_value = excluded.current_value, as_of_date = excluded.as_of_date,
         price_source = null, symbol = null, quantity = null, unit_price = null, price_at = null`,
      [acc.id, assetType(acc.name), acc.name, value, asOf],
    );
    return { ok: true };
  });

  // Hitung nilai dari jumlah unit x harga pasar. Menggantikan nilai manual sampai dimatikan.
  app.put('/api/savings/:accountId/holding', {
    schema: {
      params: { type: 'object', properties: { accountId: uuid }, required: ['accountId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['price_source', 'quantity'],
        properties: {
          price_source: { type: 'string', enum: SOURCES },
          symbol: { type: ['string', 'null'], maxLength: 40 },
          quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 },
          // Hanya berlaku saat aset baru mulai dilacak: catat nilai pasar hari ini sebagai Tabung dari Rek. utama.
          record_deposit: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    requireReports(req);
    const u = req.user;
    const { rows } = await pool.query(
      `select id, name from account where id = $1 and household_id = $2 and kind = 'asset'`,
      [req.params.accountId, u.household_id],
    );
    const acc = rows[0];
    if (!acc) throw new HttpError(404, 'Rekening aset tidak ditemukan.');
    const { price_source: source, quantity } = req.body;
    const typed = (req.body.symbol ?? '').trim();
    const symbol = source === 'gold' ? 'XAU' : source === 'fx' ? typed.toUpperCase() : typed;
    if (source === 'crypto' && !/^[A-Za-z0-9._-]{1,40}$/.test(symbol)) throw new HttpError(400, 'Isi kode koin, mis. BTC atau ETH.');
    if (source === 'fx' && !/^[A-Za-z]{3}$/.test(symbol)) throw new HttpError(400, 'Isi kode mata uang 3 huruf, mis. CHF atau USD.');
    const wasTracked = (await pool.query('select price_source from savings_holding where account_id = $1', [acc.id])).rows[0]?.price_source != null;
    await pool.query(
      `insert into savings_holding (account_id, asset_type, name, price_source, symbol, quantity, unit_price, price_at)
       values ($1, $2, $3, $4, $5, $6, null, null)
       on conflict (account_id) do update set price_source = excluded.price_source, symbol = excluded.symbol,
         quantity = excluded.quantity, unit_price = null, price_at = null`,
      [acc.id, assetType(acc.name), acc.name, source, symbol, quantity],
    );
    const errors = await refreshPrices(u.household_id, { force: true, accountId: acc.id });
    let deposit = null;
    if (req.body.record_deposit && !wasTracked && !errors[acc.id]) {
      const value = (await pool.query('select current_value from savings_holding where account_id = $1', [acc.id])).rows[0]?.current_value;
      if (value > 0) deposit = await recordOpeningDeposit(u, acc.id, value);
    }
    return { ok: true, price_error: errors[acc.id] ?? null, deposit };
  });

  /** Aset yang sudah dimiliki sebelum memakai aplikasi: dicatat sebagai Tabung (jumlah unit sudah diisi, jadi tidak ditambah lagi). */
  async function recordOpeningDeposit(u, assetId, amount) {
    const from = (await pool.query(
      `select id from account where household_id = $1 and kind <> 'asset' and not is_emergency
        order by (name = 'Rek. utama') desc, name limit 1`,
      [u.household_id],
    )).rows[0];
    if (!from) return null;
    const today = todayJakarta();
    return withTx(pool, async (c) => {
      const cycleId = await ensureCycle(c, u.household_id, cycleStart(today, u.payday_dom));
      await c.query(
        `insert into trx (account_id, to_account_id, category_id, cycle_id, user_id, trx_date, kind, amount, note)
         values ($1, $2, null, $3, $4, $5, 'transfer', $6, 'Modal awal aset (nilai pasar saat mulai dilacak)')`,
        [from.id, assetId, cycleId, u.id, today, amount],
      );
      return { amount, from_account_id: from.id };
    });
  }

  // Tombol "Perbarui harga": paksa ambil ulang semua harga pasar.
  app.post('/api/savings/refresh', async (req) => {
    requireReports(req);
    const errors = await refreshPrices(req.user.household_id, { force: true });
    return { ok: true, errors: Object.keys(errors).length };
  });
}
