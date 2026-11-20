// Aturan impor catatan lama (kolom: tanggal, kategori, keterangan, sumber, jumlah bertanda).
// Murni tanpa database: menghasilkan rencana yang lalu ditulis oleh scripts/import-old.js.
// Aturan mengikuti SPEC.md bagian "Impor catatan lama".

import { cycleStart, salaryCycleStart } from './dates.js';

const SALARY_CATEGORY = 'Gaji';
const OWN_SAVINGS = /\b(octo|permata|tabungan)\b/;
const BIG_AMOUNT = 20_000_000;
const ONE_OFF_CANDIDATE = 5_000_000;

/** Baca CSV (mendukung tanda kutip ganda dan koma di dalam kolom). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  for (const k of ['tanggal', 'kategori', 'keterangan', 'sumber', 'jumlah']) {
    if (!(k in col)) throw new Error(`Kolom "${k}" tidak ada di CSV`);
  }
  return body.map((r, i) => {
    const amount = Number(r[col.jumlah]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r[col.tanggal]) || !Number.isInteger(amount) || amount === 0) {
      throw new Error(`Baris ${i + 2} tidak valid: ${JSON.stringify(r)}`);
    }
    return { line: i + 2, date: r[col.tanggal], category: r[col.kategori], note: r[col.keterangan] ?? '', source: r[col.sumber], amount };
  });
}

/**
 * Jenis baris:
 *  - 'tarik'  : pemasukan "utang/pinjam octo|permata|tabungan" = uang diambil dari rekening darurat
 *  - 'lunas'  : pengeluaran Tagihan "bayar/ganti utang octo|permata|iin|tabungan" = pelunasan ke rekening darurat
 *  - 'income' / 'expense' : sisanya, menurut tanda jumlah
 * Entri utang di catatan lama hanya pelunasan ke tabungan sendiri (SPEC), jadi pola di atas
 * dibuat sempit; yang mirip tapi tidak cocok masuk laporan tinjauan.
 */
export function classify(row) {
  const note = row.note.toLowerCase().trim();
  if (row.amount > 0 && row.category === 'Pemasukan Lainnya'
      && /^(utang|hutang|pinjam|pinjem)\b/.test(note) && OWN_SAVINGS.test(note)) return 'tarik';
  if (row.amount < 0 && row.category === 'Tagihan'
      && (/^(bayar|ganti)\s+h?utang\s+(octo|permata|iin)\b/.test(note) || /^(bayar|ganti)\s+h?utang\s+tabungan\b/.test(note))) return 'lunas';
  return row.amount > 0 ? 'income' : 'expense';
}

/** Alasan sebuah baris perlu ditinjau manusia. Baris tidak diubah diam-diam. */
export function reviewReasons(row, type) {
  const note = row.note.toLowerCase();
  const out = [];
  const amount = Math.abs(row.amount);

  if (type === 'income' || type === 'expense') {
    if (/\b(h?utang|pinjam|pinjem|diutangi|pinjami)\b/.test(note)) {
      // Belanja yang dibayar dari tabungan sendiri ("tomoro utang octo") adalah pengeluaran biasa.
      const fromOwn = type === 'expense' && row.category !== 'Tagihan' && OWN_SAVINGS.test(note);
      if (!fromOwn) out.push('Kemungkinan utang/pinjaman yang tidak dikenali sebagai pelunasan ke tabungan sendiri');
    }
    if (/nabung|bibit|reksa|saham|crypto|kripto|\bemas\b|pasar uang|\btko\b|tokocrypto|usdt|\btarik\b|\bwd\b|swiss/.test(note)) {
      out.push('Kemungkinan tabungan/investasi (setoran atau penarikan aset)');
    }
    if (/^(Hasil Investasi|Investasi)$/.test(row.category)) {
      out.push('Kategori investasi: penarikan modal atau untung? Keputusan kategori Investasi di SPEC');
    }
    if (row.category === 'Makan dan Minum' && /kuota|paket data|pulsa|listrik|bensin|grab|laundry|obat|dokter|tiket/.test(note)) {
      out.push('Kategori mungkin salah (keterangan bukan makanan)');
    }
    if (amount >= BIG_AMOUNT && row.category !== SALARY_CATEGORY) out.push('Nominal besar (≥ Rp20 juta)');
  }
  return out;
}

/**
 * Pasangkan penarikan dan pelunasan menjadi emergency_debt.
 * FIFO: pelunasan melunasi utang terlama dulu. Sisa pelunasan yang melebihi utang terbuka
 * disimpan sebagai kredit dan dipakai menutup penarikan berikutnya, jadi sisa utang akhir
 * = total penarikan - total pelunasan. Satu utang yang baru lunas sebagian tetap terbuka
 * dengan jumlah sisanya.
 * @param events [{ idx, date, type: 'tarik'|'lunas', amount }]
 */
export function planEmergency(events) {
  // Tanggal sama: penarikan dulu, supaya pelunasan di hari gajian menutup utang yang baru dicatat.
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : a.type === b.type ? a.idx - b.idx : a.type === 'tarik' ? -1 : 1));
  const debts = [];
  const credit = []; // [{ repayIdx, remaining }]
  const surplus = []; // pelunasan yang melebihi utang terbuka

  const settle = (debt, take, repayIdx) => {
    debt.remaining -= take;
    debt.repayIdx = repayIdx;
    if (debt.remaining === 0) debt.status = 'paid';
  };

  for (const e of sorted) {
    if (e.type === 'tarik') {
      const d = { tarikIdx: e.idx, date: e.date, amount: e.amount, remaining: e.amount, status: 'open', repayIdx: null };
      debts.push(d);
      while (d.remaining > 0 && credit.length) {
        const c = credit[0];
        const take = Math.min(c.remaining, d.remaining);
        c.remaining -= take;
        settle(d, take, c.repayIdx);
        if (c.remaining === 0) credit.shift();
      }
    } else {
      let left = e.amount;
      for (const d of debts) {
        if (!left) break;
        if (d.status !== 'open') continue;
        const take = Math.min(left, d.remaining);
        left -= take;
        settle(d, take, e.idx);
      }
      if (left > 0) {
        credit.push({ repayIdx: e.idx, remaining: left });
        surplus.push({ idx: e.idx, date: e.date, amount: left });
      }
    }
  }
  return {
    debts: debts.map((d) => ({
      tarikIdx: d.tarikIdx, date: d.date, status: d.status, repayIdx: d.status === 'paid' ? d.repayIdx : null,
      amount: d.status === 'paid' ? d.amount : d.remaining,
    })),
    surplus,
    openTotal: debts.reduce((s, d) => s + (d.status === 'open' ? d.remaining : 0), 0),
    creditLeft: credit.reduce((s, c) => s + c.remaining, 0),
  };
}

/**
 * Susun rencana impor dari baris CSV.
 * Akun: 'main' (satu-satunya sumber di catatan lama adalah "kas") dan 'emergency'.
 */
export function buildPlan(rows, { payday = 25 } = {}) {
  const trx = [];
  const review = [];
  const events = [];
  const info = { fromSavingsExpense: 0 };

  rows.forEach((row, idx) => {
    const type = classify(row);
    const amount = Math.abs(row.amount);
    const start = type === 'income' && row.category === SALARY_CATEGORY
      ? salaryCycleStart(row.date, payday) : cycleStart(row.date, payday);
    const base = { idx, line: row.line, date: row.date, amount, note: row.note || null, cycleStart: start, isOneOff: false };

    if (type === 'tarik') trx.push({ ...base, kind: 'transfer', from: 'emergency', to: 'main', category: null });
    else if (type === 'lunas') trx.push({ ...base, kind: 'transfer', from: 'main', to: 'emergency', category: null });
    else trx.push({ ...base, kind: type, from: 'main', to: null, category: row.category });

    if (type === 'tarik' || type === 'lunas') events.push({ idx, date: row.date, type, amount });

    const reasons = reviewReasons(row, type);
    if (type === 'expense' && amount >= ONE_OFF_CANDIDATE && !/^(Tagihan)$/.test(row.category)) {
      reasons.push('Kandidat pengeluaran sekali bayar (≥ Rp5 juta): tandai manual bila benar');
    }
    if (/\b(h?utang|pinjam|pinjem)\b/.test(row.note.toLowerCase()) && type === 'expense'
        && row.category !== 'Tagihan' && OWN_SAVINGS.test(row.note.toLowerCase())) info.fromSavingsExpense++;
    if (reasons.length) review.push({ idx, line: row.line, date: row.date, category: row.category, note: row.note, amount: row.amount, reasons });
  });

  const emergency = planEmergency(events);
  return { trx, debts: emergency.debts, review, emergency, info };
}
