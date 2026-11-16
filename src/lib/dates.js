// Logika tanggal murni (tanpa database). Semua tanggal berbentuk string 'YYYY-MM-DD'
// dan dihitung di UTC supaya tidak bergeser karena zona waktu server.

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAY_MS = 86_400_000;

function parse(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`tanggal tidak valid: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) throw new Error(`tanggal tidak valid: ${s}`);
  return dt;
}

function fmt(dt) {
  return dt.toISOString().slice(0, 10);
}

function ymd(y, m0, d) {
  // m0 boleh di luar 0..11; Date.UTC menormalkan tahunnya.
  return fmt(new Date(Date.UTC(y, m0, d)));
}

/** Awal siklus gajian yang memuat tanggal s. Sama dengan fungsi SQL cycle_start. */
export function cycleStart(s, payday = 25) {
  const dt = parse(s);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  return dt.getUTCDate() >= payday ? ymd(y, m, payday) : ymd(y, m - 1, payday);
}

/** Akhir siklus: sehari sebelum gajian bulan berikutnya. */
export function cycleEnd(start) {
  const dt = parse(start);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate() - 1);
}

/** Label seperti "25 Nov – 24 Des 2026". */
export function cycleLabel(start) {
  const a = parse(start);
  const b = parse(cycleEnd(start));
  return `${a.getUTCDate()} ${BULAN[a.getUTCMonth()]} – ${b.getUTCDate()} ${BULAN[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

/**
 * Siklus untuk transaksi Gaji: gaji masuk siklus bulan gajiannya walau cair
 * tidak tepat tanggal gajian. Dipilih tanggal gajian terdekat; bila sama jauh,
 * dipilih yang lebih awal.
 * Contoh (payday 25): 24 Agu -> 25 Agu, 4 Okt -> 25 Sep.
 */
export function salaryCycleStart(s, payday = 25) {
  const prev = cycleStart(s, payday);
  const p = parse(prev);
  const next = ymd(p.getUTCFullYear(), p.getUTCMonth() + 1, payday);
  const t = parse(s).getTime();
  return (parse(next).getTime() - t) < (t - p.getTime()) ? next : prev;
}

/** 'weekday' (Senin–Jumat) atau 'weekend'. */
export function dayType(s) {
  const dow = parse(s).getUTCDay();
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}

/** Tanggal hari ini di Asia/Jakarta. */
export function todayJakarta(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Selisih hari b - a. */
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / DAY_MS);
}

export function isValidDate(s) {
  try { parse(s); return true; } catch { return false; }
}

/**
 * Tanggal jatuh tempo tagihan di dalam siklus yang mulai pada `start`.
 * Tanggal >= gajian jatuh di bulan awal siklus, sisanya di bulan berikutnya.
 * Tanggal yang tidak ada di bulan itu (mis. 31 Nov) dimundurkan ke akhir bulan.
 * Contoh (payday 25, siklus 25 Nov–24 Des): due 22 -> 22 Des, due 28 -> 28 Nov, due 31 -> 30 Nov.
 */
export function billDueDate(start, dueDom, payday = 25) {
  const s = parse(start);
  const y = s.getUTCFullYear();
  const m = dueDom >= payday ? s.getUTCMonth() : s.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymd(y, m, Math.min(dueDom, lastDay));
}
