-- Skema PostgreSQL untuk aplikasi pencatatan keuangan rumah tangga.
-- Sumber: ERD v3. Jalankan sekali pada database kosong.
-- Catatan: tabel transaksi bernama "trx" karena "transaction" adalah kata kunci SQL.

create extension if not exists pgcrypto;

create table household (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  payday_dom  int  not null default 25 check (payday_dom between 1 and 28)
);

create table app_user (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references household(id),
  name              text not null,
  role              text not null check (role in ('suami','istri','anak')),
  can_view_reports  boolean not null default true,
  email             text unique  -- metode login belum diputuskan, lihat SPEC.md
);

create table account (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id),
  name            text not null,
  kind            text not null check (kind in ('bank','ewallet','cash','asset')),
  is_emergency    boolean not null default false,
  monthly_target  numeric(14,2),
  unique (household_id, name)
);
-- Satu rekening darurat per rumah tangga.
create unique index account_one_emergency
  on account (household_id) where is_emergency;

create table category (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id),
  parent_id       uuid references category(id),
  name            text not null,
  kind            text not null check (kind in ('expense','income')),
  counts_as_bill  boolean not null default false,
  unique (household_id, name)
);

create table pay_cycle (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id),
  start_date    date not null,
  end_date      date not null,
  label         text not null,
  check (end_date > start_date),
  unique (household_id, start_date)
);

create table trx (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references account(id),
  to_account_id  uuid references account(id),
  category_id    uuid references category(id),
  cycle_id       uuid not null references pay_cycle(id),
  user_id        uuid not null references app_user(id),   -- pencatat awal
  updated_by     uuid references app_user(id),            -- pengubah terakhir
  trx_date       date not null,
  kind           text not null check (kind in ('income','expense','transfer')),
  amount         numeric(14,2) not null check (amount > 0),
  note           text,
  is_one_off     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  deleted_at     timestamptz,                             -- hapus lunak
  -- Transfer wajib punya rekening tujuan yang berbeda dan tanpa kategori.
  -- Pemasukan dan pengeluaran wajib berkategori dan tanpa rekening tujuan.
  check (
    (kind = 'transfer' and to_account_id is not null
       and to_account_id <> account_id and category_id is null)
    or
    (kind <> 'transfer' and to_account_id is null and category_id is not null)
  )
);
create index trx_cycle_idx   on trx (cycle_id)   where deleted_at is null;
create index trx_date_idx    on trx (trx_date)   where deleted_at is null;
create index trx_account_idx on trx (account_id) where deleted_at is null;

create table budget (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid not null references pay_cycle(id),
  category_id   uuid not null references category(id),
  limit_amount  numeric(14,2) not null check (limit_amount >= 0),
  unique (cycle_id, category_id)
);

create table daily_budget (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id),
  category_id   uuid not null references category(id),
  day_type      text not null check (day_type in ('weekday','weekend')),
  limit_amount  numeric(14,2) not null check (limit_amount >= 0),
  unique (household_id, category_id, day_type)
);

-- Penarikan dari rekening darurat dicatat sebagai utang ke rekening sendiri,
-- lalu dilunasi saat gajian lewat transaksi transfer.
create table emergency_debt (
  id                uuid primary key default gen_random_uuid(),
  withdrawal_trx_id uuid not null unique references trx(id),
  repayment_trx_id  uuid references trx(id),
  amount            numeric(14,2) not null check (amount > 0),
  status            text not null default 'open' check (status in ('open','paid')),
  check ((status = 'paid') = (repayment_trx_id is not null))
);

create table recurring_bill (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references household(id),
  category_id        uuid not null references category(id),
  account_id         uuid not null references account(id),
  name               text not null,
  default_amount     numeric(14,2) not null check (default_amount >= 0),
  is_variable        boolean not null default false,
  due_dom            int not null check (due_dom between 1 and 31),
  remind_days_before int not null default 3,
  is_active          boolean not null default true
);

create table bill_occurrence (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references recurring_bill(id),
  cycle_id         uuid not null references pay_cycle(id),
  transaction_id   uuid unique references trx(id),
  due_date         date not null,
  expected_amount  numeric(14,2) not null check (expected_amount >= 0),
  status           text not null default 'pending' check (status in ('pending','paid','skipped')),
  unique (bill_id, cycle_id)
);

create table savings_holding (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references account(id),
  asset_type       text not null check (asset_type in ('kripto','saham','emas','lainnya')),
  name             text not null,
  invested_amount  numeric(14,2) not null default 0,
  current_value    numeric(14,2),            -- diisi manual, boleh kosong
  as_of_date       date
);

-- Awal siklus gajian untuk sebuah tanggal. Contoh: payday 25, tanggal 16 Des -> 25 Nov.
create function cycle_start(d date, payday int default 25) returns date
language sql immutable as $$
  select case
    when extract(day from d) >= payday
      then make_date(extract(year from d)::int, extract(month from d)::int, payday)
    else (make_date(extract(year from d)::int, extract(month from d)::int, payday)
          - interval '1 month')::date
  end
$$;
