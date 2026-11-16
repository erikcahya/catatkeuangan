-- Data awal. Nama pengguna dan rekening adalah penampung, ganti sesuai kenyataan.
-- Kategori diambil dari catatan lama (Feb 2023 sampai 14 Jun 2025).

do $$
declare h uuid;
begin
  insert into household (name) values ('Rumah tangga') returning id into h;

  insert into app_user (household_id, name, role, can_view_reports) values
    (h, 'Erik',  'suami', true),
    (h, 'Istri', 'istri', true),
    (h, 'Anak',  'anak',  false);

  insert into account (household_id, name, kind, is_emergency, monthly_target) values
    (h, 'Rek. utama',        'bank',  false, null),
    (h, 'Rekening darurat',  'bank',  true,  10000000),
    (h, 'Kripto',            'asset', false, null),
    (h, 'Saham',             'asset', false, null),
    (h, 'Emas',              'asset', false, null);

  insert into category (household_id, name, kind, counts_as_bill) values
    (h, 'Transportasi',        'expense', false),
    (h, 'Tagihan',             'expense', true),
    (h, 'Makan dan Minum',     'expense', false),
    (h, 'Belanja',             'expense', false),
    (h, 'Keluarga dan Teman',  'expense', false),
    (h, 'Kesehatan',           'expense', false),
    (h, 'Hiburan',             'expense', false),
    (h, 'Peliharaan',          'expense', false),
    (h, 'Teknologi',           'expense', false),
    (h, 'Pakaian',             'expense', false),
    (h, 'Donasi',              'expense', false),
    (h, 'Investasi',           'expense', false),  -- keputusan masih terbuka, lihat SPEC.md
    (h, 'Lainnya',             'expense', false),
    (h, 'Bensin',              'expense', false),
    (h, 'Kecantikan',          'expense', false),
    (h, 'Bahan Makanan',       'expense', false),
    (h, 'Liburan',             'expense', false),
    (h, 'Edukasi',             'expense', false),
    (h, 'Olahraga',            'expense', false),
    (h, 'Gaji',                'income',  false),
    (h, 'Pemasukan Lainnya',   'income',  false),
    (h, 'Hasil Investasi',     'income',  false),
    (h, 'Bonus',               'income',  false);

  insert into daily_budget (household_id, category_id, day_type, limit_amount)
  select h, id, 'weekday', 300000 from category where household_id = h and name = 'Makan dan Minum';
  insert into daily_budget (household_id, category_id, day_type, limit_amount)
  select h, id, 'weekend', 200000 from category where household_id = h and name = 'Makan dan Minum';
end $$;
