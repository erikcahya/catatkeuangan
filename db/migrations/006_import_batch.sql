-- Penanda transaksi hasil impor catatan lama, supaya satu gelombang impor bisa dibatalkan utuh
-- (scripts/import-old.js --rollback). Transaksi biasa: import_batch kosong.
alter table trx add column import_batch text;
create index trx_import_batch_idx on trx (import_batch) where import_batch is not null;
