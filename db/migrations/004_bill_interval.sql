-- Tagihan dengan jadwal "tiap N hari sejak pembayaran terakhir" (mis. wifi tiap 28 hari).
-- Tagihan bulanan tetap memakai due_dom; tagihan berinterval memakai interval_days + anchor_date
-- (tanggal pembayaran terakhir sebelum dicatat di aplikasi).

alter table recurring_bill alter column due_dom drop not null;
alter table recurring_bill add column interval_days int check (interval_days between 7 and 366);
alter table recurring_bill add column anchor_date date;
alter table recurring_bill add constraint recurring_bill_one_schedule
  check ((due_dom is null) <> (interval_days is null));
alter table recurring_bill add constraint recurring_bill_interval_anchor
  check ((interval_days is null) = (anchor_date is null));

-- Satu siklus bisa memuat dua jatuh tempo tagihan 28 hari, jadi keunikan pindah ke tanggal jatuh tempo.
alter table bill_occurrence drop constraint bill_occurrence_bill_id_cycle_id_key;
create unique index bill_occurrence_bill_due on bill_occurrence (bill_id, due_date);
create index bill_occurrence_pending on bill_occurrence (bill_id) where status = 'pending';
