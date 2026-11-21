-- Nilai aset bisa dihitung otomatis dari harga pasar: jumlah unit x harga per unit (Rupiah).
-- price_source: 'crypto' (kode koin), 'gold' (emas, per gram), 'fx' (kode mata uang, mis. CHF).
-- Bila price_source kosong, nilai sekarang tetap diisi manual seperti sebelumnya.
alter table savings_holding
  add column price_source text check (price_source in ('crypto','gold','fx')),
  add column symbol       text,
  add column quantity     numeric(24,10) check (quantity is null or quantity > 0),
  add column unit_price   numeric(24,6),
  add column price_at     timestamptz;
