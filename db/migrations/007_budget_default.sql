-- Anggaran standar per kategori (per siklus gajian). Berlaku untuk semua siklus; baris di tabel
-- budget (per siklus) bila ada menimpa anggaran standar untuk siklus itu.
create table budget_default (
  household_id  uuid not null references household(id),
  category_id   uuid not null references category(id),
  limit_amount  numeric(14,2) not null check (limit_amount >= 0),
  primary key (household_id, category_id)
);
