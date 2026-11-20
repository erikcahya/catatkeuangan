-- Cek saldo: pemilik memasukkan uang yang benar-benar ada di sebuah rekening. Dibandingkan dengan
-- perkiraan dari catatan (saldo cek sebelumnya + pemasukan - pengeluaran tercatat), selisihnya
-- adalah catatan yang terlewat. Selisih tidak disimpan: dihitung ulang dari transaksi saat dibaca.
create table balance_check (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references account(id),
  user_id     uuid not null references app_user(id),
  check_date  date not null,
  actual      numeric(14,2) not null check (actual >= 0),
  created_at  timestamptz not null default now()
);
create index balance_check_account_idx on balance_check (account_id, created_at);

-- Transaksi penyeimbang ("catat selisih") tertaut ke cek yang menjadi sebabnya, supaya tidak
-- dihitung dua kali pada cek berikutnya.
alter table trx add column balance_check_id uuid references balance_check(id);
create index trx_balance_check_idx on trx (balance_check_id) where balance_check_id is not null;

-- Jarak pengingat cek saldo dalam hari; null = pengingat mati.
alter table household add column balance_check_days int check (balance_check_days between 1 and 90) default 7;
