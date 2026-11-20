"""Ubah laporan keuangan lama (xlsx) menjadi CSV untuk scripts/import-old.js.

Pemakaian:  python -I scripts/xlsx-to-csv.py <berkas.xlsx> <keluaran.csv>

Kolom keluaran: tanggal (YYYY-MM-DD), kategori, keterangan, sumber, jumlah (bertanda).
Jumlah per kategori dicocokkan dengan lembar "Ringkasan Keuangan"; selisih dilaporkan
dan membuat skrip keluar dengan kode 1.
"""
import csv
import sys
from collections import defaultdict

import openpyxl

if len(sys.argv) != 3:
    sys.exit(__doc__)
src, dst = sys.argv[1], sys.argv[2]

wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
rows = []
for i, r in enumerate(wb['Laporan Keuangan'].iter_rows(values_only=True)):
    if i < 3 or not r[0]:  # 3 baris pertama: judul dan header
        continue
    d, kategori, ket, sumber, jumlah = r[:5]
    dd, mm, yyyy = str(d).split('-')
    if not isinstance(jumlah, (int, float)) or jumlah != int(jumlah) or jumlah == 0:
        sys.exit(f'Jumlah tidak valid di baris {i + 1}: {jumlah!r}')
    rows.append((f'{yyyy}-{mm}-{dd}', kategori, (ket or '').strip(), (sumber or '').strip(), int(jumlah)))

with open(dst, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['tanggal', 'kategori', 'keterangan', 'sumber', 'jumlah'])
    w.writerows(rows)

# Cocokkan dengan lembar ringkasan.
expected = {}
for r in wb['Ringkasan Keuangan'].iter_rows(values_only=True):
    if r[0] and isinstance(r[1], (int, float)) and r[0] not in ('Kategori',):
        expected[r[0]] = int(r[1])
actual = defaultdict(int)
for _, kategori, _, _, jumlah in rows:
    actual[kategori] += jumlah

bad = [(k, expected.get(k), actual.get(k)) for k in sorted(set(expected) | set(actual)) if expected.get(k) != actual.get(k)]
print(f'{len(rows)} baris ditulis ke {dst}')
print(f'{len(expected)} kategori di ringkasan, {len(actual)} kategori di data')
if bad:
    for k, e, a in bad:
        print(f'  SELISIH {k}: ringkasan={e} data={a}')
    sys.exit(1)
print('Jumlah per kategori cocok dengan lembar Ringkasan.')
