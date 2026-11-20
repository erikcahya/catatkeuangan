# Deploy ke VPS

Aplikasi + PostgreSQL berjalan di Docker Compose, Nginx di server memberi HTTPS. HTTPS wajib: aplikasi
hanya mengirim cookie login lewat HTTPS, dan ponsel hanya mau memasang PWA dari alamat HTTPS.

Yang dibutuhkan: VPS Ubuntu 22.04/24.04 (RAM 1 GB cukup), akses SSH, dan sebuah **domain atau subdomain**
yang record A-nya sudah menunjuk ke IP VPS (mis. `keuangan.contoh.com`).

> Panduan ini belum diuji di VPS sungguhan (Docker tidak ada di komputer pengembang). Bila ada langkah
> yang gagal, kirim hasil `docker compose logs app` atau pesan galatnya.

## 1. Siapkan server

```sh
sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw nginx certbot python3-certbot-nginx git
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
curl -fsSL https://get.docker.com | sudo sh        # atau ikuti docs.docker.com/engine/install/ubuntu
sudo usermod -aG docker $USER                      # keluar lalu masuk SSH lagi agar berlaku
```

Port aplikasi (3000) dan database hanya dibuka ke server itu sendiri, bukan ke internet.

## 2. Ambil kode dan buat `.env`

```sh
sudo mkdir -p /opt/catatkeuangan && sudo chown $USER /opt/catatkeuangan
git clone https://github.com/erikcahya/catatkeuangan.git /opt/catatkeuangan
cd /opt/catatkeuangan
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')" > .env && chmod 600 .env
```

Kata sandi database dibuat acak dan panjang; jangan pakai yang sama dengan komputer lokal. Bila repo GitHub
privat, `git clone` butuh login: pakai `gh auth login`, atau deploy key / personal access token.

## 3. Data: mulai kosong, atau bawa data dari komputer lokal

**Mulai kosong**: lewati ke langkah 4, lalu buat login di langkah 5.

**Bawa data lokal** (transaksi, hasil impor, anggota, tagihan, termasuk kata sandi login yang sudah diatur):

Di komputer Anda (PowerShell atau Git Bash), kata sandi Postgres lokal akan ditanya:

```sh
pg_dump -h localhost -U postgres -Fc catatkeuangan -f catatkeuangan.dump
scp catatkeuangan.dump USER@IP_VPS:/tmp/
```

Di VPS, pulihkan ke database yang masih kosong **sebelum** aplikasi dijalankan:

```sh
cd /opt/catatkeuangan
docker compose up -d db                      # tunggu ~10 detik sampai sehat: docker compose ps
docker compose exec -T db pg_restore -U catatkeuangan -d catatkeuangan --no-owner --no-acl < /tmp/catatkeuangan.dump
docker compose exec db psql -U catatkeuangan -d catatkeuangan -c "select count(*) from trx"
shred -u /tmp/catatkeuangan.dump             # berkas itu berisi seluruh data keuangan; hapus juga di komputer Anda
```

## 4. Jalankan aplikasi

```sh
docker compose up -d --build
docker compose ps                            # app dan db: running/healthy
docker compose logs app | tail               # harus ada "Server listening"
curl -s http://127.0.0.1:3000/healthz        # {"ok":true}
```

Migrasi database dijalankan otomatis setiap aplikasi start.

## 5. Login (hanya bila mulai kosong, atau lupa kata sandi)

```sh
docker compose exec app node scripts/set-login.js Erik email-anda@contoh.com kata-sandi-panjang
```

Anggota lain bisa ditambah dan diatur dari dalam aplikasi (avatar di Beranda > Anggota keluarga).

## 6. Nginx dan HTTPS

```sh
sudo cp deploy/nginx-proxy.conf /etc/nginx/snippets/catatkeuangan-proxy.conf
sudo cp deploy/nginx.conf /etc/nginx/sites-available/catatkeuangan
sudo nano /etc/nginx/sites-available/catatkeuangan          # ganti server_name dengan domain Anda
sudo ln -s /etc/nginx/sites-available/catatkeuangan /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d keuangan.contoh.com                  # pilih opsi redirect HTTP ke HTTPS
```

Percobaan login dibatasi 5 per menit per alamat IP. Setelah HTTPS aktif, boleh menambahkan di blok `server`
yang dikelola certbot: `add_header Strict-Transport-Security "max-age=31536000" always;`

Buka `https://keuangan.contoh.com`, masuk, lalu di ponsel pilih menu browser **Tambahkan ke layar utama**.

## 7. Cadangan harian

```sh
chmod +x deploy/backup.sh
sudo deploy/backup.sh                                        # uji sekali: harus mencetak "OK ..."
sudo crontab -e                                              # tambahkan baris berikut
0 2 * * * /opt/catatkeuangan/deploy/backup.sh >> /var/log/catatkeuangan-backup.log 2>&1
```

Cadangan disimpan di `/var/backups/catatkeuangan` (14 hari terakhir). Itu **belum cukup**: bila VPS hilang,
cadangannya ikut hilang. Salin berkala ke komputer Anda, mis. `scp -r USER@IP_VPS:/var/backups/catatkeuangan .`
(butuh akses baca; atau atur `rsync` dari komputer Anda).

Memulihkan dari cadangan (ke database yang sudah ada isinya, ini **menimpa** data sekarang):

```sh
docker compose exec -T db pg_restore -U catatkeuangan -d catatkeuangan --clean --if-exists --no-owner --no-acl < NAMA_FILE.dump
```

## 8. Memperbarui aplikasi

```sh
cd /opt/catatkeuangan
sudo deploy/backup.sh                        # cadangan dulu
git pull
docker compose up -d --build                 # migrasi baru dijalankan otomatis
```

## Bila ada masalah

| Gejala | Periksa |
| --- | --- |
| Tidak bisa login setelah HTTPS aktif | Cookie hanya berlaku lewat HTTPS; buka lewat `https://`, bukan IP |
| `502 Bad Gateway` | `docker compose ps` dan `docker compose logs app` |
| `429` saat login | Terlalu banyak percobaan; tunggu semenit |
| Aplikasi tidak mau start, "DATABASE_URL..." | Pastikan `.env` ada di folder yang sama dengan `docker-compose.yml` |
| Tampilan lama setelah pembaruan | Tutup aplikasi lalu buka lagi, atau Ctrl + Shift + R |
