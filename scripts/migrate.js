// Menjalankan berkas db/migrations/*.sql yang belum pernah dijalankan, berurutan,
// masing-masing di dalam satu transaksi.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool, withTx } from '../src/db.js';

const dir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const pool = createPool();

try {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let n = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(dir + f, 'utf8');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [f]);
    });
    console.log(`✓ ${f}`);
    n++;
  }
  console.log(n ? `${n} migrasi dijalankan.` : 'Database sudah terbaru.');
} catch (err) {
  console.error('Migrasi gagal:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
