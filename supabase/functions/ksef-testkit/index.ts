/* Finovo — тестовая среда KSeF (api-test.ksef.mf.gov.pl). Только для разработки, в боевую среду не ходит.

   { mode: 'setup', firm_id, seed?: true }
     1. Самоподписанная «печать фирмы» на NIP клиента (в тестовой среде KSeF это разрешено; NIP из базы,
        если он корректный, иначе случайный корректный NIP — тестовая среда общая, реальные NIP туда нельзя).
     2. Вход XAdES → токен KSeF с правами InvoiceRead + InvoiceWrite → в Vault, подключение env = test.
     3. seed: отправляет в KSeF пару тестовых продаж (фирма → покупатель) и покупок (поставщик → фирма).
   { mode: 'seed', firm_id } — ещё несколько тестовых фактур в уже подключённую фирму.

   Доступ: сотрудник бюро (JWT) или x-cron-secret. */
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { KSeFClient, CertificateService, openSendAndClose } from 'npm:ksef-client-ts@0.16.0';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
async function secret(name: string) { const { data } = await admin.rpc('app_secret', { secret_name: name }); return data as string | null; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function validNip(n: string) {
  if (!/^\d{10}$/.test(n)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7], s = w.reduce((a, x, i) => a + x * +n[i], 0) % 11;
  return s !== 10 && s === +n[9];
}
function randomNip() {
  for (;;) {
    const d = Array.from(crypto.getRandomValues(new Uint8Array(9)), x => x % 10); if (d[0] === 0) d[0] = 1;
    const s = [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((a, x, i) => a + x * d[i], 0) % 11;
    if (s !== 10) return d.join('') + s;
  }
}
const clean = (s: string) => s.replace(/[,=+<>#;"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Firma testowa';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function login(nip: string, name: string) {
  const c = new KSeFClient({ environment: 'TEST' });
  const seal = await CertificateService.generateCompanySeal(clean(name), 'VATPL-' + nip, clean(name), 'ECDSA');
  await c.loginWithCertificate(seal.certificatePem, seal.privateKeyPem, nip);
  return c;
}

type Line = { name: string; qty: number; price: number; rate: '23' | '8' | '5' };
function fa3(o: { seller: [string, string]; buyer: [string, string]; number: string; date: string; due: string; lines: Line[]; currency?: string; fx?: number; paid?: string }) {
  const cur = o.currency || 'PLN', foreign = cur !== 'PLN';
  const g: Record<string, { net: number; vat: number }> = {};
  const rows = o.lines.map((l, i) => {
    const net = Math.round(l.qty * l.price * 100) / 100; (g[l.rate] ||= { net: 0, vat: 0 }).net += net;
    return `<FaWiersz><NrWierszaFa>${i + 1}</NrWierszaFa><P_7>${esc(l.name)}</P_7><P_8A>szt.</P_8A><P_8B>${l.qty}</P_8B><P_9A>${l.price.toFixed(2)}</P_9A><P_11>${net.toFixed(2)}</P_11><P_12>${l.rate}</P_12>${foreign ? `<KursWaluty>${o.fx!.toFixed(4)}</KursWaluty>` : ''}</FaWiersz>`;
  });
  let sums = '', total = 0;
  for (const [rate, k] of [['23', '1'], ['8', '2'], ['5', '3']] as const) {
    const x = g[rate]; if (!x) continue;
    x.net = Math.round(x.net * 100) / 100; x.vat = Math.round(x.net * +rate) / 100; total += x.net + x.vat;
    sums += `<P_13_${k}>${x.net.toFixed(2)}</P_13_${k}><P_14_${k}>${x.vat.toFixed(2)}</P_14_${k}>${foreign ? `<P_14_${k}W>${(x.vat * o.fx!).toFixed(2)}</P_14_${k}W>` : ''}`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns:etd="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
<Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>${new Date().toISOString().slice(0, 19)}Z</DataWytworzeniaFa><SystemInfo>Finovo test</SystemInfo></Naglowek>
<Podmiot1><DaneIdentyfikacyjne><NIP>${o.seller[0]}</NIP><Nazwa>${esc(o.seller[1])}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1><AdresL2>00-001 Warszawa</AdresL2></Adres></Podmiot1>
<Podmiot2><DaneIdentyfikacyjne><NIP>${o.buyer[0]}</NIP><Nazwa>${esc(o.buyer[1])}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Próbna 2</AdresL1><AdresL2>00-002 Warszawa</AdresL2></Adres><JST>2</JST><GV>2</GV></Podmiot2>
<Fa><KodWaluty>${cur}</KodWaluty><P_1>${o.date}</P_1><P_1M>Warszawa</P_1M><P_2>${esc(o.number)}</P_2>${sums}<P_15>${total.toFixed(2)}</P_15>
<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>
<RodzajFaktury>VAT</RodzajFaktury>${rows.join('')}
<Platnosc>${o.paid ? `<Zaplacono>1</Zaplacono><DataZaplaty>${o.paid}</DataZaplaty>` : ''}<TerminPlatnosci><Termin>${o.due}</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci></Platnosc></Fa>
</Faktura>`;
}

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

async function seed(firm: { name: string }, nip: string, sellerNip: string, client?: KSeFClient) {
  const tag = Date.now().toString(36).toUpperCase().slice(-5);
  const me: [string, string] = [nip, firm.name];
  const buyer: [string, string] = [randomNip(), 'Domex Development Sp. z o.o. (test)'];
  const supplier: [string, string] = [sellerNip, 'Hurtownia Budowlana Kamex (test)'];
  const sales = [
    fa3({ seller: me, buyer, number: `FV/${tag}/1`, date: day(-3), due: day(11), lines: [{ name: 'Roboty wykończeniowe — etap 1', qty: 1, price: 18500, rate: '23' }] }),
    fa3({ seller: me, buyer, number: `FV/${tag}/2`, date: day(-1), due: day(13), lines: [{ name: 'Montaż płyt g-k', qty: 120, price: 45, rate: '8' }] }),
  ];
  const costs = [
    fa3({ seller: supplier, buyer: me, number: `HB/${tag}/77`, date: day(-4), due: day(10), lines: [{ name: 'Klej do płytek', qty: 40, price: 38.5, rate: '23' }, { name: 'Płyta g-k 12,5 mm', qty: 60, price: 29.9, rate: '23' }] }),
    fa3({ seller: supplier, buyer: me, number: `HB/${tag}/78`, date: day(-2), due: day(-2), paid: day(-2), currency: 'EUR', fx: 4.25, lines: [{ name: 'Wkręty i kołki — paleta', qty: 1, price: 410, rate: '23' }] }),
  ];
  const c1 = client || await login(nip, firm.name);
  const upoS = await openSendAndClose(c1, sales);
  const c2 = await login(sellerNip, supplier[1]);
  const upoC = await openSendAndClose(c2, costs);
  try { await c2.logout(); } catch { /* */ }
  return { sales: upoS.successfulInvoiceCount ?? sales.length, costs: upoC.successfulInvoiceCount ?? costs.length, failed: (upoS.failedInvoiceCount || 0) + (upoC.failedInvoiceCount || 0) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    let uid: string | null = null;
    const cron = req.headers.get('x-cron-secret');
    if (!(cron && cron === await secret('cron_secret'))) {
      const { data: who } = await admin.auth.getUser((req.headers.get('Authorization') || '').replace('Bearer ', ''));
      if (!who?.user) return json({ error: 'Нужно войти' }, 401);
      const { data: st } = await admin.from('staff').select('user_id').eq('user_id', who.user.id).maybeSingle();
      if (!st) return json({ error: 'Только для сотрудников бюро' }, 403);
      uid = who.user.id;
    }
    const { data: firm } = await admin.from('firms').select('id,name,nip').eq('id', body.firm_id).maybeSingle();
    if (!firm) return json({ error: 'Фирма не найдена' }, 404);
    const { data: old } = await admin.from('ksef_connections').select('*').eq('firm_id', firm.id).maybeSingle();

    if (body.mode === 'setup') {
      if (old && old.env !== 'test') return json({ error: 'Фирма уже подключена к боевому KSeF — тестовое подключение не создаю' }, 400);
      const nip = old?.nip && validNip(old.nip) ? old.nip : validNip(firm.nip || '') ? firm.nip : randomNip();
      const sellerNip = old?.test_seller_nip || randomNip();
      const c = await login(nip, firm.name);
      const t = await c.tokens.generateToken({ description: 'Finovo — тестовое подключение', permissions: ['InvoiceRead', 'InvoiceWrite'] } as any);
      for (let i = 0; i < 20; i++) { const s: any = await c.tokens.getToken(t.referenceNumber); if (s.status === 'Active') break; if (s.status === 'Failed') throw new Error('KSeF не активировал токен'); await sleep(1000); }
      const secretName = (await admin.rpc('ksef_store_token', { p_firm: firm.id, p_token: t.token })).data;
      const syncFrom = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
      const { error } = await admin.from('ksef_connections').upsert({ firm_id: firm.id, env: 'test', nip, auth_method: 'token', secret_name: secretName, active: true,
        sync_from: syncFrom, cp_sale: null, cp_cost: null, last_error: null, blocked_until: null, test_seller_nip: sellerNip, updated_at: new Date().toISOString() });
      if (error) throw error;
      await admin.from('audit_log').insert({ firm_id: firm.id, user_id: uid, action: 'ksef_test_setup', detail: { nip } });
      const seeded = body.seed === false ? null : await seed(firm, nip, sellerNip, c);
      try { await c.logout(); } catch { /* */ }
      return json({ ok: true, env: 'test', nip, seeded });
    }
    if (body.mode === 'seed') {
      if (!old || old.env !== 'test') return json({ error: 'Сначала создайте тестовое подключение' }, 400);
      const sellerNip = old.test_seller_nip || randomNip();
      if (!old.test_seller_nip) await admin.from('ksef_connections').update({ test_seller_nip: sellerNip }).eq('firm_id', firm.id);
      return json({ ok: true, seeded: await seed(firm, old.nip, sellerNip) });
    }
    return json({ error: 'неизвестный режим' }, 400);
  } catch (e) { console.error(e); return json({ error: String((e as Error).message || e) }, 500); }
});
