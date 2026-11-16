import { rupiah, parseRupiah, tanggal, tanggalPendek, selisihHari, esc } from './format.js';

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
  // Layar lain belum dibuat; ditampilkan redup supaya letaknya sesuai desain.
  return `<nav class="tabbar" aria-label="Navigasi utama">
    ${link('#/', 'Beranda')}
    <span aria-disabled="true" title="Belum tersedia">Transaksi</span>
    <a class="fab" href="#/tambah" aria-label="Tambah transaksi">${ICON.plus}</a>
    <span aria-disabled="true" title="Belum tersedia">Darurat</span>
    <span aria-disabled="true" title="Belum tersedia">Laporan</span>
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
  const name = t.note || (t.kind === 'transfer' ? `Transfer ke ${t.to_account_name}` : t.category_name);
  const where = t.kind === 'transfer'
    ? `Transfer · ${t.account_name} → ${t.to_account_name}`
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
  return `<section class="card emergency-card" aria-label="${esc(e.name)}">
    <div class="daily-head">
      <span class="daily-title">${esc(e.name)}</span>
      <span class="warn-text">${e.open_debt > 0 ? `Utang belum lunas ${rupiah(e.open_debt)}` : 'Tidak ada utang'}</span>
    </div>
    <div class="em-track"><div style="width:${pct(e.filled, e.target)}%"></div></div>
    <span class="tile-label">Terisi ${rupiah(e.filled)} dari target ${rupiah(e.target)}${e.open_debt > 0 ? ' · isi ulang saat gajian' : ''}</span>
  </section>`;
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
    <div class="tile">
      <span class="tile-label">Tabungan dan investasi</span>
      <span class="tile-value small">${rupiah(s.savings.deposited)}</span>
      <span class="in tiny">Disetor siklus ini</span>
    </div>
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
          <button class="avatar" id="logout" aria-label="Keluar (login sebagai ${esc(m.user.name)})" title="Keluar">${esc(m.user.name[0] ?? '?')}</button>
          ${cyclePicker}
        </div>
      </div>
      ${s.restricted ? '' : cycleCard(s)}
      ${slider([
        ...(s.cycle.status === 'current' ? s.daily_budgets.map(dailyCard) : []),
        ...(s.restricted || !s.emergency ? [] : [emergencyCard(s.emergency)]),
      ])}
      ${s.restricted ? '' : billsAndSavings(s)}
      <div class="section-head"><h2>Transaksi terbaru</h2></div>
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
  document.getElementById('logout').addEventListener('click', async () => {
    if (!confirm(`Keluar dari akun ${m.user.name}?`)) return;
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    meta = null;
    selectedCycle = null;
    location.hash = '#/login';
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

const KIND_LABEL = { expense: 'Pengeluaran', income: 'Pemasukan', transfer: 'Transfer' };

async function renderAdd() {
  const m = await loadMeta();
  const regular = m.accounts.filter((a) => !a.is_emergency);
  const emergency = m.accounts.find((a) => a.is_emergency);
  const state = { kind: 'expense' };

  const options = (list, selected) => list
    .map((x) => `<option value="${esc(x.id)}"${x.id === selected ? ' selected' : ''}>${esc(x.name)}</option>`)
    .join('');

  app.innerHTML = `<form class="screen" id="add-form" novalidate>
    <div class="screen-body">
      <div class="topbar">
        <h1 class="title">Tambah transaksi</h1>
        <a class="icon-btn" href="#/" aria-label="Tutup">${ICON.close}</a>
      </div>
      <div class="segmented" role="group" aria-label="Jenis transaksi">
        ${Object.entries(KIND_LABEL).map(([k, label]) =>
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
          <label for="to_account">Ke rekening</label>
          <select id="to_account" name="to_account">${options(m.accounts, emergency?.id ?? m.accounts[1]?.id)}</select>
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
    show('row-category', k !== 'transfer');
    show('row-to', k === 'transfer');
    show('expense-toggles', k === 'expense');
    show('row-account', !fromEm);
    show('row-emergency-account', fromEm);
    document.getElementById('account-label').textContent = k === 'income' ? 'Ke rekening' : 'Dari rekening';
    // Transfer boleh dari rekening mana pun, termasuk rekening darurat.
    const accList = k === 'transfer' ? m.accounts : regular;
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
    if (state.kind === 'transfer' && form.account.value === form.to_account.value) {
      return fail('Rekening asal dan tujuan harus berbeda.', form.to_account);
    }

    const isExpense = state.kind === 'expense';
    const body = {
      kind: state.kind,
      amount,
      trx_date: form.trx_date.value,
      account_id: form.account.value || null,
      to_account_id: state.kind === 'transfer' ? form.to_account.value : null,
      category_id: state.kind === 'transfer' ? null : form.category.value,
      note: form.note.value.trim() || null,
      is_one_off: isExpense && form.is_one_off.checked,
      from_emergency: isExpense && !!form.from_emergency?.checked,
    };
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api('/api/trx', { method: 'POST', body });
      location.hash = '#/';
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
              <span class="tile-label">Tiap tanggal ${x.due_dom} · ${esc(x.account_name)}${x.is_active ? '' : ' · nonaktif'}</span>
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
        <label for="b-amount">Nominal tiap bulan</label>
        <input id="b-amount" inputmode="numeric" autocomplete="off" placeholder="Rp 0" value="${v.default_amount ? rupiah(v.default_amount) : ''}">
      </div>
      <div class="card rows">
        <label class="row toggle">
          <span class="text"><span>Nominal berubah tiap bulan</span>
            <span class="tile-label">Mis. listrik. Nominal di atas jadi perkiraan.</span></span>
          <input type="checkbox" id="b-variable"${v.is_variable ? ' checked' : ''}>
        </label>
        <div class="row">
          <label for="b-due">Jatuh tempo</label>
          <select id="b-due">${Array.from({ length: 31 }, (_, i) => opt(String(i + 1), `Tanggal ${i + 1}`, String(v.due_dom))).join('')}</select>
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
      <p class="tile-label">Siklus berjalan 25 sampai 24. Tanggal 25–31 jatuh di awal siklus, tanggal 1–24 di akhir siklus.</p>
    </div>
    <div class="footer"><button class="btn-primary" type="submit">${bill ? 'Simpan perubahan' : 'Simpan tagihan'}</button></div>
  </form>`;

  const f = document.getElementById('bill-form');
  const err = document.getElementById('bill-err');
  const amt = f.querySelector('#b-amount');
  amt.addEventListener('input', () => { const n = parseRupiah(amt.value); amt.value = n ? rupiah(n) : ''; });
  if (!bill) f.querySelector('#b-name').focus();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const name = f.querySelector('#b-name').value.trim();
    if (!name) return fail('Isi nama tagihan.', f.querySelector('#b-name'));
    const body = {
      name,
      default_amount: parseRupiah(amt.value),
      is_variable: f.querySelector('#b-variable').checked,
      due_dom: Number(f.querySelector('#b-due').value),
      remind_days_before: Number(f.querySelector('#b-remind').value),
      category_id: f.querySelector('#b-cat').value,
      account_id: f.querySelector('#b-acc').value,
      is_active: bill ? f.querySelector('#b-active').checked : true,
    };
    if (!body.default_amount && !body.is_variable) return fail('Isi nominalnya.', amt);
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

// ---------- Router ----------

const routes = [
  [/^(#\/?)?$/, renderHome],
  [/^#\/tambah$/, renderAdd],
  [/^#\/login$/, renderLogin],
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
