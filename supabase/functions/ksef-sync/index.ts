/* Finovo — загрузка фактур клиентов из KSeF API 2.0.

   Режимы (POST JSON):
     { mode: 'cron' }                         — все подключённые фирмы (заголовок x-cron-secret), запускает pg_cron
     { mode: 'sync', firm_id }                — одна фирма сейчас (сотрудник бюро)
     { mode: 'connect', firm_id, env, nip?, token, sync_from? } — проверить токен KSeF, сохранить в Vault, загрузить
     { mode: 'disconnect', firm_id }          — отключить (фактуры остаются)

   Как загружается:
     1. Вход токеном KSeF в контексте NIP клиента.
     2. Метаданные новых фактур с прошлой контрольной точки (дата PermanentStorage + High Water Mark),
        отдельно продажи (Subject1) и покупки (Subject2) → строки в invoices. Дублей нет: уникальный (firm_id, ksef_no).
     3. Для части новых фактур — XML FA(3): точная ставка, срок оплаты, отметка об оплате, курс, позиции;
        XML сохраняется в хранилище docs/<firm>/ksef/<номер>.xml. Остальные дозагрузятся в следующий запуск
        (лимит KSeF на скачивание фактур — 16 в минуту, 64 в час).
     4. 429 от KSeF → пауза до Retry-After (blocked_until), без повторных ударов. */
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { Ksef, KsefError, validNip, type Env, type InvoiceMetadata } from './ksef.ts';
import { parseFa, categorize } from './fa3.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
async function secret(name: string) { const { data } = await admin.rpc('app_secret', { secret_name: name }); return data as string | null; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (d: Date) => d.toISOString();
const WINDOW_DAYS = 90;           // окно запроса метаданных
const XML_PER_RUN = 12;           // сколько XML скачивать за один запуск (лимит KSeF: 16/мин, 64/ч)

/* ---- курс NBP (таблица A) за последний рабочий день перед датой ---- */
const fxCache = new Map<string, number>();
async function nbp(cur: string, date: string): Promise<number | null> {
  const k = cur + date; if (fxCache.has(k)) return fxCache.get(k)!;
  const d = new Date(date + 'T12:00:00Z'), from = new Date(d.getTime() - 12 * 864e5), to = new Date(d.getTime() - 864e5);
  try {
    const r = await fetch(`https://api.nbp.pl/api/exchangerates/rates/a/${cur.toLowerCase()}/${iso(from).slice(0, 10)}/${iso(to).slice(0, 10)}/?format=json`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json(); const last = j.rates?.[j.rates.length - 1];
    if (!last) return null; fxCache.set(k, last.mid); return last.mid;
  } catch { return null; }
}

function guessRate(net: number, vat: number) {
  if (!net) return '23';
  if (Math.abs(vat) < 0.005) return '0';
  const p = Math.abs(vat / net) * 100;
  return ([23, 8, 5] as const).reduce((a, b) => (Math.abs(p - b) < Math.abs(p - a) ? b : a), 23 as number).toString();
}

async function metaRow(firmId: string, kind: 'sale' | 'cost', m: InvoiceMetadata) {
  const currency = m.currency || 'PLN';
  const cpName = kind === 'sale' ? m.buyer?.name : m.seller?.name;
  const cpNip = kind === 'sale' ? (m.buyer?.identifier?.value || null) : (m.seller?.nip || null);
  return {
    firm_id: firmId, kind, number: m.invoiceNumber, issue_date: m.issueDate,
    counterparty: cpName || cpNip || '—', cp_nip: cpNip,
    net: r2(+m.netAmount || 0), vat: r2(+m.vatAmount || 0), vat_rate: guessRate(+m.netAmount, +m.vatAmount),
    currency, fx: currency === 'PLN' ? 1 : (await nbp(currency, m.issueDate)) ?? 1,
    category: kind === 'sale' ? 'Выручка' : categorize(cpName || ''),
    source: 'ksef', ksef_no: m.ksefNumber, ksef_type: m.invoiceType || null,
  };
}

type Conn = { firm_id: string; env: Env; nip: string; secret_name: string; sync_from: string; cp_sale: string | null; cp_cost: string | null; blocked_until: string | null };

async function syncFirm(conn: Conn, opts: { xml?: number; deadline: number }) {
  const started = new Date();
  if (conn.blocked_until && Date.parse(conn.blocked_until) > Date.now())
    return { firm_id: conn.firm_id, skipped: 'пауза KSeF до ' + conn.blocked_until };
  const token = await secret(conn.secret_name);
  if (!token) throw new Error('Нет токена KSeF — подключите заново');
  const k = new Ksef(conn.env);
  const stats = { sale: 0, cost: 0, xml: 0, pending: 0, calls: 0 };
  const patch: Record<string, unknown> = {};
  try {
    await k.loginWithToken(conn.nip, token);
    for (const [subject, kind, cpKey] of [['Subject1', 'sale', 'cp_sale'], ['Subject2', 'cost', 'cp_cost']] as const) {
      let cp = (conn[cpKey] || conn.sync_from) as string;
      for (let guard = 0; guard < 12 && Date.now() < opts.deadline; guard++) {
        const winEnd = Date.parse(cp) + WINDOW_DAYS * 864e5;
        const to = winEnd < Date.now() - 60e3 ? iso(new Date(winEnd)) : undefined;   // последнее окно — до HWM
        let from = cp, page = 0, last: InvoiceMetadata | null = null, hwm: string | undefined;
        for (let p = 0; p < 40; p++) {
          const r = await k.queryMetadata(subject, from, to, page);
          hwm = r.permanentStorageHwmDate || hwm;
          if (r.invoices?.length) {
            last = r.invoices[r.invoices.length - 1];
            const rows = [];
            for (const m of r.invoices) rows.push(await metaRow(conn.firm_id, kind, m));
            const { data, error } = await admin.from('invoices').upsert(rows, { onConflict: 'firm_id,ksef_no', ignoreDuplicates: true }).select('id');
            if (error) throw error;
            stats[kind] += (data || []).length;
          }
          if (r.hasMore && !r.isTruncated) { page++; continue; }
          if (r.hasMore && r.isTruncated && last) { from = last.permanentStorageDate; page = 0; continue; }
          break;
        }
        // следующая точка: конец окна, либо HWM (всё, что до него, KSeF гарантирует полностью)
        const next = to || hwm || last?.permanentStorageDate || cp;
        cp = next; patch[cpKey] = next;
        if (!to) break;
      }
    }

    // XML для фактур без XML: свежие первыми
    const { data: pend } = await admin.from('invoices').select('id,kind,ksef_no,category,paid_at,currency,issue_date,counterparty')
      .eq('firm_id', conn.firm_id).not('ksef_no', 'is', null).is('ksef_xml', null).order('issue_date', { ascending: false }).limit(opts.xml ?? XML_PER_RUN);
    for (const inv of pend || []) {
      if (Date.now() > opts.deadline) break;
      const xml = await k.getInvoiceXml(inv.ksef_no);
      const path = `${conn.firm_id}/ksef/${inv.ksef_no.replace(/[^\w.-]/g, '_')}.xml`;
      await admin.storage.from('docs').upload(path, new Blob([xml], { type: 'application/xml' }), { upsert: true, contentType: 'application/xml' });
      const upd: Record<string, unknown> = { ksef_xml: path };
      try {
        const f = parseFa(xml);
        Object.assign(upd, { net: f.net, vat: f.vat, vat_rate: f.rate, due_date: f.dueDate });
        if (f.number) upd.number = f.number;
        if (f.currency !== 'PLN') upd.fx = f.fx ?? (await nbp(f.currency, f.issueDate || inv.issue_date)) ?? 1;
        if (f.paidAt && !inv.paid_at) upd.paid_at = f.paidAt;
        if (inv.kind === 'cost' && (!inv.category || inv.category === 'Прочие расходы'))
          upd.category = categorize([f.seller.name, ...f.lines].join(' '));
        const cp = inv.kind === 'sale' ? f.buyer : f.seller;
        if (cp.name && (!inv.counterparty || inv.counterparty === '—' || /^\d+$/.test(inv.counterparty))) upd.counterparty = cp.name;
      } catch (e) { console.error('parse', inv.ksef_no, e); }
      await admin.from('invoices').update(upd).eq('id', inv.id);
      stats.xml++;
      await sleep(300);
    }
    const { count } = await admin.from('invoices').select('id', { count: 'exact', head: true })
      .eq('firm_id', conn.firm_id).not('ksef_no', 'is', null).is('ksef_xml', null);
    stats.pending = count || 0;
    Object.assign(patch, { last_ok_at: iso(new Date()), last_error: null, blocked_until: null });
  } catch (e) {
    const err = e as KsefError;
    patch.last_error = String(err.message || e).slice(0, 500);
    if (err.status === 429) patch.blocked_until = iso(new Date(Date.now() + (err.retryAfter || 60) * 1000));
    if (err.status !== 429 && !(e instanceof KsefError)) console.error(e);
  } finally {
    if (k.access) await k.logout();
    stats.calls = k.calls;
    Object.assign(patch, { last_sync_at: iso(started), stats, updated_at: iso(new Date()) });
    await admin.from('ksef_connections').update(patch).eq('firm_id', conn.firm_id);
    if (stats.sale || stats.cost || patch.last_error)
      await admin.from('audit_log').insert({ firm_id: conn.firm_id, action: 'ksef_sync', detail: { ...stats, error: patch.last_error || null } });
  }
  return { firm_id: conn.firm_id, ok: !patch.last_error, error: patch.last_error || null, ...stats };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === 'cron') {
      if (!req.headers.get('x-cron-secret') || req.headers.get('x-cron-secret') !== await secret('cron_secret')) return json({ error: 'forbidden' }, 403);
      const { data: conns } = await admin.from('ksef_connections').select('*').eq('active', true).order('last_sync_at', { ascending: true, nullsFirst: true });
      const out = [];
      for (const c of conns || []) {
        if (Date.now() - t0 > 110e3) { out.push({ firm_id: c.firm_id, skipped: 'не успели — в следующий раз' }); continue; }
        try { out.push(await syncFirm(c, { deadline: t0 + 120e3 })); } catch (e) { out.push({ firm_id: c.firm_id, error: String((e as Error).message || e) }); }
      }
      return json({ ok: true, firms: out });
    }

    // остальное — только сотрудники бюро
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: who } = await admin.auth.getUser(jwt);
    if (!who?.user) return json({ error: 'Нужно войти' }, 401);
    const { data: st } = await admin.from('staff').select('user_id').eq('user_id', who.user.id).maybeSingle();
    if (!st) return json({ error: 'Только для сотрудников бюро' }, 403);
    const fid = body.firm_id;
    const { data: firm } = await admin.from('firms').select('id,nip,opening_date').eq('id', fid).maybeSingle();
    if (!firm) return json({ error: 'Фирма не найдена' }, 404);

    if (body.mode === 'connect') {
      const env: Env = ['test', 'demo', 'prod'].includes(body.env) ? body.env : 'test';
      const nip = String(body.nip || firm.nip || '').replace(/\D/g, '');
      const token = String(body.token || '').trim();
      if (!validNip(nip)) return json({ error: 'Неверный NIP' }, 400);
      if (token.length < 20) return json({ error: 'Вставьте токен KSeF целиком' }, 400);
      const k = new Ksef(env);
      try { await k.loginWithToken(nip, token); } catch (e) { return json({ error: String((e as Error).message || e) }, 400); }
      await k.logout();
      const { data: old } = await admin.from('ksef_connections').select('*').eq('firm_id', fid).maybeSingle();
      const secretName = (await admin.rpc('ksef_store_token', { p_firm: fid, p_token: token })).data as string;
      const syncFrom = body.sync_from ? new Date(body.sync_from + 'T00:00:00Z').toISOString() : (old?.sync_from || new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString());
      const same = old && old.env === env && old.nip === nip && old.sync_from === syncFrom;
      const row = { firm_id: fid, env, nip, auth_method: 'token', secret_name: secretName, active: true, sync_from: syncFrom,
        cp_sale: same ? old.cp_sale : null, cp_cost: same ? old.cp_cost : null, last_error: null, blocked_until: null, updated_at: iso(new Date()) };
      const { error } = await admin.from('ksef_connections').upsert(row);
      if (error) throw error;
      await admin.from('audit_log').insert({ firm_id: fid, user_id: who.user.id, action: 'ksef_connect', detail: { env, nip } });
      const res = await syncFirm(row as Conn, { deadline: t0 + 100e3 });
      return json({ ok: true, connected: true, sync: res });
    }
    if (body.mode === 'disconnect') {
      await admin.rpc('ksef_drop_token', { p_firm: fid });
      await admin.from('ksef_connections').delete().eq('firm_id', fid);
      await admin.from('audit_log').insert({ firm_id: fid, user_id: who.user.id, action: 'ksef_disconnect', detail: {} });
      return json({ ok: true });
    }
    if (body.mode === 'sync') {
      const { data: c } = await admin.from('ksef_connections').select('*').eq('firm_id', fid).maybeSingle();
      if (!c) return json({ error: 'KSeF не подключён' }, 400);
      return json({ ok: true, sync: await syncFirm(c, { deadline: t0 + 100e3 }) });
    }
    return json({ error: 'неизвестный режим' }, 400);
  } catch (e) { console.error(e); return json({ error: String((e as Error).message || e) }, 500); }
});
