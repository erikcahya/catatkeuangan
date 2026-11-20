// Ikon kategori dan rekening: gambar garis sederhana (SVG inline), warna dari kelas .t-<tema> di styles.css.
// Tidak ada berkas gambar; semuanya diturunkan dari nama, jadi kategori baru tinggal memakai ikon cadangan.
import { esc } from './format.js';

const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const PATHS = {
  food: '<path d="M6 3v6a3 3 0 0 0 6 0V3"/><path d="M9 12v9"/><path d="M17 21V3c-2.2 1.2-3.5 3.8-3.5 6.5 0 1.7.8 2.5 2 2.5H17"/>',
  basket: '<path d="M3.5 9h17l-1.7 10a2 2 0 0 1-2 1.7H7.2a2 2 0 0 1-2-1.7L3.5 9z"/><path d="M8 9l3-5"/><path d="M16 9l-3-5"/>',
  bag: '<path d="M5 8h14l-1 12.2H6L5 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  fuel: '<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 21h12"/><path d="M8 8h4"/><path d="M15 10h2a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  bus: '<rect x="4" y="4" width="16" height="14" rx="2"/><path d="M4 11h16"/><path d="M7 18v2.5"/><path d="M17 18v2.5"/><path d="M8 14.5h.01"/><path d="M16 14.5h.01"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6"/><path d="M9 12h6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.3"/><path d="M16.5 14.2c2.8.3 4.5 2.4 4.5 5.8"/>',
  heart: '<path d="M12 20.5s-8-4.9-8-10.6A4.5 4.5 0 0 1 12 7.2a4.5 4.5 0 0 1 8 2.7c0 5.7-8 10.6-8 10.6z"/><path d="M12 10v5"/><path d="M9.5 12.5h5"/>',
  game: '<path d="M6.5 8h11A4.5 4.5 0 0 1 22 12.5v.5a3 3 0 0 1-5.3 1.9L15.5 13.5h-7l-1.2 1.4A3 3 0 0 1 2 13v-.5A4.5 4.5 0 0 1 6.5 8z"/><path d="M8 10.5v3"/><path d="M6.5 12h3"/><path d="M16 11h.01"/><path d="M18 13h.01"/>',
  paw: '<circle cx="7" cy="10" r="1.7"/><circle cx="12" cy="7" r="1.7"/><circle cx="17" cy="10" r="1.7"/><path d="M7.5 17c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5c0 1.8-1.5 2.5-3 2.5-1 0-1.2-.5-1.5-.5s-.5.5-1.5.5c-1.5 0-3-.7-3-2.5z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  shirt: '<path d="M8 3 3 6l2 4 3-1v12h8V9l3 1 2-4-5-3a4 4 0 0 1-8 0z"/>',
  gift: '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M12 9v12"/><path d="M3 13.5h18"/><path d="M12 9c-1.5-3.5-5.5-3-4.5-.2.5 1.2 2.5 1.2 4.5.2z"/><path d="M12 9c1.5-3.5 5.5-3 4.5-.2-.5 1.2-2.5 1.2-4.5.2z"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  dots: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  sparkle: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9L11 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  plane: '<path d="M21 3 3 10.5l6.5 2.5L12 20l3-6.5L21 3z"/><path d="M9.5 13 21 3"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5L2 9z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9v6"/>',
  dumbbell: '<path d="M3 9v6"/><path d="M6 7v10"/><path d="M18 7v10"/><path d="M21 9v6"/><path d="M6 12h12"/>',
  banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5h.01"/><path d="M18 14.5h.01"/>',
  inbox: '<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M4 20h16"/>',
  bars: '<path d="M4 20h16"/><path d="M7 20v-7"/><path d="M12 20V6"/><path d="M17 20v-10"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.3l6.1-.7L12 3z"/>',
  tag: '<path d="M3 12V4h8l9.5 9.5a1.5 1.5 0 0 1 0 2.1l-5.4 5.4a1.5 1.5 0 0 1-2.1 0L3 12z"/><path d="M7.5 8.5h.01"/>',
  bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8"/><path d="M9.5 10v8"/><path d="M14.5 10v8"/><path d="M19 10v8"/><path d="M3 20.5h18"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  wallet: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H17v4"/><path d="M3 7.5V18a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5.5A2.5 2.5 0 0 1 3 7.5z"/><path d="M16 14.5h.01"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8h3.2a2 2 0 0 1 0 4H9.5h3.7a2 2 0 0 1 0 4H9.5"/><path d="M9.5 8v8"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 15l3-4 3 2.5 5-6"/>',
  gold: '<path d="M3 18.5l2-6h6l2 6H3z"/><path d="M11 18.5l2-6h6l2 6H11z"/><path d="M7.5 12.5l1.5-5h5l1.5 5"/>',
  swap: '<path d="M7 8h13l-3-3"/><path d="M17 16H4l3 3"/>',
};

// nama kategori (huruf kecil) -> [ikon, tema, kata kunci pencarian]
const CATEGORY = {
  'makan dan minum': ['food', 'orange', ['makan', 'minum', 'kopi', 'jajan', 'restoran', 'warung', 'kantin', 'sarapan', 'bakso', 'es']],
  'bahan makanan': ['basket', 'orange', ['sayur', 'daging', 'pasar', 'supermarket', 'beras']],
  belanja: ['bag', 'pink', ['toko', 'online', 'marketplace', 'shopee', 'tokopedia', 'indomaret', 'alfamart']],
  bensin: ['fuel', 'blue', ['pertamax', 'pertalite', 'solar', 'bbm', 'spbu']],
  transportasi: ['bus', 'blue', ['grab', 'gojek', 'ojek', 'parkir', 'tol', 'kereta', 'taksi', 'tiket', 'bus']],
  tagihan: ['receipt', 'amber', ['listrik', 'air', 'wifi', 'internet', 'pulsa', 'kuota', 'langganan', 'kontrakan', 'kos', 'cicilan']],
  'keluarga dan teman': ['people', 'red', ['orangtua', 'ortu', 'mamah', 'papah', 'traktir', 'hadiah', 'kado']],
  kesehatan: ['heart', 'red', ['dokter', 'obat', 'apotek', 'rumah sakit', 'klinik']],
  hiburan: ['game', 'violet', ['bioskop', 'game', 'film', 'musik', 'konser']],
  peliharaan: ['paw', 'green', ['kucing', 'anjing', 'pakan']],
  teknologi: ['phone', 'slate', ['hp', 'laptop', 'gadget', 'aplikasi']],
  pakaian: ['shirt', 'pink', ['baju', 'celana', 'sepatu', 'laundry']],
  donasi: ['gift', 'green', ['infaq', 'sedekah', 'zakat', 'sumbangan']],
  investasi: ['trend', 'green', ['saham', 'reksa', 'emas', 'kripto']],
  lainnya: ['dots', 'gray', []],
  kecantikan: ['sparkle', 'pink', ['skincare', 'salon', 'makeup', 'sunscreen']],
  liburan: ['plane', 'violet', ['hotel', 'wisata', 'tiket pesawat']],
  edukasi: ['cap', 'green', ['sekolah', 'kursus', 'buku', 'les']],
  olahraga: ['dumbbell', 'green', ['gym', 'futsal', 'lari']],
  gaji: ['banknote', 'green', ['gajian', 'salary']],
  'pemasukan lainnya': ['inbox', 'green', ['reimburse', 'refund', 'hadiah']],
  'hasil investasi': ['bars', 'green', ['untung', 'profit', 'dividen']],
  bonus: ['star', 'green', ['thr', 'tunjangan']],
};

const key = (name) => String(name ?? '').trim().toLowerCase();
const badge = (iconName, theme, size = 'md') =>
  `<span class="ico ico-${size} t-${theme}" aria-hidden="true">${svg(PATHS[iconName] ?? PATHS.tag)}</span>`;

/** Apakah kategori ini punya ikon sendiri (bukan ikon cadangan)? */
export const hasCategoryIcon = (name) => key(name) in CATEGORY;

export function categoryBadge(name, size = 'md') {
  const [icon, theme] = CATEGORY[key(name)] ?? ['tag', 'gray'];
  return badge(icon, theme, size);
}

/** Kata kunci tambahan untuk pencarian kategori ("kopi" menemukan Makan dan Minum). */
export const categoryKeywords = (name) => CATEGORY[key(name)]?.[2] ?? [];

const KIND_LABEL = { bank: 'Rekening bank', ewallet: 'Dompet digital', cash: 'Uang tunai', asset: 'Tabungan dan investasi' };

function accountVisual(name, kind, emergency) {
  const n = key(name);
  if (emergency || /darurat/.test(n)) return ['shield', 'amber'];
  if (/kripto|crypto|bitcoin/.test(n)) return ['coin', 'violet'];
  if (/saham/.test(n)) return ['chart', 'blue'];
  if (/emas/.test(n)) return ['gold', 'amber'];
  if (kind === 'asset') return ['coin', 'violet'];
  if (kind === 'ewallet' || kind === 'cash') return ['wallet', 'orange'];
  return ['bank', 'green'];
}

export function accountBadge(name, { kind = 'bank', emergency = false } = {}, size = 'md') {
  const [icon, theme] = accountVisual(name, kind, emergency);
  return badge(icon, theme, size);
}

export const accountSubtitle = (kind, emergency = false) => (emergency ? 'Rekening darurat' : (KIND_LABEL[kind] ?? ''));

/** Ikon untuk transfer antar rekening. */
export const transferBadge = (size = 'md') => badge('swap', 'slate', size);

/** Ikon bulat bergambar tanda panah dsb. untuk dipakai di tempat lain bila perlu. */
export const iconSvg = (name) => svg(PATHS[name] ?? PATHS.tag);
export const escHtml = esc;
