// Pilihan berupa lembar dari bawah (menggantikan <select> polos): tampil sebagai baris yang bisa ditekan
// dengan ikon dan pilihan saat ini. <select> aslinya tetap ada (tersembunyi) sebagai penyimpan nilai,
// jadi kode form yang membaca/menulis select.value dan mengisi ulang <option> tidak perlu diubah.
import { esc } from './format.js';

const CHEVRON = '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const CLOSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CHECK = '<svg class="check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const FREQUENT = 4; // jumlah pilihan di bagian "Sering dipakai"

let dialog = null;
const normalize = (s) => String(s ?? '').toLowerCase().trim();

function sheet() {
  if (dialog && dialog.isConnected) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'sheet picker-sheet';
  dialog.setAttribute('aria-labelledby', 'picker-title');
  document.body.append(dialog);
  return dialog;
}

/**
 * @param select  elemen <select> yang diperbagus
 * @param cfg { title, mode: 'list'|'grid', searchable, placeholder,
 *              badge(option) -> html, subtitle(option) -> teks, keywords(option) -> [kata] }
 * Atribut data-uses pada <option> (jumlah pemakaian) dipakai untuk bagian "Sering dipakai" di mode grid.
 */
export function enhanceSelect(select, cfg) {
  if (select.dataset.picker) return { refresh: select.refreshPicker };
  select.dataset.picker = '1';
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'picker-btn';
  btn.id = `${select.id || `pick${Math.random().toString(36).slice(2, 7)}`}-picker`;
  btn.setAttribute('aria-haspopup', 'dialog');
  select.after(btn);
  const label = select.id ? document.querySelector(`label[for="${select.id}"]`) : null;
  if (label) label.htmlFor = btn.id; // klik label membuka pilihan

  const refresh = () => {
    const opt = select.selectedOptions?.[0];
    const text = opt && opt.value !== '' ? opt.textContent : (cfg.placeholder ?? 'Pilih');
    btn.innerHTML = `${opt && opt.value !== '' && cfg.badge ? cfg.badge(opt) : ''}<span class="picker-text${opt && opt.value !== '' ? '' : ' muted'}">${esc(text)}</span>${CHEVRON}`;
    btn.setAttribute('aria-label', `${cfg.title}: ${opt && opt.value !== '' ? opt.textContent : 'belum dipilih'}`);
    btn.disabled = select.disabled;
  };
  select.refreshPicker = refresh;
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  select.addEventListener('change', refresh);
  btn.addEventListener('click', () => open(select, cfg, btn));
  refresh();
  return { refresh };
}

function open(select, cfg, trigger) {
  const dlg = sheet();
  const items = [...select.options].filter((o) => !o.disabled && o.value !== '').map((o) => ({
    value: o.value, text: o.textContent, selected: o.selected, uses: Number(o.dataset.uses || 0),
    haystack: normalize([o.textContent, ...(cfg.keywords?.(o) ?? [])].join(' ')), opt: o,
  }));
  const grid = cfg.mode === 'grid';

  const tile = (it) => (grid
    ? `<button type="button" class="pick-tile${it.selected ? ' on' : ''}" data-value="${esc(it.value)}" aria-pressed="${it.selected}">
        ${cfg.badge ? cfg.badge(it.opt) : ''}<span class="pick-label">${esc(it.text)}</span></button>`
    : `<button type="button" class="pick-row${it.selected ? ' on' : ''}" data-value="${esc(it.value)}" aria-pressed="${it.selected}">
        ${cfg.badge ? cfg.badge(it.opt) : ''}
        <span class="pick-main"><span class="pick-name">${esc(it.text)}</span>${cfg.subtitle?.(it.opt) ? `<span class="pick-sub">${esc(cfg.subtitle(it.opt))}</span>` : ''}</span>
        ${it.selected ? CHECK : ''}</button>`);
  const group = (title, list) => `<section class="pick-group" aria-label="${esc(title)}"><h3 class="pick-head">${esc(title)}</h3><div class="${grid ? 'pick-grid' : 'pick-list'}">${list.map(tile).join('')}</div></section>`;

  function results(query) {
    const q = normalize(query);
    if (q) {
      const hit = items.filter((it) => it.haystack.includes(q));
      return hit.length ? `<div class="${grid ? 'pick-grid' : 'pick-list'}">${hit.map(tile).join('')}</div>` : '<p class="empty">Tidak ditemukan.</p>';
    }
    const frequent = grid ? [...items].filter((it) => it.uses > 0).sort((a, b) => b.uses - a.uses || a.text.localeCompare(b.text)).slice(0, FREQUENT) : [];
    const all = [...items].sort((a, b) => a.text.localeCompare(b.text));
    return (frequent.length ? group('Sering dipakai', frequent) : '') + (grid ? group(frequent.length ? 'Semua' : 'Semua pilihan', all) : `<div class="pick-list">${items.map(tile).join('')}</div>`);
  }

  dlg.innerHTML = `<div class="sheet-body picker-body">
    <div class="picker-top"><h2 id="picker-title" class="title" tabindex="-1" autofocus>${esc(cfg.title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Tutup">${CLOSE}</button></div>
    ${cfg.searchable ? `<input class="picker-search" type="search" placeholder="Cari…" aria-label="Cari ${esc(cfg.title)}" autocomplete="off">` : ''}
    <div class="picker-results">${results('')}</div>
  </div>`;

  const box = dlg.querySelector('.picker-results');
  dlg.querySelector('.picker-search')?.addEventListener('input', (e) => { box.innerHTML = results(e.target.value); });
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    select.value = b.dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    dlg.close();
  });
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); }; // tekan di luar lembar = tutup
  dlg.addEventListener('close', () => trigger.focus?.(), { once: true });
  dlg.showModal();
}
