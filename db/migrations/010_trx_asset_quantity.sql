-- Tabung/Tarik pada aset yang mengikuti harga pasar boleh mencatat jumlah unit (gram, koin) yang dibeli/dijual.
-- Jumlah itu menambah/mengurangi savings_holding.quantity; disimpan di transaksi agar ubah/hapus bisa membatalkannya.
alter table trx add column asset_quantity numeric(24,10) check (asset_quantity is null or asset_quantity > 0);
-- Menjual semua unit menghasilkan jumlah 0 (tetap dilacak), jadi batas bawah jadi >= 0.
alter table savings_holding drop constraint savings_holding_quantity_check;
alter table savings_holding add constraint savings_holding_quantity_check check (quantity is null or quantity >= 0);
