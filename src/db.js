import pg from 'pg';

// DATE dikembalikan sebagai string 'YYYY-MM-DD', bukan Date, supaya tidak bergeser zona waktu.
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC dikembalikan sebagai angka. Aman untuk rupiah hingga ~9 kuadriliun.
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL belum diisi (lihat .env.example)');
  return new pg.Pool({ connectionString });
}

/** Jalankan fn(client) di dalam satu transaksi database. */
export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
