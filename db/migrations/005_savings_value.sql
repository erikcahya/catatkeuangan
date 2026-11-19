-- Nilai sekarang aset diisi manual, satu baris per rekening aset.
-- Total setoran tidak disimpan: dihitung dari transfer ke/dari rekening aset
-- (kolom invested_amount dibiarkan, tidak dipakai aplikasi).
create unique index savings_holding_account on savings_holding (account_id);
