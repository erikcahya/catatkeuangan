import {
  rupiah, rupiahSingkat, parseRupiah, tanggal, tanggalPendek, selisihHari, esc,
} from './format.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let meta = null; // { user, today, cycle, accounts, categories }

const ICON = {
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  filter: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    meta = null;
    location.hash = '#/login';
    throw new ApiError(401, data.error || 'Silakan login dulu.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Gagal (${res.status})`);
  return data;
}

async function loadMeta() {
  if (!meta) meta = await api('/api/meta');
  return meta;
}

// ---------- UI kecil ----------

let toastTimer;
function toast(msg, { warn = false } = {}) {
  toastEl.textContent = msg;
  toastEl.className = warn ? 'warn' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, warn ? 6000 : 3000);
}

function tabbar(active) {
  const link = (hash, label) =>
    `<a href="${hash}"${active === hash ? ' aria-current="page"' : ''}>${label}</a>`;
  // Darurat dan Laporan redup untuk anggota yang tidak boleh melihat laporan (anak).
  const reports = meta?.user.can_view_reports;
  return `<nav class="tabbar" aria-label="Navigasi utama">
    ${link('#/', 'Beranda')}
    ${link('#/transaksi', 'Transaksi')}
    <a class="fab" href="#/tambah" aria-label="Tambah transaksi">${ICON.plus}</a>
    ${reports ? link('#/darurat', 'Darurat') : '<span aria-disabled="true">Darurat</span>'}
    ${reports ? link('#/laporan', 'Laporan') : '<span aria-disabled="true">Laporan</span>'}
  </nav>`;
}

// ---------- Layar: login ----------

function renderLogin() {
  app.innerHTML = `<div class="screen"><form class="screen-body login" id="login-form" novalidate>
    <h1>Catat Keuangan</h1>
    <p class="eyebrow">Masuk dengan akun anggota keluarga.</p>
    <div id="login-err" class="error" hidden></div>
    <div class="card rows">
      <div class="field"><label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Kata sandi</label>
        <input id="password" type="password" autocomplete="current-password" required></div>
    </div>
    <button class="btn-primary" type="submit">Masuk</button>
  </form></div>`;
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-err');
  form.email.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    err.hidden = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      meta = null;
      location.hash = '#/';
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------- Layar 2: beranda ----------

let selectedCycle = null; // awal siklus yang dipilih; null = siklus berjalan

const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0);

function trxLine(t, { withDelete = true } = {}) {
  const sign = t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : '';
  // Transfer ke rekening aset ditampilkan sebagai "Tabung".
  const moveLabel = t.to_account_kind === 'asset' ? 'Tabung' : 'Transfer';
  const name = t.note || (t.kind === 'transfer' ? `${moveLabel} ke ${t.to_account_name}` : t.category_name);
  const where = t.kind === 'transfer'
    ? `${moveLabel} · ${t.account_name} → ${t.to_account_name}`
    : t.is_emergency_withdrawal ? `${t.category_name} · utang ke rekening darurat` : `${t.category_name} · ${t.account_name}`;
  return `<li class="trx-item">
    <div class="main">
      <span class="name">${esc(name)}</span>
      <span class="meta${t.is_emergency_withdrawal ? ' warn' : ''}">${esc(where)} · ${esc(tanggal(t.trx_date))} · oleh ${esc(t.recorded_by)}</span>
    </div>
    <div class="right">
      <span class="amt${t.kind === 'income' ? ' in' : ''}">${sign}${rupiah(t.amount)}</span>
      ${withDelete ? `<button class="del" data-del="${esc(t.id)}" aria-label="Hapus ${esc(name)}">${ICON.trash}</button>` : ''}
    </div>
  </li>`;
}

function cycleCard(s) {
  const { income, expense, remaining } = s.totals;
  const c = s.cycle;
  const when = c.status === 'current'
    ? (c.days_left === 0 ? 'hari terakhir' : `${c.days_left} hari lagi`)
    : c.status === 'past' ? 'siklus selesai' : 'siklus mendatang';
  const used = pct(expense, income);
  return `<section class="hero" aria-label="Sisa anggaran siklus">
      <span class="hero-label">Sisa anggaran siklus ini</span>
      <span class="hero-amount${remaining < 0 ? ' neg' : ''}">${remaining < 0 ? '−' : ''}${rupiah(remaining)}</span>
      <div class="hero-track" role="img" aria-label="Terpakai ${Math.round(used)} persen"><div style="width:${used}%"></div></div>
      <span class="hero-label">${income > 0
        ? `Terpakai ${rupiah(expense)} dari ${rupiah(income)} · ${when}`
        : `Belum ada pemasukan di siklus ini · ${when}`}</span>
    </section>
    <div class="tiles">
      <div class="tile"><span class="tile-label">Pemasukan</span><span class="tile-value in">${rupiah(income)}</span></div>
      <div class="tile"><span class="tile-label">Pengeluaran</span><span class="tile-value">${rupiah(expense)}</span></div>
    </div>`;
}

function dailyCard(d) {
  const over = d.over > 0;
  const okPart = over ? pct(d.limit, d.total) : pct(d.total, d.limit);
  const hari = d.day_type === 'weekend' ? 'Akhir pekan' : 'Hari kerja';
  return `<section class="card daily${over ? ' over' : ''}" aria-label="Budget ${esc(d.category_name)} hari ini">
    <div class="daily-head">
      <span class="daily-title">Budget makan hari ini</span>
      <span class="tile-label">${hari} · ${rupiah(d.limit)}</span>
    </div>
    <div class="daily-track" role="img" aria-label="${rupiah(d.total)} dari ${rupiah(d.limit)}">
      <div class="ok" style="width:${okPart}%"></div>
      ${over ? `<div class="bad" style="left:${okPart}%;width:${100 - okPart}%"></div><div class="mark" style="left:${okPart}%"></div>` : ''}
    </div>
    <div class="daily-foot">
      ${over
        ? `<span class="daily-warn">${ICON.warn} Melebihi ${rupiah(d.over)}</span>`
        : `<span class="tile-label">Sisa ${rupiah(d.limit - d.total)}</span>`}
      <span class="tile-label">Terpakai ${rupiah(d.total)}</span>
    </div>
  </section>`;
}

function emergencyCard(e) {
  return `<a class="card emergency-card" href="#/darurat">
    <div class="daily-head">
      <span class="daily-title">${esc(e.name)}</span>
      <span class="warn-text">${e.open_debt > 0 ? `Utang belum lunas ${rupiah(e.open_debt)}` : 'Tidak ada utang'}</span>
    </div>
    <div class="em-track"><div style="width:${pct(e.filled, e.target)}%"></div></div>
    <span class="tile-label">Terisi ${rupiah(e.filled)} dari target ${rupiah(e.target)}${e.open_debt > 0 ? ' · isi ulang saat gajian' : ''}</span>
  </a>`;
}

function billsAndSavings(s) {
  const b = s.bills;
  const billNote = b.count === 0 ? 'Belum diatur'
    : b.unpaid_count > 0 ? `${b.unpaid_count} belum dibayar` : 'Semua lunas';
  return `<div class="tiles">
    <a class="tile" href="#/tagihan">
      <span class="tile-label">Tagihan berulang</span>
      <span class="tile-value small">${rupiah(b.total)}</span>
      <span class="${b.unpaid_count > 0 ? 'warn-text' : 'tile-label'} tiny">${billNote}</span>
    </a>
    <a class="tile" href="#/tabungan">
      <span class="tile-label">Tabungan dan investasi</span>
      <span class="tile-value small">${rupiah(s.savings.deposited)}</span>
      <span class="in tiny">Disetor siklus ini</span>
    </a>
  </div>`;
}

/** Kartu yang bisa digeser ke samping, dengan titik penanda. Satu kartu = tanpa slider. */
function slider(cards) {
  if (cards.length === 0) return '';
  if (cards.length === 1) return cards[0];
  return `<section class="slider" aria-roledescription="carousel" aria-label="Budget makan dan rekening darurat">
    <div class="slider-track">
      ${cards.map((c, i) => `<div class="slide" aria-roledescription="slide" aria-label="${i + 1} dari ${cards.length}">${c}</div>`).join('')}
    </div>
    <div class="slider-dots">
      ${cards.map((_, i) => `<button type="button" data-slide="${i}" aria-label="Tampilkan kartu ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}></button>`).join('')}
    </div>
  </section>`;
}

function setupSliders(root) {
  root.querySelectorAll('.slider').forEach((el) => {
    const track = el.querySelector('.slider-track');
    const dots = [...el.querySelectorAll('[data-slide]')];
    const slides = [...track.children];
    dots.forEach((d) => d.addEventListener('click', () => {
      track.scrollTo({ left: slides[Number(d.dataset.slide)].offsetLeft - track.offsetLeft, behavior: 'smooth' });
    }));
    let raf = 0;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const i = Math.round(track.scrollLeft / track.clientWidth);
        dots.forEach((d, j) => (j === i ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current')));
      });
    }, { passive: true });
  });
}

async function renderHome() {
  const m = await loadMeta();
  const q = selectedCycle ? `?cycle=${selectedCycle}` : '';
  const [s, list] = await Promise.all([
    api(`/api/summary${q}`),
    api(`/api/trx?limit=10&cycle=${selectedCycle ?? m.cycle.start}`),
  ]);
  const items = list.items;

  const cyclePicker = s.restricted ? '' : `<label class="icon-btn picker" title="Ganti siklus">
      ${ICON.chevron}
      <select id="cycle-select" aria-label="Ganti siklus">
        ${s.cycles.map((c) => `<option value="${esc(c.start)}"${c.start === s.cycle.start ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select>
    </label>`;

  app.innerHTML = `<div class="screen">
    <div class="screen-body home">
      <div class="topbar">
        <div><div class="eyebrow">Siklus gajian</div><h1 class="title">${esc(s.cycle.label)}</h1></div>
        <div class="topbar-actions">
          <a class="avatar" href="#/anggota" aria-label="Anggota keluarga, login sebagai ${esc(m.user.name)}">${esc(m.user.name[0] ?? '?')}</a>
          ${cyclePicker}
        </div>
      </div>
      ${s.restricted ? '' : cycleCard(s)}
      ${slider([
        ...(s.cycle.status === 'current' ? s.daily_budgets.map(dailyCard) : []),
        ...(s.restricted || !s.emergency ? [] : [emergencyCard(s.emergency)]),
      ])}
      ${s.restricted ? '' : billsAndSavings(s)}
      <div class="section-head"><h2>Transaksi terbaru</h2><a class="see-all" href="#/transaksi">Lihat semua</a></div>
      ${items.length
        ? `<ul class="trx-list">${items.map((t) => trxLine(t)).join('')}</ul>`
        : '<p class="empty">Belum ada transaksi di siklus ini. Tekan + untuk mencatat.</p>'}
    </div>
    ${tabbar('#/')}
  </div>`;

  setupSliders(app);
  document.getElementById('cycle-select')?.addEventListener('change', (e) => {
    selectedCycle = e.target.value === m.cycle.start ? null : e.target.value;
    renderHome();
  });
  app.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Hapus transaksi ini?')) return;
    try {
      await api(`/api/trx/${btn.dataset.del}`, { method: 'DELETE' });
      toast('Transaksi dihapus.');
      renderHome();
    } catch (ex) {
      toast(ex.message, { warn: true });
    }
  }));
}

// ---------- Layar 1: tambah transaksi ----------

// "Tabung" = transfer ke rekening aset (kripto, saham, emas). Di server tetap kind 'transfer'.
// Pilihan "Transfer" antar rekening biasa sengaja tidak ditampilkan (keputusan pemilik, 19 Nov 2026);
// transfer tetap dipakai di balik layar untuk Tabung, pelunasan darurat, dan impor.
const KIND_LABEL = { expense: 'Pengeluaran', income: 'Pemasukan', saving: 'Tabung' };

/**
 * @param preset  { kind, toAccountId, title, back } — dipakai mis. oleh tombol "Tabung"
 */
async function renderAdd(preset = {}) {
  const m = await loadMeta();
  const regular = m.accounts.filter((a) => !a.is_emergency);
  const emergency = m.accounts.find((a) => a.is_emergency);
  const assets = m.accounts.filter((a) => a.kind === 'asset');
  const nonAsset = m.accounts.filter((a) => a.kind !== 'asset');
  const kinds = Object.entries(KIND_LABEL).filter(([k]) => k !== 'saving' || assets.length);
  const state = { kind: preset.kind ?? 'expense' };
  const back = preset.back ?? '#/';

  const options = (list, selected) => list
    .map((x) => `<option value="${esc(x.id)}"${x.id === selected ? ' selected' : ''}>${esc(x.name)}</option>`)
    .join('');

  app.innerHTML = `<form class="screen" id="add-form" novalidate>
    <div class="screen-body">
      <div class="topbar">
        <h1 class="title">${esc(preset.title ?? 'Tambah transaksi')}</h1>
        <a class="icon-btn" href="${back}" aria-label="Tutup">${ICON.close}</a>
      </div>
      <div class="segmented${kinds.length === 2 ? ' two' : ''}" role="group" aria-label="Jenis transaksi">
        ${kinds.map(([k, label]) =>
          `<button type="button" data-kind="${k}" aria-pressed="${k === state.kind}">${label}</button>`).join('')}
      </div>
      <div id="add-err" class="error" hidden></div>
      <div class="card field amount">
        <label for="amount">Jumlah</label>
        <input id="amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="Rp 0" required>
      </div>
      <div class="card rows">
        <div class="row" id="row-category">
          <label for="category">Kategori</label>
          <select id="category" name="category"></select>
        </div>
        <div class="row" id="row-account">
          <label for="account" id="account-label">Dari rekening</label>
          <select id="account" name="account">${options(regular, regular[0]?.id)}</select>
        </div>
        <div class="row" id="row-emergency-account" hidden>
          <span class="label">Dari rekening</span>
          <span class="value">${esc(emergency?.name ?? '—')}</span>
        </div>
        <div class="row" id="row-to" hidden>
          <label for="to_account" id="to-label">Ke rekening</label>
          <select id="to_account" name="to_account">${options(m.accounts, preset.toAccountId ?? emergency?.id ?? m.accounts[1]?.id)}</select>
        </div>
        <div class="row">
          <label for="trx_date">Tanggal</label>
          <input id="trx_date" name="trx_date" type="date" value="${esc(m.today)}" required>
        </div>
        <div class="row">
          <span class="label">Dicatat oleh</span>
          <span class="value">${esc(m.user.name)}</span>
        </div>
      </div>
      <div class="card field">
        <label for="note">Catatan</label>
        <input id="note" name="note" maxlength="300" autocomplete="off" placeholder="Contoh: Listrik">
      </div>
      <div class="card rows" id="expense-toggles">
        <label class="row toggle">
          <span>Pengeluaran sekali bayar</span>
          <input type="checkbox" name="is_one_off">
        </label>
        ${emergency ? `<label class="row toggle emergency">
          <span class="text">
            <span>Ambil dari rekening darurat</span>
            <span class="hint">Dicatat sebagai utang, dilunasi saat gajian</span>
          </span>
          <input type="checkbox" name="from_emergency">
        </label>` : ''}
      </div>
    </div>
    <div class="footer"><button class="btn-primary" type="submit">Simpan transaksi</button></div>
  </form>`;

  const form = document.getElementById('add-form');
  const err = document.getElementById('add-err');
  const show = (id, on) => { document.getElementById(id).hidden = !on; };

  function sync() {
    const k = state.kind;
    form.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
    const cats = m.categories.filter((c) => c.kind === k);
    const prev = form.category.value;
    form.category.innerHTML = options(cats, cats.some((c) => c.id === prev) ? prev : cats[0]?.id);
    const fromEm = k === 'expense' && form.from_emergency?.checked;
    const moving = k === 'transfer' || k === 'saving';
    show('row-category', !moving);
    show('row-to', moving);
    show('expense-toggles', k === 'expense');
    show('row-account', !fromEm);
    show('row-emergency-account', fromEm);
    document.getElementById('account-label').textContent = k === 'income' ? 'Ke rekening' : 'Dari rekening';
    document.getElementById('to-label').textContent = k === 'saving' ? 'Ke tabungan' : 'Ke rekening';
    if (moving) {
      const toList = k === 'saving' ? assets : m.accounts;
      const prevTo = form.to_account.value;
      const fallback = k === 'saving' ? (preset.toAccountId ?? assets[0]?.id) : (emergency?.id ?? m.accounts[1]?.id);
      form.to_account.innerHTML = options(toList, toList.some((a) => a.id === prevTo) ? prevTo : fallback);
    }
    // Transfer boleh dari rekening mana pun, termasuk rekening darurat; tabung dari rekening non-aset.
    const accList = k === 'transfer' ? m.accounts : k === 'saving' ? nonAsset : regular;
    const prevAcc = form.account.value;
    form.account.innerHTML = options(accList, accList.some((a) => a.id === prevAcc) ? prevAcc : accList[0]?.id);
  }

  form.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    sync();
  }));
  form.from_emergency?.addEventListener('change', sync);
  form.amount.addEventListener('input', () => {
    const n = parseRupiah(form.amount.value);
    form.amount.value = n ? rupiah(n) : '';
  });
  sync();
  form.amount.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const amount = parseRupiah(form.amount.value);
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    if (!amount) return fail('Isi jumlahnya dulu.', form.amount);
    if (!form.trx_date.value) return fail('Isi tanggalnya.', form.trx_date);
    const moving = state.kind === 'transfer' || state.kind === 'saving';
    if (moving && form.account.value === form.to_account.value) {
      return fail('Rekening asal dan tujuan harus berbeda.', form.to_account);
    }

    const isExpense = state.kind === 'expense';
    const body = {
      kind: moving ? 'transfer' : state.kind,
      amount,
      trx_date: form.trx_date.value,
      account_id: form.account.value || null,
      to_account_id: moving ? form.to_account.value : null,
      category_id: moving ? null : form.category.value,
      note: form.note.value.trim() || null,
      is_one_off: isExpense && form.is_one_off.checked,
      from_emergency: isExpense && !!form.from_emergency?.checked,
    };
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api('/api/trx', { method: 'POST', body });
      location.hash = back;
      const d = res.daily_budget;
      if (d && d.over > 0) {
        toast(`Budget makan ${tanggal(d.date)} terlewati ${rupiah(d.over)} (total ${rupiah(d.total)} dari ${rupiah(d.limit)}).`, { warn: true });
      } else {
        toast(`Tersimpan di siklus ${res.cycle.label}.`);
      }
    } catch (ex) {
      btn.disabled = false;
      fail(ex.message);
    }
  });
}

// ---------- Layar 3: tagihan berulang ----------

function billDue(o, today) {
  if (o.status === 'paid') return { text: `Dibayar ${tanggalPendek(o.paid_date)}`, cls: 'tile-label' };
  if (o.status === 'skipped') return { text: 'Dilewati siklus ini', cls: 'tile-label' };
  const d = selisihHari(today, o.due_date);
  const tgl = tanggalPendek(o.due_date);
  if (d < 0) return { text: `Lewat ${-d} hari · jatuh tempo ${tgl}`, cls: 'danger-text' };
  if (d === 0) return { text: 'Jatuh tempo hari ini', cls: 'warn-text tiny' };
  if (d <= o.remind_days_before) return { text: `Jatuh tempo ${tgl} · ${d} hari lagi`, cls: 'warn-text tiny' };
  return { text: `Jatuh tempo ${tgl}`, cls: 'tile-label' };
}

function backHeader(eyebrow, title, href = '#/') {
  return `<div class="topbar start">
    <a class="icon-btn" href="${href}" aria-label="Kembali">${ICON.back}</a>
    <div><div class="eyebrow">${esc(eyebrow)}</div><h1 class="title">${esc(title)}</h1></div>
  </div>`;
}

async function renderBills() {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/'; return; }
  const b = await api(`/api/bills${selectedCycle ? `?cycle=${selectedCycle}` : ''}`);
  const pending = b.items.filter((o) => o.status === 'pending');
  const paid = b.items.filter((o) => o.status === 'paid');
  const skipped = b.items.filter((o) => o.status === 'skipped');
  const s = b.summary;

  const row = (o, right) => {
    const due = billDue(o, b.today);
    return `<li class="trx-item">
      <div class="main">
        <span class="name">${esc(o.name)}</span>
        <span class="${due.cls}">${esc(due.text)}${o.is_variable && o.status !== 'skipped' ? ' · nominal berubah' : ''}</span>
      </div>
      <div class="right">${right}</div>
    </li>`;
  };

  const summaryCard = s.count === 0 ? '' : `<section class="card bill-summary">
      <span class="eyebrow">Belum dibayar siklus ini</span>
      <span class="big-amount">${rupiah(s.unpaid_amount)}</span>
      <div class="em-track neutral"><div style="width:${pct(s.paid_count, s.count)}%"></div></div>
      <span class="tile-label">${s.paid_count} dari ${s.count} tagihan sudah lunas · total ${rupiah(s.total)}</span>
    </section>`;

  const emptyText = b.bills.length === 0
    ? 'Belum ada tagihan berulang. Tambahkan wifi, pembantu, kontrakan, listrik, dan lainnya.'
    : b.cycle.status === 'future'
      ? 'Tagihan siklus ini dibuat saat siklusnya dimulai.'
      : 'Tidak ada tagihan aktif di siklus ini.';

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      ${backHeader(`Siklus ${b.cycle.label}`, 'Tagihan berulang')}
      ${summaryCard}
      ${b.items.length === 0 ? `<p class="empty">${emptyText}</p>` : ''}
      ${pending.length ? `<div class="section-head"><h2>Belum dibayar</h2></div>
        <ul class="trx-list">${pending.map((o) => row(o, `
          <span class="amt strong">${rupiah(o.expected_amount)}</span>
          <button type="button" class="btn-pill" data-pay="${esc(o.id)}">Bayar</button>`)).join('')}</ul>` : ''}
      ${paid.length ? `<div class="section-head"><h2>Sudah dibayar</h2></div>
        <ul class="trx-list">${paid.map((o) => row(o, `<span class="amt in">${rupiah(o.paid_amount)}</span>`)).join('')}</ul>` : ''}
      ${skipped.length ? `<div class="section-head"><h2>Dilewati</h2></div>
        <ul class="trx-list">${skipped.map((o) => row(o, `
          <span class="amt muted">${rupiah(o.expected_amount)}</span>
          <button type="button" class="btn-pill outline" data-unskip="${esc(o.id)}">Batalkan</button>`)).join('')}</ul>` : ''}
      ${b.bills.length ? `<div class="section-head"><h2>Semua tagihan</h2></div>
        <ul class="trx-list">${b.bills.map((x) => `<li>
          <a class="trx-item link-row" href="#/tagihan/${esc(x.id)}">
            <div class="main">
              <span class="name">${esc(x.name)}</span>
              <span class="tile-label">${x.interval_days
                ? `Tiap ${x.interval_days} hari${x.next_due && x.is_active ? ` · berikutnya ${tanggalPendek(x.next_due)}` : ''}`
                : `Tiap tanggal ${x.due_dom}`} · ${esc(x.account_name)}${x.is_active ? '' : ' · nonaktif'}</span>
            </div>
            <span class="amt${x.is_active ? '' : ' muted'}">${x.is_variable ? '± ' : ''}${rupiah(x.default_amount)}</span>
          </a></li>`).join('')}</ul>` : ''}
    </div>
    <div class="footer"><a class="btn-outline" href="#/tagihan/baru">Tambah tagihan berulang</a></div>
  </div>
  <dialog id="pay-dialog" class="sheet" aria-labelledby="pay-title"></dialog>`;

  const dlg = document.getElementById('pay-dialog');
  const payable = m.accounts.filter((a) => a.kind !== 'asset');

  app.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', () => {
    const o = b.items.find((x) => x.id === btn.dataset.pay);
    dlg.innerHTML = `<form class="sheet-body" id="pay-form" novalidate>
      <h2 id="pay-title" class="title">Bayar ${esc(o.name)}</h2>
      <div id="pay-err" class="error" hidden></div>
      <div class="card field amount">
        <label for="pay-amount">Jumlah${o.is_variable ? ' (sesuaikan dengan tagihan bulan ini)' : ''}</label>
        <input id="pay-amount" inputmode="numeric" autocomplete="off" value="${rupiah(o.expected_amount)}">
      </div>
      <div class="card rows">
        <div class="row"><label for="pay-date">Tanggal</label>
          <input id="pay-date" type="date" value="${esc(b.today)}"></div>
        <div class="row"><label for="pay-account">Dari rekening</label>
          <select id="pay-account">${payable.map((a) => `<option value="${esc(a.id)}"${a.id === o.account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      </div>
      <button class="btn-primary" type="submit">Bayar ${esc(o.name)}</button>
      <div class="sheet-actions">
        <button type="button" class="btn-text" id="pay-skip">Lewati siklus ini</button>
        <button type="button" class="btn-text" id="pay-cancel">Batal</button>
      </div>
    </form>`;
    const f = dlg.querySelector('form');
    const amt = f.querySelector('#pay-amount');
    const err = f.querySelector('#pay-err');
    amt.addEventListener('input', () => { const n = parseRupiah(amt.value); amt.value = n ? rupiah(n) : ''; });
    f.querySelector('#pay-cancel').addEventListener('click', () => dlg.close());
    f.querySelector('#pay-skip').addEventListener('click', async () => {
      await api(`/api/bills/occurrences/${o.id}/skip`, { method: 'POST', body: { skipped: true } });
      dlg.close();
      toast(`${o.name} dilewati untuk siklus ini.`);
      renderBills();
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = parseRupiah(amt.value);
      if (!amount) { err.textContent = 'Isi jumlahnya.'; err.hidden = false; amt.focus(); return; }
      const submit = f.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await api(`/api/bills/occurrences/${o.id}/pay`, {
          method: 'POST',
          body: { amount, trx_date: f.querySelector('#pay-date').value, account_id: f.querySelector('#pay-account').value },
        });
        dlg.close();
        toast(`${o.name} dibayar ${rupiah(amount)}.`);
        renderBills();
      } catch (ex) {
        submit.disabled = false;
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    dlg.showModal();
    amt.focus();
    amt.select();
  }));

  app.querySelectorAll('[data-unskip]').forEach((btn) => btn.addEventListener('click', async () => {
    await api(`/api/bills/occurrences/${btn.dataset.unskip}/skip`, { method: 'POST', body: { skipped: false } });
    renderBills();
  }));
}

async function renderBillForm(id) {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/'; return; }
  let bill = null;
  if (id) {
    bill = (await api('/api/bills')).bills.find((x) => x.id === id);
    if (!bill) throw new Error('Tagihan tidak ditemukan.');
  }
  const cats = m.categories.filter((c) => c.kind === 'expense');
  const accounts = m.accounts.filter((a) => a.kind !== 'asset');
  const v = bill ?? {
    name: '', default_amount: 0, is_variable: false, due_dom: 1, remind_days_before: 3, is_active: true,
    interval_days: null, anchor_date: null,
    category_id: (cats.find((c) => c.counts_as_bill) ?? cats[0])?.id,
    account_id: accounts.find((a) => !a.is_emergency)?.id,
  };
  const opt = (value, label, sel) => `<option value="${esc(value)}"${value === sel ? ' selected' : ''}>${esc(label)}</option>`;

  app.innerHTML = `<form class="screen" id="bill-form" novalidate>
    <div class="screen-body">
      ${backHeader('Tagihan berulang', bill ? 'Ubah tagihan' : 'Tambah tagihan', '#/tagihan')}
      <div id="bill-err" class="error" hidden></div>
      <div class="card field">
        <label for="b-name">Nama</label>
        <input id="b-name" maxlength="80" autocomplete="off" placeholder="Contoh: Wifi (Biznet)" value="${esc(v.name)}">
      </div>
      <div class="card field amount">
        <label for="b-amount">Nominal tiap bayar</label>
        <input id="b-amount" inputmode="numeric" autocomplete="off" placeholder="Rp 0" value="${v.default_amount ? rupiah(v.default_amount) : ''}">
      </div>
      <div class="card rows">
        <label class="row toggle">
          <span class="text"><span>Nominal berubah-ubah</span>
            <span class="tile-label">Mis. listrik. Nominal di atas jadi perkiraan.</span></span>
          <input type="checkbox" id="b-variable"${v.is_variable ? ' checked' : ''}>
        </label>
      </div>
      <div class="segmented two" role="group" aria-label="Jadwal tagihan">
        <button type="button" data-sched="monthly" aria-pressed="${!v.interval_days}">Tanggal tetap</button>
        <button type="button" data-sched="interval" aria-pressed="${!!v.interval_days}">Tiap N hari</button>
      </div>
      <div class="card rows">
        <div class="row" id="row-monthly">
          <label for="b-due">Jatuh tempo</label>
          <select id="b-due">${Array.from({ length: 31 }, (_, i) => opt(String(i + 1), `Tanggal ${i + 1}`, String(v.due_dom ?? 1))).join('')}</select>
        </div>
        <div class="row" id="row-interval">
          <label for="b-interval">Tiap</label>
          <span class="inline-num"><input id="b-interval" type="number" inputmode="numeric" min="7" max="366" value="${v.interval_days ?? 28}"> hari</span>
        </div>
        <div class="row" id="row-anchor">
          <label for="b-anchor">Terakhir dibayar</label>
          <input id="b-anchor" type="date" value="${esc(v.anchor_date ?? m.today)}">
        </div>
        <div class="row">
          <label for="b-remind">Ingatkan</label>
          <select id="b-remind">${[0, 1, 2, 3, 5, 7].map((n) => opt(String(n), n ? `${n} hari sebelumnya` : 'Pada harinya', String(v.remind_days_before))).join('')}</select>
        </div>
        <div class="row">
          <label for="b-cat">Kategori</label>
          <select id="b-cat">${cats.map((c) => opt(c.id, c.name, v.category_id)).join('')}</select>
        </div>
        <div class="row">
          <label for="b-acc">Dibayar dari</label>
          <select id="b-acc">${accounts.map((a) => opt(a.id, a.name, v.account_id)).join('')}</select>
        </div>
        ${bill ? `<label class="row toggle">
          <span class="text"><span>Aktif</span>
            <span class="tile-label">Matikan bila tagihan sudah berhenti. Riwayat tetap tersimpan.</span></span>
          <input type="checkbox" id="b-active"${v.is_active ? ' checked' : ''}>
        </label>` : ''}
      </div>
      <p class="tile-label" id="hint-monthly">Siklus berjalan 25 sampai 24. Tanggal 25–31 jatuh di awal siklus, tanggal 1–24 di akhir siklus.</p>
      <p class="tile-label" id="hint-interval">Jatuh tempo berikutnya dihitung dari tanggal bayar terakhir, mis. wifi tiap 28 hari sejak terakhir beli. ${bill?.interval_days ? 'Setelah tagihan dibayar lewat aplikasi, tanggal bayar itu yang dipakai.' : ''}</p>
    </div>
    <div class="footer"><button class="btn-primary" type="submit">${bill ? 'Simpan perubahan' : 'Simpan tagihan'}</button></div>
  </form>`;

  const f = document.getElementById('bill-form');
  const err = document.getElementById('bill-err');
  const amt = f.querySelector('#b-amount');
  amt.addEventListener('input', () => { const n = parseRupiah(amt.value); amt.value = n ? rupiah(n) : ''; });
  if (!bill) f.querySelector('#b-name').focus();

  let sched = v.interval_days ? 'interval' : 'monthly';
  const syncSched = () => {
    f.querySelectorAll('[data-sched]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sched === sched)));
    for (const [id, on] of [['row-monthly', sched === 'monthly'], ['hint-monthly', sched === 'monthly'],
      ['row-interval', sched === 'interval'], ['row-anchor', sched === 'interval'], ['hint-interval', sched === 'interval']]) {
      document.getElementById(id).hidden = !on;
    }
  };
  f.querySelectorAll('[data-sched]').forEach((x) => x.addEventListener('click', () => { sched = x.dataset.sched; syncSched(); }));
  syncSched();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const name = f.querySelector('#b-name').value.trim();
    if (!name) return fail('Isi nama tagihan.', f.querySelector('#b-name'));
    const body = {
      name,
      default_amount: parseRupiah(amt.value),
      is_variable: f.querySelector('#b-variable').checked,
      due_dom: sched === 'monthly' ? Number(f.querySelector('#b-due').value) : null,
      interval_days: sched === 'interval' ? Number(f.querySelector('#b-interval').value) : null,
      anchor_date: sched === 'interval' ? f.querySelector('#b-anchor').value || null : null,
      remind_days_before: Number(f.querySelector('#b-remind').value),
      category_id: f.querySelector('#b-cat').value,
      account_id: f.querySelector('#b-acc').value,
      is_active: bill ? f.querySelector('#b-active').checked : true,
    };
    if (!body.default_amount && !body.is_variable) return fail('Isi nominalnya.', amt);
    if (sched === 'interval') {
      if (!(body.interval_days >= 7 && body.interval_days <= 366)) return fail('Jarak tagihan 7 sampai 366 hari.', f.querySelector('#b-interval'));
      if (!body.anchor_date) return fail('Isi tanggal terakhir dibayar.', f.querySelector('#b-anchor'));
    }
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await api(bill ? `/api/bills/${bill.id}` : '/api/bills', { method: bill ? 'PUT' : 'POST', body });
      toast(bill ? 'Tagihan diperbarui.' : 'Tagihan ditambahkan.');
      location.hash = '#/tagihan';
    } catch (ex) {
      btn.disabled = false;
      fail(ex.message);
    }
  });
}

// ---------- Layar 4: rekening darurat ----------

async function renderEmergency() {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/'; return; }
  const e = await api('/api/emergency');
  const target = e.account.target ?? 0;

  const debtRow = (d) => `<li class="trx-item">
    <div class="main">
      <span class="name">${esc(d.note || `Tarik ${e.account.name.toLowerCase()}`)}</span>
      <span class="tile-label">${esc(tanggal(d.trx_date))} · ${esc(d.category_name ?? '')} · oleh ${esc(d.recorded_by)}</span>
    </div>
    <span class="amt strong warn-amt">${rupiah(d.amount)}</span>
  </li>`;

  const repayRow = (g) => `<li class="trx-item">
    <div class="main">
      <span class="name">Lunas ${esc(tanggal(g.repaid_date))}</span>
      <span class="tile-label">${g.debts.length} penarikan · dari ${esc(g.repaid_from)} · oleh ${esc(g.repaid_by)}</span>
    </div>
    <div class="right">
      <span class="amt in">${rupiah(g.amount)}</span>
      <button type="button" class="btn-text small" data-undo="${esc(g.trx_id)}" aria-label="Batalkan pelunasan ${esc(tanggal(g.repaid_date))}">Batalkan</button>
    </div>
  </li>`;

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      <div><div class="eyebrow">Siklus ${esc(m.cycle.label)}</div><h1 class="title">${esc(e.account.name)}</h1></div>
      <section class="card emergency-hero">
        <span class="warn-text">Saldo bulan ini</span>
        <span class="big-amount">${rupiah(e.filled)}</span>
        <div class="em-track thick"><div style="width:${pct(e.filled, target)}%"></div></div>
        <div class="daily-foot">
          <span class="tile-label">Target ${rupiah(target)}</span>
          <span class="tile-label">${e.open_debt > 0 ? `Kurang ${rupiah(e.open_debt)}` : 'Penuh'}</span>
        </div>
      </section>
      <section class="card rules">
        <span class="daily-title">Aturan</span>
        <span class="rules-text">Rekening ini berisi ${rupiah(target)} tiap siklus. Setiap penarikan dicatat sebagai utang ke rekening sendiri dan dilunasi saat gajian tanggal ${e.payday}.</span>
      </section>
      <div class="section-head"><h2>Utang belum lunas</h2></div>
      ${e.open.length
        ? `<ul class="trx-list">${e.open.map(debtRow).join('')}</ul>`
        : '<p class="empty">Tidak ada utang. Penarikan dicatat dari layar Tambah transaksi dengan sakelar "Ambil dari rekening darurat".</p>'}
      ${e.repayments.length ? `<div class="section-head"><h2>Sudah lunas</h2></div>
        <ul class="trx-list">${e.repayments.map(repayRow).join('')}</ul>` : ''}
    </div>
    ${e.open.length ? '<div class="footer tight"><button type="button" class="btn-primary warn" id="repay">Catat pelunasan</button></div>' : ''}
    ${tabbar('#/darurat')}
  </div>
  <dialog id="repay-dialog" class="sheet" aria-labelledby="repay-title"></dialog>`;

  const dlg = document.getElementById('repay-dialog');
  document.getElementById('repay')?.addEventListener('click', () => {
    const sources = m.accounts.filter((a) => !a.is_emergency && a.kind !== 'asset');
    dlg.innerHTML = `<form class="sheet-body" novalidate>
      <h2 id="repay-title" class="title">Catat pelunasan</h2>
      <div class="error" hidden></div>
      <fieldset class="card rows plain">
        <legend class="visually-hidden">Utang yang dilunasi</legend>
        ${e.open.map((d) => `<label class="row toggle">
          <span class="text"><span>${esc(d.note || 'Penarikan')} · ${rupiah(d.amount)}</span>
            <span class="tile-label">${esc(tanggal(d.trx_date))} · ${esc(d.category_name ?? '')}</span></span>
          <input type="checkbox" name="debt" value="${esc(d.id)}" data-amount="${d.amount}" checked>
        </label>`).join('')}
      </fieldset>
      <div class="card rows">
        <div class="row"><label for="r-from">Dari rekening</label>
          <select id="r-from">${sources.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>
        <div class="row"><label for="r-date">Tanggal</label>
          <input id="r-date" type="date" value="${esc(e.today)}"></div>
      </div>
      <p class="tile-label">Dicatat sebagai transfer ke ${esc(e.account.name)}, bukan pengeluaran.</p>
      <button class="btn-primary warn" type="submit" id="r-submit"></button>
      <div class="sheet-actions"><span></span><button type="button" class="btn-text" id="r-cancel">Batal</button></div>
    </form>`;
    const f = dlg.querySelector('form');
    const err = f.querySelector('.error');
    const submit = f.querySelector('#r-submit');
    const boxes = [...f.querySelectorAll('[name="debt"]')];
    const sync = () => {
      const chosen = boxes.filter((x) => x.checked);
      const total = chosen.reduce((s, x) => s + Number(x.dataset.amount), 0);
      submit.textContent = chosen.length ? `Lunasi ${rupiah(total)}` : 'Pilih utang yang dilunasi';
      submit.disabled = !chosen.length;
    };
    boxes.forEach((x) => x.addEventListener('change', sync));
    sync();
    f.querySelector('#r-cancel').addEventListener('click', () => dlg.close());
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      try {
        const res = await api('/api/emergency/repay', {
          method: 'POST',
          body: {
            debt_ids: boxes.filter((x) => x.checked).map((x) => x.value),
            account_id: f.querySelector('#r-from').value,
            trx_date: f.querySelector('#r-date').value,
          },
        });
        dlg.close();
        toast(`Pelunasan ${rupiah(res.amount)} tercatat.`);
        renderEmergency();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        sync();
      }
    });
    dlg.showModal();
  });

  app.querySelectorAll('[data-undo]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Batalkan pelunasan ini? Utangnya akan kembali belum lunas.')) return;
    try {
      await api(`/api/emergency/repayments/${btn.dataset.undo}`, { method: 'DELETE' });
      toast('Pelunasan dibatalkan.');
      renderEmergency();
    } catch (ex) {
      toast(ex.message, { warn: true });
    }
  }));
}

// ---------- Layar 5: tabungan dan investasi ----------

async function renderSavings() {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/'; return; }
  const s = await api(`/api/savings${selectedCycle ? `?cycle=${selectedCycle}` : ''}`);

  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${rupiah(n)}`;
  const row = (a) => {
    const value = a.current_value == null
      ? '<span class="warn-text tiny">Nilai sekarang belum diisi</span>'
      : `<span class="tile-label">Nilai sekarang ${rupiah(a.current_value)}${a.gain != null
        ? ` · <span class="${a.gain >= 0 ? 'in' : 'danger-text'}">${signed(a.gain)}</span>` : ''}</span>`;
    return `<li><button type="button" class="trx-item link-row as-button" data-asset="${esc(a.account_id)}"
        aria-label="${esc(a.name)}: ubah nilai sekarang">
      <div class="main">
        <span class="name">${esc(a.name)}</span>
        <span class="tile-label">Total setoran ${rupiah(a.net_invested)}</span>
      </div>
      <div class="main end">
        <span class="amt strong">${signed(a.cycle_net)}</span>
        ${value}
      </div>
    </button></li>`;
  };

  const inv = s.investasi_expense;
  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      ${backHeader(`Siklus ${s.cycle.label}`, 'Tabungan dan investasi')}
      <section class="hero">
        <span class="hero-label">Disetor siklus ini</span>
        <span class="hero-amount">${rupiah(s.deposited_cycle)}</span>
        <span class="hero-label">Uang yang ditabung, tidak dihitung sebagai pengeluaran${s.withdrawn_cycle
          ? ` · ditarik ${rupiah(s.withdrawn_cycle)}` : ''}</span>
      </section>
      ${inv.count ? `<div class="note-box">Ada ${inv.count} transaksi (${rupiah(inv.amount)}) di kategori pengeluaran
        "Investasi" pada siklus ini. Itu dihitung sebagai pengeluaran, bukan setoran. Untuk setoran berikutnya pakai
        tombol "Tabung".</div>` : ''}
      <div class="section-head"><h2>Per aset</h2></div>
      ${s.assets.length
        ? `<ul class="trx-list">${s.assets.map(row).join('')}</ul>`
        : '<p class="empty">Belum ada rekening berjenis aset.</p>'}
      <p class="tile-label">Nilai sekarang diisi manual dan boleh dikosongkan; tekan aset untuk mengubahnya.
        Total setoran dihitung dari yang Anda tabung, dikurangi yang ditarik kembali.</p>
    </div>
    ${s.assets.length ? '<div class="footer"><a class="btn-primary as-link" href="#/tabungan/setor">Tabung</a></div>' : ''}
  </div>
  <dialog id="value-dialog" class="sheet" aria-labelledby="value-title"></dialog>`;

  const dlg = document.getElementById('value-dialog');
  app.querySelectorAll('[data-asset]').forEach((btn) => btn.addEventListener('click', () => {
    const a = s.assets.find((x) => x.account_id === btn.dataset.asset);
    dlg.innerHTML = `<form class="sheet-body" novalidate>
      <h2 id="value-title" class="title">Nilai ${esc(a.name)} sekarang</h2>
      <div class="error" hidden></div>
      <div class="card field amount">
        <label for="v-amount">Nilai sekarang (kosongkan bila tidak tahu)</label>
        <input id="v-amount" inputmode="numeric" autocomplete="off" placeholder="Rp 0"
          value="${a.current_value == null ? '' : rupiah(a.current_value)}">
      </div>
      <p class="tile-label">Total setoran ${rupiah(a.net_invested)}${a.as_of_date ? ` · terakhir diisi ${esc(tanggal(a.as_of_date))}` : ''}</p>
      <button class="btn-primary" type="submit">Simpan</button>
      <div class="sheet-actions"><span></span><button type="button" class="btn-text" id="v-cancel">Batal</button></div>
    </form>`;
    const f = dlg.querySelector('form');
    const amt = f.querySelector('#v-amount');
    amt.addEventListener('input', () => { const n = parseRupiah(amt.value); amt.value = amt.value.trim() ? rupiah(n) : ''; });
    f.querySelector('#v-cancel').addEventListener('click', () => dlg.close());
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const raw = amt.value.trim();
      try {
        await api(`/api/savings/${a.account_id}/value`, {
          method: 'PUT',
          body: { current_value: raw ? parseRupiah(raw) : null },
        });
        dlg.close();
        toast(raw ? `Nilai ${a.name} disimpan.` : `Nilai ${a.name} dikosongkan.`);
        renderSavings();
      } catch (ex) {
        const err = f.querySelector('.error');
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    dlg.showModal();
    amt.focus();
  }));
}

/** Tombol "Tabung" = form tambah transaksi dengan jenis Tabung (transfer ke rekening aset). */
async function renderDeposit() {
  const m = await loadMeta();
  const asset = m.accounts.find((a) => a.kind === 'asset');
  return renderAdd({ kind: 'saving', toAccountId: asset?.id, title: 'Tabung', back: '#/tabungan' });
}

// ---------- Layar 6: laporan siklus, dan daftar transaksi ----------

/** Deretan tombol siklus yang bisa digeser; yang aktif berwarna. */
function cycleChips(cycles, active) {
  return `<div class="chips" role="group" aria-label="Pilih siklus">
    ${cycles.map((c) => `<button type="button" class="chip" data-cycle="${esc(c.start)}"
      aria-pressed="${c.start === active}">${esc(c.label)}</button>`).join('')}
  </div>`;
}

function bindChips(root, current, rerender) {
  root.querySelectorAll('[data-cycle]').forEach((b) => b.addEventListener('click', () => {
    selectedCycle = b.dataset.cycle === current ? null : b.dataset.cycle;
    rerender();
  }));
  root.querySelector('.chip[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function renderReport() {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/transaksi'; return; }
  const r = await api(`/api/report${selectedCycle ? `?cycle=${selectedCycle}` : ''}`);
  const { income, expense, remaining } = r.totals;
  const maxSpent = Math.max(1, ...r.expense_by_category.map((c) => c.total));
  const short = (c) => c.label.replace(/ \d{4}$/, '');

  // Tiap kategori = tautan ke halaman penuh kategori itu.
  const catRow = (c) => {
    const hasBudget = c.budget != null;
    const width = hasBudget ? pct(c.total, c.budget) : pct(c.total, maxSpent);
    const over = hasBudget && c.total > c.budget;
    const right = hasBudget
      ? `${rupiahSingkat(c.total)} / ${rupiahSingkat(c.budget).replace('Rp ', '')}`
      : `${rupiahSingkat(c.total)} · ${Math.round(pct(c.total, expense))}%`;
    return `<li><a class="cat-head" href="#/laporan/kategori/${esc(c.category_id)}">
        <span class="cat-line"><span class="cat-name">${esc(c.name)}</span>
          <span class="cat-right"><span class="${over ? 'danger-text' : 'tile-label'}">${right}</span>${ICON.next}</span></span>
        <span class="cat-track"><span class="${over ? 'over' : ''}" style="width:${width}%"></span></span>
      </a></li>`;
  };

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      <h1 class="title">Laporan siklus</h1>
      ${cycleChips(r.cycles.map((c) => ({ ...c, label: short(c) })), r.cycle.start)}
      <div class="tiles three">
        <div class="tile"><span class="tile-label">Masuk</span><span class="tile-value small in">${rupiahSingkat(income)}</span></div>
        <div class="tile"><span class="tile-label">Keluar</span><span class="tile-value small">${rupiahSingkat(expense)}</span></div>
        <div class="tile"><span class="tile-label">Sisa</span><span class="tile-value small${remaining < 0 ? ' danger-text' : ''}">${remaining < 0 ? '−' : ''}${rupiahSingkat(remaining)}</span></div>
      </div>
      <section class="card report">
        <div class="daily-head">
          <h2 class="daily-title">Per kategori</h2>
          <span class="tile-label">${r.expense_by_category.some((c) => c.budget != null) ? 'Terpakai / anggaran' : 'Porsi dari pengeluaran'}</span>
        </div>
        ${r.expense_by_category.length
          ? `<ul class="cats">${r.expense_by_category.map(catRow).join('')}</ul>`
          : '<p class="empty">Belum ada pengeluaran di siklus ini.</p>'}
      </section>
      ${r.income_by_category.length ? `<section class="card report">
        <h2 class="daily-title">Pemasukan</h2>
        <ul class="cats">${r.income_by_category.map((c) => `<li><a class="cat-line link" href="#/laporan/kategori/${esc(c.category_id)}">
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-right"><span class="in tiny">${rupiah(c.total)}</span>${ICON.next}</span></a></li>`).join('')}</ul>
      </section>` : ''}
      <div class="card rows facts">
        <div class="row"><span class="label">Ditabung</span><span class="value">${rupiah(r.extra.saved)}</span></div>
        <div class="row"><span class="label">Diambil dari rekening darurat</span><span class="value">${rupiah(r.extra.from_emergency)}</span></div>
        <div class="row"><span class="label">Pengeluaran sekali bayar</span><span class="value">${rupiah(r.extra.one_off)}</span></div>
      </div>
      <p class="tile-label">Tabung dan pelunasan rekening darurat tidak dihitung sebagai pengeluaran. Penarikan rekening darurat termasuk pengeluaran. Tekan kategori untuk melihat semua transaksinya.</p>
    </div>
    ${tabbar('#/laporan')}
  </div>`;

  bindChips(app, m.cycle.start, renderReport);
}

/** Halaman penuh satu kategori: semua transaksinya di siklus terpilih. */
async function renderCategory(categoryId) {
  const m = await loadMeta();
  if (!m.user.can_view_reports) { location.hash = '#/transaksi'; return; }
  const cat = m.categories.find((c) => c.id === categoryId);
  if (!cat) throw new Error('Kategori tidak ditemukan.');
  const q = selectedCycle ? `?cycle=${selectedCycle}` : '';
  const r = await api(`/api/report${q}`);
  const { items } = await api(`/api/trx?limit=200&cycle=${r.cycle.start}&category_id=${categoryId}`);
  const isExpense = cat.kind === 'expense';
  const row = (isExpense ? r.expense_by_category : r.income_by_category).find((c) => c.category_id === categoryId);
  const total = row?.total ?? 0;
  const budget = row?.budget ?? null;
  const short = (c) => c.label.replace(/ \d{4}$/, '');

  const groups = [];
  for (const t of items) {
    if (groups.at(-1)?.date !== t.trx_date) groups.push({ date: t.trx_date, items: [], total: 0 });
    groups.at(-1).items.push(t);
    groups.at(-1).total += t.amount;
  }

  const sub = [
    `${items.length} transaksi`,
    items.length ? `rata-rata ${rupiah(total / items.length)}` : null,
    isExpense && r.totals.expense ? `${Math.round(pct(total, r.totals.expense))}% dari pengeluaran` : null,
  ].filter(Boolean).join(' · ');

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      ${backHeader('Laporan', cat.name, '#/laporan')}
      ${cycleChips(r.cycles.map((c) => ({ ...c, label: short(c) })), r.cycle.start)}
      <section class="card bill-summary">
        <span class="eyebrow">${isExpense ? 'Pengeluaran' : 'Pemasukan'} siklus ${esc(r.cycle.label)}</span>
        <span class="big-amount${isExpense ? '' : ' in'}">${rupiah(total)}</span>
        ${budget != null ? `<div class="cat-track"><span class="${total > budget ? 'over' : ''}" style="width:${pct(total, budget)}%"></span></div>
          <span class="${total > budget ? 'danger-text' : 'tile-label'}">Anggaran ${rupiah(budget)} · ${total > budget
            ? `lewat ${rupiah(total - budget)}` : `sisa ${rupiah(budget - total)}`}</span>` : ''}
        <span class="tile-label">${esc(sub)}</span>
      </section>
      ${groups.length
        ? groups.map((g) => `<section aria-label="${esc(tanggal(g.date))}">
            <div class="date-row"><h2 class="date-head">${esc(tanggal(g.date))}</h2>
              <span class="tile-label">${rupiah(g.total)}</span></div>
            <ul class="trx-list">${g.items.map((t) => trxLine(t)).join('')}</ul>
          </section>`).join('')
        : `<p class="empty">Belum ada transaksi ${esc(cat.name)} di siklus ini.</p>`}
      ${items.length === 200 ? '<p class="tile-label">Menampilkan 200 transaksi terbaru.</p>' : ''}
    </div>
    ${tabbar('#/laporan')}
  </div>`;

  bindChips(app, m.cycle.start, () => renderCategory(categoryId));
  app.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Hapus transaksi ini?')) return;
    try {
      await api(`/api/trx/${btn.dataset.del}`, { method: 'DELETE' });
      toast('Transaksi dihapus.');
      renderCategory(categoryId);
    } catch (ex) {
      toast(ex.message, { warn: true });
    }
  }));
}

// Filter layar Transaksi: rentang tanggal { from, to } (keduanya opsional); null = semua.
let trxFilter = null;
const TRX_PAGE = 50;

async function renderTransactions() {
  await loadMeta();
  const f = trxFilter ?? { from: '', to: '' };
  const items = [];
  let done = false;

  const filterText = !trxFilter ? ''
    : trxFilter.from && trxFilter.to ? `${tanggalPendek(trxFilter.from)} – ${tanggalPendek(trxFilter.to)}`
      : trxFilter.from ? `Sejak ${tanggalPendek(trxFilter.from)}` : `Sampai ${tanggalPendek(trxFilter.to)}`;

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      <div class="topbar">
        <h1 class="title">Transaksi</h1>
        <button type="button" class="icon-btn${trxFilter ? ' is-active' : ''}" id="f-open"
          aria-label="Filter tanggal${trxFilter ? ` (aktif: ${esc(filterText)})` : ''}" aria-haspopup="dialog">${ICON.filter}</button>
      </div>
      ${trxFilter ? `<div><button type="button" class="filter-chip" id="f-clear"
        aria-label="Hapus filter ${esc(filterText)}">${esc(filterText)} ${ICON.x}</button></div>` : ''}
      <div id="trx-groups"></div>
      <button type="button" class="btn-outline" id="trx-more" hidden>Muat lebih banyak</button>
    </div>
    ${tabbar('#/transaksi')}
  </div>
  <dialog id="f-dialog" class="sheet" aria-labelledby="f-title">
    <form class="sheet-body" id="trx-filter" novalidate>
      <h2 id="f-title" class="title">Filter tanggal</h2>
      <div id="f-err" class="error" hidden></div>
      <div class="card rows">
        <div class="row"><label for="f-from">Dari</label><input id="f-from" type="date" value="${esc(f.from)}"></div>
        <div class="row"><label for="f-to">Sampai</label><input id="f-to" type="date" value="${esc(f.to)}"></div>
      </div>
      <p class="tile-label">Boleh isi salah satu saja.</p>
      <button type="submit" class="btn-primary">Terapkan</button>
      <div class="sheet-actions">
        <button type="button" class="btn-text" id="f-reset"${trxFilter ? '' : ' hidden'}>Hapus filter</button>
        <button type="button" class="btn-text" id="f-cancel">Batal</button>
      </div>
    </form>
  </dialog>`;

  const box = document.getElementById('trx-groups');
  const more = document.getElementById('trx-more');
  const form = document.getElementById('trx-filter');
  const err = document.getElementById('f-err');

  function draw() {
    const groups = [];
    for (const t of items) {
      if (groups.at(-1)?.date !== t.trx_date) groups.push({ date: t.trx_date, items: [] });
      groups.at(-1).items.push(t);
    }
    box.innerHTML = groups.length
      ? groups.map((g) => `<section aria-label="${esc(tanggal(g.date))}">
          <h2 class="date-head">${esc(tanggal(g.date))}</h2>
          <ul class="trx-list">${g.items.map((t) => trxLine(t)).join('')}</ul>
        </section>`).join('')
      : `<p class="empty">${trxFilter ? 'Tidak ada transaksi di rentang tanggal ini.' : 'Belum ada transaksi. Tekan + untuk mencatat.'}</p>`;
    more.hidden = done;
  }

  async function load() {
    more.disabled = true;
    const p = new URLSearchParams({ limit: TRX_PAGE, offset: items.length });
    if (trxFilter?.from) p.set('from', trxFilter.from);
    if (trxFilter?.to) p.set('to', trxFilter.to);
    const { items: page } = await api(`/api/trx?${p}`);
    items.push(...page);
    done = page.length < TRX_PAGE;
    more.disabled = false;
    draw();
  }

  // Filter baru berlaku setelah "Terapkan" ditekan.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = form.querySelector('#f-from').value;
    const to = form.querySelector('#f-to').value;
    if (from && to && from > to) {
      err.textContent = 'Tanggal "dari" harus sebelum atau sama dengan tanggal "sampai".';
      err.hidden = false;
      return;
    }
    trxFilter = from || to ? { from, to } : null;
    dlg.close();
    renderTransactions();
  });
  const dlg = document.getElementById('f-dialog');
  const clear = () => { dlg.close(); trxFilter = null; renderTransactions(); };
  document.getElementById('f-open').addEventListener('click', () => { err.hidden = true; dlg.showModal(); });
  document.getElementById('f-cancel').addEventListener('click', () => dlg.close());
  document.getElementById('f-reset').addEventListener('click', clear);
  document.getElementById('f-clear')?.addEventListener('click', clear);
  more.addEventListener('click', () => load().catch((ex) => toast(ex.message, { warn: true })));
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn || !confirm('Hapus transaksi ini?')) return;
    try {
      await api(`/api/trx/${btn.dataset.del}`, { method: 'DELETE' });
      toast('Transaksi dihapus.');
      const i = items.findIndex((t) => t.id === btn.dataset.del);
      if (i >= 0) items.splice(i, 1);
      draw();
    } catch (ex) {
      toast(ex.message, { warn: true });
    }
  });

  await load();
}

// ---------- Layar 7: anggota keluarga ----------

const ROLE_LABEL = { suami: 'Suami', istri: 'Istri', anak: 'Anak' };

function permChips(member) {
  const ok = (t) => `<span class="perm">${t}</span>`;
  return member.can_view_reports
    ? ok('Catat') + ok('Lihat laporan') + ok('Ubah dan hapus')
    : ok('Catat') + ok('Ubah dan hapus') + '<span class="perm off">Tanpa laporan dan saldo</span>';
}

async function renderMembers() {
  await loadMeta();
  const d = await api('/api/members');

  const card = (x) => `<section class="card member" aria-label="${esc(x.name)}">
    <div class="daily-head">
      <span class="member-name">${esc(x.name)}</span>
      ${x.id === d.me ? '<span class="in tiny">Akun yang login</span>' : ''}
    </div>
    <span class="tile-label">${ROLE_LABEL[x.role]}${x.has_login
      ? (x.email ? ` · ${esc(x.email)}` : '')
      : ' · <span class="warn-text tiny">belum punya login</span>'}</span>
    <div class="perms">${permChips(x)}</div>
    ${d.can_manage ? `<a class="btn-text small member-edit" href="#/anggota/${esc(x.id)}">Atur</a>` : ''}
  </section>`;

  app.innerHTML = `<div class="screen">
    <div class="screen-body">
      ${backHeader('Pengaturan', 'Anggota keluarga')}
      <p class="rules-text">Semua anggota saling melihat transaksi, dan tiap transaksi menampilkan siapa yang mencatat.</p>
      ${d.members.map(card).join('')}
      <section class="emergency-hero small-note">
        <span class="daily-title">Jejak perubahan</span>
        <span class="rules-text">Karena semua bisa mengubah dan menghapus, tiap transaksi menyimpan pencatat awal dan pengubah terakhir.</span>
      </section>
      <div class="card rows">
        <a class="row link-row" href="#/anggota/${esc(d.me)}/sandi"><span>Ganti kata sandi saya</span>${ICON.next}</a>
        <button type="button" class="row link-row as-button danger-row" id="logout"><span>Keluar</span></button>
      </div>
    </div>
    ${d.can_manage ? '<div class="footer"><a class="btn-outline" href="#/anggota/baru">Tambah anggota</a></div>' : ''}
  </div>`;

  document.getElementById('logout').addEventListener('click', async () => {
    if (!confirm(`Keluar dari akun ${meta.user.name}?`)) return;
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    meta = null;
    selectedCycle = null;
    trxFilter = null;
    location.hash = '#/login';
  });
}

/** Tambah atau atur anggota (hanya suami/istri). id = null untuk anggota baru. */
async function renderMemberForm(id) {
  await loadMeta();
  const d = await api('/api/members');
  if (!d.can_manage) { location.hash = '#/anggota'; return; }
  const x = id ? d.members.find((mm) => mm.id === id) : null;
  if (id && !x) throw new Error('Anggota tidak ditemukan.');
  const v = x ?? { name: '', role: 'anak', email: '', has_login: false };

  app.innerHTML = `<form class="screen" id="member-form" novalidate>
    <div class="screen-body">
      ${backHeader('Anggota keluarga', x ? `Atur ${x.name}` : 'Tambah anggota', '#/anggota')}
      <div id="m-err" class="error" hidden></div>
      <div class="card field">
        <label for="m-name">Nama</label>
        <input id="m-name" maxlength="60" autocomplete="off" value="${esc(v.name)}">
      </div>
      <div class="card rows">
        <div class="row">
          <label for="m-role">Peran</label>
          <select id="m-role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}"${k === v.role ? ' selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <p class="tile-label" id="m-role-hint"></p>
      <div class="card field">
        <label for="m-email">Email untuk login</label>
        <input id="m-email" type="email" autocomplete="off" inputmode="email" value="${esc(v.email ?? '')}" placeholder="nama@contoh.com">
      </div>
      ${x?.id === d.me
        ? `<a class="card row link-row" href="#/anggota/${esc(d.me)}/sandi"><span>Ganti kata sandi saya</span>${ICON.next}</a>`
        : `<div class="card field">
        <label for="m-pass">${v.has_login ? 'Kata sandi baru (kosongkan bila tidak diganti)' : 'Kata sandi (minimal 8 karakter)'}</label>
        <input id="m-pass" type="password" autocomplete="new-password">
      </div>`}
      <p class="tile-label">Beri tahu email dan kata sandi ini ke anggotanya. Mereka bisa menggantinya sendiri setelah masuk.
        Kosongkan email bila anggota ini tidak perlu login.</p>
    </div>
    <div class="footer"><button class="btn-primary" type="submit">${x ? 'Simpan' : 'Tambah anggota'}</button></div>
  </form>`;

  const f = document.getElementById('member-form');
  const err = document.getElementById('m-err');
  const role = f.querySelector('#m-role');
  const hint = f.querySelector('#m-role-hint');
  const syncHint = () => {
    hint.textContent = role.value === 'anak'
      ? 'Anak bisa mencatat, mengubah, dan menghapus transaksi, tetapi tidak melihat laporan, saldo, rekening darurat, dan tabungan.'
      : 'Suami dan istri bisa melihat semua dan mengatur anggota.';
  };
  role.addEventListener('change', syncHint);
  syncHint();
  if (!x) f.querySelector('#m-name').focus();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const name = f.querySelector('#m-name').value.trim();
    const email = f.querySelector('#m-email').value.trim() || null;
    const password = f.querySelector('#m-pass')?.value ?? '';
    if (!name) return fail('Isi namanya.', f.querySelector('#m-name'));
    if (password && password.length < 8) return fail('Kata sandi minimal 8 karakter.', f.querySelector('#m-pass'));
    if (password && !email) return fail('Isi email dulu supaya kata sandi bisa dipakai login.', f.querySelector('#m-email'));
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const body = { name, role: role.value, email };
      let memberId = x?.id;
      if (x) await api(`/api/members/${x.id}`, { method: 'PUT', body });
      else memberId = (await api('/api/members', { method: 'POST', body })).id;
      if (password) await api(`/api/members/${memberId}/password`, { method: 'PUT', body: { password } });
      meta = null; // nama/peran sendiri bisa berubah
      toast(x ? 'Anggota diperbarui.' : `${name} ditambahkan.`);
      location.hash = '#/anggota';
    } catch (ex) {
      btn.disabled = false;
      fail(ex.message);
    }
  });
}

/** Ganti kata sandi sendiri. */
async function renderOwnPassword() {
  const m = await loadMeta();
  app.innerHTML = `<form class="screen" id="pw-form" novalidate>
    <div class="screen-body">
      ${backHeader('Anggota keluarga', 'Ganti kata sandi', '#/anggota')}
      <div id="pw-err" class="error" hidden></div>
      <input type="text" autocomplete="username" value="${esc(m.user.name)}" hidden>
      <div class="card field"><label for="pw-old">Kata sandi lama</label>
        <input id="pw-old" type="password" autocomplete="current-password"></div>
      <div class="card field"><label for="pw-new">Kata sandi baru (minimal 8 karakter)</label>
        <input id="pw-new" type="password" autocomplete="new-password"></div>
      <div class="card field"><label for="pw-new2">Ulangi kata sandi baru</label>
        <input id="pw-new2" type="password" autocomplete="new-password"></div>
      <p class="tile-label">Perangkat lain yang sedang masuk dengan akun ini akan diminta login ulang.</p>
    </div>
    <div class="footer"><button class="btn-primary" type="submit">Simpan kata sandi</button></div>
  </form>`;
  const f = document.getElementById('pw-form');
  const err = document.getElementById('pw-err');
  f.querySelector('#pw-old').focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const oldPw = f.querySelector('#pw-old').value;
    const pw = f.querySelector('#pw-new').value;
    if (pw.length < 8) return fail('Kata sandi baru minimal 8 karakter.', f.querySelector('#pw-new'));
    if (pw !== f.querySelector('#pw-new2').value) return fail('Kata sandi baru tidak sama.', f.querySelector('#pw-new2'));
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await api(`/api/members/${m.user.id}/password`, { method: 'PUT', body: { password: pw, current_password: oldPw } });
      toast('Kata sandi diganti.');
      location.hash = '#/anggota';
    } catch (ex) {
      btn.disabled = false;
      fail(ex.message);
    }
  });
}

// ---------- Router ----------

const routes = [
  [/^(#\/?)?$/, renderHome],
  [/^#\/tambah$/, renderAdd],
  [/^#\/login$/, renderLogin],
  [/^#\/darurat$/, renderEmergency],
  [/^#\/laporan$/, renderReport],
  [/^#\/laporan\/kategori\/([0-9a-f-]{36})$/, (id) => renderCategory(id)],
  [/^#\/transaksi$/, renderTransactions],
  [/^#\/anggota$/, renderMembers],
  [/^#\/anggota\/baru$/, () => renderMemberForm(null)],
  [/^#\/anggota\/[0-9a-f-]{36}\/sandi$/, renderOwnPassword],
  [/^#\/anggota\/([0-9a-f-]{36})$/, (id) => renderMemberForm(id)],
  [/^#\/tabungan$/, renderSavings],
  [/^#\/tabungan\/setor$/, renderDeposit],
  [/^#\/tagihan$/, renderBills],
  [/^#\/tagihan\/baru$/, () => renderBillForm(null)],
  [/^#\/tagihan\/([0-9a-f-]{36})$/, (id) => renderBillForm(id)],
];

function resolve(hash) {
  for (const [re, fn] of routes) {
    const mm = re.exec(hash);
    if (mm) return () => fn(...mm.slice(1));
  }
  return renderHome;
}

async function route() {
  const render = resolve(location.hash);
  try {
    await render();
  } catch (ex) {
    if (ex.status === 401) return; // sudah dialihkan ke login
    app.innerHTML = `<div class="screen"><div class="screen-body">
      <div class="error">${esc(ex.message)}</div>
      <button class="btn-primary" type="button" id="retry">Coba lagi</button>
    </div></div>`;
    document.getElementById('retry').addEventListener('click', route);
  }
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
