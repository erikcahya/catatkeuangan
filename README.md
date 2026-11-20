# Catat Keuangan

Aplikasi pencatatan keuangan rumah tangga. Spesifikasi lengkap: [SPEC.md](SPEC.md).

## Menjalankan di komputer sendiri

Butuh Node.js 20+ dan PostgreSQL 16+.

```sh
npm install
cp .env.example .env            # isi kata sandi Postgres di DATABASE_URL
createdb -h localhost -U postgres catatkeuangan
npm run migrate                 # skema + data awal + tabel login
npm run set-login -- Erik erik@contoh.id kata-sandi-anda
npm run dev                     # http://localhost:3000
```

Anggota lain diberi login dengan cara yang sama (`Istri`, `Anak` adalah nama penampung di data awal).

## Perintah

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Server dengan muat ulang otomatis |
| `npm start` | Server biasa |
| `npm run migrate` | Jalankan migrasi yang belum dijalankan |
| `npm run set-login -- <nama> <email> <sandi>` | Atur login seorang anggota |
| `npm run import-old -- <csv> [--commit]` | Impor catatan lama (simulasi bila tanpa `--commit`) |
| `npm run reset-trx -- --semua` atau `--sejak YYYY-MM-DD` | Reset transaksi saja (simulasi bila tanpa `--commit`) |
| `npm test` | Tes cepat (tanpa database) |
| `npm run test:db` | Tes integrasi ke `TEST_DATABASE_URL` (database itu dikosongkan tiap kali jalan) |

## Impor catatan lama

```sh
python -I scripts/xlsx-to-csv.py "laporan.xlsx" import/catatan-lama.csv
npm run import-old -- import/catatan-lama.csv            # simulasi + laporan-tinjau.csv, tidak menulis apa pun
npm run import-old -- import/catatan-lama.csv --commit   # tulis ke database
npm run import-old -- --rollback                         # batalkan seluruh gelombang impor
```

Folder `import/` tidak ikut git. Aturannya ada di SPEC.md, bagian "Impor catatan lama".

## Struktur

```
db/migrations/   berkas SQL berurutan; 001 skema, 002 data awal, 003 login
src/app.js       server Fastify, cek sesi, penanganan galat
src/routes/      auth, meta (data form), trx (transaksi)
src/lib/dates.js siklus gajian, hari kerja/akhir pekan (Asia/Jakarta)
public/          PWA (HTML, CSS, JS tanpa build step)
test/            node:test
```

Migrasi baru: tambahkan berkas `004_....sql`. Jangan ubah berkas yang sudah dijalankan.

## Deploy

Langkah lengkap ke VPS (Docker Compose, Nginx, HTTPS, cadangan, membawa data lokal): [DEPLOY.md](DEPLOY.md).
