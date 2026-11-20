# Aplikasi pencatatan keuangan rumah tangga: spesifikasi

Aplikasi kecil untuk satu rumah tangga (suami, istri, anak). Dokumen ini adalah konteks untuk Claude Code di VS Code.

Desain layar: https://claude.ai/artifact/XzJgVuup3NgEQpHiMdW3im (7 layar, angka di dalamnya hanya contoh).
Skema: `db/migrations/001_schema.sql`. Data awal: `db/migrations/002_seed.sql`. Cara menjalankan: `README.md`.

## Stack (rekomendasi, bukan keputusan final)

- Backend: Node.js dengan Fastify dan `pg` (node-postgres), SQL ditulis langsung tanpa ORM. Migrasi berupa berkas SQL berurutan.
- Database: PostgreSQL 16.
- Frontend: PWA mobile-first, lebar acuan 390 px, supaya anggota keluarga memasangnya dari ponsel.
- Deploy: Docker Compose (app dan postgres) di belakang Nginx.
- Satu rumah tangga per instalasi. Kolom `household_id` tetap ada supaya tabel konsisten, tetapi tidak perlu multi-tenant.

## Aturan bisnis

Ditandai: **[pasti]** = disebut langsung oleh pemilik; **[asumsi]** = tafsiran saya yang perlu dikonfirmasi.

### Siklus gajian
- **[pasti]** Gajian tiap tanggal 25. Satu siklus berjalan 25 sampai 24 bulan berikutnya. Fungsi SQL `cycle_start(date, payday)` menghitung awal siklus.
- **[pasti]** Gaji yang cair tidak tepat tanggal 25 (misalnya 24 Agu atau 4 Okt) tetap masuk siklus bulan gajiannya. Pada impor, kategori Gaji ditetapkan ke siklus bulan gajiannya, bukan dari tanggal transaksi.
- **[asumsi]** Pada input manual aturan yang sama dipakai: transaksi kategori Gaji masuk siklus dengan tanggal gajian terdekat (24 Agu -> siklus 25 Agu, 4 Okt -> siklus 25 Sep).
- **[asumsi]** `pay_cycle` dibuat otomatis saat transaksi pertama pada siklus itu dicatat.

### Rekening darurat
- **[pasti]** Satu rekening darurat, target Rp10 juta per bulan.
- **[pasti]** Setiap penarikan dicatat sebagai utang ke rekening itu (`emergency_debt`), sebagai pengingat bahwa bulan tersebut kelebihan belanja. Dilunasi saat gajian.
- **[pasti]** Tidak pernah berutang ke orang lain. Entri "utang" di catatan lama (misalnya octo, permata) hanya pelunasan ke tabungan sendiri.
- Penarikan dibuat dari layar Tambah transaksi dengan sakelar "Ambil dari rekening darurat". Pelunasan adalah transaksi transfer ke rekening darurat, lalu `emergency_debt.status` menjadi `paid`.
- "Catat pelunasan" di layar Rekening darurat: pilih utang (default semua yang belum lunas), rekening asal, dan tanggal. Satu transfer melunasi semua utang terpilih.
- Pelunasan bisa dibatalkan dari layar itu: utang kembali belum lunas dan transfernya dihapus lunak. Transfer pelunasan tidak bisa dihapus dari daftar transaksi biasa.

### Transfer, tabungan, investasi
- **[pasti]** Transfer ke rekening sendiri bukan pengeluaran dan bukan tabungan baru (`kind = 'transfer'`).
- **[pasti, 19 Nov 2026]** Form Tambah transaksi tidak menampilkan pilihan Transfer; pilihannya Pengeluaran, Pemasukan, dan Tabung (transfer ke rekening aset). Transfer tetap dipakai di balik layar untuk Tabung, pelunasan rekening darurat, dan impor catatan lama.
- **[pasti]** Uang kontrakan yang disisihkan dicatat di kategori Tagihan dan dihitung sebagai tagihan (`counts_as_bill`), bukan tabungan.
- **[asumsi]** Setoran investasi adalah transfer ke rekening berjenis `asset`. Total setoran per aset dihitung dari transfer itu. `savings_holding.current_value` diisi manual dan boleh kosong.
- **[asumsi, 19 Nov 2026]** Setoran investasi dicatat sebagai transfer ke rekening aset ("Catat setoran" di layar Tabungan). Kategori pengeluaran "Investasi" tetap ada untuk catatan lama, tetapi tidak dihitung sebagai setoran; layar Tabungan memberi tanda bila ada transaksi di kategori itu.
- Total setoran per aset = transfer masuk - transfer keluar (sepanjang waktu). Nilai sekarang diisi manual per rekening aset (`savings_holding`, satu baris per rekening) dan boleh dikosongkan.

### Tagihan berulang
- **[pasti]** Contoh: wifi (Biznet), pembantu, kontrakan. Listrik berubah tiap bulan (`is_variable`).
- Tiap awal siklus, buat satu `bill_occurrence` per tagihan aktif dengan `due_date` di dalam siklus. Menekan "Bayar" membuat transaksi pengeluaran dan menautkannya ke `bill_occurrence`, status menjadi `paid`.
- **[terbuka]** Nominal dan tanggal jatuh tempo asli belum diketahui. Nilai di desain hanya contoh.
- Tagihan siklus dibuat saat layar Tagihan atau Beranda dibuka untuk siklus berjalan atau lampau, bukan untuk siklus mendatang. Tagihan baru langsung muncul di siklus berjalan.
- Tanggal jatuh tempo 25–31 jatuh di awal siklus, 1–24 di akhir siklus. Tanggal yang tidak ada di bulan itu (31 Nov) dimundurkan ke akhir bulan.
- **[pasti]** Wifi jatuh tempo tiap 28 hari sejak pembelian terakhir, bukan tanggal tetap. Tagihan punya dua jenis jadwal: tanggal tetap tiap bulan (`due_dom`) atau tiap N hari (`interval_days`) sejak pembayaran terakhir. Untuk yang kedua, `anchor_date` = pembayaran terakhir sebelum dicatat di aplikasi; setelah itu dipakai tanggal transaksi pembayarannya (atau tanggal jatuh tempo yang dilewati). Selalu ada tepat satu jatuh tempo yang belum dibayar.
- Siklus transaksi pembayaran = yang lebih akhir antara siklus tagihan dan siklus tanggal bayar: bayar lebih awal tetap masuk siklus tagihannya, bayar terlambat masuk siklus saat dibayar.
- Tagihan yang belum dibayar dari siklus sebelumnya tetap tampil (dan dihitung) di siklus berjalan sebagai terlambat.
- Mengubah tagihan memperbarui tagihan siklus berjalan yang belum dibayar. Menonaktifkan menghapusnya dari siklus berjalan; riwayat tetap ada.
- Tagihan bisa dilewati untuk satu siklus (`status = skipped`), mis. pembantu libur. Menghapus transaksi pembayaran mengembalikan tagihan ke belum dibayar.
- **[asumsi]** Layar Tagihan hanya untuk anggota yang boleh melihat laporan.

### Budget makan harian
- **[pasti]** Kategori Makan dan Minum: Rp300.000 hari kerja, Rp200.000 akhir pekan. Ada peringatan bila total hari itu melebihi batas.
- Tabel `daily_budget`. Total hari ini adalah jumlah transaksi pengeluaran kategori itu pada tanggal tersebut yang belum dihapus.
- **[asumsi]** Hari kerja = Senin sampai Jumat, dihitung dengan zona waktu Asia/Jakarta.

### Anggota dan izin
- **[pasti]** Login dengan email dan kata sandi (diputuskan 16 Nov 2026). Sesi berlaku 90 hari, disimpan di tabel `session` (`db/migrations/003_auth.sql`).
- **[pasti]** Semua anggota saling melihat transaksi, dan tiap transaksi menampilkan pencatatnya (`trx.user_id`).
- **[pasti]** Anak hanya boleh mencatat. Mengubah dan menghapus boleh untuk semua anggota.
- **[asumsi]** Anak tidak melihat laporan, saldo, rekening darurat, dan tabungan (`can_view_reports = false`). Anak melihat daftar transaksi agar bisa mengubah dan menghapus.
- Penghapusan bersifat lunak (`deleted_at`). Pengubahan mengisi `updated_by` dan `updated_at`.
- **Ubah transaksi** (menekan baris transaksi): jumlah, tanggal, kategori, rekening, catatan, dan tanda sekali bayar bisa diubah; jenis boleh pindah antara Pengeluaran, Pemasukan, dan Tabung. Siklus dihitung ulang dari tanggal baru (gaji tetap ke siklus gajian terdekat).
- Penarikan rekening darurat dan pembayaran tagihan terkunci jenisnya; penarikan juga terkunci rekeningnya dan mengubah jumlahnya ikut mengubah utang yang terbuka. Jumlah penarikan yang utangnya sudah lunas terkunci. Transfer pelunasan utang darurat tidak bisa diubah dari daftar transaksi (batalkan di layar Rekening darurat).
- **[asumsi]** Hanya suami/istri yang bisa menambah anggota, mengubah peran, dan mengatur email/kata sandi anggota lain. Harus selalu ada minimal satu suami atau istri. Setiap anggota bisa mengganti kata sandinya sendiri (dengan kata sandi lama). Email anggota lain tidak ditampilkan ke anak.

### Kategori
- 19 kategori pengeluaran dan 4 pemasukan, lihat `db/migrations/002_seed.sql`. Struktur induk dan sub-kategori didukung (`parent_id`) tetapi belum dipakai.

## Layar (urutan pengerjaan)
1. Tambah transaksi
2. Beranda (siklus, budget makan, rekening darurat, ringkasan tagihan dan tabungan, transaksi terbaru)
3. Tagihan berulang
4. Rekening darurat
5. Tabungan dan investasi
6. Laporan siklus
7. Anggota keluarga

## Beranda: cara menghitung angka
- **[asumsi]** Anggaran siklus = total pemasukan siklus itu. Sisa = pemasukan - pengeluaran. Transfer tidak dihitung.
- **[asumsi]** Rekening darurat "terisi" = target - utang yang belum lunas (saldo awal rekening tidak dicatat di aplikasi).
- **[asumsi]** Tabungan "disetor siklus ini" = transfer ke rekening berjenis `asset` pada siklus itu. Pengeluaran berkategori Investasi tidak ikut dihitung (keputusan kategori Investasi masih terbuka).
- Anak (`can_view_reports = false`) hanya melihat budget makan hari ini dan transaksi terbaru; API tidak mengirim angka lainnya.

## Impor catatan lama
Catatan lama punya kolom: tanggal, kategori, keterangan, sumber, jumlah (bertanda plus atau minus). Aturan impor:
- Tanda jumlah menentukan pemasukan atau pengeluaran.
- Transfer ke rekening sendiri tidak ada jenisnya di catatan lama, jadi harus dideteksi dan ditandai (berdasarkan keterangan) agar tidak terhitung sebagai pemasukan atau pengeluaran.
- Pasangkan penarikan dan pelunasan rekening darurat menjadi `emergency_debt`.
- Gaji masuk ke siklus bulan gajiannya.
- Penanda `is_one_off` tidak ada di data lama dan harus ditetapkan ulang.
- Beberapa baris salah kategori (contoh: "nabung bibit" di Makan dan Minum). Sediakan laporan baris yang perlu ditinjau, jangan perbaiki diam-diam.
- Pencatat transaksi lama: tetapkan ke satu pengguna tetap, karena data lama tidak mencatatnya.

### Cara impor (dibuat 20 Nov 2026)
Berkas sumber: laporan Excel "ec.financial planning_report" (25 Feb 2023 sampai 14 Jun 2025, 4.592 baris). `scripts/xlsx-to-csv.py` mengubahnya menjadi CSV dan mencocokkan jumlah per kategori dengan lembar Ringkasan; `npm run import-old` mengimpor (simulasi dulu, `--commit` untuk menulis, `--rollback` untuk membatalkan seluruh gelombang lewat kolom `trx.import_batch`).
- Semua baris bersumber "kas": masuk ke rekening "Rek. utama". Semua transaksi lama dicatat atas nama Erik.
- **[pasti]** Penarikan = pemasukan Pemasukan Lainnya bertuliskan "utang/pinjam octo|permata|tabungan"; pelunasan = pengeluaran Tagihan "bayar/ganti utang octo|permata|iin|tabungan". Keduanya menjadi transfer antara Rek. utama dan rekening darurat, bukan pemasukan/pengeluaran. Pengeluaran biasa yang hanya bertuliskan "utang octo" (mis. "tomoro utang octo") tetap pengeluaran.
- **[asumsi]** Pemasangan utang FIFO: pelunasan menutup utang terlama dulu. Pelunasan yang melebihi utang terbuka menjadi kredit untuk penarikan berikutnya (di catatan lama banyak utang tidak dicatat sebagai penarikan), jadi sisa utang akhir = total penarikan - total pelunasan. Utang yang baru lunas sebagian tetap terbuka dengan jumlah sisanya. Pada tanggal yang sama penarikan diproses sebelum pelunasan.
- Gaji masuk siklus tanggal gajian terdekat; yang lain mengikuti tanggal transaksi.
- `is_one_off` semua `false`; pengeluaran ≥ Rp5 juta masuk laporan tinjauan sebagai kandidat untuk ditandai manual.
- Baris yang meragukan (investasi, utang ke orang lain, nominal besar, kategori mungkin salah) diimpor apa adanya dan dicatat di `laporan-tinjau.csv` (berkas CSV dan laporan itu ada di `import/`, tidak ikut git karena pribadi).

## Belum diputuskan
- Undangan lewat email (butuh layanan pengirim email). Untuk sekarang suami/istri menambah anggota dan mengatur email + kata sandinya di layar Anggota keluarga; `npm run set-login` tetap ada untuk akun pertama.
- Layar pengaturan batas budget harian.
