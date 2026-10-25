import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import './calc.js';
// deno-lint-ignore no-explicit-any
const Calc = (globalThis as any).Calc;

/* Finovo — уведомления. Тексты на языке получателя (notify_prefs.lang: pl | uk). */
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
type Lang = 'pl' | 'uk';
const GEN: Record<Lang, string[]> = {
  pl: ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'],
  uk: ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'] };
const NOM: Record<Lang, string[]> = {
  pl: ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'],
  uk: ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'] };
// виды документов хранятся в базе как в приложении — переводим при отправке
const DOCS: Record<string, [string, string]> = {
  'Разрешение на работу': ['Zezwolenie na pracę', 'Дозвіл на роботу'], 'Медосмотр': ['Badania lekarskie', 'Медогляд'], 'Виза': ['Wiza', 'Віза'],
  'Договор': ['Umowa', 'Договір'], 'Karta pobytu': ['Karta pobytu', 'Karta pobytu'], 'BHP': ['BHP', 'BHP'], 'A1': ['A1', 'A1'] };
const docName = (k: string, l: Lang) => (DOCS[k] || [k, k])[l === 'uk' ? 1 : 0];
const fmt = (x: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(x || 0) + ' zł';
const dWord = (d: string, l: Lang) => +d.slice(8) + ' ' + GEN[l][+d.slice(5, 7) - 1];
const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const days = (d: string, today: string) => Math.round((Date.parse(d) - Date.parse(today)) / 864e5);
const KIND: Record<string, string> = { zus: 'ZUS', pit4: 'PIT-4', it: 'PIT', vat: 'VAT' };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
async function secret(name: string) { const { data } = await admin.rpc('app_secret', { secret_name: name }); return data as string | null; }

const langCache = new Map<string, Lang>();
async function langsOf(users: string[]) {
  const need = users.filter(u => !langCache.has(u));
  if (need.length) {
    const { data } = await admin.from('notify_prefs').select('user_id, lang').in('user_id', need);
    need.forEach(u => langCache.set(u, ((data || []).find((p: any) => p.user_id === u)?.lang === 'uk' ? 'uk' : 'pl')));
  }
  return (u: string) => langCache.get(u) || 'pl';
}

async function loadFirm(fid: string, today: string) {
  const year = today.slice(0, 4);
  const q = async (p: any) => { const { data, error } = await p; if (error) throw error; return data; };
  const [firm, invoices, employees, closes, payments, bal, members] = await Promise.all([
    q(admin.from('firms').select('*').eq('id', fid).single()),
    q(admin.from('invoices').select('*').eq('firm_id', fid).gte('issue_date', year + '-01-01').limit(10000)),
    q(admin.from('employees').select('*, employee_docs(*)').eq('firm_id', fid)),
    q(admin.from('month_close').select('*').eq('firm_id', fid)),
    q(admin.from('payments').select('*').eq('firm_id', fid)),
    q(admin.from('bank_balances').select('*').eq('firm_id', fid).order('date', { ascending: false }).limit(1)),
    q(admin.from('firm_members').select('user_id').eq('firm_id', fid))
  ]);
  const d = { firm, invoices, employees, closes, payments, balance: bal[0] || null, members };
  (d as any).year = Calc.computeYear(d, today.slice(0, 7));
  return d as any;
}

type Note = { user_id: string; firm_id: string | null; kind: string; title: string; body: string; url: string; dedup: string };
type Msg = (l: Lang) => { title: string; body: string };

async function dailyNotes(d: any, today: string): Promise<Note[]> {
  const out: Note[] = []; const f = d.firm; const it = f.type === 'jdg' ? (f.tax_form === 'ryczalt' ? 'Ryczałt' : 'PIT') : 'CIT';
  const name = f.short || f.name;
  const lang = await langsOf(d.members.map((m: any) => m.user_id));
  const forAll = (n: { firm_id: string; kind: string; url: string; dedup: string }, msg: Msg) =>
    d.members.forEach((m: any) => out.push({ ...n, ...msg(lang(m.user_id)), user_id: m.user_id }));
  const obl = d.year.flatMap((m: any) => m.obligations).filter((o: any) => !o.paid_at && o.amt > 0);
  const byDue: Record<string, any[]> = {}; obl.forEach((o: any) => (byDue[o.due] = byDue[o.due] || []).push(o));
  for (const [due, list] of Object.entries(byDue)) {
    const dd = days(due, today), sum = list.reduce((s, o) => s + o.amt, 0);
    const lines = list.map(o => (o.kind === 'it' ? it : KIND[o.kind]) + ' ' + fmt(o.amt)).join(', ');
    if (dd === 3 || dd === 0) forAll({ firm_id: f.id, kind: 'due', url: '/#taxes', dedup: `due:${due}:${dd}` }, l => l === 'uk'
      ? { title: dd === 0 ? `${name}: сьогодні термін платежів` : `${name}: платежі через 3 дні`, body: `${dWord(due, l)}: ${lines}. Разом ${fmt(sum)}.` }
      : { title: dd === 0 ? `${name}: dziś termin płatności` : `${name}: płatności za 3 dni`, body: `${dWord(due, l)}: ${lines}. Razem ${fmt(sum)}.` });
    if (dd === -1) forAll({ firm_id: f.id, kind: 'late', url: '/#taxes', dedup: `late:${due}` }, l => l === 'uk'
      ? { title: `${name}: платіж прострочено`, body: `Термін був ${dWord(due, l)}: ${lines}. Якщо вже оплатили — бюро позначить за випискою.` }
      : { title: `${name}: płatność po terminie`, body: `Termin minął ${dWord(due, l)}: ${lines}. Jeśli już zapłaciłeś, biuro oznaczy płatność na podstawie wyciągu.` });
  }
  d.employees.forEach((e: any) => (e.employee_docs || []).forEach((x: any) => {
    const dd = days(x.valid_to, today);
    if (dd === 30 || dd === 7 || dd === 0) forAll({ firm_id: f.id, kind: 'doc', url: '/#people', dedup: `doc:${x.id}:${dd}` }, l => ({
      title: `${e.name}: ${docName(x.kind, l)}`,
      body: l === 'uk' ? (dd === 0 ? 'Документ спливає сьогодні.' : `Спливає через ${dd} дн., ${dWord(x.valid_to, l)}. Подбайте про продовження.`)
                       : (dd === 0 ? 'Dokument wygasa dziś.' : `Wygasa za ${dd} dni, ${dWord(x.valid_to, l)}. Zajmij się przedłużeniem.`) }));
  }));
  d.invoices.filter((i: any) => i.kind === 'sale' && !i.paid_at && i.due_date && days(i.due_date, today) === -7).forEach((i: any) => {
    const amt = fmt(Calc.pln(i) + Calc.plnVat(i));
    forAll({ firm_id: f.id, kind: 'recv', url: '/#money', dedup: `recv:${i.id}` }, l => l === 'uk'
      ? { title: `${i.counterparty}: немає оплати`, body: `${i.number}: ${amt}, прострочка 7 днів. У застосунку є готове нагадування польською.` }
      : { title: `${i.counterparty}: brak zapłaty`, body: `${i.number}: ${amt}, 7 dni po terminie. W aplikacji jest gotowe przypomnienie po polsku.` });
  });
  if (new Date(today + 'T12:00:00Z').getUTCDay() === 1 && d.balance) {
    const need = obl.reduce((s: number, o: any) => s + o.amt, 0), bal = +d.balance.balance;
    if (bal < need) forAll({ firm_id: f.id, kind: 'reserve', url: '/', dedup: `reserve:${today}` }, l => l === 'uk'
      ? { title: `${name}: бракує на податки`, body: `Потрібно ${fmt(need)}, на рахунку ${fmt(bal)}. Бракує ${fmt(need - bal)}.` }
      : { title: `${name}: brakuje na podatki`, body: `Potrzeba ${fmt(need)}, na koncie ${fmt(bal)}. Brakuje ${fmt(need - bal)}.` });
  }
  return out;
}

async function deliver(notes: Note[]) {
  if (!notes.length) return { created: 0, pushed: 0, emailed: 0 };
  const { data: created, error } = await admin.from('notifications').upsert(notes, { onConflict: 'user_id,dedup', ignoreDuplicates: true }).select();
  if (error) throw error;
  if (!created?.length) return { created: 0, pushed: 0, emailed: 0 };
  const [pub, priv, resend, from, appUrl] = await Promise.all([secret('vapid_public'), secret('vapid_private'), secret('resend_key'), secret('mail_from'), secret('app_url')]);
  const APP = (appUrl || 'https://kabinet-biuro.netlify.app').replace(/\/$/, '');
  if (pub && priv) webpush.setVapidDetails(APP, pub, priv);
  const users = [...new Set(created.map((n: any) => n.user_id))];
  const [{ data: subs }, { data: prefs }] = await Promise.all([
    admin.from('push_subscriptions').select('*').in('user_id', users),
    admin.from('notify_prefs').select('*').in('user_id', users)]);
  const pref = (u: string) => (prefs || []).find((p: any) => p.user_id === u) || { push: true, email: true, lang: 'pl' };
  let pushed = 0, emailed = 0;
  for (const n of created as any[]) {
    const p = pref(n.user_id);
    if (p.push && pub && priv) {
      for (const s of (subs || []).filter((s: any) => s.user_id === n.user_id)) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.dedup }), { TTL: 86400 });
          pushed++; await admin.from('notifications').update({ pushed: true }).eq('id', n.id);
        } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', s.id); }
      }
    }
    if (p.email && resend && from && ['due', 'late', 'closed', 'request', 'reserve'].includes(n.kind)) {
      const { data: u } = await admin.auth.admin.getUserById(n.user_id);
      const to = u?.user?.email; if (!to || to.endsWith('.demo')) continue;
      const open = p.lang === 'uk' ? 'Відкрити кабінет: ' : 'Otwórz aplikację: ';
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + resend, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject: n.title, text: n.body + '\n\n' + open + APP + (n.url || '/') }) });
      if (r.ok) { emailed++; await admin.from('notifications').update({ emailed: true }).eq('id', n.id); }
    }
  }
  return { created: created.length, pushed, emailed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const today = warsawToday();
    if (body.mode === 'daily') {
      if (req.headers.get('x-cron-secret') !== await secret('cron_secret')) return json({ error: 'forbidden' }, 403);
      const { data: firms } = await admin.from('firms').select('id');
      const notes: Note[] = [];
      for (const f of firms || []) { try { notes.push(...await dailyNotes(await loadFirm(f.id, today), today)); } catch (e) { console.error('firm', f.id, e); } }
      return json({ ok: true, ...(await deliver(notes)) });
    }
    // события из приложения: нужен вход
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: who } = await admin.auth.getUser(jwt);
    if (!who?.user) return json({ error: 'Нужно войти' }, 401);
    const uid = who.user.id, fid = body.firm_id;
    const { data: st } = await admin.from('staff').select('user_id').eq('user_id', uid).maybeSingle();
    const { data: mem } = await admin.from('firm_members').select('user_id').eq('firm_id', fid).eq('user_id', uid).maybeSingle();
    const notes: Note[] = [];
    if (body.mode === 'month_closed' && st) {
      const d = await loadFirm(fid, today), m = d.year.find((x: any) => x.ym === body.ym); if (!m) return json({ error: 'нет месяца' }, 400);
      const lang = await langsOf(d.members.map((x: any) => x.user_id)), mi = +body.ym.slice(5) - 1;
      d.members.forEach((x: any) => {
        const l = lang(x.user_id), jdg = d.firm.type === 'jdg';
        const t = l === 'uk'
          ? { title: `${NOM.uk[mi]} закрито бухгалтеркою`, body: `${jdg ? 'Ваше чистими' : 'Можна забрати'}: ${fmt(m.mine)}. Податки й ZUS: ${fmt(m.taxes)}, оплатити до ${jdg ? '20-го' : '15-го (ZUS), 20-го'} і 25-го.` }
          : { title: `${NOM.pl[mi]} zamknięty przez księgową`, body: `${jdg ? 'Twoje na czysto' : 'Możesz wypłacić'}: ${fmt(m.mine)}. Podatki i ZUS: ${fmt(m.taxes)}, do zapłaty do ${jdg ? '20.' : '15. (ZUS), 20.'} i 25.` };
        notes.push({ user_id: x.user_id, firm_id: fid, kind: 'closed', ...t, url: '/', dedup: `closed:${body.ym}:${m.closed_at || ''}${Date.now() - Date.now() % 3600000}` });
      });
    } else if (body.mode === 'request' && st) {
      const { data: r } = await admin.from('requests').select('*').eq('id', body.request_id).single();
      const { data: ms } = await admin.from('firm_members').select('user_id').eq('firm_id', r.firm_id);
      const lang = await langsOf((ms || []).map((x: any) => x.user_id));
      (ms || []).forEach((x: any) => {
        const l = lang(x.user_id);
        const t = l === 'uk'
          ? { title: 'Бюро просить документ', body: r.title + (r.due ? ` — до ${dWord(r.due, l)}` : '') + '. Завантажте в розділі «Бюро».' }
          : { title: 'Biuro prosi o dokument', body: r.title + (r.due ? ` — do ${dWord(r.due, l)}` : '') + '. Prześlij w sekcji „Biuro”.' };
        notes.push({ user_id: x.user_id, firm_id: r.firm_id, kind: 'request', ...t, url: '/#docs', dedup: `req:${r.id}` });
      });
    } else if (body.mode === 'doc_uploaded' && (mem || st)) {
      const { data: staff } = await admin.from('staff').select('user_id');
      const { data: f } = await admin.from('firms').select('name,short').eq('id', fid).single();
      const lang = await langsOf((staff || []).map((x: any) => x.user_id));
      (staff || []).forEach((x: any) => notes.push({ user_id: x.user_id, firm_id: fid, kind: 'upload',
        title: `${f?.short || f?.name}: ${lang(x.user_id) === 'uk' ? 'новий документ' : 'nowy dokument'}`, body: String(body.name || 'plik').slice(0, 120), url: '/', dedup: `up:${fid}:${body.name}:${Date.now()}` }));
    } else if (body.mode === 'test') {
      const l = (await langsOf([uid]))(uid);
      notes.push({ user_id: uid, firm_id: fid || null, kind: 'test',
        title: l === 'uk' ? 'Сповіщення працюють' : 'Powiadomienia działają',
        body: l === 'uk' ? 'Так надходитимуть нагадування про платежі й документи.' : 'Tak będą przychodzić przypomnienia o płatnościach i dokumentach.', url: '/', dedup: `test:${Date.now()}` });
    } else return json({ error: 'forbidden' }, 403);
    return json({ ok: true, ...(await deliver(notes)) });
  } catch (e) { console.error(e); return json({ error: String((e as Error).message || e) }, 500); }
});
