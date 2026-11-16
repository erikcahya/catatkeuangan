// Mengatur email dan kata sandi seorang anggota. Sesi lama anggota itu ikut dicabut.
// Pemakaian: npm run set-login -- <nama anggota> <email> <kata sandi>
// Contoh:    npm run set-login -- Erik erik@contoh.id rahasia-panjang
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password) {
  console.error('Pemakaian: npm run set-login -- <nama anggota> <email> <kata sandi>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Kata sandi minimal 8 karakter.');
  process.exit(1);
}

const pool = createPool();
try {
  const { rows } = await pool.query(
    `update app_user set email = lower($2), password_hash = $3 where name = $1 returning id, name, role`,
    [name, email, await hashPassword(password)],
  );
  if (!rows.length) {
    const all = await pool.query('select name from app_user order by name');
    console.error(`Anggota "${name}" tidak ada. Yang ada: ${all.rows.map((r) => r.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    await pool.query('delete from session where user_id = $1', [rows[0].id]);
    console.log(`✓ Login untuk ${rows[0].name} (${rows[0].role}) diatur ke ${email.toLowerCase()}`);
  }
} catch (err) {
  console.error('Gagal:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
