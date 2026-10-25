#!/usr/bin/env python3
"""Finovo — сборка кабинета из одного исходника (app.html).

Выход:
  out/kabinet/   — настоящий кабинет для Netlify (Supabase, push, PL/UA)
  out/demo.html  — демо для сайта (finovo.com.pl/demo/): вымышленные фирмы, без входа
  out/crawl.html — служебная версия для проверки переводов (демо-данные, обычный вход)

Интерфейс в исходнике на русском; перевод на польский и украинский делает слой i18n
по словарю dict.py. Данные в базе (категории, виды документов) хранятся как есть
и переводятся при показе.
"""
import json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / 'out'
sys.path.insert(0, str(ROOT))
from dict import WHOLE, PART, MONTHS_FULL, MONTHS_SHORT

SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
SITE = 'https://finovo.com.pl'

src = (ROOT / 'app.html').read_text('utf-8')

def rep(s, a, b, n=1):
    assert s.count(a) == n, (a[:80], s.count(a)); return s.replace(a, b)

# ── общие правки ───────────────────────────────────────────────────────────
s = src
s = rep(s, '<div class="logo">K</div><div><h2>Кабинет владельца</h2>', '<div class="logo">F</div><div><h2>Finovo</h2>')
s = rep(s, '<p class="small" style="background:var(--warn-soft);color:var(--warn);padding:10px 12px;border-radius:12px;font-weight:600">',
           '<p class="small demo-only" style="background:var(--warn-soft);color:var(--warn);padding:10px 12px;border-radius:12px;font-weight:600">')
s = rep(s, '<div class="demo-acc">', '<div class="demo-acc demo-only">')
# переключатель языка на экране входа
s = rep(s, '  <form class="card" id="loginForm" novalidate>\n',
           '  <form class="card" id="loginForm" novalidate>\n    <div class="seg langseg" role="group" aria-label="Język / Мова"><button type="button" data-setlang="pl">PL</button><button type="button" data-setlang="uk">UA</button></div>\n')
# язык в меню
s = rep(s, """   <section class="card"><h2 style="font-size:16px">Уведомления</h2>""",
           """   <section class="card"><h2 style="font-size:16px">Язык</h2><div class="seg langseg" role="group" aria-label="Język / Мова"><button type="button" data-setlang="pl">Polski</button><button type="button" data-setlang="uk">Українська</button></div></section>
   <section class="card"><h2 style="font-size:16px">Уведомления</h2>""")
# после входа — сохранить язык пользователя для уведомлений
s = rep(s, """    loadNotes(); setInterval(loadNotes, 120000);""",
           """    loadNotes(); setInterval(loadNotes, 120000);
    if (!CONFIG.demo) sb.from('notify_prefs').upsert({ user_id: S.user.id, lang: window.APP_LANG }, { onConflict: 'user_id' }).then(() => {}, () => {});""")
s = rep(s, '.hidden{display:none!important}', '''.hidden{display:none!important}
.langseg{align-self:flex-end}
.langseg button[aria-pressed="true"]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card .langseg{align-self:stretch}''')

MOCK_START = '<script>\n/* Демо-режим: база в памяти браузера вместо Supabase. Данные вымышленные. */'
i0 = s.index(MOCK_START); i1 = s.index('</script>', i0) + len('</script>')
MOCK = s[i0:i1]
s_nomock = s[:i0] + s[i1:]

I18N = {'whole': WHOLE, 'part': sorted(PART, key=lambda x: -len(x[0])), 'words': MONTHS_FULL + MONTHS_SHORT}
I18N_JS = r"""<script>
/* Finovo: польский и украинский. Интерфейс в коде на русском, здесь — перевод на лету по словарю. */
(function () {
  const P = new URLSearchParams(location.search), ok = l => l === 'pl' || l === 'uk';
  let LANG = P.get('lang');
  if (!ok(LANG)) { try { LANG = localStorage.getItem('finovo.lang'); } catch (e) {} }
  if (!ok(LANG)) { const n = (navigator.language || '').toLowerCase(); LANG = n.startsWith('uk') || n.startsWith('ru') ? 'uk' : 'pl'; }
  const L = LANG === 'uk' ? 2 : 1;
  window.APP_LANG = LANG; document.documentElement.lang = LANG;
  const D = __DICT__;
  const NUM = '\\d+(?:[ \\u00a0\\u202f.,]\\d+)*';
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tpl = k => esc(k).replace(/#/g, '(' + NUM + ')');
  const fill = (t, g) => { let i = 0; return t.replace(/#/g, () => g[i++] ?? ''); };
  const whole = new Map(), wholeRe = [];
  D.whole.forEach(r => { if (r[0].includes('#')) wholeRe.push([new RegExp('^' + tpl(r[0]) + '$'), r[L]]); else whole.set(r[0], r[L]); });
  const part = D.part.map(r => [new RegExp(tpl(r[0]), 'g'), r[L]]);
  const words = D.words.map(r => [new RegExp('(?<![А-Яа-яЁёІіЇїЄєҐґ])' + esc(r[0]) + '(?![А-Яа-яЁёІіЇїЄєҐґ])', 'g'), r[L]]);
  const CYR = /[А-Яа-яЁё]/;
  function tr(s) {
    if (!s || !CYR.test(s)) return s;
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/), core = m[2].replace(/\s+/g, ' ');
    let out = whole.get(core);
    if (out === undefined) for (const [re, t] of wholeRe) { const g = core.match(re); if (g) { out = fill(t, g.slice(1)); break; } }
    if (out === undefined) { out = core; for (const [re, t] of part) out = out.replace(re, (...a) => fill(t, a.slice(1, -2))); for (const [re, t] of words) out = out.replace(re, t); }
    return m[1] + out + m[3];
  }
  const done = new WeakMap(), SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
  function node(n) {
    if (n.nodeType === 3) { const pe = n.parentNode; if (!pe || SKIP[pe.nodeName] || done.get(n) === n.nodeValue) return; const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; done.set(n, n.nodeValue); return; }
    if (n.nodeType !== 1 || SKIP[n.tagName]) return;
    for (const a of ['aria-label', 'title', 'placeholder']) { const v = n.getAttribute(a); if (v) { const t = tr(v); if (t !== v) n.setAttribute(a, t); } }
    if (n.tagName === 'INPUT' && (n.type === 'button' || n.type === 'submit') && n.value) n.value = tr(n.value);
    if (n.hasAttribute && n.hasAttribute('data-setlang')) n.setAttribute('aria-pressed', n.dataset.setlang === LANG);
    for (const c of n.childNodes) node(c);
  }
  window.TR = tr;
  const go = () => { node(document.body); document.title = tr(document.title); };
  new MutationObserver(ms => { for (const m of ms) { if (m.type === 'characterData') node(m.target); else { m.addedNodes.forEach(node); if (m.type === 'attributes') node(m.target); } } })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder'] });
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  // всплывающие окна браузера тоже на языке пользователя
  const _c = window.confirm, _a = window.alert;
  window.confirm = m => _c.call(window, tr(String(m))); window.alert = m => _a.call(window, tr(String(m)));
  window.setLang = async l => {
    if (!ok(l) || l === LANG) return;
    try { localStorage.setItem('finovo.lang', l); } catch (e) {}
    try { if (!CONFIG.demo && typeof sb !== 'undefined' && typeof S !== 'undefined' && S.user) await sb.from('notify_prefs').upsert({ user_id: S.user.id, lang: l }, { onConflict: 'user_id' }); } catch (e) {}
    const u = new URL(location); if (CONFIG.demo) u.searchParams.set('lang', l); else u.searchParams.delete('lang');
    u.hash = (typeof S !== 'undefined' && S.tab) || ''; history.replaceState(null, '', u.toString()); location.reload();
  };
  document.addEventListener('click', e => { const b = e.target.closest('[data-setlang]'); if (b) { e.preventDefault(); window.setLang(b.dataset.setlang); } }, true);
})();
</script>""".replace('__DICT__', json.dumps(I18N, ensure_ascii=False))

CFG_END = "\n};\n\n</script>"

def with_i18n(x):
    return rep(x, CFG_END, CFG_END + '\n' + I18N_JS)

def demo_only_css(x, show):
    return rep(x, '.hidden{display:none!important}', '.hidden{display:none!important}' + ('' if show else '\n.demo-only{display:none!important}'))

# ── 1. настоящий кабинет ───────────────────────────────────────────────────
real = s_nomock
real = rep(real, '<title>Finovo — кабинет</title>', '''<title>Finovo</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#15705a">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Finovo">
<meta name="apple-mobile-web-app-status-bar-style" content="default">''')
real = rep(real, '<script>\nwindow.CONFIG = {', f'<script src="{SUPABASE_JS}"></script>\n<script>\nwindow.CONFIG = {{')
real = rep(real, '  demo: true,', '  demo: false,')
real = rep(real, "  bureauName: 'Ваше бюро',", "  bureauName: 'Finovo',")
real = re.sub(r'\s*<p class="small demo-only".*?</p>', '', real, count=1, flags=re.S)
real = re.sub(r'\s*<div class="demo-acc demo-only">.*?</div>', '', real, count=1, flags=re.S)
real = rep(real, "document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => { $('#email').value = b.dataset.demo; $('#password').value = 'Demo-2026!'; $('#loginForm').requestSubmit(); }));\n", '')
assert 'kabinet.demo' not in real and 'Demo-2026' not in real
real = demo_only_css(with_i18n(real), False)

# ── 2. демо для сайта ──────────────────────────────────────────────────────
demo = s
demo = rep(demo, '<title>Finovo — кабинет</title>', '<title>Finovo — демо кабинета</title>\n<meta name="robots" content="noindex">\n<link rel="icon" href="/icon.svg" type="image/svg+xml">\n<meta name="theme-color" content="#15705a">')
demo = rep(demo, "url: 'https://heplihpjoxwsqpuyarul.supabase.co',", "url: 'demo',")
demo = rep(demo, "key: 'sb_publishable_BjcMQXZ4qG7ncjHDHAFP_Q_JsB_is2e',", "key: 'demo',")
demo = re.sub(r"  vapid: '[^']*'", "  vapid: '',\n  site: '/',\n  contact: '/#kontakt'", demo)
demo = rep(demo, "  bureauName: 'Ваше бюро',", "  bureauName: 'Finovo',")
crawl = demo  # до правок «без входа»
demo = rep(demo, """.hidden{display:none!important}""", """.hidden{display:none!important}
.demobar{max-width:520px;margin:0 auto 10px;display:flex;flex-direction:column;gap:9px;background:var(--warn-soft);color:var(--warn);border-radius:16px;padding:10px 12px;font-size:13px;font-weight:600}
.demobar .dtop{display:flex;align-items:center;gap:10px}
.demobar a{margin-left:auto;border-radius:10px;padding:7px 11px;font-size:12.5px;font-weight:600;background:var(--acc);color:var(--on-g);text-decoration:none;white-space:nowrap}
.demobar .dsw{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.demobar .seg{background:color-mix(in srgb,var(--card) 55%,transparent)}
.demobar .seg button{color:var(--mute);white-space:nowrap}
.demobar .seg button[aria-pressed="true"]{color:var(--ink)}
@media (min-width:1000px){.demobar{max-width:980px;flex-direction:row;align-items:center}.demobar .dtop{flex:1}.demobar .dsw{width:360px}}""")
demo = rep(demo, """  $('#asBanner').innerHTML = S.staff && S.asClient ? `<div class="asbanner">Вы смотрите как клиент<button data-act="exitClient">← В пульт</button></div>` : '';""",
"""  $('#asBanner').innerHTML = S.staff && S.asClient ? `<div class="asbanner">Вы смотрите как клиент<button data-act="exitClient">← В пульт</button></div>` : `<div class="demobar"><div class="dtop"><span>Демо · фирма и цифры вымышленные</span><a href="${CONFIG.contact}">Хочу так же</a></div>
   <div class="dsw"><div class="seg" role="group" aria-label="${APP_LANG === 'uk' ? 'Мова' : 'Język'}"><button type="button" data-setlang="pl">🇵🇱 PL</button><button type="button" data-setlang="uk">🇺🇦 UA</button></div>
   <div class="seg" role="group" aria-label="JDG / Sp. z o.o."><button type="button" aria-pressed="${DEMO_FIRM === 'jdg'}" onclick="demoFirm('jdg')">JDG</button><button type="button" aria-pressed="${DEMO_FIRM === 'spolka'}" onclick="demoFirm('spolka')">Sp. z o.o.</button></div></div></div>`;""")
demo = rep(demo, """<button class="btn ghost block" data-act="logout">Выйти</button>`;""", """<a class="btn block" href="${CONFIG.contact}" style="text-decoration:none">Хочу такой кабинет — написать в Finovo</a>
   <a class="btn ghost block" href="${CONFIG.site}" style="text-decoration:none">← Вернуться на сайт Finovo</a>`;""")
demo = rep(demo, """async function start() {
  const { data: { session } } = await sb.auth.getSession();""", """async function start() {
  if (CONFIG.demo) { await sb.auth.signInWithPassword({ email: (DEMO_FIRM === 'spolka' ? 'novabud' : 'budmax') + '@kabinet.demo', password: 'Demo-2026!' }); }
  const { data: { session } } = await sb.auth.getSession();""")
demo = rep(demo, """    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});""", """    if (!CONFIG.demo && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});""")
demo = rep(demo, '<div id="boot" class="loading"><div class="spin"></div>Загружаем…</div>', '<div id="boot" class="loading"><div class="spin"></div>Открываем демо…</div>')
# прошлый месяц: прошедшие сроки — оплачены (иначе демо показывает «просрочено»)
PAYLINE = "if (m <= CURM - 2) ['zus', 'pit4', 'it', 'vat'].forEach(k => T.payments.push({ firm_id: fid, ym: Y + '-' + pad(m), kind: k, paid_at: dayIn(m + 1, k === 'vat' ? 24 : k === 'zus' && c.type === 'sp' ? 14 : 19) }));"
for name in ('demo', 'crawl'):
    x = globals()[name]
    x = rep(x, PAYLINE, PAYLINE + "\n      if (m === CURM - 1) ['zus', 'pit4', 'it', 'vat'].forEach(k => { const due = k === 'vat' ? 25 : k === 'zus' && c.type === 'sp' ? 15 : 20; if (CURD > due) T.payments.push({ firm_id: fid, ym: Y + '-' + pad(m), kind: k, paid_at: dayIn(CURM, due - 1) }); });")
    globals()[name] = x
DEMO_FIRM_JS = """<script>
window.DEMO_FIRM = new URLSearchParams(location.search).get('firma') === 'spolka' ? 'spolka' : 'jdg';
CONFIG.site = APP_LANG === 'uk' ? '/uk/' : '/'; CONFIG.contact = CONFIG.site + '#kontakt';
window.demoFirm = v => { const u = new URL(location); u.searchParams.set('lang', APP_LANG); if (v === 'jdg') u.searchParams.delete('firma'); else u.searchParams.set('firma', v); u.hash = (typeof S !== 'undefined' && S.tab) || ''; history.replaceState(null, '', u.toString()); location.reload(); };
</script>"""
demo = demo_only_css(with_i18n(demo), True)
demo = rep(demo, I18N_JS, I18N_JS + '\n' + DEMO_FIRM_JS)
crawl = demo_only_css(with_i18n(crawl), True)

# ── запись ─────────────────────────────────────────────────────────────────
if OUT.exists(): shutil.rmtree(OUT)
K = OUT / 'kabinet'; K.mkdir(parents=True)
(K / 'index.html').write_text(real, 'utf-8')
(OUT / 'demo.html').write_text(demo, 'utf-8')
(OUT / 'crawl.html').write_text(crawl, 'utf-8')
for f in (ROOT / 'kabinet-static').iterdir(): shutil.copy(f, K / f.name)
print('OK', len(real), len(demo), len(crawl))
