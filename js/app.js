"use strict";
/* =========================================================
   DR Darre – Sistema de vendas v3
   Offline-first: grava no aparelho (IndexedDB) e sincroniza
   com o Supabase quando há internet e login feito.
   ========================================================= */

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(+v || 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const sum = a => a.reduce((s, x) => s + (+x || 0), 0);
const nowISO = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const rnd = n => Array.from({ length: n }, () => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 32 | 0]).join('');
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const parseNum = s => { s = String(s ?? '').replace(/[R$\s]/g, ''); if (!s) return 0; if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDT = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtHora = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const soDigitos = s => String(s ?? '').replace(/\D/g, '');
const telWa = s => { let d = soDigitos(s); if (!d) return ''; if (d.length <= 11) d = '55' + d; return d; };
function parseBR(s) { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[^\d]*(\d{1,2})?:?(\d{2})?:?(\d{2})?/); if (!m) return null; const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0)); return isNaN(d) ? null : d.toISOString(); }

// ---------- armazenamento local (IndexedDB com reserva em localStorage) ----------
const KV = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('prdarre', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    catch { try { return JSON.parse(localStorage.getItem('prd:' + k)); } catch { return null; } }
  },
  async set(k, v) {
    try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
    catch { try { localStorage.setItem('prd:' + k, JSON.stringify(v)); } catch { toast('Sem espaço para salvar neste aparelho. Faça um backup.', 'bad'); } }
  },
  async del(k) { try { const db = await this.open(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; }); } catch {} localStorage.removeItem('prd:' + k); }
};

// ---------- estado ----------
const DEF_CFG = {
  nome: 'DR Darre', subtitulo: 'Moda & acessórios', whatsapp: '', instagram: '',
  rodape: 'Obrigada pela preferência! Trocas em até 7 dias com a etiqueta.',
  tipos: ['Blusa', 'Vestido', 'Calça', 'Saia', 'Short', 'Macacão', 'Conjunto', 'Jaqueta', 'Body', 'Acessório'],
  tamanhos: ['PP', 'P', 'M', 'G', 'GG', 'XG', 'Único'],
  vendedores: ['Regina', 'Bianca']
};
const TABELAS = ['produtos', 'ajustes', 'vendas', 'config'];
let S = novoEstado();
function novoEstado() {
  return {
    v: 3, produtos: {}, vendas: {}, ajustes: {}, movs: {}, vendedor: '',
    config: { id: 'loja', valor: { ...DEF_CFG } },
    outbox: { produtos: {}, ajustes: {}, vendas: {}, config: {} },
    cursor: { produtos: '', vendas: '', config: '', ajustes: '' },
    cloud: null, lastUrl: null, lastSync: null, tema: 'auto'
  };
}
const persist = debounce(() => KV.set('state', S), 250);
function salvarJa() { return KV.set('state', S); }
function dirty(t, id) { S.outbox[t][id] = (S.outbox[t][id] || 0) + 1; persist(); pintarSync(); agendarSync(); }
// cada ajuste de estoque vira uma movimentação: vai para a nuvem (S.ajustes, apagado após o envio)
// e fica no histórico deste aparelho (S.movs, usado na aba Estoque e na consulta)
function addAjuste(produto_id, delta, motivo, extra = {}) {
  if (!delta) return;
  const id = uid();
  const a = { id, produto_id, delta: Math.trunc(delta), motivo: motivo || null, created_at: nowISO(),
    tipo: extra.tipo || (motivo === 'Cadastro' ? 'cadastro' : motivo === 'Ajuste manual' ? 'ajuste' : 'carga'),
    venda_id: extra.venda_id || null, cliente: extra.cliente || null, vendedor: extra.vendedor || null, valor: extra.valor ?? null };
  S.ajustes[id] = a; S.movs[id] = { ...a };
  dirty('ajustes', id);
}
const tipoMov = a => a.tipo || (a.motivo === 'Cadastro' ? 'cadastro' : a.motivo === 'Ajuste manual' ? 'ajuste' : 'carga');
const NOME_MOV = { cadastro: 'Cadastro', entrada: 'Entrada', ajuste: 'Ajuste', devolucao: 'Devolução', carga: 'Carga', venda: 'Venda' };
const cfg = () => S.config.valor;
const ativos = () => Object.values(S.produtos).filter(p => !p.deleted);
const nomeP = p => (p.descricao && p.descricao.trim()) || p.tipo || 'Peça';
const ordTam = t => { const i = cfg().tamanhos.indexOf(t); return i < 0 ? 99 : i; };
const validas = () => Object.values(S.vendas).filter(v => !v.cancelada);
const pendentes = () => sum(Object.values(S.outbox).map(o => Object.keys(o).length));
function porCodigo(c) { c = String(c || '').trim().toUpperCase(); if (!c) return null; return ativos().find(p => String(p.codigo).toUpperCase() === c) || null; }
function novoCodigo(tipo) {
  const pre = (norm(tipo).replace(/[^a-z]/g, '').slice(0, 3) || 'pca').toUpperCase().padEnd(3, 'X');
  let c; do { c = `${pre}-${rnd(5)}`; } while (porCodigo(c));
  return c;
}

// ---------- migração do sistema v2 (localStorage 'pr-darre-dados') ----------
function importarV2(d) {
  let np = 0, nv = 0; const porCod = {};
  Object.values(S.produtos).forEach(p => porCod[p.codigo] = p.id);
  (d.pecas || []).forEach(p => {
    if (porCod[p.codigo]) return;
    const id = uid();
    S.produtos[id] = { id, codigo: String(p.codigo || novoCodigo(p.tipo)), tipo: p.tipo || 'Peça', descricao: '', tamanho: p.tamanho || '', cor: p.cor || '',
      preco: r2(p.valor), custo: null, qtd: Math.trunc(+p.quantidade || 0), estoque_min: 2, deleted: false, created_at: parseBR(p.dataCadastro) || nowISO() };
    porCod[p.codigo] = id; dirty('produtos', id); addAjuste(id, S.produtos[id].qtd, 'Importado do sistema anterior', { tipo: 'carga' }); np++;
  });
  (d.vendas || []).forEach(v => {
    const agrup = {};
    (v.itens || []).forEach(i => { const k = i.codigo; agrup[k] = agrup[k] || { ...i, q: 0 }; agrup[k].q++; });
    const id = uid();
    S.vendas[id] = { id, numero: 'A-' + String(v.id).padStart(4, '0'), data: parseBR(v.data) || nowISO(),
      itens: Object.values(agrup).map(i => ({ produto_id: porCod[i.codigo] || null, codigo: i.codigo, nome: i.tipo, tamanho: i.tamanho || '', cor: i.cor || '', preco: r2(i.valor), custo: null, qtd: i.q })),
      subtotal: r2(v.subtotal), desconto: r2(v.desconto), desconto_tipo: '%', total: r2(v.total), forma: v.formaPagamento || '', parcelas: 1,
      recebido: null, troco: null, cliente_nome: null, cliente_tel: null, cancelada: false, baixa_estoque: false };
    dirty('vendas', id); nv++;
  });
  return { np, nv };
}

// ---------- nuvem (Supabase via REST, sem biblioteca) ----------
const Cloud = {
  pronto() { return !!(S.cloud && S.cloud.url && S.cloud.key && S.cloud.refresh); },
  async auth(body, grant) {
    const r = await fetch(`${S.cloud.url}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: S.cloud.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (grant === 'refresh_token') { S.cloud.refresh = null; S.cloud.access = null; persist(); }
      const m = j.error_description || j.msg || j.message || j.error || ('erro ' + r.status);
      throw new Error(/invalid login|invalid_grant|credentials/i.test(m) ? 'E-mail ou senha incorretos.' : m);
    }
    Object.assign(S.cloud, { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, email: j.user?.email || S.cloud.email });
    persist();
  },
  async token(force) {
    if (force || !S.cloud.access || Date.now() > (S.cloud.exp || 0) - 60000) await this.auth({ refresh_token: S.cloud.refresh }, 'refresh_token');
    return S.cloud.access;
  },
  async req(path, opt = {}, retry = true) {
    const t = await this.token();
    const r = await fetch(`${S.cloud.url}/rest/v1/${path}`, { ...opt, headers: { apikey: S.cloud.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    if (r.status === 401 && retry) { await this.token(true); return this.req(path, opt, false); }
    const txt = await r.text();
    if (!r.ok) { let m = txt; try { const j = JSON.parse(txt); m = [j.code, j.message, j.hint].filter(Boolean).join(' '); } catch {} throw new Error(`${r.status} ${m}`.trim()); }
    return txt ? JSON.parse(txt) : null;
  }
};
const PICK = {
  produtos: p => ({ id: p.id, codigo: p.codigo, tipo: p.tipo ?? null, descricao: p.descricao ?? null, tamanho: p.tamanho ?? null, cor: p.cor ?? null,
    preco: r2(p.preco), custo: p.custo == null ? null : r2(p.custo), estoque_min: Math.trunc(+p.estoque_min || 0), deleted: !!p.deleted, created_at: p.created_at || nowISO() }),
  ajustes: a => ({ id: a.id, produto_id: a.produto_id, delta: a.delta, motivo: a.motivo ?? null, created_at: a.created_at,
    tipo: tipoMov(a), venda_id: a.venda_id ?? null, cliente: a.cliente ?? null, vendedor: a.vendedor ?? null, valor: a.valor == null ? null : r2(a.valor) }),
  vendas: v => ({ id: v.id, numero: v.numero, data: v.data, itens: v.itens, subtotal: r2(v.subtotal), desconto: r2(v.desconto), desconto_tipo: v.desconto_tipo ?? null,
    total: r2(v.total), forma: v.forma ?? null, parcelas: v.parcelas || 1, recebido: v.recebido ?? null, troco: v.troco ?? null,
    cliente_nome: v.cliente_nome ?? null, cliente_tel: v.cliente_tel ?? null, vendedor: v.vendedor ?? null, cancelada: !!v.cancelada, baixa_estoque: v.baixa_estoque !== false }),
  config: () => ({ id: 'loja', valor: S.config.valor })
};
const FONTE = { produtos: id => S.produtos[id], ajustes: id => S.ajustes[id], vendas: id => S.vendas[id], config: id => id === 'loja' ? S.config : null };

async function enviar(t) {
  const ids = Object.keys(S.outbox[t]); if (!ids.length) return;
  const snap = { ...S.outbox[t] };
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const rows = lote.map(id => FONTE[t](id)).filter(Boolean).map(PICK[t]);
    if (rows.length) {
      const pref = t === 'ajustes' ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates';
      await Cloud.req(`${t}?on_conflict=id`, { method: 'POST', headers: { Prefer: pref + ',return=minimal' }, body: JSON.stringify(rows) });
    }
    lote.forEach(id => { if (S.outbox[t][id] === snap[id]) { delete S.outbox[t][id]; if (t === 'ajustes') delete S.ajustes[id]; } });
    persist();
  }
}
function produtosEmUso() {
  const s = new Set();
  Object.keys(S.outbox.vendas).forEach(id => (S.vendas[id]?.itens || []).forEach(i => i.produto_id && s.add(i.produto_id)));
  Object.values(S.ajustes).forEach(a => s.add(a.produto_id));
  return s;
}
async function receber(t) {
  let from = S.cursor[t] ? new Date(new Date(S.cursor[t]).getTime() - 120000).toISOString() : '';
  for (let pag = 0; pag < 40; pag++) {
    const rows = await Cloud.req(`${t}?select=*&order=updated_at.asc,id.asc&limit=1000` + (from ? `&updated_at=gte.${encodeURIComponent(from)}` : ''));
    if (!rows || !rows.length) break;
    const emUso = t === 'produtos' ? produtosEmUso() : null;
    for (const r of rows) {
      if (t === 'config') { if (r.id === 'loja' && !S.outbox.config.loja) S.config = { id: 'loja', valor: { ...DEF_CFG, ...(r.valor || {}) }, updated_at: r.updated_at }; continue; }
      if (t === 'ajustes') { S.movs[r.id] = r; continue; }            // só histórico: o estoque já vem certo em produtos.qtd
      if (S.outbox[t][r.id]) continue;
      if (t === 'produtos' && emUso.has(r.id) && S.produtos[r.id]) { S.produtos[r.id] = { ...r, qtd: S.produtos[r.id].qtd }; continue; }
      S[t][r.id] = r;
    }
    const ult = rows[rows.length - 1].updated_at;
    if (!S.cursor[t] || ult > S.cursor[t]) S.cursor[t] = ult;
    if (rows.length < 1000 || ult === from) break;
    from = ult;
  }
}
let sincronizando = false, deNovo = false;
async function sync(manual) {
  if (!Cloud.pronto()) { pintarSync(); if (manual) toast('Conecte a nuvem em Ajustes para sincronizar.', 'warn'); return; }
  if (!navigator.onLine) { pintarSync(); if (manual) toast('Sem internet. As alterações ficam guardadas e sobem sozinhas quando a conexão voltar.', 'warn'); return; }
  if (sincronizando) { deNovo = true; return; }
  sincronizando = true; pintarSync('sync');
  try {
    for (const t of TABELAS) await enviar(t);           // produtos → ajustes → vendas → config
    for (const t of ['produtos', 'vendas', 'config', 'ajustes']) await receber(t);
    S.lastSync = nowISO(); S.cloud.erro = null; persist();
    renderDados();
    if (manual) toast('Tudo sincronizado com a nuvem.', 'ok');
  } catch (e) {
    console.error(e);
    if (S.cloud) S.cloud.erro = e.message;
    if (manual || !Cloud.pronto()) toast(Cloud.pronto() ? 'Não foi possível sincronizar: ' + traduzErro(e.message) : 'Sua sessão na nuvem expirou. Entre novamente em Ajustes.', 'bad');
  } finally {
    sincronizando = false; pintarSync(); if (vista === 'ajustes') pintarNuvem();
    if (deNovo) { deNovo = false; setTimeout(sync, 400); }
  }
}
const agendarSync = debounce(() => sync(), 1500);
function traduzErro(m) {
  if (/PGRST204|42703|column .* does not exist|Could not find the '/i.test(m)) return 'o banco da nuvem precisa da atualização desta versão (vendedora e devoluções). Rode de novo o script SQL (Ajustes › Como preparar a nuvem).';
  if (/PGRST205|42P01|does not exist|schema cache/i.test(m)) return 'as tabelas não existem no Supabase. Rode o script SQL (Ajustes › Como preparar a nuvem).';
  if (/42501|row-level security|permission/i.test(m)) return 'sem permissão. Confira se o script SQL foi executado por completo.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'não foi possível alcançar o servidor. Confira o endereço do projeto e a internet.';
  return m;
}
function reenviarTudo() {
  S.ajustes = {}; S.outbox = { produtos: {}, ajustes: {}, vendas: {}, config: { loja: 1 } };
  S.cursor = { produtos: '', vendas: '', config: '', ajustes: '' };
  Object.values(S.produtos).forEach(p => { S.outbox.produtos[p.id] = 1; if (p.qtd) addAjuste(p.id, p.qtd, 'Carga inicial deste aparelho', { tipo: 'carga' }); });
  Object.values(S.vendas).forEach(v => { v.baixa_estoque = false; S.outbox.vendas[v.id] = 1; });
  persist();
}
function pintarSync(forcar) {
  const el = $('#sync-pill'); const n = pendentes();
  let s, txt;
  if (!S.cloud || !S.cloud.url) { s = 'local'; txt = 'Só neste aparelho'; }
  else if (!S.cloud.refresh) { s = 'login'; txt = 'Entre na nuvem'; }
  else if (forcar === 'sync' || sincronizando) { s = 'sync'; txt = 'Sincronizando…'; }
  else if (!navigator.onLine) { s = 'offline'; txt = n ? `Sem internet, ${n} ${n === 1 ? 'pendente' : 'pendentes'}` : 'Sem internet'; }
  else if (S.cloud.erro) { s = 'erro'; txt = 'Erro na nuvem'; }
  else if (n) { s = 'pend'; txt = `${n} ${n === 1 ? 'alteração' : 'alterações'} a enviar`; }
  else { s = 'ok'; txt = 'Salvo na nuvem'; }
  el.dataset.s = s; el.querySelector('span').textContent = txt;
  el.title = S.lastSync ? 'Última sincronização: ' + fmtDT(S.lastSync) : 'Sincronização';
}

// ---------- avisos e diálogos ----------
const toasts = $('#toasts');
function toast(msg, kind = '', act) {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (act) { const b = document.createElement('button'); b.type = 'button'; b.textContent = act.label; b.onclick = () => { act.fn(); t.remove(); }; t.append(b); }
  toasts.append(t);
  if (toasts.showPopover) { try { toasts.hidePopover(); } catch {} try { toasts.showPopover(); } catch {} }
  const vida = act ? 7000 : 3400;
  setTimeout(() => t.classList.add('out'), vida); setTimeout(() => t.remove(), vida + 350);
}
const dlg = $('#dlg');
function abrirDlg(html, onClose) {
  dlg.innerHTML = html; dlg.onclose = () => { onClose && onClose(); dlg.innerHTML = ''; };
  dlg.showModal();
}
dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
function confirmar(msg, { ok = 'Confirmar', perigo = false } = {}) {
  return new Promise(res => {
    const d = $('#dlg-confirm');
    d.innerHTML = `<div class="dlg-body sm"><p style="font-size:16px">${esc(msg)}</p><div class="dlg-foot"><span class="grow"></span><button class="btn ghost" type="button" value="0">Voltar</button><button class="btn ${perigo ? 'danger' : 'primary'}" type="button" value="1">${esc(ok)}</button></div></div>`;
    d.returnValue = '';
    d.querySelectorAll('button').forEach(b => b.onclick = () => d.close(b.value));
    d.onclose = () => res(d.returnValue === '1');
    d.showModal(); d.querySelector('[value="1"]').focus();
  });
}
function baixar(nome, conteudo, tipo) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo })); a.download = nome;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- navegação ----------
const VISTAS = ['inicio', 'vender', 'produtos', 'estoque', 'vendas', 'ajustes'];
let vista = 'inicio';
function mostrar() {
  vista = VISTAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'inicio';
  VISTAS.forEach(v => $('#v-' + v).hidden = v !== vista);
  $$('#nav button').forEach(b => b.dataset.go === vista ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  window.scrollTo(0, 0);
  if (vista === 'ajustes') rAjustes(); else renderDados();
  if (vista === 'vender' && matchMedia('(pointer:fine)').matches) setTimeout(() => $('#busca').focus(), 30);
  if (vista === 'estoque' && matchMedia('(pointer:fine)').matches) setTimeout(() => $('#cons-busca').focus(), 30);
}
function ir(v) { if (location.hash === '#' + v) mostrar(); else location.hash = v; }
function renderDados() {
  pintarMarca(); pintarSync(); listasAux();
  if (vista === 'inicio') rInicio();
  if (vista === 'vender') rCarrinho();
  if (vista === 'produtos') rProdutos();
  if (vista === 'estoque') rEstoque();
  if (vista === 'vendas') rVendas();
  if (vista === 'ajustes') pintarNuvem();
}
function pintarMarca() { $('#brand-nome').textContent = cfg().nome || 'DR Darre'; $('#brand-sub').textContent = cfg().subtitulo || ''; document.title = (cfg().nome || 'DR Darre') + ' – Sistema de vendas'; }
function listasAux() {
  $('#dl-tipos').innerHTML = cfg().tipos.map(t => `<option value="${esc(t)}">`).join('');
  const cores = [...new Set(ativos().map(p => p.cor).filter(Boolean))].sort();
  $('#dl-cores').innerHTML = cores.map(c => `<option value="${esc(c)}">`).join('');
  const cli = {}; Object.values(S.vendas).forEach(v => { if (v.cliente_nome) cli[v.cliente_nome] = v.cliente_tel || cli[v.cliente_nome] || ''; });
  $('#dl-clientes').innerHTML = Object.keys(cli).sort().map(n => `<option value="${esc(n)}">`).join('');
  listasAux.clientes = cli;
  pintarVendedoras();
  const fv = $('#per-vend'), fvv = fv.value;
  const nomes = [...new Set([...vendedoras(), ...Object.values(S.vendas).map(v => v.vendedor).filter(Boolean)])];
  fv.innerHTML = '<option value="">Todas as vendedoras</option>' + nomes.map(n => `<option ${n === fvv ? 'selected' : ''}>${esc(n)}</option>`).join('') + '<option value="-">Sem vendedora</option>';
  if (fvv === '-') fv.value = '-';
}
const vendedoras = () => (cfg().vendedores && cfg().vendedores.length ? cfg().vendedores : DEF_CFG.vendedores);

// ---------- INÍCIO ----------
function rInicio() {
  const hoje = new Date(), k = dayKey(hoje), vs = validas();
  const hv = vs.filter(v => dayKey(new Date(v.data)) === k);
  const fat = sum(hv.map(v => v.total)), pcs = sum(hv.flatMap(v => v.itens.map(i => i.qtd)));
  const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const mv = vs.filter(v => new Date(v.data) >= ini);
  const prods = ativos(), est = sum(prods.map(p => Math.max(0, p.qtd)));
  const baixo = prods.filter(p => p.qtd <= (p.estoque_min || 0)).sort((a, b) => a.qtd - b.qtd);
  const ult = Object.values(S.vendas).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6);
  $('#v-inicio').innerHTML = `
    <div class="hero">
      <p class="hero-date">${(d => d[0].toUpperCase() + d.slice(1))(hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
      <p class="hero-num">${money(fat)}</p>
      <p class="hero-cap">${hv.length ? `vendidos hoje em ${hv.length} ${hv.length === 1 ? 'venda' : 'vendas'}, ${pcs} ${pcs === 1 ? 'peça' : 'peças'}` : 'Nenhuma venda hoje ainda.'}</p>
      <div class="hero-actions"><a class="btn primary lg" href="#vender">Nova venda</a><button class="btn ghost lg" type="button" data-act="nova-peca">Cadastrar peça</button>${pedidoInstalar && !instalado() ? '<button class="btn ghost lg" type="button" data-act="instalar">Instalar aplicativo</button>' : ''}</div>
    </div>
    <div class="stats">
      <div><span>Vendido no mês</span><strong>${money(sum(mv.map(v => v.total)))}</strong><small>${mv.length} ${mv.length === 1 ? 'venda' : 'vendas'}</small></div>
      <div><span>Ticket médio hoje</span><strong>${money(hv.length ? fat / hv.length : 0)}</strong></div>
      <div><span>Peças em estoque</span><strong>${est}</strong><small>${prods.length} ${prods.length === 1 ? 'item cadastrado' : 'itens cadastrados'}</small></div>
    </div>
    <div class="two">
      <section class="panel"><h2>Estoque acabando</h2>
        ${baixo.length ? `<ul class="mini">${baixo.slice(0, 7).map(p => `<li><button class="grow" type="button" data-edit="${p.id}"><strong>${esc(nomeP(p))}</strong><span class="meta"><span>${esc(p.tamanho)}</span><span>${esc(p.cor)}</span></span></button><span class="tag ${p.qtd <= 0 ? 'bad' : 'warn'}">${p.qtd <= 0 ? 'esgotado' : p.qtd + ' un'}</span></li>`).join('')}</ul>
          ${baixo.length > 7 ? `<button class="link" type="button" data-act="ver-baixo">Ver as ${baixo.length} peças</button>` : ''}`
          : `<p class="muted">${prods.length ? 'Nenhuma peça abaixo do estoque mínimo.' : 'Cadastre as peças da loja para acompanhar o estoque aqui.'}</p>`}
      </section>
      <section class="panel"><h2>Últimas vendas</h2>
        ${ult.length ? `<ul class="mini">${ult.map(v => `<li><button class="grow" type="button" data-venda="${v.id}"><strong>${esc(v.cliente_nome || resumoItens(v))}</strong><span class="meta"><span>${fmtHora(v.data)}${dayKey(new Date(v.data)) === k ? '' : ', ' + new Date(v.data).toLocaleDateString('pt-BR')}</span><span>${esc(v.forma)}</span></span></button>${v.cancelada ? '<span class="tag bad">cancelada</span>' : `<b class="num">${money(v.total)}</b>`}</li>`).join('')}</ul>`
          : '<p class="muted">As vendas finalizadas aparecem aqui.</p>'}
      </section>
    </div>`;
}
const resumoItens = v => { const n = sum(v.itens.map(i => i.qtd)); const p = v.itens[0]; return p ? `${p.nome}${n > 1 ? ` + ${n - 1}` : ''}` : 'Venda'; };

// ---------- VENDER ----------
let carrinho = [], descTipo = '%', forma = '', sugs = [], sugIx = -1;
const busca = $('#busca');
function buscarProdutos(q, lim = 8) {
  const termos = norm(q).split(/\s+/).filter(Boolean); if (!termos.length) return [];
  return ativos().map(p => ({ p, h: norm(`${p.codigo} ${p.tipo} ${p.descricao} ${p.tamanho} ${p.cor}`) }))
    .filter(x => termos.every(t => x.h.includes(t)))
    .sort((a, b) => (b.p.qtd > 0) - (a.p.qtd > 0) || nomeP(a.p).localeCompare(nomeP(b.p)) || ordTam(a.p.tamanho) - ordTam(b.p.tamanho))
    .slice(0, lim).map(x => x.p);
}
function pintarSugs() {
  const box = $('#sugs');
  if (!sugs.length) { box.hidden = true; return; }
  box.innerHTML = sugs.map((p, i) => `<button type="button" class="sug ${p.qtd <= 0 ? 'zero' : ''}" role="option" aria-selected="${i === sugIx}" data-i="${i}">
    <strong>${esc(nomeP(p))}</strong><span class="r">${money(p.preco)}</span>
    <span class="meta"><span>${esc(p.tamanho)}</span><span>${esc(p.cor)}</span><span class="code">${esc(p.codigo)}</span></span><span class="r muted" style="font-size:13px">${p.qtd <= 0 ? 'sem estoque' : p.qtd + ' em estoque'}</span></button>`).join('');
  box.hidden = false;
}
busca.addEventListener('input', () => { sugs = buscarProdutos(busca.value); sugIx = sugs.length ? 0 : -1; pintarSugs(); });
busca.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!sugs.length) return; e.preventDefault(); sugIx = (sugIx + (e.key === 'ArrowDown' ? 1 : -1) + sugs.length) % sugs.length; pintarSugs(); }
  else if (e.key === 'Escape') { sugs = []; pintarSugs(); }
  else if (e.key === 'Enter' && !e.ctrlKey) {
    e.preventDefault(); const v = busca.value.trim(); if (!v) return;
    const p = porCodigo(v) || (sugs.length ? sugs[Math.max(0, sugIx)] : null);
    if (p) adicionar(p); else toast(`Nenhuma peça encontrada para “${v}”.`, 'warn');
  }
});
busca.addEventListener('blur', () => setTimeout(() => { sugs = []; pintarSugs(); }, 180));
$('#sugs').addEventListener('mousedown', e => e.preventDefault());
$('#sugs').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) adicionar(sugs[+b.dataset.i]); });
function adicionar(p, q = 1) {
  const it = carrinho.find(i => i.produto_id === p.id);
  const nova = (it ? it.qtd : 0) + q;
  if (nova > p.qtd) { toast(p.qtd <= 0 ? `${nomeP(p)} ${p.tamanho} está sem estoque.` : `Só há ${p.qtd} em estoque de ${nomeP(p)} ${p.tamanho}.`, 'warn', { label: 'Ajustar estoque', fn: () => abrirProduto(p.id) }); return; }
  if (it) it.qtd = nova; else carrinho.push({ produto_id: p.id, qtd: q });
  busca.value = ''; sugs = []; pintarSugs(); rCarrinho();
  if (navigator.vibrate) navigator.vibrate(15);
}
function rCarrinho() {
  carrinho = carrinho.filter(i => S.produtos[i.produto_id] && !S.produtos[i.produto_id].deleted);
  const el = $('#cart');
  el.innerHTML = !carrinho.length
    ? `<div class="empty cart-empty"><strong>Venda vazia</strong>Leia o QR code da etiqueta, use o leitor ou digite o código ou nome da peça.</div>`
    : `<ul class="cart">${carrinho.map((i, ix) => { const p = S.produtos[i.produto_id]; return `<li>
        <div class="ci-info"><strong>${esc(nomeP(p))}</strong><span class="meta"><span>${esc(p.tamanho)}</span><span>${esc(p.cor)}</span><span class="code">${esc(p.codigo)}</span><span>${money(p.preco)} un</span></span></div>
        <div class="step"><button type="button" data-dec="${ix}" aria-label="Diminuir">−</button><span>${i.qtd}</span><button type="button" data-inc="${ix}" aria-label="Aumentar">+</button></div>
        <strong class="ci-price">${money(p.preco * i.qtd)}</strong>
        <button class="x" type="button" data-rm="${ix}" aria-label="Remover">×</button></li>`; }).join('')}</ul>`;
  rTotais();
}
$('#cart').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.inc) { const i = carrinho[+b.dataset.inc]; adicionar(S.produtos[i.produto_id]); }
  if (b.dataset.dec) { const i = carrinho[+b.dataset.dec]; i.qtd--; if (i.qtd <= 0) carrinho.splice(+b.dataset.dec, 1); rCarrinho(); }
  if (b.dataset.rm) { carrinho.splice(+b.dataset.rm, 1); rCarrinho(); }
});
function calc() {
  const sub = r2(sum(carrinho.map(i => (S.produtos[i.produto_id]?.preco || 0) * i.qtd)));
  const dv = Math.max(0, parseNum($('#desc').value));
  const desc = r2(Math.min(sub, descTipo === '%' ? sub * Math.min(dv, 100) / 100 : dv));
  return { sub, desc, tot: r2(sub - desc) };
}
function rTotais() {
  const { sub, tot } = calc();
  $('#t-sub').textContent = money(sub); $('#t-tot').textContent = money(tot);
  if (forma === 'Dinheiro') pintarTroco();
  if (forma === 'Crédito') { const s = $('#parc'); if (s) { const v = s.value; s.innerHTML = opcoesParcelas(tot); s.value = v; } }
}
const opcoesParcelas = tot => Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}x de ${money(tot / (i + 1))}</option>`).join('');
$('#desc').addEventListener('input', rTotais);
$('#desc-tipo').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; descTipo = b.dataset.v; $$('#desc-tipo button').forEach(x => x.setAttribute('aria-pressed', x === b)); rTotais(); });
$('#pgto').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; forma = b.dataset.v;
  $$('#pgto button').forEach(x => x.setAttribute('aria-pressed', x === b));
  const ex = $('#pg-extra');
  if (forma === 'Crédito') ex.innerHTML = `<label>Parcelas<select id="parc">${opcoesParcelas(calc().tot)}</select></label>`;
  else if (forma === 'Dinheiro') { ex.innerHTML = `<label>Valor recebido<input id="receb" inputmode="decimal" placeholder="0,00"></label><div class="troco" id="troco"></div>`; $('#receb').addEventListener('input', pintarTroco); pintarTroco(); if (matchMedia('(pointer:fine)').matches) $('#receb').focus(); }
  else ex.innerHTML = '';
});
function pintarTroco() {
  const el = $('#troco'); if (!el) return; const rec = parseNum($('#receb').value), { tot } = calc();
  if (!rec) { el.innerHTML = ''; el.className = 'troco'; return; }
  const t = r2(rec - tot); el.className = 'troco' + (t < 0 ? ' bad' : '');
  el.innerHTML = t < 0 ? `<span>Faltam</span><span>${money(-t)}</span>` : `<span>Troco</span><span>${money(t)}</span>`;
}
// vendedora: fica escolhida neste aparelho de uma venda para outra
function pintarVendedoras() {
  const el = $('#vend'); if (!el) return;
  const ls = vendedoras(), sel = S.vendedor || '';
  el.style.gridTemplateColumns = `repeat(${Math.min(ls.length + 1, 4)},1fr)`;
  el.innerHTML = [...ls, 'Outros'].map(n => `<button type="button" data-v="${esc(n)}" aria-pressed="${n === sel}">${esc(n)}</button>`).join('');
  $('#vend-outro').hidden = sel !== 'Outros';
}
$('#vend').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.vendedor = b.dataset.v; persist(); pintarVendedoras();
  if (S.vendedor === 'Outros') { $('#vend-outro').value = S.vendedorOutro || ''; $('#vend-outro').focus(); }
});
$('#vend-outro').addEventListener('input', e => { S.vendedorOutro = e.target.value; persist(); });
function vendedorAtual() { return S.vendedor === 'Outros' ? ($('#vend-outro').value.trim()) : (S.vendedor || ''); }
$('#cli-nome').addEventListener('change', e => { const t = (listasAux.clientes || {})[e.target.value]; if (t && !$('#cli-tel').value) $('#cli-tel').value = t; });
function limparVenda() {
  carrinho = []; forma = ''; descTipo = '%';
  $('#desc').value = ''; $('#pg-extra').innerHTML = ''; $('#cli-nome').value = ''; $('#cli-tel').value = ''; $('details.cli').open = false;
  $$('#pgto button').forEach(x => x.setAttribute('aria-pressed', 'false'));
  $$('#desc-tipo button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === '%'));
  rCarrinho();
}
$('#btn-limpar').addEventListener('click', async () => { if (!carrinho.length || await confirmar('Limpar os itens desta venda?', { ok: 'Limpar venda', perigo: true })) limparVenda(); });
$('#btn-fin').addEventListener('click', finalizar);
function finalizar() {
  if (!carrinho.length) return toast('Adicione pelo menos uma peça à venda.', 'warn');
  if (!forma) { toast('Escolha a forma de pagamento.', 'warn'); $('#pgto button').focus(); return; }
  const vendedor = vendedorAtual();
  if (!vendedor) { toast(S.vendedor === 'Outros' ? 'Escreva o nome de quem vendeu.' : 'Escolha quem fez a venda.', 'warn'); (S.vendedor === 'Outros' ? $('#vend-outro') : $('#vend button')).focus(); return; }
  for (const i of carrinho) { const p = S.produtos[i.produto_id]; if (i.qtd > p.qtd) return toast(`Estoque insuficiente de ${nomeP(p)} ${p.tamanho}.`, 'bad'); }
  const { sub, desc, tot } = calc();
  let recebido = null, troco = null;
  if (forma === 'Dinheiro') { recebido = parseNum($('#receb')?.value) || null; if (recebido != null) { if (recebido < tot) return toast(`O valor recebido é menor que o total (${money(tot)}).`, 'warn'); troco = r2(recebido - tot); } }
  const d = new Date(), id = uid();
  const v = {
    id, numero: `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${rnd(4)}`,
    data: d.toISOString(),
    itens: carrinho.map(i => { const p = S.produtos[i.produto_id]; return { produto_id: p.id, codigo: p.codigo, nome: nomeP(p), tamanho: p.tamanho, cor: p.cor, preco: r2(p.preco), custo: p.custo ?? null, qtd: i.qtd }; }),
    subtotal: sub, desconto: desc, desconto_tipo: descTipo, total: tot, forma, parcelas: forma === 'Crédito' ? +($('#parc')?.value || 1) : 1,
    recebido, troco, cliente_nome: $('#cli-nome').value.trim() || null, cliente_tel: soDigitos($('#cli-tel').value) || null, vendedor, cancelada: false, baixa_estoque: true
  };
  v.itens.forEach(i => { S.produtos[i.produto_id].qtd -= i.qtd; });
  S.vendas[id] = v; dirty('vendas', id); salvarJa();
  limparVenda(); abrirVenda(id, true);
}

// venda: recibo, WhatsApp, impressão e cancelamento
function reciboHTML(v) {
  const c = cfg();
  return `<div class="rec"><div class="rec-brand">${esc(c.nome)}</div>${c.subtitulo ? `<div class="rec-sub">${esc(c.subtitulo)}</div>` : ''}
    <div class="rec-meta">Venda ${esc(v.numero)}<br>${fmtDT(v.data)}${v.cliente_nome ? `<br>Cliente: ${esc(v.cliente_nome)}` : ''}${v.vendedor ? `<br>Atendida por ${esc(v.vendedor)}` : ''}</div>
    <table class="rec-items">${v.itens.map(i => `<tr><td>${i.qtd}× ${esc(i.nome)}<br><small>${esc(i.tamanho)} ${esc(i.cor)} ${esc(i.codigo)}</small></td><td>${money(i.preco * i.qtd)}</td></tr>`).join('')}</table>
    <div class="rec-tot"><div><span>Subtotal</span><span>${money(v.subtotal)}</span></div>
      ${v.desconto > 0 ? `<div><span>Desconto</span><span>− ${money(v.desconto)}</span></div>` : ''}
      <div class="big"><span>Total</span><span>${money(v.total)}</span></div>
      <div><span>${esc(v.forma)}${v.forma === 'Crédito' && v.parcelas > 1 ? ` em ${v.parcelas}x de ${money(v.total / v.parcelas)}` : ''}</span><span></span></div>
      ${v.recebido ? `<div><span>Recebido</span><span>${money(v.recebido)}</span></div><div><span>Troco</span><span>${money(v.troco)}</span></div>` : ''}</div>
    ${v.cancelada ? '<div class="rec-cancel">Venda cancelada</div>' : ''}
    ${devolucoesDe(v.id).length ? `<div class="rec-dev">${devolucoesDe(v.id).map(d => `Devolvida: ${d.delta}× ${esc(nomeMov(d))} em ${new Date(d.created_at).toLocaleDateString('pt-BR')}`).join('<br>')}</div>` : ''}
    ${c.rodape ? `<p class="rec-foot">${esc(c.rodape)}</p>` : ''}${c.instagram ? `<p class="rec-foot">${esc(c.instagram)}</p>` : ''}</div>`;
}
function textoWa(v) {
  const c = cfg();
  const itens = v.itens.map(i => `• ${i.qtd}x ${i.nome} ${i.tamanho} ${i.cor}: ${money(i.preco * i.qtd)}`).join('\n');
  return `*${c.nome}*\nComprovante da venda ${v.numero}\n${fmtDT(v.data)}\n\n${itens}\n\nSubtotal: ${money(v.subtotal)}` +
    (v.desconto > 0 ? `\nDesconto: -${money(v.desconto)}` : '') + `\n*Total: ${money(v.total)}*\nPagamento: ${v.forma}` +
    (v.forma === 'Crédito' && v.parcelas > 1 ? ` em ${v.parcelas}x` : '') + (v.vendedor ? `\nAtendida por ${v.vendedor}` : '') + (c.rodape ? `\n\n${c.rodape}` : '') + (c.instagram ? `\n${c.instagram}` : '');
}
function abrirVenda(id, nova) {
  const v = S.vendas[id]; if (!v) return;
  abrirDlg(`<div class="dlg-body"><header><h2>${nova ? 'Venda concluída' : 'Venda ' + esc(v.numero)}</h2><button class="x" type="button" data-close aria-label="Fechar">×</button></header>
    ${reciboHTML(v)}
    <div class="dlg-foot">${!v.cancelada && !nova ? '<button class="btn danger" type="button" data-a="cancelar">Cancelar venda</button>' : ''}<span class="grow"></span>
      <button class="btn ghost" type="button" data-a="imprimir">Imprimir recibo</button>
      <button class="btn ${nova ? 'ghost' : 'primary'}" type="button" data-a="wa">Enviar no WhatsApp</button>
      ${nova ? '<button class="btn primary" type="button" data-close>Nova venda</button>' : ''}</div></div>`,
    () => { if (nova && vista === 'vender' && matchMedia('(pointer:fine)').matches) busca.focus(); });
  dlg.querySelector('.dlg-foot').addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'wa') { const tel = telWa(v.cliente_tel); window.open(`https://wa.me/${tel}?text=${encodeURIComponent(textoWa(v))}`, '_blank'); }
    if (a === 'imprimir') imprimir(reciboHTML(v), 'size:80mm auto;margin:4mm');
    if (a === 'cancelar' && await confirmar(`Cancelar a venda ${v.numero} de ${money(v.total)}? As peças voltam para o estoque.`, { ok: 'Cancelar venda', perigo: true })) {
      v.cancelada = true;
      v.itens.forEach(i => { const p = S.produtos[i.produto_id]; if (p) p.qtd += i.qtd; });
      // o cancelamento devolve a venda inteira; o que já tinha sido devolvido sai de novo para não contar duas vezes
      devolucoesDe(v.id).forEach(d => { const p = S.produtos[d.produto_id]; if (p) { p.qtd -= d.delta; addAjuste(p.id, -d.delta, 'Correção: peça já devolvida antes do cancelamento', { tipo: 'ajuste', venda_id: v.id }); } });
      dirty('vendas', v.id); dlg.close(); renderDados(); toast('Venda cancelada. As peças voltaram ao estoque.', 'ok');
    }
  });
}
async function imprimir(html, page) {
  $('#print').innerHTML = html; $('#page-style').textContent = `@page{${page}}`;
  await Promise.all($$('#print img').map(i => i.decode ? i.decode().catch(() => {}) : 0));
  window.print();
}

// leitor pela câmera (BarcodeDetector)
$('#btn-scan').addEventListener('click', () => abrirScanner(cod => { const p = porCodigo(cod); if (p) adicionar(p); else toast(`Código ${cod} não está cadastrado.`, 'warn'); }));
async function abrirScanner(aoLer) {
  if (!('BarcodeDetector' in window)) return toast('Este navegador não lê códigos pela câmera. Use o Chrome no Android, o leitor USB ou digite o código.', 'warn');
  let det; try { det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39'] }); } catch { det = new BarcodeDetector(); }
  let stream, timer, ativo = true;
  abrirDlg(`<div class="dlg-body scan"><header><h2>Ler etiqueta</h2><button class="x" type="button" data-close aria-label="Fechar">×</button></header><video playsinline muted></video><p class="muted" style="margin-top:10px">Aponte a câmera para o código de barras ou o QR code da etiqueta.</p></div>`,
    () => { ativo = false; clearTimeout(timer); stream && stream.getTracks().forEach(t => t.stop()); });
  const video = dlg.querySelector('video');
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { dlg.close(); return toast('Sem acesso à câmera. Libere a permissão no navegador.', 'bad'); }
  if (!ativo) { stream.getTracks().forEach(t => t.stop()); return; }
  video.srcObject = stream; await video.play().catch(() => {});
  const ler = async () => {
    if (!ativo) return;
    try { const r = await det.detect(video); if (r.length) { const cod = r[0].rawValue.trim(); dlg.close(); if (navigator.vibrate) navigator.vibrate(15); aoLer(cod); return; } } catch {}
    timer = setTimeout(ler, 250);
  };
  ler();
}

// ---------- PRODUTOS ----------
const sel = new Set(); let pLimite = 200;
function rProdutos() {
  const tSel = $('#p-tipo'), tv = tSel.value;
  const tipos = [...new Set([...cfg().tipos, ...ativos().map(p => p.tipo)].filter(Boolean))];
  tSel.innerHTML = `<option value="">Todos os tipos</option>` + tipos.map(t => `<option ${t === tv ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const q = $('#p-busca').value, baixo = $('#p-baixo').checked;
  let lista = q ? buscarProdutos(q, 99999) : ativos();
  if (tv) lista = lista.filter(p => p.tipo === tv);
  if (baixo) lista = lista.filter(p => p.qtd <= (p.estoque_min || 0));
  if (!q) lista.sort((a, b) => nomeP(a).localeCompare(nomeP(b)) || String(a.cor).localeCompare(String(b.cor)) || ordTam(a.tamanho) - ordTam(b.tamanho));
  const todos = ativos();
  $('#p-resumo').textContent = todos.length ? `${lista.length} de ${todos.length} itens, ${sum(lista.map(p => Math.max(0, p.qtd)))} peças em estoque valendo ${money(sum(lista.map(p => Math.max(0, p.qtd) * p.preco)))}` : '';
  const el = $('#plist');
  if (!todos.length) { el.innerHTML = `<div class="empty panel"><strong>Nenhuma peça cadastrada</strong>Cadastre a primeira peça e imprima a etiqueta com QR code para vender mais rápido.<div class="btns" style="justify-content:center"><button class="btn primary" type="button" data-act="nova-peca">Cadastrar peça</button></div></div>`; pintarSel(); return; }
  if (!lista.length) { el.innerHTML = `<div class="empty panel"><strong>Nada encontrado</strong>Tente outro termo ou limpe os filtros.</div>`; pintarSel(); return; }
  el.innerHTML = `<div class="plist"><div class="phead"><span></span><span>Peça</span><span style="text-align:right">Preço</span><span style="text-align:right">Estoque</span><span></span></div>
    ${lista.slice(0, pLimite).map(p => `<div class="prow ${p.qtd <= 0 ? 'zero' : p.qtd <= (p.estoque_min || 0) ? 'low' : ''}">
      <input type="checkbox" data-sel="${p.id}" ${sel.has(p.id) ? 'checked' : ''} aria-label="Selecionar ${esc(nomeP(p))}">
      <button class="pinfo" type="button" data-edit="${p.id}"><strong>${esc(nomeP(p))}</strong><span class="meta"><span>${esc(p.tipo)}</span><span><b>${esc(p.tamanho)}</b></span><span>${esc(p.cor)}</span><span class="code">${esc(p.codigo)}</span></span></button>
      <span class="pprice">${money(p.preco)}</span><span class="pqtd">${p.qtd}<small> un</small></span>
      <button class="icon-btn" type="button" data-etq="${p.id}" aria-label="Imprimir etiqueta" title="Etiqueta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7.2 7.2a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7.2-7.2a1 1 0 0 1-.3-.7z"/><circle cx="8" cy="8" r="1.4"/></svg></button></div>`).join('')}</div>
    ${lista.length > pLimite ? `<div class="btns" style="justify-content:center"><button class="btn ghost" type="button" data-act="mais">Mostrar mais ${Math.min(200, lista.length - pLimite)}</button></div>` : ''}`;
  pintarSel();
}
function pintarSel() { [...sel].forEach(id => { if (!S.produtos[id] || S.produtos[id].deleted) sel.delete(id); }); $('#selbar').hidden = !sel.size; $('#sel-n').textContent = `${sel.size} ${sel.size === 1 ? 'peça selecionada' : 'peças selecionadas'}`; }
$('#p-busca').addEventListener('input', debounce(() => { pLimite = 200; rProdutos(); }, 120));
$('#p-tipo').addEventListener('change', rProdutos);
$('#p-baixo').addEventListener('change', rProdutos);
$('#plist').addEventListener('change', e => { const id = e.target.dataset.sel; if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); pintarSel(); });

function abrirProduto(id) {
  const p = id ? S.produtos[id] : null, c = cfg();
  const tams = [...new Set([...c.tamanhos, p?.tamanho].filter(Boolean))];
  abrirDlg(`<form class="dlg-body" id="fp" novalidate><header><h2>${p ? 'Editar peça' : 'Nova peça'}</h2><button class="x" type="button" data-close aria-label="Fechar">×</button></header>
    <div class="fgrid">
      <label>Tipo<input name="tipo" list="dl-tipos" required value="${esc(p?.tipo || '')}" placeholder="Ex.: Vestido"></label>
      <label class="span2">Nome da peça <em>(opcional)</em><input name="descricao" value="${esc(p?.descricao || '')}" placeholder="Ex.: Vestido midi floral"></label>
      <label>Cor<input name="cor" list="dl-cores" required value="${esc(p?.cor || '')}" placeholder="Ex.: Preto"></label>
      <label>Preço de venda<input name="preco" inputmode="decimal" required value="${p ? String(p.preco).replace('.', ',') : ''}" placeholder="0,00"></label>
      <label>Custo <em>(opcional)</em><input name="custo" inputmode="decimal" value="${p?.custo != null ? String(p.custo).replace('.', ',') : ''}" placeholder="0,00"></label>
      <label>Avisar quando restar<input name="estoque_min" type="number" min="0" inputmode="numeric" value="${p ? p.estoque_min ?? 2 : 1}"></label>
      ${p ? `<label>Tamanho<select name="tamanho">${tams.map(t => `<option ${t === p.tamanho ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
             <label>Estoque atual<input name="qtd" type="number" inputmode="numeric" value="${p.qtd}"></label>
             <label>Código<input value="${esc(p.codigo)}" readonly></label>` : ''}
    </div>
    ${p ? '' : `<fieldset class="grade"><legend>Quantidade por tamanho</legend><div class="grade-cells">${tams.map(t => `<label class="gcell"><span>${esc(t)}</span><input type="number" min="0" inputmode="numeric" data-tam="${esc(t)}" placeholder="–" aria-label="Quantidade ${esc(t)}"></label>`).join('')}</div>
      <p class="muted" style="font-size:13px;margin-top:8px">Cada tamanho preenchido vira um item com código e etiqueta próprios.</p></fieldset>`}
    <div class="dlg-foot">${p ? '<button class="btn danger" type="button" data-a="del">Excluir peça</button><button class="btn ghost" type="button" data-a="etq">Etiqueta</button><button class="btn ghost" type="button" data-a="dev">Registrar devolução</button>' : ''}<span class="grow"></span>
      <button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">${p ? 'Salvar alterações' : 'Cadastrar peça'}</button></div></form>`);
  const f = $('#fp');
  if (!p) setTimeout(() => f.tipo.focus(), 30);
  f.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'etq') { dlg.close(); abrirEtiquetas([p.id]); }
    if (a === 'dev') { dlg.close(); abrirDevolucao(p.id); }
    if (a === 'del' && await confirmar(`Excluir ${nomeP(p)} ${p.tamanho} ${p.cor}? O histórico de vendas continua guardado.`, { ok: 'Excluir peça', perigo: true })) {
      p.deleted = true; dirty('produtos', p.id); dlg.close(); renderDados(); toast('Peça excluída.', 'ok');
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const tipo = f.tipo.value.trim(), cor = f.cor.value.trim(), preco = r2(parseNum(f.preco.value));
    const custo = f.custo.value.trim() ? r2(parseNum(f.custo.value)) : null, emin = Math.max(0, Math.trunc(+f.estoque_min.value || 0));
    if (!tipo) return toast('Informe o tipo da peça.', 'warn'), f.tipo.focus();
    if (!cor) return toast('Informe a cor.', 'warn'), f.cor.focus();
    if (!(preco > 0)) return toast('Informe o preço de venda.', 'warn'), f.preco.focus();
    const base = { tipo, descricao: f.descricao.value.trim(), cor, preco, custo, estoque_min: emin };
    if (!cfg().tipos.some(t => norm(t) === norm(tipo))) { cfg().tipos.push(tipo); dirty('config', 'loja'); }
    if (p) {
      const nq = Math.trunc(+f.qtd.value || 0), delta = nq - p.qtd;
      Object.assign(p, base, { tamanho: f.tamanho.value, qtd: nq });
      dirty('produtos', p.id); if (delta) addAjuste(p.id, delta, 'Ajuste manual');
      dlg.close(); renderDados(); toast('Peça atualizada.', 'ok');
    } else {
      const cells = $$('[data-tam]', f).filter(i => i.value !== '');
      if (!cells.length) return toast('Preencha a quantidade de pelo menos um tamanho.', 'warn'), $('[data-tam]', f).focus();
      const novos = cells.map(i => {
        const id = uid(), q = Math.max(0, Math.trunc(+i.value || 0));
        S.produtos[id] = { id, codigo: novoCodigo(tipo), ...base, tamanho: i.dataset.tam, qtd: q, deleted: false, created_at: nowISO() };
        dirty('produtos', id); addAjuste(id, q, 'Cadastro'); return id;
      });
      dlg.close(); renderDados();
      toast(novos.length === 1 ? 'Peça cadastrada.' : `${novos.length} itens cadastrados.`, 'ok', { label: 'Imprimir etiquetas', fn: () => abrirEtiquetas(novos) });
    }
  });
}

// etiquetas com código de barras (Code 128) e o código escrito embaixo; QR code como alternativa
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
// desenha o código em SVG vetorial: fica nítido em qualquer impressora e é lido por leitor USB, Bluetooth ou câmera
function barrasSVG(txt) {
  txt = String(txt).replace(/[^\x20-\x7e]/g, '');
  const v = [104, ...[...txt].map(c => c.charCodeAt(0) - 32)];
  let ck = 104; v.slice(1).forEach((x, i) => ck += x * (i + 1)); v.push(ck % 103, 106);
  const Q = 10; let x = Q, rects = '', bar = true;
  v.forEach(c => [...C128[c]].forEach(w => { w = +w; if (bar) rects += `<rect x="${x}" width="${w}" height="40"/>`; x += w; bar = !bar; }));
  return `<svg class="barras" viewBox="0 0 ${x + Q} 40" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Código de barras ${esc(txt)}"><rect width="${x + Q}" height="40" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
let qrPromessa;
function carregarQR() {
  if (window.QRCode) return Promise.resolve();
  return qrPromessa ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/qrcode.min.js';
    s.onload = res; s.onerror = () => { qrPromessa = null; rej(new Error('offline')); }; document.head.append(s);
  });
}
function qrImg(txt) {
  const d = document.createElement('div');
  new QRCode(d, { text: txt, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
  const c = d.querySelector('canvas'); return c ? c.toDataURL('image/png') : d.querySelector('img')?.src;
}
function etqHTML(p, modo, qr) {
  const topo = `<div class="et-top"><span class="eb">${esc(cfg().nome)}</span><span class="ep">${money(p.preco)}</span></div>
    <div class="et-nome">${esc(nomeP(p))}</div><div class="et-var">Tam. ${esc(p.tamanho)}, ${esc(p.cor)}</div>`;
  if (modo === 'qr') return `<div class="etq qr">${qr ? `<img src="${qr}" alt="">` : ''}<div class="et-col">${topo}<span class="ec">${esc(p.codigo)}</span></div></div>`;
  return `<div class="etq">${topo}<div class="et-bar">${barrasSVG(p.codigo)}</div><div class="ec">${esc(p.codigo)}</div></div>`;
}
function abrirEtiquetas(ids) {
  const ps = ids.map(id => S.produtos[id]).filter(p => p && !p.deleted); if (!ps.length) return;
  abrirDlg(`<form class="dlg-body" id="fe"><header><h2>Imprimir etiquetas</h2><button class="x" type="button" data-close aria-label="Fechar">×</button></header>
    <div class="fgrid" style="margin-bottom:14px">
      <label class="span2">Formato<select name="fmt"><option value="rolo">Impressora de etiquetas (50 × 30 mm)</option><option value="a4">Folha A4 comum (várias por folha)</option></select></label>
      <label>Código na etiqueta<select name="modo"><option value="barras">Código de barras</option><option value="qr">QR code</option></select></label>
    </div>
    <div class="etq-prev" id="etq-prev" aria-label="Prévia da etiqueta"></div>
    <ul class="mini">${ps.map(p => `<li><div class="grow"><strong>${esc(nomeP(p))}</strong><span class="meta"><span>${esc(p.tamanho)}</span><span>${esc(p.cor)}</span><span>${money(p.preco)}</span><span class="code">${esc(p.codigo)}</span></span></div>
      <label style="width:90px">Cópias<input type="number" min="0" max="200" inputmode="numeric" data-cop="${p.id}" value="${Math.min(Math.max(p.qtd, 1), 50)}"></label></li>`).join('')}</ul>
    <div class="dlg-foot"><span class="grow"></span><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">Imprimir</button></div></form>`);
  const f = $('#fe');
  f.fmt.value = localStorage.getItem('prd-etq-fmt') || 'rolo';
  f.modo.value = localStorage.getItem('prd-etq-modo') || 'barras';
  const prev = async () => {
    let qr = null; if (f.modo.value === 'qr') { try { await carregarQR(); qr = qrImg(ps[0].codigo); } catch {} }
    $('#etq-prev').innerHTML = `<div class="etqs ${f.fmt.value}">${etqHTML(ps[0], f.modo.value, qr)}</div>`;
  };
  f.fmt.addEventListener('change', prev); f.modo.addEventListener('change', prev); prev();
  f.addEventListener('submit', async e => {
    e.preventDefault(); const fmt = f.fmt.value, modo = f.modo.value;
    localStorage.setItem('prd-etq-fmt', fmt); localStorage.setItem('prd-etq-modo', modo);
    const lista = []; $$('[data-cop]', f).forEach(i => { const p = S.produtos[i.dataset.cop]; for (let k = 0; k < Math.min(200, +i.value || 0); k++) lista.push(p); });
    if (!lista.length) return toast('Informe ao menos uma cópia.', 'warn');
    let temQR = modo === 'qr';
    if (temQR) { try { await carregarQR(); } catch { temQR = false; toast('Não foi possível gerar o QR code. As etiquetas saem só com o código escrito.', 'warn'); } }
    const cache = {}; const img = c => temQR ? (cache[c] ||= qrImg(c)) : null;
    const html = `<div class="etqs ${fmt}">${lista.map(p => etqHTML(p, modo, img(p.codigo))).join('')}</div>`;
    dlg.close();
    imprimir(html, fmt === 'rolo' ? 'size:50mm 30mm;margin:0' : 'size:A4;margin:8mm');
  });
}

// ---------- ESTOQUE: consulta, movimentações e devoluções ----------
const porCodigoTodos = c => { c = String(c || '').trim().toUpperCase(); return c ? Object.values(S.produtos).find(p => String(p.codigo).toUpperCase() === c) || null : null; };
const nomeMov = m => { const p = S.produtos[m.produto_id]; return p ? `${nomeP(p)} ${p.tamanho}` : 'Peça'; };
const devolucoesDe = vid => Object.values(S.movs).filter(m => m.venda_id === vid && tipoMov(m) === 'devolucao');
const devolvido = (vid, pid) => sum(devolucoesDe(vid).filter(m => m.produto_id === pid).map(m => m.delta));
const itemDe = (v, p) => v.itens.find(i => i.produto_id === p.id || (!i.produto_id && String(i.codigo).toUpperCase() === String(p.codigo).toUpperCase()));
const pagoItem = (v, i, q = i.qtd) => r2(i.preco * q * (v.subtotal > 0 ? v.total / v.subtotal : 1));   // já com o desconto da venda
const vendasDaPeca = p => Object.values(S.vendas).filter(v => itemDe(v, p)).sort((a, b) => b.data.localeCompare(a.data));

let consCod = '';
const consBusca = $('#cons-busca');
function consultar(cod) {
  consCod = String(cod || '').trim(); consBusca.value = consCod;
  if (vista !== 'estoque') ir('estoque'); else rConsulta();
  $('#cons-res').scrollIntoView({ block: 'nearest' });
}
consBusca.addEventListener('input', debounce(() => { consCod = consBusca.value.trim(); rConsulta(); }, 150));
consBusca.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); consCod = consBusca.value.trim(); rConsulta(); consBusca.select(); } if (e.key === 'Escape') { consBusca.value = consCod = ''; rConsulta(); } });
$('#btn-scan-cons').addEventListener('click', () => abrirScanner(consultar));
$('#btn-consulta').addEventListener('click', () => { ir('estoque'); setTimeout(() => { consBusca.focus(); consBusca.select(); }, 60); });

function rConsulta() {
  const el = $('#cons-res'), q = consCod;
  if (!q) { el.innerHTML = '<p class="muted cons-dica">Mostra o preço, quanto há em estoque e, se a peça já foi vendida, quando, para quem e por quanto.</p>'; return; }
  const p = porCodigoTodos(q);
  if (p) { el.innerHTML = cartaoPeca(p); return; }
  // peça que só existe no histórico de vendas (sistema anterior)
  const vs = Object.values(S.vendas).filter(v => v.itens.some(i => String(i.codigo).toUpperCase() === q.toUpperCase()));
  if (vs.length) { const i = vs[0].itens.find(i => String(i.codigo).toUpperCase() === q.toUpperCase()); el.innerHTML = cartaoPeca({ id: null, codigo: i.codigo, tipo: '', descricao: i.nome, tamanho: i.tamanho, cor: i.cor, preco: i.preco, qtd: 0, deleted: true, avulsa: true }); return; }
  const ls = buscarProdutos(q, 8);
  el.innerHTML = ls.length
    ? `<p class="muted cons-dica">Nenhum código igual a “${esc(q)}”. Peças parecidas:</p><ul class="mini cons-lista">${ls.map(p => `<li><button class="grow" type="button" data-cons="${esc(p.codigo)}"><strong>${esc(nomeP(p))}</strong><span class="meta"><span>${esc(p.tamanho)}</span><span>${esc(p.cor)}</span><span class="code">${esc(p.codigo)}</span></span></button><b class="num">${money(p.preco)}</b></li>`).join('')}</ul>`
    : `<p class="cons-dica"><strong>Nenhuma peça com o código “${esc(q)}”.</strong> <span class="muted">Confira o código ou cadastre a peça em Produtos.</span></p>`;
}
function cartaoPeca(p) {
  const vs = p.avulsa ? Object.values(S.vendas).filter(v => v.itens.some(i => String(i.codigo).toUpperCase() === String(p.codigo).toUpperCase())).sort((a, b) => b.data.localeCompare(a.data)) : vendasDaPeca(p);
  const movs = p.id ? Object.values(S.movs).filter(m => m.produto_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
  const status = p.avulsa ? '<span class="tag">só no histórico</span>' : p.deleted ? '<span class="tag bad">excluída do cadastro</span>' : p.qtd <= 0 ? '<span class="tag bad">esgotada</span>' : `<span class="tag ${p.qtd <= (p.estoque_min || 0) ? 'warn' : 'ok'}">${p.qtd} em estoque</span>`;
  const vendidas = sum(vs.filter(v => !v.cancelada).map(v => { const i = itemDe(v, p) || v.itens.find(i => i.codigo === p.codigo); return i ? i.qtd : 0; }));
  return `<div class="cons-card">
    <div class="cons-head">
      <div class="grow"><strong class="cons-nome">${esc(nomeP(p))}</strong>
        <span class="meta">${p.tipo ? `<span>${esc(p.tipo)}</span>` : ''}<span>Tam. <b>${esc(p.tamanho)}</b></span><span>${esc(p.cor)}</span><span class="code">${esc(p.codigo)}</span></span>
        <div class="cons-status">${status}${vendidas ? `<span class="muted">${vendidas} ${vendidas === 1 ? 'vendida' : 'vendidas'} até hoje</span>` : ''}${p.created_at ? `<span class="muted">cadastrada em ${new Date(p.created_at).toLocaleDateString('pt-BR')}</span>` : ''}</div></div>
      <div class="cons-preco">${money(p.preco)}</div>
    </div>
    ${p.avulsa ? '' : `<div class="btns">
      ${!p.deleted && p.qtd > 0 ? `<button class="btn primary sm" type="button" data-addcart="${p.id}">Adicionar à venda</button>` : ''}
      <button class="btn ghost sm" type="button" data-dev="${p.id}">Registrar devolução</button>
      ${p.deleted ? '' : `<button class="btn ghost sm" type="button" data-edit="${p.id}">Editar</button><button class="btn ghost sm" type="button" data-etq="${p.id}">Etiqueta</button>`}</div>`}
    <h3 class="cons-h">${vs.length ? 'Vendas desta peça' : 'Ainda não foi vendida'}</h3>
    ${vs.length ? `<ul class="cons-vendas">${vs.map(v => { const i = (p.avulsa ? null : itemDe(v, p)) || v.itens.find(x => x.codigo === p.codigo); const dv = p.id ? devolvido(v.id, p.id) : 0; const pago = pagoItem(v, i);
      return `<li class="${v.cancelada ? 'cancel' : ''}">
        <button class="grow" type="button" data-venda="${v.id}">
          <strong>${fmtDT(v.data)}</strong>
          <span class="meta"><span>Cliente: ${esc(v.cliente_nome || 'não informada')}</span><span>Vendedora: ${esc(v.vendedor || 'não informada')}</span><span>${esc(v.forma)}${v.parcelas > 1 ? ' ' + v.parcelas + 'x' : ''}</span><span class="code">Venda ${esc(v.numero)}</span></span>
          ${v.cancelada ? '<span class="tag bad">venda cancelada</span>' : ''}${dv ? `<span class="tag warn">${dv} ${dv === 1 ? 'devolvida' : 'devolvidas'}</span>` : ''}
        </button>
        <div class="cons-v"><b class="num">${money(pago)}</b><small class="muted">${i.qtd}× ${money(i.preco)}${pago < r2(i.preco * i.qtd) ? ', com desconto' : ''}</small>
          ${!v.cancelada && p.id && dv < i.qtd ? `<button class="link" type="button" data-dev="${p.id}|${v.id}">Devolver</button>` : ''}</div></li>`; }).join('')}</ul>` : ''}
    ${movs.length ? `<h3 class="cons-h">Entradas e ajustes</h3><ul class="cons-movs">${movs.slice(0, 12).map(m => `<li><span>${fmtDT(m.created_at)}</span><span>${esc(NOME_MOV[tipoMov(m)])}${m.cliente ? ', ' + esc(m.cliente) : ''}${m.motivo && !['Cadastro', 'Ajuste manual'].includes(m.motivo) ? ` <span class="muted">(${esc(m.motivo)})</span>` : ''}</span><b class="num ${m.delta > 0 ? 'mais' : 'menos'}">${m.delta > 0 ? '+' : '−'}${Math.abs(m.delta)}</b></li>`).join('')}</ul>` : ''}
  </div>`;
}

function abrirDevolucao(pid, vid) {
  const p = S.produtos[pid]; if (!p) return;
  const vs = vendasDaPeca(p).filter(v => !v.cancelada).map(v => { const i = itemDe(v, p); return { v, i, rest: i.qtd - devolvido(v.id, p.id) }; }).filter(x => x.rest > 0);
  const ini = vs.find(x => x.v.id === vid) || (vid === undefined ? vs[0] : null);
  abrirDlg(`<form class="dlg-body" id="fdev" novalidate><header><h2>Registrar devolução</h2><button class="x" type="button" data-close aria-label="Fechar">×</button></header>
    <p style="margin-bottom:14px"><strong>${esc(nomeP(p))}</strong> <span class="muted">Tam. ${esc(p.tamanho)}, ${esc(p.cor)}, ${esc(p.codigo)}</span><br><span class="muted">A peça volta para o estoque${p.deleted ? ' e para o cadastro' : ''}.</span></p>
    <div class="fgrid">
      <label class="span2" style="grid-column:1/-1">Venda de origem<select name="venda">
        ${vs.map(x => `<option value="${x.v.id}" ${x === ini ? 'selected' : ''}>${new Date(x.v.data).toLocaleDateString('pt-BR')}, ${esc(x.v.cliente_nome || 'cliente não informada')}, ${money(pagoItem(x.v, x.i, 1))} un${x.v.vendedor ? ', ' + esc(x.v.vendedor) : ''}</option>`).join('')}
        <option value="" ${ini ? '' : 'selected'}>Sem venda registrada</option></select></label>
      <label>Quantidade<input name="qtd" type="number" min="1" inputmode="numeric" value="1"></label>
      <label>Motivo<select name="motivo">${['Troca', 'Não serviu', 'Defeito', 'Desistência', 'Outro'].map(m => `<option>${m}</option>`).join('')}</select></label>
      <label>Cliente<input name="cliente" list="dl-clientes" autocomplete="off" value="${esc(ini?.v.cliente_nome || '')}"></label>
      <label>Recebida por<input name="vendedor" list="dl-vend" autocomplete="off" value="${esc(vendedorAtual())}"></label>
      <label class="span2" style="grid-column:1/-1">Observação<input name="obs" autocomplete="off" placeholder="Opcional, ex.: trocou pelo tamanho G"></label>
    </div>
    <datalist id="dl-vend">${vendedoras().map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <p class="muted" id="dev-info" style="font-size:13.5px;margin-top:12px"></p>
    <div class="dlg-foot"><span class="grow"></span><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">Devolver ao estoque</button></div></form>`);
  const f = $('#fdev');
  const sel = () => vs.find(x => x.v.id === f.venda.value);
  const info = () => { const x = sel(), q = Math.max(1, Math.trunc(+f.qtd.value || 1));
    f.qtd.max = x ? x.rest : 999;
    $('#dev-info').textContent = x ? `Vendida em ${fmtDT(x.v.data)}. Valor a devolver: ${money(pagoItem(x.v, x.i, Math.min(q, x.rest)))}.${x.rest < x.i.qtd ? ` Já ${x.i.qtd - x.rest === 1 ? 'foi devolvida 1' : 'foram devolvidas ' + (x.i.qtd - x.rest)} desta venda.` : ''}` : `Sem venda de origem, o valor considerado é o preço atual: ${money(p.preco * q)}.`; };
  f.venda.addEventListener('change', () => { const x = sel(); if (x) f.cliente.value = x.v.cliente_nome || ''; info(); });
  f.qtd.addEventListener('input', info); info();
  f.addEventListener('submit', e => {
    e.preventDefault(); const x = sel(), q = Math.trunc(+f.qtd.value || 0);
    if (q < 1) return toast('Informe a quantidade devolvida.', 'warn'), f.qtd.focus();
    if (x && q > x.rest) return toast(`Nesta venda só ${x.rest === 1 ? 'resta 1 peça' : `restam ${x.rest} peças`} para devolver.`, 'warn'), f.qtd.focus();
    const obs = f.obs.value.trim();
    if (p.deleted) { p.deleted = false; dirty('produtos', p.id); }
    p.qtd += q;
    addAjuste(p.id, q, f.motivo.value + (obs ? ': ' + obs : ''), { tipo: 'devolucao', venda_id: x ? x.v.id : null, cliente: f.cliente.value.trim() || null, vendedor: f.vendedor.value.trim() || null, valor: x ? pagoItem(x.v, x.i, q) : r2(p.preco * q) });
    salvarJa(); dlg.close(); renderDados();
    toast(q === 1 ? 'Devolução registrada. A peça voltou ao estoque.' : `Devolução registrada. ${q} peças voltaram ao estoque.`, 'ok');
  });
}

// movimentações do período: entradas e ajustes (S.movs) + saídas por venda
let mPer = '30', mLimite = 300;
const sinal = (n, d) => n ? (d > 0 ? '+' : '−') + n : '0';
function movimentos() {
  const [a, b] = intervalo(mPer, '#m-de', '#m-ate'), dentro = iso => { const d = new Date(iso); return d >= a && d <= b; };
  const ls = [];
  Object.values(S.movs).forEach(m => { if (!dentro(m.created_at)) return; const p = S.produtos[m.produto_id];
    ls.push({ id: m.id, data: m.created_at, tipo: tipoMov(m), qtd: m.delta, nome: p ? nomeP(p) : 'Peça', tamanho: p?.tamanho || '', cor: p?.cor || '', codigo: p?.codigo || '',
      valor: m.valor ?? (p ? r2(p.preco * Math.abs(m.delta)) : 0), cliente: m.cliente, vendedor: m.vendedor, venda_id: m.venda_id, obs: m.motivo }); });
  Object.values(S.vendas).forEach(v => { if (!dentro(v.data)) return;
    v.itens.forEach(i => ls.push({ id: v.id + i.codigo, data: v.data, tipo: 'venda', qtd: -i.qtd, nome: i.nome, tamanho: i.tamanho, cor: i.cor, codigo: i.codigo,
      valor: pagoItem(v, i), cliente: v.cliente_nome, vendedor: v.vendedor, venda_id: v.id, cancelada: v.cancelada, numero: v.numero })); });
  return ls.sort((x, y) => y.data.localeCompare(x.data));
}
function rEstoque() {
  rConsulta();
  const todos = movimentos(), ft = $('#m-tipo').value;
  const lista = todos.filter(m => !ft || (ft === 'e' ? m.qtd > 0 : ft === 's' ? m.qtd < 0 : m.tipo === ft));
  const conta = m => !m.cancelada && m.tipo !== 'carga';
  const ent = todos.filter(m => conta(m) && m.qtd > 0 && m.tipo !== 'devolucao'), dev = todos.filter(m => m.tipo === 'devolucao');
  const ven = todos.filter(m => conta(m) && m.tipo === 'venda'), bx = todos.filter(m => conta(m) && m.qtd < 0 && m.tipo !== 'venda');
  const q = a => sum(a.map(m => Math.abs(m.qtd)));
  const prods = ativos(), pcs = sum(prods.map(p => Math.max(0, p.qtd)));
  const porTipo = {}; prods.forEach(p => { const k = p.tipo || 'Sem tipo'; const t = porTipo[k] ||= { itens: 0, pcs: 0, venda: 0, custo: 0, semCusto: 0 }; const n = Math.max(0, p.qtd);
    t.itens++; t.pcs += n; t.venda += n * p.preco; if (p.custo != null) t.custo += n * p.custo; else if (n) t.semCusto++; });
  const tipos = Object.entries(porTipo).sort((x, y) => y[1].pcs - x[1].pcs), temCusto = prods.some(p => p.custo != null);
  const grupos = []; lista.slice(0, mLimite).forEach(m => { const k = dayKey(new Date(m.data)); const g = grupos[grupos.length - 1]; if (g && g.k === k) g.ls.push(m); else grupos.push({ k, d: m.data, ls: [m] }); });
  $('#mres').innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Entraram</span><strong class="mais">${sinal(q(ent), 1)}</strong><small class="muted">cadastros e ajustes</small></div>
      <div class="kpi"><span>Devolvidas</span><strong class="mais">${sinal(q(dev), 1)}</strong><small class="muted">${money(sum(dev.map(m => m.valor)))}</small></div>
      <div class="kpi"><span>Vendidas</span><strong class="menos">${sinal(q(ven), -1)}</strong><small class="muted">${money(sum(ven.map(m => m.valor)))}</small></div>
      ${bx.length ? `<div class="kpi"><span>Baixas manuais</span><strong class="menos">${sinal(q(bx), -1)}</strong></div>` : ''}
      <div class="kpi main"><span>Em estoque agora</span><strong>${pcs} ${pcs === 1 ? 'peça' : 'peças'}</strong><small>${money(sum(prods.map(p => Math.max(0, p.qtd) * p.preco)))} a preço de venda</small></div>
    </div>
    ${tipos.length ? `<section class="panel" style="margin-bottom:16px"><h2>Estoque por tipo</h2><div class="tscroll"><table class="ttab">
      <thead><tr><th>Tipo</th><th>Itens</th><th>Peças</th><th>Valor de venda</th>${temCusto ? '<th>Custo</th>' : ''}</tr></thead>
      <tbody>${tipos.map(([k, t]) => `<tr><td>${esc(k)}</td><td>${t.itens}</td><td>${t.pcs}</td><td>${money(t.venda)}</td>${temCusto ? `<td>${money(t.custo)}${t.semCusto ? '<small class="muted"> parcial</small>' : ''}</td>` : ''}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td>${prods.length}</td><td>${pcs}</td><td>${money(sum(tipos.map(t => t[1].venda)))}</td>${temCusto ? `<td>${money(sum(tipos.map(t => t[1].custo)))}</td>` : ''}</tr></tfoot></table></div></section>` : ''}
    <h2>${lista.length ? `${lista.length} ${lista.length === 1 ? 'movimentação' : 'movimentações'} no período` : ''}</h2>
    ${lista.length ? grupos.map(g => `<p class="mgrupo">${(d => d[0].toUpperCase() + d.slice(1))(new Date(g.d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
      <div class="vlist">${g.ls.map(m => `<button class="mrow ${m.cancelada ? 'cancel' : ''}" type="button" ${m.tipo === 'venda' ? `data-venda="${m.venda_id}"` : `data-cons="${esc(m.codigo)}"`}>
        <span class="mtag t-${m.tipo}">${NOME_MOV[m.tipo]}</span>
        <span class="minfo"><strong>${esc(m.nome)}</strong><span class="meta"><span>${fmtHora(m.data)}</span><span>${esc(m.tamanho)}</span><span>${esc(m.cor)}</span><span class="code">${esc(m.codigo)}</span>${m.cliente ? `<span>${esc(m.cliente)}</span>` : ''}${m.vendedor ? `<span>${esc(m.vendedor)}</span>` : ''}${m.cancelada ? '<span class="tag bad">cancelada</span>' : ''}</span></span>
        <b class="mq ${m.qtd > 0 ? 'mais' : 'menos'}">${m.qtd > 0 ? '+' : '−'}${Math.abs(m.qtd)}</b>
        <span class="mv">${m.valor ? money(m.valor) : ''}</span></button>`).join('')}</div>`).join('')
      + (lista.length > mLimite ? `<div class="btns" style="justify-content:center"><button class="btn ghost" type="button" data-act="mais-mov">Mostrar mais</button></div>` : '')
      : `<div class="empty panel"><strong>Nenhuma movimentação neste período</strong>Cadastros, vendas, devoluções e ajustes de estoque aparecem aqui.</div>`}`;
}
$('#m-per').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; mPer = b.dataset.v; mLimite = 300;
  $$('#m-per button').forEach(x => x.setAttribute('aria-pressed', x === b));
  $('#m-de').hidden = $('#m-ate').hidden = mPer !== 'per';
  if (mPer === 'per' && !$('#m-de').value) { const h = new Date(); $('#m-de').value = dayKey(new Date(h.getFullYear(), h.getMonth(), 1)); $('#m-ate').value = dayKey(h); }
  rEstoque();
});
['m-de', 'm-ate', 'm-tipo'].forEach(id => $('#' + id).addEventListener('change', () => { mLimite = 300; rEstoque(); }));
function csvMov() {
  return csv([['Data', 'Hora', 'Movimento', 'Código', 'Peça', 'Tamanho', 'Cor', 'Quantidade', 'Valor', 'Cliente', 'Vendedora', 'Venda', 'Observação'],
    ...movimentos().map(m => [new Date(m.data).toLocaleDateString('pt-BR'), fmtHora(m.data), NOME_MOV[m.tipo] + (m.cancelada ? ' (cancelada)' : ''), m.codigo, m.nome, m.tamanho, m.cor, m.qtd, m.valor ? n2(m.valor) : '', m.cliente, m.vendedor, m.numero || (m.venda_id && S.vendas[m.venda_id]?.numero) || '', m.tipo === 'venda' ? '' : m.obs])]);
}

// ---------- VENDAS (relatório) ----------
let per = 'hoje';
function intervalo(pp = per, deSel = '#per-de', ateSel = '#per-ate') {
  const per = pp, h = new Date(), fim = new Date(h.getFullYear(), h.getMonth(), h.getDate(), 23, 59, 59, 999);
  const ini = d => new Date(h.getFullYear(), h.getMonth(), h.getDate() - d);
  if (per === 'hoje') return [ini(0), fim];
  if (per === '7') return [ini(6), fim];
  if (per === '30') return [ini(29), fim];
  if (per === 'mes') return [new Date(h.getFullYear(), h.getMonth(), 1), fim];
  const de = $(deSel).value, ate = $(ateSel).value;
  return [de ? new Date(de + 'T00:00:00') : new Date(2000, 0, 1), ate ? new Date(ate + 'T23:59:59.999') : fim];
}
function vendasFiltradas(incluiCanc) {
  const [a, b] = intervalo(), f = $('#per-forma').value, fv = $('#per-vend').value;
  return Object.values(S.vendas).filter(v => { const d = new Date(v.data); return d >= a && d <= b && (!f || v.forma === f) && (!fv || (fv === '-' ? !v.vendedor : v.vendedor === fv)) && (incluiCanc || !v.cancelada); })
    .sort((x, y) => y.data.localeCompare(x.data));
}
function rVendas() {
  const todas = vendasFiltradas(true), vs = todas.filter(v => !v.cancelada);
  const fat = sum(vs.map(v => v.total)), pcs = sum(vs.flatMap(v => v.itens.map(i => i.qtd))), desc = sum(vs.map(v => v.desconto));
  const comCusto = vs.filter(v => v.itens.every(i => i.custo != null));
  const lucro = sum(comCusto.map(v => v.total - sum(v.itens.map(i => i.custo * i.qtd))));
  // por dia
  const [a, b] = intervalo(); const dias = [];
  const inicio = vs.length && per === 'per' && !$('#per-de').value ? new Date(vs[vs.length - 1].data) : a;
  for (let d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate()); d <= b && dias.length < 400; d.setDate(d.getDate() + 1)) dias.push(dayKey(d));
  const porDia = {}; vs.forEach(v => { const k = dayKey(new Date(v.data)); porDia[k] = (porDia[k] || 0) + v.total; });
  let serie = dias.map(k => ({ k, v: porDia[k] || 0, l: k.slice(8) }));
  if (serie.length > 62) { const m = {}; serie.forEach(s => { const mk = s.k.slice(0, 7); m[mk] = (m[mk] || 0) + s.v; }); serie = Object.keys(m).map(k => ({ k, v: m[k], l: k.slice(5) + '/' + k.slice(2, 4) })); }
  let porHora = null;
  if (per === 'hoje') { porHora = {}; vs.forEach(v => { const hh = new Date(v.data).getHours(); porHora[hh] = (porHora[hh] || 0) + v.total; }); const hs = Object.keys(porHora).map(Number); const h0 = Math.min(9, ...hs), h1 = Math.max(19, ...hs); serie = []; for (let hh = h0; hh <= h1; hh++) serie.push({ k: hh + 'h', v: porHora[hh] || 0, l: hh + 'h' }); }
  const max = Math.max(1, ...serie.map(s => s.v));
  const formas = {}; vs.forEach(v => formas[v.forma] = (formas[v.forma] || 0) + v.total);
  const top = {}; vs.forEach(v => v.itens.forEach(i => { const k = i.nome; top[k] = top[k] || { q: 0, t: 0 }; top[k].q += i.qtd; top[k].t += i.preco * i.qtd; }));
  const topL = Object.entries(top).sort((x, y) => y[1].q - x[1].q || y[1].t - x[1].t).slice(0, 6), topMax = Math.max(1, ...topL.map(t => t[1].q));
  const nc = todas.length - vs.length;
  const porVend = {}; vs.forEach(v => { const k = v.vendedor || 'Sem vendedora'; porVend[k] = porVend[k] || { n: 0, t: 0 }; porVend[k].n++; porVend[k].t += v.total; });
  const [da, db] = intervalo(); const ids = new Set(vs.map(v => v.id));
  const devs = Object.values(S.movs).filter(m => tipoMov(m) === 'devolucao' && (() => { const d = new Date(m.created_at); return d >= da && d <= db; })() && (!$('#per-vend').value && !$('#per-forma').value || ids.has(m.venda_id)));
  const devT = sum(devs.map(m => m.valor));
  $('#vres').innerHTML = `
    <div class="kpis">
      <div class="kpi main"><span>Faturamento</span><strong>${money(fat)}</strong></div>
      <div class="kpi"><span>Vendas</span><strong>${vs.length}</strong></div>
      <div class="kpi"><span>Ticket médio</span><strong>${money(vs.length ? fat / vs.length : 0)}</strong></div>
      <div class="kpi"><span>Peças vendidas</span><strong>${pcs}</strong></div>
      <div class="kpi"><span>Descontos dados</span><strong>${money(desc)}</strong></div>
      ${comCusto.length ? `<div class="kpi"><span>Lucro estimado</span><strong>${money(lucro)}</strong></div>` : ''}
      ${devs.length ? `<div class="kpi"><span>Devoluções</span><strong>${money(devT)}</strong><small class="muted">${sum(devs.map(m => m.delta))} ${sum(devs.map(m => m.delta)) === 1 ? 'peça' : 'peças'}</small></div>` : ''}
    </div>
    ${vs.length ? `<div class="charts">
      <section class="panel"><h2>${porHora ? 'Vendas por hora' : serie.length && serie[0].k.length === 7 ? 'Vendas por mês' : 'Vendas por dia'}</h2>
        <div class="bars">${serie.map(s => `<div class="bar ${s.v ? '' : 'zero'}" title="${esc(s.k)}: ${money(s.v)}"><i style="height:${Math.max(1, s.v / max * 100)}%"></i><small>${esc(s.l)}</small></div>`).join('')}</div></section>
      <section class="panel"><h2>Por vendedora</h2>
        <ul class="hbars">${Object.entries(porVend).sort((x, y) => y[1].t - x[1].t).map(([n, d]) => `<li><span>${esc(n)} <span class="muted">${d.n} ${d.n === 1 ? 'venda' : 'vendas'}</span></span><b>${money(d.t)}</b><div><i style="width:${fat ? d.t / fat * 100 : 0}%;background:var(--gold)"></i></div></li>`).join('')}</ul>
        <h2 style="margin-top:22px">Por forma de pagamento</h2>
        <ul class="hbars">${Object.entries(formas).sort((x, y) => y[1] - x[1]).map(([f, v]) => `<li><span>${esc(f)} <span class="muted">${Math.round(v / fat * 100)}%</span></span><b>${money(v)}</b><div><i style="width:${v / fat * 100}%"></i></div></li>`).join('')}</ul>
        <h2 style="margin-top:22px">Mais vendidas</h2>
        <ul class="hbars">${topL.map(([n, t]) => `<li><span>${esc(n)}</span><b>${t.q} un</b><div><i style="width:${t.q / topMax * 100}%;background:var(--gold)"></i></div></li>`).join('')}</ul>
      </section></div>` : ''}
    <h2 style="margin-top:6px">${todas.length ? `${todas.length} ${todas.length === 1 ? 'venda' : 'vendas'} no período${nc ? `, ${nc} ${nc === 1 ? 'cancelada' : 'canceladas'}` : ''}` : ''}</h2>
    ${todas.length ? `<div class="vlist">${todas.slice(0, 500).map(v => `<button class="vrow ${v.cancelada ? 'cancel' : ''}" type="button" data-venda="${v.id}">
        <span><strong>${esc(v.cliente_nome || resumoItens(v))}</strong><span class="meta"><span>${fmtDT(v.data)}</span><span>${sum(v.itens.map(i => i.qtd))} ${sum(v.itens.map(i => i.qtd)) === 1 ? 'peça' : 'peças'}</span>${v.vendedor ? `<span>${esc(v.vendedor)}</span>` : ''}<span class="code">${esc(v.numero)}</span></span></span>
        <span>${v.cancelada ? '<span class="tag bad">cancelada</span>' : `<span class="tag">${esc(v.forma)}${v.parcelas > 1 ? ' ' + v.parcelas + 'x' : ''}</span>`}</span>
        <span class="vt">${money(v.total)}</span></button>`).join('')}</div>`
      : `<div class="empty panel"><strong>Nenhuma venda neste período</strong>Escolha outro período ou registre uma venda na tela Vender.</div>`}`;
}
$('#per').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; per = b.dataset.v;
  $$('#per button').forEach(x => x.setAttribute('aria-pressed', x === b));
  $('#per-de').hidden = $('#per-ate').hidden = per !== 'per';
  if (per === 'per' && !$('#per-de').value) { const h = new Date(); $('#per-de').value = dayKey(new Date(h.getFullYear(), h.getMonth(), 1)); $('#per-ate').value = dayKey(h); }
  rVendas();
});
['per-de', 'per-ate', 'per-forma', 'per-vend'].forEach(id => $('#' + id).addEventListener('change', rVendas));
function csv(linhas) { return '\ufeff' + linhas.map(l => l.map(c => { const s = String(c ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n'); }
const n2 = v => (+v || 0).toFixed(2).replace('.', ',');
function csvVendas(lista) {
  return csv([['Número', 'Data', 'Hora', 'Vendedora', 'Cliente', 'Telefone', 'Itens', 'Peças', 'Subtotal', 'Desconto', 'Total', 'Pagamento', 'Parcelas', 'Situação'],
    ...lista.map(v => { const d = new Date(v.data); return [v.numero, d.toLocaleDateString('pt-BR'), fmtHora(v.data), v.vendedor, v.cliente_nome, v.cliente_tel, v.itens.map(i => `${i.qtd}x ${i.nome} ${i.tamanho} ${i.cor}`).join(' | '), sum(v.itens.map(i => i.qtd)), n2(v.subtotal), n2(v.desconto), n2(v.total), v.forma, v.parcelas, v.cancelada ? 'Cancelada' : 'Concluída']; })]);
}
function csvEstoque() {
  return csv([['Código', 'Tipo', 'Nome', 'Tamanho', 'Cor', 'Preço', 'Custo', 'Estoque', 'Estoque mínimo'],
    ...ativos().sort((a, b) => nomeP(a).localeCompare(nomeP(b))).map(p => [p.codigo, p.tipo, nomeP(p), p.tamanho, p.cor, n2(p.preco), p.custo == null ? '' : n2(p.custo), p.qtd, p.estoque_min])]);
}

// ---------- AJUSTES ----------
const SQL = `-- DR Darre · estrutura da nuvem. Rode uma vez no SQL Editor do Supabase.
create table if not exists public.produtos (
  id uuid primary key, codigo text not null, tipo text, descricao text, tamanho text, cor text,
  preco numeric(12,2) not null default 0, custo numeric(12,2), qtd integer not null default 0,
  estoque_min integer not null default 2, deleted boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.ajustes (
  id uuid primary key, produto_id uuid not null references public.produtos(id), delta integer not null,
  motivo text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.vendas (
  id uuid primary key, numero text, data timestamptz not null default now(), itens jsonb not null default '[]',
  subtotal numeric(12,2) default 0, desconto numeric(12,2) default 0, desconto_tipo text, total numeric(12,2) default 0,
  forma text, parcelas integer default 1, recebido numeric(12,2), troco numeric(12,2), cliente_nome text, cliente_tel text,
  cancelada boolean not null default false, baixa_estoque boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.config (id text primary key, valor jsonb not null default '{}', updated_at timestamptz not null default now());
create index if not exists produtos_upd on public.produtos(updated_at);
create index if not exists vendas_upd on public.vendas(updated_at);
create index if not exists vendas_data on public.vendas(data);
-- versão 3.3: vendedora nas vendas e detalhes das movimentações (devoluções). Pode rodar de novo sem problema.
alter table public.vendas add column if not exists vendedor text;
alter table public.ajustes add column if not exists tipo text;
alter table public.ajustes add column if not exists venda_id uuid;
alter table public.ajustes add column if not exists cliente text;
alter table public.ajustes add column if not exists vendedor text;
alter table public.ajustes add column if not exists valor numeric(12,2);
create index if not exists ajustes_upd on public.ajustes(updated_at);

-- carimbo de alteração (usado na sincronização)
create or replace function public.prd_upd() returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;
do $$ declare t text; begin foreach t in array array['produtos','ajustes','vendas','config'] loop
  execute format('drop trigger if exists %I_upd on public.%I', t, t);
  execute format('create trigger %I_upd before insert or update on public.%I for each row execute function public.prd_upd()', t, t);
end loop; end $$;

-- estoque: entradas e ajustes somam, vendas descontam, cancelamentos devolvem
create or replace function public.prd_ajuste() returns trigger language plpgsql as $$
begin update public.produtos set qtd = qtd + new.delta where id = new.produto_id; return new; end $$;
drop trigger if exists ajustes_estoque on public.ajustes;
create trigger ajustes_estoque after insert on public.ajustes for each row execute function public.prd_ajuste();

create or replace function public.prd_venda() returns trigger language plpgsql as $$
declare it jsonb; s int := 0;
begin
  if tg_op = 'INSERT' then
    if not new.cancelada and new.baixa_estoque then s := -1; end if;
  elsif new.cancelada and not old.cancelada then s := 1;
  elsif old.cancelada and not new.cancelada then s := -1;
  end if;
  if s <> 0 then
    for it in select * from jsonb_array_elements(new.itens) loop
      if it ? 'produto_id' and (it->>'produto_id') is not null then
        update public.produtos set qtd = qtd + s * coalesce((it->>'qtd')::int, 1) where id = (it->>'produto_id')::uuid;
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists vendas_estoque on public.vendas;
create trigger vendas_estoque after insert or update of cancelada on public.vendas for each row execute function public.prd_venda();

-- segurança: só usuários logados da loja acessam
do $$ declare t text; begin foreach t in array array['produtos','ajustes','vendas','config'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('drop policy if exists equipe on public.%I', t);
  execute format('create policy equipe on public.%I for all to authenticated using (true) with check (true)', t);
  execute format('grant select, insert, update, delete on public.%I to authenticated', t);
end loop; end $$;
notify pgrst, 'reload schema';`;

function rAjustes() {
  const c = cfg();
  $('#v-ajustes').innerHTML = `<h1 class="h1">Ajustes</h1>
  <div class="aj-grid">
    <section class="panel wide" id="aj-nuvem"></section>
    <section class="panel"><h2>Dados da loja</h2><p>Aparecem no topo do sistema, nos recibos e nas etiquetas.</p>
      <form id="f-loja" class="fgrid">
        <label>Nome da loja<input name="nome" value="${esc(c.nome)}" required></label>
        <label>Frase abaixo do nome<input name="subtitulo" value="${esc(c.subtitulo)}"></label>
        <label>WhatsApp da loja<input name="whatsapp" inputmode="tel" value="${esc(c.whatsapp)}" placeholder="(19) 99999-9999"></label>
        <label>Instagram<input name="instagram" value="${esc(c.instagram)}" placeholder="@drdarre"></label>
        <label class="span2" style="grid-column:1/-1">Mensagem no recibo<textarea name="rodape" rows="2">${esc(c.rodape)}</textarea></label>
        <div style="grid-column:1/-1"><button class="btn primary" type="submit">Salvar dados da loja</button></div>
      </form></section>
    <section class="panel"><h2>Tipos, tamanhos e vendedoras</h2><p>Separe por vírgula. A ordem dos tamanhos é usada nas listas e no cadastro.</p>
      <form id="f-listas" style="display:grid;gap:12px">
        <label>Tipos de peça<textarea name="tipos" rows="3">${esc(c.tipos.join(', '))}</textarea></label>
        <label>Tamanhos<input name="tamanhos" value="${esc(c.tamanhos.join(', '))}"></label>
        <label>Vendedoras<input name="vendedores" value="${esc(vendedoras().join(', '))}" aria-describedby="vend-dica"></label>
        <p id="vend-dica" style="margin:-4px 0 0;font-size:13px">Na venda aparece também a opção Outros, para escrever outro nome.</p>
        <div><button class="btn primary" type="submit">Salvar listas</button></div>
      </form></section>
    <section class="panel" id="aj-app"></section>
    <section class="panel"><h2>Aparência</h2><p>O modo automático segue o celular ou computador.</p>
      <div class="seg" id="seg-tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${S.tema === v}">${l}</button>`).join('')}</div></section>
    <section class="panel"><h2>Cópias e planilhas</h2><p>O backup guarda peças, vendas e ajustes em um arquivo que pode ser restaurado em qualquer aparelho.</p>
      <div class="btns">
        <button class="btn ghost" type="button" data-act="backup">Baixar backup</button>
        <button class="btn ghost" type="button" data-act="restaurar">Restaurar backup</button>
        <button class="btn ghost" type="button" data-act="csv-estoque">Planilha do estoque</button>
        <button class="btn ghost" type="button" data-act="csv-todas">Planilha de todas as vendas</button>
      </div>
      <input type="file" id="arq-backup" accept=".json,application/json" hidden>
      <div class="btns" style="margin-top:22px"><button class="btn danger" type="button" data-act="apagar">Apagar dados deste aparelho</button></div></section>
  </div>`;
  pintarNuvem(); pintarApp();
  $('#f-loja').addEventListener('submit', e => { e.preventDefault(); const f = e.target; ['nome', 'subtitulo', 'whatsapp', 'instagram', 'rodape'].forEach(k => cfg()[k] = f[k].value.trim()); if (!cfg().nome) cfg().nome = 'DR Darre'; dirty('config', 'loja'); pintarMarca(); toast('Dados da loja salvos.', 'ok'); });
  $('#f-listas').addEventListener('submit', e => {
    e.preventDefault(); const sp = s => [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))];
    const t = sp(e.target.tipos.value), tm = sp(e.target.tamanhos.value), vd = sp(e.target.vendedores.value).filter(n => norm(n) !== 'outros');
    if (!t.length || !tm.length) return toast('Informe pelo menos um tipo e um tamanho.', 'warn');
    if (!vd.length) return toast('Informe pelo menos uma vendedora.', 'warn');
    cfg().tipos = t; cfg().tamanhos = tm; cfg().vendedores = vd; dirty('config', 'loja'); listasAux(); toast('Listas salvas.', 'ok');
  });
  $('#seg-tema').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.tema = b.dataset.v; aplicarTema(); persist(); $$('#seg-tema button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('#arq-backup').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restaurar(f); });
}
function pintarNuvem() {
  const el = $('#aj-nuvem'); if (!el) return;
  const cl = S.cloud || {}, n = pendentes(), logado = Cloud.pronto();
  el.innerHTML = `<h2>Nuvem</h2>
    ${logado ? `<div class="cloud-state ${cl.erro ? 'bad' : 'ok'}"><div class="grow"><b>${cl.erro ? 'Conectada, mas a última sincronização falhou' : 'Conectada e sincronizando'}</b>
        <small>${esc(cl.email || '')} em ${esc(cl.url.replace('https://', ''))}<br>${S.lastSync ? 'Última sincronização: ' + fmtDT(S.lastSync) : 'Ainda não sincronizou.'}${n ? `, ${n} ${n === 1 ? 'alteração' : 'alterações'} a enviar` : ''}${cl.erro ? '<br>Motivo: ' + esc(traduzErro(cl.erro)) : ''}</small></div></div>
      <div class="btns"><button class="btn primary" type="button" data-act="sync">Sincronizar agora</button><button class="btn ghost" type="button" data-act="sair">Desconectar este aparelho</button></div>`
    : `<p>${cl.url ? 'A sessão expirou ou foi encerrada. Entre de novo para voltar a sincronizar.' : 'Conecte a um projeto Supabase para guardar tudo na nuvem e usar o mesmo estoque em vários celulares e computadores. Sem conexão, o sistema funciona normalmente e envia as alterações depois.'}</p>
      <form id="f-nuvem" class="fgrid">
        <label class="span2">Endereço do projeto<input name="url" value="${esc(cl.url || '')}" placeholder="https://xxxxxxxx.supabase.co" autocomplete="off" spellcheck="false"></label>
        <label class="span2">Chave pública (anon ou publishable)<input name="key" value="${esc(cl.key || '')}" placeholder="eyJhbGciOi… ou sb_publishable_…" autocomplete="off" spellcheck="false"></label>
        <label>E-mail da loja<input name="email" type="email" value="${esc(cl.email || '')}" autocomplete="username"></label>
        <label>Senha<input name="senha" type="password" autocomplete="current-password"></label>
        <div style="grid-column:1/-1"><button class="btn primary" type="submit">Conectar à nuvem</button></div>
      </form>`}
    <details class="how" ${cl.url ? '' : 'open'}><summary>Como preparar a nuvem (uma vez só)</summary>
      <ol class="steps">
        <li>Crie uma conta grátis em supabase.com e um projeto novo. Escolha a região São Paulo (South America).</li>
        <li>No projeto, abra <b>SQL Editor</b>, cole o script abaixo e clique em <b>Run</b>.</li>
        <li>Em <b>Authentication › Users</b>, clique em <b>Add user</b> e crie o e-mail e a senha da loja, marcando <b>Auto Confirm User</b>.</li>
        <li>Em <b>Authentication › Sign In / Providers</b>, desligue <b>Allow new users to sign up</b>, para ninguém de fora criar conta.</li>
        <li>Em <b>Project Settings › API Keys</b>, copie o endereço do projeto e a chave pública. Preencha acima e toque em Conectar. Repita só este passo em cada aparelho da loja.</li>
      </ol>
      <textarea class="sql" readonly>${esc(SQL)}</textarea>
      <div class="btns"><button class="btn ghost sm" type="button" data-act="copiar-sql">Copiar script SQL</button><button class="btn ghost sm" type="button" data-act="baixar-sql">Baixar como arquivo</button></div>
    </details>`;
  $('#f-nuvem')?.addEventListener('submit', conectar);
}
async function conectar(e) {
  e.preventDefault(); const f = e.target, bt = f.querySelector('[type=submit]');
  let url = f.url.value.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  if (/^[a-z0-9]{15,30}$/.test(url)) url = `https://${url}.supabase.co`;
  if (!/^https:\/\/.+/.test(url)) return toast('Informe o endereço do projeto, começando com https://', 'warn');
  const key = f.key.value.trim(), email = f.email.value.trim(), senha = f.senha.value;
  if (!key || !email || !senha) return toast('Preencha a chave, o e-mail e a senha.', 'warn');
  if (!navigator.onLine) return toast('É preciso internet para conectar.', 'warn');
  bt.disabled = true; bt.textContent = 'Conectando…';
  const antes = S.cloud;
  S.cloud = { url, key, email };
  try {
    await Cloud.auth({ email, password: senha }, 'password');
    await Cloud.req('config?select=id&limit=1');
    if (S.lastUrl && S.lastUrl !== url) reenviarTudo();
    S.lastUrl = url; await salvarJa();
    toast('Nuvem conectada. Sincronizando…', 'ok');
    pintarNuvem(); await sync();
  } catch (err) {
    S.cloud = antes && antes.url === url ? { ...antes, refresh: null } : { url, key, email };
    persist(); bt.disabled = false; bt.textContent = 'Conectar à nuvem';
    toast(/E-mail ou senha/.test(err.message) ? err.message : 'Não foi possível conectar: ' + traduzErro(err.message), 'bad');
  }
  pintarSync();
}
async function restaurar(file) {
  let j; try { j = JSON.parse(await file.text()); } catch { return toast('Este arquivo não é um backup válido.', 'bad'); }
  if (j.pecas) { if (!await confirmar(`Importar o backup do sistema anterior (${(j.pecas || []).length} peças, ${(j.vendas || []).length} vendas)?`, { ok: 'Importar' })) return; const r = importarV2(j); renderDados(); return toast(`${r.np} peças e ${r.nv} vendas importadas.`, 'ok'); }
  if (!j.produtos || !j.vendas) return toast('Este arquivo não é um backup do DR Darre.', 'bad');
  if (!await confirmar(`Restaurar o backup de ${j.exportado ? fmtDT(j.exportado) : 'data desconhecida'}? As peças e vendas do arquivo serão juntadas às deste aparelho.`, { ok: 'Restaurar' })) return;
  j.produtos.forEach(p => { const atual = S.produtos[p.id]; const delta = (+p.qtd || 0) - (atual ? atual.qtd : 0); S.produtos[p.id] = { ...p }; dirty('produtos', p.id); if (delta) addAjuste(p.id, delta, 'Backup restaurado', { tipo: 'carga' }); });
  j.vendas.forEach(v => { if (!S.vendas[v.id]) { S.vendas[v.id] = { ...v, baixa_estoque: false }; dirty('vendas', v.id); } });
  (j.movs || []).forEach(m => { if (!S.movs[m.id]) S.movs[m.id] = m; });
  if (j.config) { S.config.valor = { ...DEF_CFG, ...j.config }; dirty('config', 'loja'); }
  await salvarJa(); renderDados(); toast('Backup restaurado.', 'ok');
}

// ---------- ações globais ----------
document.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]'); if (go) return ir(go.dataset.go);
  const ed = e.target.closest('[data-edit]'); if (ed) return abrirProduto(ed.dataset.edit);
  const vd = e.target.closest('[data-venda]'); if (vd) return abrirVenda(vd.dataset.venda);
  const et = e.target.closest('[data-etq]'); if (et) return abrirEtiquetas([et.dataset.etq]);
  const co = e.target.closest('[data-cons]'); if (co) return consultar(co.dataset.cons);
  const dv = e.target.closest('[data-dev]'); if (dv) { const [pid, vid] = dv.dataset.dev.split('|'); return abrirDevolucao(pid, vid); }
  const ac = e.target.closest('[data-addcart]'); if (ac) { const p = S.produtos[ac.dataset.addcart]; if (p) { ir('vender'); adicionar(p); } return; }
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const hoje = dayKey(new Date());
  switch (act) {
    case 'nova-peca': abrirProduto(); break;
    case 'instalar': instalarApp(); break;
    case 'ver-baixo': ir('produtos'); $('#p-baixo').checked = true; rProdutos(); break;
    case 'mais': pLimite += 200; rProdutos(); break;
    case 'mais-mov': mLimite += 300; rEstoque(); break;
    case 'csv-mov': { const l = movimentos(); if (!l.length) return toast('Não há movimentações no período escolhido.', 'warn'); baixar(`movimentacoes-${hoje}.csv`, csvMov(), 'text/csv;charset=utf-8'); break; }
    case 'sel-etq': abrirEtiquetas([...sel]); break;
    case 'sel-clear': sel.clear(); rProdutos(); break;
    case 'csv-vendas': { const l = vendasFiltradas(true); if (!l.length) return toast('Não há vendas no período escolhido.', 'warn'); baixar(`vendas-${hoje}.csv`, csvVendas(l), 'text/csv;charset=utf-8'); break; }
    case 'csv-todas': baixar(`vendas-completo-${hoje}.csv`, csvVendas(Object.values(S.vendas).sort((a, b) => b.data.localeCompare(a.data))), 'text/csv;charset=utf-8'); break;
    case 'csv-estoque': baixar(`estoque-${hoje}.csv`, csvEstoque(), 'text/csv;charset=utf-8'); break;
    case 'backup': baixar(`backup-drdarre-${hoje}.json`, JSON.stringify({ sistema: 'DR Darre', versao: 3, exportado: nowISO(), produtos: Object.values(S.produtos), vendas: Object.values(S.vendas), movs: Object.values(S.movs), config: cfg() }), 'application/json'); toast('Backup baixado.', 'ok'); break;
    case 'restaurar': $('#arq-backup').click(); break;
    case 'sync': sync(true); break;
    case 'sair': if (await confirmar(pendentes() ? `Há ${pendentes()} alterações que ainda não subiram. Desconectando agora, elas ficam só neste aparelho até você entrar de novo. Continuar?` : 'Desconectar este aparelho da nuvem? Os dados continuam salvos aqui.', { ok: 'Desconectar', perigo: !!pendentes() })) { S.cloud = { url: S.cloud.url, key: S.cloud.key, email: S.cloud.email }; persist(); pintarNuvem(); pintarSync(); } break;
    case 'copiar-sql': try { await navigator.clipboard.writeText(SQL); toast('Script copiado. Cole no SQL Editor do Supabase.', 'ok'); } catch { $('.sql').select(); toast('Selecionei o script: use Ctrl + C para copiar.', 'warn'); } break;
    case 'baixar-sql': baixar('drdarre-supabase.sql', SQL, 'text/plain;charset=utf-8'); break;
    case 'apagar':
      if (!await confirmar(Cloud.pronto() ? 'Apagar os dados deste aparelho? O que já está na nuvem continua lá e volta quando você conectar de novo.' : 'Apagar TODAS as peças e vendas deste aparelho? Sem nuvem conectada, isso não tem volta. Faça um backup antes.', { ok: 'Apagar dados', perigo: true })) return;
      if (pendentes() && Cloud.pronto() && !await confirmar(`Ainda há ${pendentes()} alterações sem enviar à nuvem. Elas serão perdidas.`, { ok: 'Apagar mesmo assim', perigo: true })) return;
      await KV.del('state'); localStorage.setItem('pr-darre-migrado', '1'); location.reload(); break;
  }
});
$('#sync-pill').addEventListener('click', () => { ir('ajustes'); if (Cloud.pronto()) sync(true); });
function aplicarTema() {
  const r = document.documentElement;
  if (S.tema === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = S.tema;
  const escuro = S.tema === 'dark' || (S.tema === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = escuro ? '#161217' : '#FAF7F8';
}
$('#btn-tema').addEventListener('click', () => {
  const escuro = S.tema === 'dark' || (S.tema === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  S.tema = escuro ? 'light' : 'dark'; aplicarTema(); persist(); if (vista === 'ajustes') $$('#seg-tema button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === S.tema));
});
document.addEventListener('keydown', e => {
  if (e.key === 'F2') { e.preventDefault(); ir('vender'); setTimeout(() => busca.focus(), 50); }
  if (e.key === 'F3') { e.preventDefault(); ir('estoque'); setTimeout(() => { consBusca.focus(); consBusca.select(); }, 50); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && vista === 'vender' && !dlg.open) { e.preventDefault(); finalizar(); }
});
window.addEventListener('hashchange', mostrar);
window.addEventListener('online', () => { pintarSync(); sync(); });
window.addEventListener('offline', () => pintarSync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); else salvarJa(); });
window.addEventListener('pagehide', () => salvarJa());
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 25000);


// ---------- aplicativo instalável (PWA) ----------
let pedidoInstalar = null, armazenamentoFixo = null;
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ehIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); pedidoInstalar = e; if (vista === 'inicio') rInicio(); pintarApp(); });
window.addEventListener('appinstalled', () => { pedidoInstalar = null; toast('Aplicativo instalado. Procure o ícone DR Darre na tela do celular.', 'ok'); renderDados(); pintarApp(); });
async function instalarApp() {
  if (!pedidoInstalar) return ir('ajustes');
  pedidoInstalar.prompt();
  const r = await pedidoInstalar.userChoice.catch(() => null);
  if (r && r.outcome === 'accepted') pedidoInstalar = null;
  renderDados(); pintarApp();
}
function pintarApp() {
  const el = $('#aj-app'); if (!el) return;
  const seguro = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  let corpo;
  if (instalado()) corpo = `<div class="cloud-state ok"><div class="grow"><b>Você está usando o aplicativo instalado</b><small>Ele abre mesmo sem internet. As vendas sobem para a nuvem quando a conexão voltar.</small></div></div>`;
  else if (!seguro) corpo = `<p>Para instalar no celular, o sistema precisa estar publicado num endereço que começa com https, como o GitHub Pages. Aberto direto do arquivo, ele funciona, mas não vira aplicativo.</p>`;
  else if (pedidoInstalar) corpo = `<p>Instale para abrir o sistema pelo ícone na tela inicial, em tela cheia e sem internet.</p><div class="btns"><button class="btn primary" type="button" data-act="instalar">Instalar aplicativo</button></div>`;
  else if (ehIOS()) corpo = `<p>No iPhone, instale pelo Safari:</p><ol class="steps"><li>Toque no botão <b>Compartilhar</b> (o quadrado com a seta para cima).</li><li>Escolha <b>Adicionar à Tela de Início</b>.</li><li>Toque em <b>Adicionar</b>.</li></ol>`;
  else corpo = `<p>No Android, abra o menu do Chrome (os três pontinhos) e toque em <b>Instalar aplicativo</b> ou <b>Adicionar à tela inicial</b>.</p>`;
  const fixo = armazenamentoFixo === true ? 'Os dados deste aparelho estão protegidos contra limpeza automática do navegador.' : armazenamentoFixo === false ? 'O navegador pode apagar os dados deste aparelho se faltar espaço. Instale o aplicativo ou conecte a nuvem para proteger.' : '';
  el.innerHTML = `<h2>Aplicativo no celular</h2>${corpo}${fixo ? `<p style="margin-top:12px;font-size:13px">${fixo}</p>` : ''}`;
}
async function protegerArmazenamento() {
  try { if (navigator.storage && navigator.storage.persist) armazenamentoFixo = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch {}
  pintarApp();
}
function registrarSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const avisar = w => toast('Há uma versão nova do sistema.', 'ok', { label: 'Atualizar', fn: () => w.postMessage('atualizar') });
    if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) avisar(w); }); });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(e => console.warn('Service worker não registrado', e));
  let recarregando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (recarregando) return; recarregando = true; salvarJa().then(() => location.reload()); });
}

// ---------- início ----------
(async function iniciar() {
  const salvo = await KV.get('state');
  if (salvo && salvo.v === 3) {
    const base = novoEstado();
    S = { ...base, ...salvo, movs: salvo.movs || {}, outbox: { ...base.outbox, ...salvo.outbox }, cursor: { ...base.cursor, ...salvo.cursor }, config: { id: 'loja', ...salvo.config, valor: { ...DEF_CFG, ...(salvo.config?.valor || {}) } } };
  }
  if (localStorage.getItem('pr-darre-tema') === 'true' && !salvo) S.tema = 'dark';
  aplicarTema();
  Object.values(S.ajustes).forEach(a => { if (!S.movs[a.id]) S.movs[a.id] = { ...a }; });   // ajustes ainda não enviados entram no histórico
  if (salvo && salvo.v === 3 && !salvo.movs && Cloud.pronto()) S.cursor.ajustes = '';          // baixa da nuvem o histórico antigo
  if (S.config.valor.nome === 'PR Darre') { S.config.valor.nome = 'DR Darre'; dirty('config', 'loja'); }
  let migrou = null;
  if (!localStorage.getItem('pr-darre-migrado')) {
    try { const antigo = JSON.parse(localStorage.getItem('pr-darre-dados') || 'null'); if (antigo && (antigo.pecas?.length || antigo.vendas?.length)) migrou = importarV2(antigo); } catch {}
    localStorage.setItem('pr-darre-migrado', '1'); await salvarJa();
  }
  mostrar(); registrarSW(); protegerArmazenamento();
  if (migrou) toast(`Trouxe ${migrou.np} ${migrou.np === 1 ? 'peça' : 'peças'} e ${migrou.nv} ${migrou.nv === 1 ? 'venda' : 'vendas'} do sistema anterior.`, 'ok');
  sync();
})();
