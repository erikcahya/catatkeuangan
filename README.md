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
| `npm test` | Tes cepat (tanpa database) |
| `npm run test:db` | Tes integrasi ke `TEST_DATABASE_URL` (database itu dikosongkan tiap kali jalan) |

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

`docker compose up -d --build` dengan `POSTGRES_PASSWORD` di `.env`. App mendengarkan di `127.0.0.1:3000`; pasang Nginx dengan HTTPS di depannya (cookie login hanya dikirim lewat HTTPS saat `NODE_ENV=production`).
