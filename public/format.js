// Helper tampilan. Dipakai di browser dan dites dari Node.

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** 520000 -> "Rp 520.000" */
export function rupiah(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  return `Rp ${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** "Rp 520.000" / "520.000" / "520000" -> 520000; kosong -> 0 */
export function parseRupiah(s) {
  const digits = String(s ?? '').replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

/** "2026-12-16" -> "16 Des 2026" */
export function tanggal(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${BULAN[m - 1]} ${y}`;
}

/** Escape teks untuk disisipkan ke HTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/** "2026-12-22" -> "22 Des" */
export function tanggalPendek(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${d} ${BULAN[m - 1]}`;
}

/** Selisih hari b - a untuk tanggal 'YYYY-MM-DD'. */
export function selisihHari(a, b) {
  const t = (s) => Date.UTC(...s.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}
