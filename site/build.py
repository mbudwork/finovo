#!/usr/bin/env python3
"""Finovo — сборка статического сайта.

Генерирует готовые HTML-страницы (текст сразу в HTML, без зависимости от JavaScript),
отдельные URL для польской и украинской версий, robots.txt, sitemap.xml, 404, редиректы.

Запуск:  python3 build.py        → результат в папке dist/
На Netlify (деплой из git): build command "python3 build.py", publish "dist".
"""
import hashlib, html, json, re, shutil, datetime as dt
from pathlib import Path

ROOT = Path(__file__).parent
SRC, OUT = ROOT / 'src', ROOT / 'dist'

# ── Настройки сайта (меняются здесь) ────────────────────────────────────────
SITE = 'https://finovo.com.pl'          # основной домен, без слэша в конце
APP_URL = '/app/'                       # клиентский кабинет: собирается в /app/ этого же сайта (не индексируется);
                                        # на поддомене app.finovo.com.pl открывается тот же кабинет (см. _redirects)
BRAND = 'Finovo'
CONTACT_EMAIL = 'biuro@finovo.com.pl'   # в JSON-LD не попадает, пока ящик не создан (см. EMAIL_ACTIVE)
EMAIL_ACTIVE = False
# Телефон для связи (он же WhatsApp)
# (тогда номер попадёт и в разметку для Google).
PHONE = '+49 15510 469402'
PHONE_ACTIVE = True
WHATSAPP = True                          # кнопка WhatsApp на тот же номер
# Заявки с формы дублируются в Google-таблицу и Telegram через Google Apps Script (см. leads/README.md).
# Вставьте сюда адрес веб-приложения Apps Script (https://script.google.com/macros/s/…/exec). Пусто — только Netlify Forms.
LEADS_HOOK = 'https://script.google.com/macros/s/AKfycbyOUI6zCYoLzhyGphXgiNk8mgRem0fPb2GbNF-FnyblErkODrZb3cjhEE_6oMHpCmH_Aw/exec'
DEMO_PATH = '/demo/'                     # демо кабинета (src/demo/index.html), не индексируется
SEASON_UNTIL = '2026-12-31'              # до этой даты на первом экране плашка «смена бюро с 1 января»
# Данные spółki для политики конфиденциальности — заполнить после регистрации.
COMPANY = dict(name='[nazwa spółki]', address='[adres siedziby]', nip='[NIP]', krs='[KRS]')
PRIVACY_UPDATED = '2026-10-21'

T = json.loads((SRC / 'i18n.json').read_text('utf-8'))
ASSET_V = ''  # задаётся в main() по содержимому site.css и site.js
LANGS = {
    'pl': dict(html='pl', og='pl_PL', prefix=''),
    'uk': dict(html='uk', og='uk_UA', prefix='/uk'),
}

HOME = {
    'pl': dict(path='/', title='Finovo — biuro rachunkowe z aplikacją dla właściciela firmy',
               desc='Biuro rachunkowe nowej generacji. Prowadzimy księgowość JDG i spółek, kadry i płace. W aplikacji widzisz zysk, podatki, ZUS i terminy. Po polsku i po ukraińsku.'),
    'uk': dict(path='/uk/', title='Finovo — бухгалтерське бюро в Польщі із застосунком',
               desc='Бухгалтерське бюро в Польщі: бухгалтерія JDG і spółek, кадри й зарплати. У застосунку видно прибуток, податки, ZUS і терміни. Польською та українською.'),
}

UI = {
    'pl': dict(home='Strona główna', articles='Poradniki', published='Opublikowano', updated='Zaktualizowano', author='Autor',
               sources='Źródła', disclaimer='Artykuł ma charakter informacyjny i nie stanowi porady prawnej ani podatkowej. Szczegóły zależą od formy i sytuacji firmy.',
               cta_h='Chcesz przejść do Finovo?', cta_p='Pierwsza konsultacja jest bezpłatna. Przejęcie dokumentów od poprzedniego biura bierzemy na siebie.',
               switch='Zmiana biura', nf_t='Nie znaleziono strony', nf_p='Ta strona nie istnieje albo została przeniesiona.', nf_b='Wróć na stronę główną',
               months_nom=['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
               months=['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia']),
    'uk': dict(home='Головна', articles='Поради', published='Опубліковано', updated='Оновлено', author='Автор',
               sources='Джерела', disclaimer='Стаття має інформаційний характер і не є юридичною чи податковою консультацією. Деталі залежать від форми та ситуації фірми.',
               cta_h='Хочете перейти до Finovo?', cta_p='Перша консультація безкоштовна. Забрати документи від попереднього бюро беремо на себе.',
               switch='Зміна бюро', nf_t='Сторінку не знайдено', nf_p='Цієї сторінки не існує або її перенесено.', nf_b='Повернутися на головну',
               months_nom=['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'],
               months=['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня']),
}

# ── Экспертные материалы ────────────────────────────────────────────────────
# Каждая статья — пара PL/UA. Поля author/reviewer: указывать только реальных людей.
# reviewer=None — статья ещё не проверена бухгалтером (в разметке поле не выводится).
SRC_UPL = ('Formularz UPL-1 — pełnomocnictwo do podpisywania deklaracji (podatki.gov.pl)', 'https://www.podatki.gov.pl/media/4290/upl-1_06-08-2.pdf')
SRC_PEL = ('Pełnomocnictwo ZUS PEL (zus.pl)', 'https://www.zus.pl/wzory-formularzy/pelnomocnictwo/pel-pelnomocnictwo')
SRC_KSEF = ('KSeF: uwierzytelnienie i nadawanie uprawnień — materiał MF (ksef.podatki.gov.pl)', 'https://ksef.podatki.gov.pl/media/2qybmm1r/srody-z-ksef_modul-ii_uwierzytelnienie-i-autoryzacja-w-ksef-oraz-nadawanie-uprawnien.pdf')
SRC_CEIDG = ('Ustawa z 6 marca 2018 r. o CEIDG i Punkcie Informacji dla Przedsiębiorcy, Dz.U. 2018 poz. 647 (isap.sejm.gov.pl)', 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180000647')

ARTICLES = [
  {
    'id': 'zmiana-biura',
    'published': '2026-10-19', 'updated': '2026-10-19', 'author': 'Zespół Finovo', 'reviewer': None,
    'sources': [SRC_UPL, SRC_PEL, SRC_KSEF, SRC_CEIDG],
    'pl': {
      'path': '/zmiana-biura/',
      'title': 'Jak zmienić biuro rachunkowe: kroki i lista dokumentów',
      'seo_title': 'Jak zmienić biuro rachunkowe — kroki i lista dokumentów | Finovo',
      'desc': 'Kiedy najlepiej zmienić biuro rachunkowe, jakie pełnomocnictwa odwołać i nadać (UPL-1, ZUS PEL, KSeF) i jakie dokumenty odebrać od poprzedniego biura.',
      'lead': 'Zmiana biura rachunkowego to kilka formalności i jedno przekazanie dokumentów. Poniżej lista kroków i dokumentów, z której korzystamy przy przejmowaniu klientów.',
      'body': '''
<h2>Kiedy zmienić biuro</h2>
<p>Najwygodniej od pierwszego dnia miesiąca. Poprzednie biuro rozlicza wtedy ostatni pełny miesiąc: wysyła JPK_V7M i deklarację ZUS DRA oraz wylicza zaliczkę na podatek dochodowy. Nowe biuro zaczyna od kolejnego miesiąca. Termin wypowiedzenia sprawdź w obecnej umowie.</p>
<h2>Krok 1. Pełnomocnictwa</h2>
<ul>
<li><strong>Urząd skarbowy.</strong> Odwołaj pełnomocnictwo dotychczasowego biura i nadaj nowe na formularzu UPL-1 — pełnomocnictwo do podpisywania deklaracji składanych elektronicznie.</li>
<li><strong>ZUS.</strong> Udziel pełnomocnictwa na formularzu ZUS PEL (przez eZUS lub w placówce) i odwołaj pełnomocnictwo poprzedniego biura.</li>
<li><strong>KSeF.</strong> W Aplikacji Podatnika KSeF nadaj uprawnienia nowemu biuru, np. do przeglądania faktur, i odbierz je poprzedniemu.</li>
</ul>
<h2>Krok 2. Wpis w CEIDG (jednoosobowa działalność)</h2>
<p>Przy JDG zaktualizuj w CEIDG dane podmiotu prowadzącego księgi i miejsce przechowywania dokumentacji. Wniosek o zmianę danych składa się w ciągu 7 dni od zmiany. W przypadku spółek potrzebne zgłoszenia przygotuje biuro.</p>
<h2>Krok 3. Dokumenty od poprzedniego biura</h2>
<p>Przekazanie najlepiej potwierdzić protokołem przekazania dokumentów.</p>
<h3>Księgi za bieżący rok</h3>
<ul>
<li>KPiR lub księgi rachunkowe — wydruk i plik eksportu z programu księgowego</li>
<li>rejestry VAT i wysłane pliki JPK_V7M wraz z UPO</li>
<li>wyliczenia zaliczek na PIT lub CIT</li>
<li>ewidencja środków trwałych i wartości niematerialnych z planem amortyzacji</li>
<li>salda rozrachunków z kontrahentami na dzień przekazania</li>
<li>spis z natury (remanent), jeśli firma ma towary lub materiały</li>
</ul>
<h3>Poprzednie lata</h3>
<ul>
<li>zeznania roczne (PIT-36, PIT-36L, PIT-28 lub CIT-8) wraz z UPO</li>
<li>w spółkach: sprawozdania finansowe, uchwały zatwierdzające i zakładowy plan kont</li>
<li>korespondencja z urzędem skarbowym i ZUS, informacje o kontrolach, ratach i korektach</li>
</ul>
<h3>ZUS</h3>
<ul>
<li>deklaracje DRA za bieżący rok</li>
<li>informacja, jakie składki opłaca przedsiębiorca (np. ulga na start, składki preferencyjne, mały ZUS plus)</li>
</ul>
<h3>Kadry i płace (jeśli prowadziło je biuro)</h3>
<ul>
<li>akta osobowe pracowników, umowy o pracę i umowy zlecenia</li>
<li>listy płac i karty wynagrodzeń za bieżący rok, zgłoszenia do ZUS</li>
<li>ewidencja czasu pracy i urlopów, PIT-11 za poprzedni rok</li>
<li>badania lekarskie, szkolenia BHP, zezwolenia na pracę, oświadczenia o powierzeniu pracy i zaświadczenia A1</li>
</ul>
<h2>Krok 4. Dane od właściciela firmy</h2>
<ul>
<li>wpis z CEIDG lub odpis z KRS, NIP i REGON, w spółce — umowa spółki</li>
<li>potwierdzenie rejestracji jako podatnik VAT, a przy transakcjach w UE — VAT-UE</li>
<li>lista rachunków bankowych i wyciągi za bieżący rok, najlepiej w formacie CSV lub MT940</li>
<li>faktury i dokumenty spoza KSeF, np. zagraniczne</li>
</ul>
<h2>Wskazówka</h2>
<p>Poproś poprzednie biuro o plik eksportu z programu księgowego i salda na dzień przekazania. Dzięki temu historię od stycznia da się odtworzyć znacznie szybciej.</p>
'''},
    'uk': {
      'path': '/uk/zmina-bukhgalterii/',
      'title': 'Як змінити бухгалтерське бюро в Польщі: кроки й перелік документів',
      'seo_title': 'Як змінити бухгалтерське бюро в Польщі — кроки й документи | Finovo',
      'desc': 'Коли найкраще змінити бухгалтерське бюро в Польщі, які довіреності відкликати й надати (UPL-1, ZUS PEL, KSeF) і які документи забрати в попереднього бюро.',
      'lead': 'Зміна бухгалтерського бюро — це кілька формальностей і одна передача документів. Нижче перелік кроків і документів, яким ми користуємося, коли приймаємо клієнтів.',
      'body': '''
<h2>Коли змінювати бюро</h2>
<p>Найзручніше з першого числа місяця. Попереднє бюро тоді закриває останній повний місяць: надсилає JPK_V7M і декларацію ZUS DRA та розраховує аванс податку на дохід. Нове бюро починає з наступного місяця. Термін розірвання перевірте у своєму договорі.</p>
<h2>Крок 1. Довіреності</h2>
<ul>
<li><strong>Податкова (urząd skarbowy).</strong> Відкличте довіреність попереднього бюро й надайте нову на формулярі UPL-1 — довіреність на підписання декларацій, що подаються електронно.</li>
<li><strong>ZUS.</strong> Надайте довіреність на формулярі ZUS PEL (через eZUS або у відділенні) і відкличте довіреність попереднього бюро.</li>
<li><strong>KSeF.</strong> В Aplikacji Podatnika KSeF надайте новому бюро права, наприклад на перегляд фактур, і заберіть їх у попереднього.</li>
</ul>
<h2>Крок 2. Запис у CEIDG (JDG)</h2>
<p>Для JDG оновіть у CEIDG дані про того, хто веде облік, і місце зберігання документації. Заяву про зміну даних подають протягом 7 днів від зміни. Для spółek потрібні повідомлення підготує бюро.</p>
<h2>Крок 3. Документи від попереднього бюро</h2>
<p>Передачу найкраще підтвердити протоколом передачі документів (protokół przekazania dokumentów).</p>
<h3>Облік за поточний рік</h3>
<ul>
<li>KPiR або księgi rachunkowe — роздруківка й файл експорту з бухгалтерської програми</li>
<li>реєстри VAT і надіслані файли JPK_V7M разом з UPO</li>
<li>розрахунки авансів PIT або CIT</li>
<li>реєстр основних засобів і нематеріальних активів з планом амортизації</li>
<li>сальдо розрахунків з контрагентами на дату передачі</li>
<li>інвентаризація (remanent), якщо фірма має товари чи матеріали</li>
</ul>
<h3>Попередні роки</h3>
<ul>
<li>річні декларації (PIT-36, PIT-36L, PIT-28 або CIT-8) разом з UPO</li>
<li>для spółek: фінансова звітність, ухвали про її затвердження та план рахунків</li>
<li>листування з податковою і ZUS, інформація про перевірки, розстрочки й коригування</li>
</ul>
<h3>ZUS</h3>
<ul>
<li>декларації DRA за поточний рік</li>
<li>інформація, які внески сплачує підприємець (наприклад, ulga na start, пільгові внески, mały ZUS plus)</li>
</ul>
<h3>Кадри й зарплати (якщо їх вело бюро)</h3>
<ul>
<li>особові справи працівників, трудові договори й umowy zlecenia</li>
<li>відомості й картки зарплат за поточний рік, реєстрації в ZUS</li>
<li>облік робочого часу й відпусток, PIT-11 за попередній рік</li>
<li>медогляди, навчання BHP, дозволи на роботу, oświadczenia o powierzeniu pracy та довідки A1</li>
</ul>
<h2>Крок 4. Дані від власника фірми</h2>
<ul>
<li>запис CEIDG або витяг з KRS, NIP і REGON, для spółki — договір spółki</li>
<li>підтвердження реєстрації платником VAT, а для операцій у ЄС — VAT-UE</li>
<li>перелік банківських рахунків і виписки за поточний рік, найкраще у форматі CSV або MT940</li>
<li>фактури й документи поза KSeF, наприклад іноземні</li>
</ul>
<h2>Порада</h2>
<p>Попросіть попереднє бюро про файл експорту з бухгалтерської програми та сальдо на дату передачі. Так історію з січня можна відновити значно швидше.</p>
'''},
  },
]

# ── Утилиты ─────────────────────────────────────────────────────────────────
e = html.escape
TEL_HREF = 'tel:' + re.sub(r'[^+\d]', '', PHONE)
WA_HREF = 'https://wa.me/' + re.sub(r'\D', '', PHONE)
def demo_url(lang, firma=None):
    q = ['lang=' + lang]
    if firma == 'spolka': q.append('firma=spolka')
    return DEMO_PATH + ('?' + '&'.join(q) if q else '')
PRIVACY = {'pl': '/polityka-prywatnosci/', 'uk': '/uk/polityka-konfidentsiinosti/'}
LOGIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>'
def ab(path): return SITE + path
def date_word(iso, lang):
    y, m, d = iso.split('-'); return f"{int(d)} {UI[lang]['months'][int(m)-1]} {y}"

LOGO_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#24a07c"/><stop offset=".5" stop-color="#15705a"/><stop offset="1" stop-color="#0c4a3b"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#lg)"/><rect x="13" y="36" width="8" height="15" rx="3" fill="#f2fbf7" opacity=".55"/><rect x="26" y="27" width="8" height="24" rx="3" fill="#f2fbf7" opacity=".8"/><rect x="39" y="18" width="8" height="33" rx="3" fill="#f2fbf7"/><circle cx="50" cy="14" r="4.5" fill="#f2b45e"/></svg>'

def head(lang, title, desc, path, alt_paths, og_type='website', jsonld=None, noindex=False):
    L = LANGS[lang]
    alts = ''
    if alt_paths:
        for lg, p in alt_paths.items():
            alts += f'<link rel="alternate" hreflang="{LANGS[lg]["html"]}" href="{ab(p)}">\n'
        alts += f'<link rel="alternate" hreflang="x-default" href="{ab(alt_paths["pl"])}">\n'
    other = 'uk' if lang == 'pl' else 'pl'
    ld = ''
    if jsonld:
        ld = '<script type="application/ld+json">' + json.dumps(jsonld, ensure_ascii=False, separators=(',', ':')) + '</script>\n'
    robots = '<meta name="robots" content="noindex">\n' if noindex else '<meta name="robots" content="index, follow, max-image-preview:large">\n'
    canon = '' if noindex else f'<link rel="canonical" href="{ab(path)}">\n'
    return f'''<!doctype html>
<html lang="{L['html']}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
{robots}{canon}{alts}<meta name="theme-color" content="#15705a">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/logo-512.png">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:type" content="{og_type}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{ab(path)}">
<meta property="og:image" content="{SITE}/og-{lang}.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:locale" content="{L['og']}"><meta property="og:locale:alternate" content="{LANGS[other]['og']}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css?v={ASSET_V}">
{ld}</head>
<body>
'''

def header(lang, alt_paths, home_path):
    t = T[lang]; h = home_path
    sw = ''
    for lg, label in (('pl', 'PL'), ('uk', 'UA')):
        target = (alt_paths or {}).get(lg, HOME[lg]['path'])
        cur = ' aria-current="true"' if lg == lang else ''
        sw += f'<a href="{target}" hreflang="{LANGS[lg]["html"]}" lang="{LANGS[lg]["html"]}"{cur}>{label}</a>'
    return f'''<header class="top gut">
  <div class="in bar">
    <a class="logo" href="{h}" aria-label="{BRAND}">{LOGO_SVG}<b>finovo</b></a>
    <nav class="nav" aria-label="Menu">
      <a href="{h}#uslugi">{t['nav.services']}</a>
      <a href="{h}#aplikacja">{t['nav.app']}</a>
      <a href="{h}#jak">{t['nav.how']}</a>
      <a href="{h}#warunki">{t['nav.terms']}</a>
      <a href="{h}#faq">{t['nav.faq']}</a>
    </nav>
    <div class="lang" role="group" aria-label="Język / Мова">{sw}</div>
    <a class="login" href="{APP_URL}" rel="nofollow" aria-label="{t['nav.login']}">{LOGIN_SVG}<span>{t['nav.login']}</span></a>
    <a class="btn small" href="{h}#kontakt"><span class="full">{t['cta.consult']}</span><span class="short">{t['cta.short']}</span></a>
  </div>
</header>
'''

def footer(lang, home_path):
    t, u, h = T[lang], UI[lang], home_path
    art = next(a for a in ARTICLES if a['id'] == 'zmiana-biura')[lang]['path']
    return f'''<footer class="gut">
  <div class="in">
    <a class="logo" href="{h}" aria-label="{BRAND}">{LOGO_SVG.replace('<svg ', '<svg style="width:28px;height:28px" ', 1).replace('id="lg"','id="lgf"').replace('url(#lg)','url(#lgf)')}<b style="font-size:18px">finovo</b></a>
    <nav><a href="{h}#uslugi">{t['nav.services']}</a><a href="{h}#aplikacja">{t['nav.app']}</a><a href="{art}">{u['switch']}</a><a href="{h}#faq">{t['nav.faq']}</a><a href="{h}#kontakt">{t['nav.contact']}</a></nav>
    <div class="ft2"><a href="{APP_URL}" rel="nofollow">{t['nav.login']}</a><a href="{demo_url(lang)}">{t['nav.demo']}</a><a href="{PRIVACY[lang]}">{t['nav.privacy']}</a><a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a><a href="{TEL_HREF}" class="num">{PHONE}</a></div>
    <span class="ft3">© {dt.date.today().year} {BRAND} · {t['ft.tag']}</span>
  </div>
</footer>
'''

def scripts(lang):
    return f'<script src="/assets/site.js?v={ASSET_V}" defer></script>\n</body>\n</html>\n'

# ── JSON-LD ─────────────────────────────────────────────────────────────────
ORG_ID = SITE + '/#organization'
SERVICE_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6']
def org_ld(lang):
    t = T[lang]
    org = {
        '@type': 'AccountingService', '@id': ORG_ID, 'name': BRAND, 'url': SITE + '/',
        'logo': SITE + '/logo-512.png', 'image': f'{SITE}/og-{lang}.png',
        'description': HOME[lang]['desc'],
        'areaServed': {'@type': 'Country', 'name': 'Polska' if lang == 'pl' else 'Польща'},
        'knowsLanguage': ['pl', 'uk'],
        'hasOfferCatalog': {'@type': 'OfferCatalog', 'name': t['svc.h'], 'itemListElement': [
            {'@type': 'Offer', 'itemOffered': {'@type': 'Service', 'name': t[k + '.h'], 'description': t[k + '.p']}} for k in SERVICE_KEYS]},
    }
    if EMAIL_ACTIVE: org['email'] = CONTACT_EMAIL
    if PHONE_ACTIVE: org['telephone'] = PHONE
    return org

def home_ld(lang):
    return {'@context': 'https://schema.org', '@graph': [
        {'@type': 'WebSite', '@id': SITE + '/#website', 'url': SITE + '/', 'name': BRAND, 'inLanguage': ['pl', 'uk'], 'publisher': {'@id': ORG_ID}},
        {'@type': 'WebPage', '@id': ab(HOME[lang]['path']) + '#webpage', 'url': ab(HOME[lang]['path']), 'name': HOME[lang]['title'],
         'description': HOME[lang]['desc'], 'inLanguage': LANGS[lang]['html'], 'isPartOf': {'@id': SITE + '/#website'}, 'about': {'@id': ORG_ID}},
        org_ld(lang)]}

def article_ld(a, lang):
    c = a[lang]; url = ab(c['path'])
    page = {'@type': 'WebPage', '@id': url + '#webpage', 'url': url, 'name': c['title'], 'inLanguage': LANGS[lang]['html'],
            'isPartOf': {'@id': SITE + '/#website'}, 'breadcrumb': {'@id': url + '#breadcrumb'}}
    if a.get('reviewer'): page['reviewedBy'] = {'@type': 'Person', 'name': a['reviewer']}
    return {'@context': 'https://schema.org', '@graph': [
        page,
        {'@type': 'Article', '@id': url + '#article', 'headline': c['title'], 'description': c['desc'], 'inLanguage': LANGS[lang]['html'],
         'datePublished': a['published'], 'dateModified': a['updated'], 'mainEntityOfPage': {'@id': url + '#webpage'},
         'author': {'@type': 'Organization', '@id': ORG_ID, 'name': BRAND}, 'publisher': {'@id': ORG_ID},
         'image': f'{SITE}/og-{lang}.png', 'citation': [s[1] for s in a['sources']]},
        {'@type': 'BreadcrumbList', '@id': url + '#breadcrumb', 'itemListElement': [
            {'@type': 'ListItem', 'position': 1, 'name': UI[lang]['home'], 'item': ab(HOME[lang]['path'])},
            {'@type': 'ListItem', 'position': 2, 'name': c['title'], 'item': url}]},
        {'@type': 'Organization', '@id': ORG_ID, 'name': BRAND, 'url': SITE + '/', 'logo': SITE + '/logo-512.png'}]}

# ── Страницы ────────────────────────────────────────────────────────────────
def calendar_html(lang):
    wd = T[lang]['cal.wd']; marks = {5: 'k-doc', 10: 'k-pay', 15: 'k-close', 20: 'k-tax', 25: 'k-vat'}
    h = ''.join(f'<div class="wd">{d}</div>' for d in wd) + '<div></div>' * 6   # listopad 2026: 1.11 = niedziela
    for d in range(1, 31):
        dow = (6 + d - 1) % 7
        cls = ' '.join(x for x in ['day', 'we' if dow >= 5 else '', ('k ' + marks[d]) if d in marks else ''] if x)
        h += f'<div class="{cls}">{d}</div>'
    return h

def build_home(lang):
    t, H = T[lang], HOME[lang]
    src = (SRC / 'home.html').read_text('utf-8')
    main = src[src.index('<main'):src.index('</main>') + 7]
    def fill(m):
        key = m.group(4); v = t.get(key)
        if not isinstance(v, str): raise KeyError(key)
        return f'<{m.group(2)}{m.group(3)}{m.group(5)}>{v}</{m.group(2)}>'
    main = re.sub(r'<((\w+))([^>]*?) data-i18n="([^"]+)"([^>]*)></\2>', fill, main)
    assert 'data-i18n' not in main, 'остались непереведённые элементы'
    main = main.replace('<div class="grid7" id="calGrid"></div>', f'<div class="grid7" id="calGrid">{calendar_html(lang)}</div>')
    main = main.replace('<input type="hidden" name="jezyk" id="fLang" value="pl">', f'<input type="hidden" name="jezyk" id="fLang" value="{lang}">')
    main = main.replace('id="leadForm"', f'id="leadForm" data-ok="{e(t["ct.ok"])}" data-err="{e(t["ct.err"])}" data-req="{e(t["ct.req"])}" data-preview="{e(t["ct.preview"])}"')
    main = main.replace('id="copyMail"', f'id="copyMail" data-copied="{e(t["ct.copied"])}"')
    art = ARTICLES[0][lang]['path']
    main = main.replace(f'<p>{t["fq4.a"]}</p>', f'<p>{t["fq4.a"]} <a href="{art}">{UI[lang]["switch"]} →</a></p>')
    main = main.replace('href="#demo" data-demo-link="jdg"', f'href="{demo_url(lang)}"')
    main = main.replace('href="#demo" data-demo-link="spolka"', f'href="{demo_url(lang, "spolka")}"')
    main = main.replace('href="#demo" data-demo-link', f'href="{demo_url(lang)}"')
    main = main.replace(f'<p>{t["fq7.a"]}</p>', f'<p>{t["fq7.a"]} <a href="{demo_url(lang)}">JDG →</a> <a href="{demo_url(lang, "spolka")}">Sp. z o.o. →</a></p>')
    main = main.replace('<a href="#privacy" data-privacy-link></a>', f'<a href="{PRIVACY[lang]}">{t["nav.privacy"].lower()}</a>')
    main = main.replace('href="#tel" data-tel', f'href="{TEL_HREF}"').replace('<b class="num" data-tel-text></b>', f'<b class="num">{PHONE}</b>')
    wa = f'href="{WA_HREF}"'
    main = main.replace('href="#wa" data-wa', wa) if WHATSAPP else re.sub(r'<a class="btn glass small" href="#wa" data-wa[^>]*>.*?</a>', '', main)
    main = main.replace('<code id="mailAddr">biuro@finovo.com.pl</code>', f'<code id="mailAddr">{CONTACT_EMAIL}</code>')
    if dt.date.today().isoformat() > SEASON_UNTIL:
        main = re.sub(r'<a class="season".*?</a>\n\s*', '', main, flags=re.S)
    main = main.replace('data-until="2026-12-31"', f'data-until="{SEASON_UNTIL}"')
    mn = UI[lang]['months_nom']
    main = main.replace('<b id="calMonth"', f'<b id="calMonth" data-months="{e(json.dumps(mn, ensure_ascii=False))}"')
    main = main.replace('<div class="grid7" id="calGrid">', f'<div class="grid7" id="calGrid" data-wd="{e(json.dumps(t["cal.wd"], ensure_ascii=False))}">')
    alts = {lg: HOME[lg]['path'] for lg in LANGS}
    return head(lang, H['title'], H['desc'], H['path'], alts, jsonld=home_ld(lang)) + header(lang, alts, H['path']) + main + '\n' + footer(lang, H['path']) + scripts(lang)

def build_article(a, lang):
    c, u, home_path = a[lang], UI[lang], HOME[lang]['path']
    alts = {lg: a[lg]['path'] for lg in LANGS}
    srcs = ''.join(f'<li><a href="{s[1]}" rel="noopener" target="_blank">{e(s[0])}</a></li>' for s in a['sources'])
    rev = f' · {"Sprawdził(a)" if lang == "pl" else "Перевірив(ла)"}: {e(a["reviewer"])}' if a.get('reviewer') else ''
    body = f'''<main id="top">
<article class="art gut">
  <div class="in art-in">
    <nav class="crumbs" aria-label="breadcrumb"><a href="{home_path}">{u['home']}</a><span>/</span><span>{e(c['title'])}</span></nav>
    <h1>{e(c['title'])}</h1>
    <p class="art-meta">{u['published']}: <time datetime="{a['published']}">{date_word(a['published'], lang)}</time> · {u['updated']}: <time datetime="{a['updated']}">{date_word(a['updated'], lang)}</time> · {u['author']}: {e(a['author'])}{rev}</p>
    <p class="lead">{e(c['lead'])}</p>
    <div class="art-body">{c['body']}</div>
    <section class="art-src"><h2>{u['sources']}</h2><ul>{srcs}</ul><p class="note">{u['disclaimer']}</p></section>
    <section class="art-cta"><h2>{u['cta_h']}</h2><p>{u['cta_p']}</p><a class="btn" href="{home_path}#kontakt">{T[lang]['cta.consult']} <span class="arr" aria-hidden="true">→</span></a></section>
  </div>
</article>
</main>
'''
    return head(lang, c['seo_title'], c['desc'], c['path'], alts, og_type='article', jsonld=article_ld(a, lang)) + header(lang, alts, home_path) + body + footer(lang, home_path) + scripts(lang)

PRIV_TXT = {
 'pl': dict(title='Polityka prywatności', seo='Polityka prywatności | Finovo', desc='Jak Finovo przetwarza dane osobowe przekazane przez stronę i formularz kontaktowy.',
  body='''
<h2>1. Administrator danych</h2>
<p>Administratorem danych osobowych przekazanych przez stronę finovo.com.pl jest {name}, {address}, NIP {nip}, KRS {krs}. W sprawach danych osobowych napisz na <a href="mailto:{email}">{email}</a>.</p>
<h2>2. Jakie dane zbieramy</h2>
<p>Imię, telefon lub e-mail, formę firmy i treść wiadomości z formularza kontaktowego, a także dane z korespondencji e-mail, rozmów telefonicznych i komunikatorów.</p>
<h2>3. Cel i podstawa prawna</h2>
<ul>
<li>odpowiedź na zapytanie i przygotowanie oferty na Twoje żądanie — art. 6 ust. 1 lit. b RODO;</li>
<li>prowadzenie korespondencji i ochrona przed roszczeniami — nasz prawnie uzasadniony interes, art. 6 ust. 1 lit. f RODO.</li>
</ul>
<h2>4. Jak długo przechowujemy dane</h2>
<p>Do zakończenia rozmów. Jeśli nie zawrzemy umowy — nie dłużej niż 12 miesięcy od ostatniego kontaktu.</p>
<h2>5. Komu przekazujemy dane</h2>
<p>Dostawcom usług IT, z których korzystamy: hosting strony i formularza (Netlify, Inc.) oraz poczta e-mail. Część z nich może przetwarzać dane poza Europejskim Obszarem Gospodarczym, w tym w USA — wyłącznie na podstawie mechanizmów przewidzianych w RODO, np. standardowych klauzul umownych. Strona korzysta z czcionek Google Fonts, więc przeglądarka łączy się z serwerami Google.</p>
<h2>6. Twoje prawa</h2>
<p>Masz prawo dostępu do danych, ich sprostowania, usunięcia, ograniczenia przetwarzania i przenoszenia, a także prawo sprzeciwu wobec przetwarzania opartego na naszym prawnie uzasadnionym interesie. Możesz złożyć skargę do Prezesa Urzędu Ochrony Danych Osobowych (ul. Stawki 2, 00-193 Warszawa).</p>
<h2>7. Dobrowolność</h2>
<p>Podanie danych jest dobrowolne, ale bez nich nie możemy odpowiedzieć na zapytanie.</p>
<h2>8. Pliki cookies</h2>
<p>Strona nie używa plików cookies analitycznych ani marketingowych.</p>
<h2>9. Aplikacja dla klientów</h2>
<p>Dane klientów w aplikacji Finovo przetwarzamy na podstawie umowy o świadczenie usług księgowych i umowy powierzenia przetwarzania danych. Szczegóły zawiera umowa.</p>
'''),
 'uk': dict(title='Політика конфіденційності', seo='Політика конфіденційності | Finovo', desc='Як Finovo обробляє персональні дані, передані через сайт і контактну форму.',
  body='''
<h2>1. Адміністратор даних</h2>
<p>Адміністратор персональних даних, переданих через сайт finovo.com.pl, — {name}, {address}, NIP {nip}, KRS {krs}. З питань персональних даних пишіть на <a href="mailto:{email}">{email}</a>.</p>
<h2>2. Які дані ми збираємо</h2>
<p>Ім'я, телефон або e-mail, форму фірми й текст повідомлення з контактної форми, а також дані з листування, телефонних розмов і месенджерів.</p>
<h2>3. Мета й правова підстава</h2>
<ul>
<li>відповідь на запит і підготовка пропозиції на ваше прохання — ст. 6 ч. 1 п. b RODO (GDPR);</li>
<li>ведення листування й захист від претензій — наш законний інтерес, ст. 6 ч. 1 п. f RODO.</li>
</ul>
<h2>4. Як довго зберігаємо дані</h2>
<p>До завершення розмов. Якщо договір не буде укладено — не довше 12 місяців від останнього контакту.</p>
<h2>5. Кому передаємо дані</h2>
<p>Постачальникам IT-послуг, якими ми користуємося: хостинг сайту й форми (Netlify, Inc.) та електронна пошта. Частина з них може обробляти дані поза Європейською економічною зоною, зокрема в США, — лише на підставі механізмів, передбачених RODO, наприклад стандартних договірних положень. Сайт використовує шрифти Google Fonts, тому браузер з'єднується із серверами Google.</p>
<h2>6. Ваші права</h2>
<p>Ви маєте право на доступ до даних, їх виправлення, видалення, обмеження обробки й перенесення, а також право заперечити проти обробки на підставі нашого законного інтересу. Ви можете подати скаргу до Голови Управління із захисту персональних даних (Prezes UODO, ul. Stawki 2, 00-193 Warszawa).</p>
<h2>7. Добровільність</h2>
<p>Надання даних добровільне, але без них ми не зможемо відповісти на запит.</p>
<h2>8. Файли cookies</h2>
<p>Сайт не використовує аналітичних і маркетингових файлів cookies.</p>
<h2>9. Застосунок для клієнтів</h2>
<p>Дані клієнтів у застосунку Finovo ми обробляємо на підставі договору про бухгалтерське обслуговування та договору доручення обробки даних. Подробиці — у договорі.</p>
'''),
}

def build_privacy(lang):
    c, u, home_path = PRIV_TXT[lang], UI[lang], HOME[lang]['path']
    body = c['body'].format(email=CONTACT_EMAIL, **COMPANY)
    page = f'''<main id="top">
<article class="art gut">
  <div class="in art-in">
    <nav class="crumbs" aria-label="breadcrumb"><a href="{home_path}">{u['home']}</a><span>/</span><span>{c['title']}</span></nav>
    <h1>{c['title']}</h1>
    <p class="art-meta">{u['updated']}: <time datetime="{PRIVACY_UPDATED}">{date_word(PRIVACY_UPDATED, lang)}</time></p>
    <div class="art-body">{body}</div>
  </div>
</article>
</main>
'''
    return head(lang, c['seo'], c['desc'], PRIVACY[lang], dict(PRIVACY), noindex=True) + header(lang, dict(PRIVACY), home_path) + page + footer(lang, home_path) + scripts(lang)

def build_404():
    u = UI['pl']; v = UI['uk']
    body = f'''<main id="top"><section class="nf gut"><div class="in">
<p class="nf-code">404</p><h1>{u['nf_t']}</h1><p>{u['nf_p']}</p><p lang="uk">{v['nf_t']}. {v['nf_p']}</p>
<div class="ctas"><a class="btn" href="/">{u['nf_b']}</a><a class="btn ghost" href="/uk/" lang="uk">{v['nf_b']}</a></div>
</div></section></main>
'''
    return head('pl', '404 — ' + u['nf_t'] + ' | Finovo', u['nf_p'], '/404', None, noindex=True) + header('pl', None, '/') + body + footer('pl', '/') + scripts('pl')

SITE_JS = r'''/* Finovo: форма заявки и копирование адреса. Текст страницы от JS не зависит. */
(function () {
  var f = document.getElementById('leadForm');
  var copy = document.getElementById('copyMail');
  if (copy) copy.addEventListener('click', function () {
    var addr = document.getElementById('mailAddr'), out = document.getElementById('copied');
    var show = function () { out.textContent = copy.dataset.copied; out.hidden = false; setTimeout(function () { out.hidden = true; }, 2200); };
    if (navigator.clipboard) navigator.clipboard.writeText(addr.textContent).then(show, function () { var r = document.createRange(); r.selectNodeContents(addr); getSelection().removeAllRanges(); getSelection().addRange(r); });
  });
  /* плашка сезона: прячем после даты */
  var sz = document.querySelector('.season');
  if (sz && new Date().toISOString().slice(0, 10) > sz.dataset.until) sz.remove();
  /* FAQ: открыть вопрос по якорю (#wypowiedzenie) */
  function openHash() { var el = location.hash && document.getElementById(location.hash.slice(1)); if (el && el.tagName === 'DETAILS') el.open = true; }
  window.addEventListener('hashchange', openHash); openHash();
  /* календарь: текущий месяц (после 25-го — следующий) */
  var g = document.getElementById('calGrid'), mEl = document.getElementById('calMonth');
  if (g && mEl && g.dataset.wd && mEl.dataset.months) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    if (now.getDate() > 25) { m++; if (m > 11) { m = 0; y++; } }
    var wd = JSON.parse(g.dataset.wd), names = JSON.parse(mEl.dataset.months), marks = { 5: 'k-doc', 10: 'k-pay', 15: 'k-close', 20: 'k-tax', 25: 'k-vat' };
    var first = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    var h = wd.map(function (d) { return '<div class="wd">' + d + '</div>'; }).join('');
    for (var i = 0; i < first; i++) h += '<div></div>';
    for (var d = 1; d <= days; d++) { var dow = (first + d - 1) % 7; h += '<div class="day' + (dow >= 5 ? ' we' : '') + (marks[d] ? ' k ' + marks[d] : '') + '">' + d + '</div>'; }
    g.innerHTML = h; mEl.textContent = names[m]; var yEl = document.getElementById('calYear'); if (yEl) yEl.textContent = y;
  }
  if (!f) return;
  var live = /finovo|netlify\.app$/i.test(location.hostname), HOOK = '__LEADS_HOOK__';
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var out = document.getElementById('fMsgOut'), btn = document.getElementById('fSend');
    if (!document.getElementById('fName').value.trim() || !document.getElementById('fContact').value.trim()) { out.className = 'msg err'; out.textContent = f.dataset.req; return; }
    if (!live) { out.className = 'msg'; out.textContent = f.dataset.preview; return; }
    btn.disabled = true;
    var fd = new FormData(f), c = (fd.get('kontakt') || '').trim(), q = new URLSearchParams(location.search), utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].forEach(function (k) { if (q.get(k)) utm[k] = q.get(k); });
    var lead = { name: (fd.get('imie') || '').trim(), contact: c, phone: /@/.test(c) ? '' : c, email: /@/.test(c) ? c : '', form: fd.get('forma') || '',
      message: (fd.get('wiadomosc') || '').trim(), lang: fd.get('jezyk') || '', page: location.href, referrer: document.referrer || '', utm: utm, submitted_at: new Date().toISOString() };
    /* копия в Google-таблицу и Telegram (Apps Script); основная отправка — Netlify Forms */
    if (HOOK && !fd.get('bot-field')) { try { fetch(HOOK, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(lead), keepalive: true }).catch(function () {}); } catch (e) {} }
    fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fd).toString() })
      .then(function (r) { if (!r.ok) throw new Error(r.status); out.className = 'msg ok'; out.textContent = f.dataset.ok; f.reset(); })
      .catch(function () { out.className = 'msg err'; out.textContent = f.dataset.err; })
      .then(function () { btn.disabled = false; });
  });
})();
'''

EXTRA_CSS = '''
/* язык — ссылки */
.lang a{border-radius:9px;padding:6px 11px;font-weight:700;font-size:13px;color:var(--muted);text-decoration:none}
.lang a[aria-current="true"]{background:var(--card);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.1)}
.faq details p a{color:var(--brand);font-weight:700}
/* статьи */
.art{padding-block:48px 80px}
.art-in{max-width:780px}
.crumbs{display:flex;flex-wrap:wrap;gap:8px;font-size:14px;font-weight:600;color:var(--muted);margin-bottom:22px}
.crumbs a{color:var(--brand);text-decoration:none}
.art h1{font-size:clamp(32px,4.6vw,52px);line-height:1.05;letter-spacing:-.045em}
.art-meta{margin-top:16px;color:var(--muted);font-size:14.5px;font-weight:600}
.art .lead{margin-top:20px}
.art-body{margin-top:28px}
.art-body h2{font-size:26px;letter-spacing:-.03em;margin:40px 0 12px}
.art-body h3{font-size:19px;letter-spacing:-.02em;margin:24px 0 8px}
.art-body p{margin:0 0 12px}
.art-body ul{margin:0 0 12px;padding-left:22px}
.art-body li{margin:6px 0}
.art-body li::marker{color:var(--brand)}
.art-src{margin-top:44px;padding:24px 26px;border-radius:22px;background:var(--card);border:1px solid var(--line);box-shadow:var(--sh)}
.art-src h2{font-size:20px;letter-spacing:-.02em}
.art-src ul{padding-left:20px;margin:12px 0}
.art-src a{color:var(--brand);font-weight:600;word-break:break-word}
.art-src .note{color:var(--muted);font-size:14px}
.art-cta{margin-top:24px;padding:30px;border-radius:26px;color:var(--on-g);background:radial-gradient(420px 220px at 100% 0%,rgba(143,227,195,.32),transparent 60%),linear-gradient(150deg,var(--g3) -20%,var(--g2) 35%,var(--g1));box-shadow:var(--sh-lg)}
.art-cta h2{font-size:26px;letter-spacing:-.03em}
.art-cta p{color:var(--on-g-mute);margin:10px 0 20px}
.art-cta .btn{background:var(--card);color:var(--ink)}
/* вход: на телефоне — иконка */
.login{display:inline-flex;align-items:center;gap:7px}
.login svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;flex:none}
@media (max-width:560px){.top .login{display:inline-flex;flex:none;width:40px;height:40px;justify-content:center;padding:0;border:1px solid var(--line);background:var(--card);border-radius:12px}.top .login span{display:none}.bar{gap:8px}}
@media (max-width:340px){.logo b{display:none}.top .btn.small{padding:9px 10px;font-size:13.5px}}
@media (max-width:400px){.bar{gap:6px;padding:0 8px 0 10px}.logo{gap:7px}.logo svg{width:28px;height:28px}.logo b{font-size:18px}.lang a{padding:6px 8px}.top .login{width:36px;height:36px}.top .btn.small{padding:10px 12px}}
@media (max-width:920px){.chip{right:0}}
/* сезонная плашка */
.season{display:inline-flex;align-items:center;gap:10px;margin-bottom:14px;padding:7px 14px 7px 7px;border-radius:999px;background:var(--amber-soft);color:var(--amber);font-size:14px;font-weight:700;text-decoration:none;border:1px solid rgba(184,104,10,.18);transition:transform .18s}
.season:hover{transform:translateY(-1px)}
.season{max-width:100%}
@media (max-width:560px){.season{font-size:13px;gap:8px;padding:6px 12px 6px 6px;border-radius:16px;line-height:1.3}}
.season-k{flex:none;background:var(--amber);color:#fff;border-radius:999px;padding:3px 9px;font-size:12.5px;font-weight:800}
.hero .season+.badge{display:flex;width:fit-content;max-width:100%}
/* демо */
.demo-cta{margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:20px 32px;flex-wrap:wrap;padding:26px 28px;border-radius:var(--r-l);color:var(--on-g);background:radial-gradient(420px 220px at 100% 0%,rgba(143,227,195,.32),transparent 60%),linear-gradient(150deg,var(--g3) -20%,var(--g2) 35%,var(--g1));box-shadow:var(--sh-lg)}
.demo-t{display:flex;gap:16px;align-items:flex-start;flex:1 1 380px}
.demo-ic{width:46px;height:46px;border-radius:15px;background:rgba(255,255,255,.16);display:grid;place-items:center;flex:none}
.demo-ic svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round}
.demo-t h3{font-size:22px;letter-spacing:-.03em}
.demo-t p{color:var(--on-g-mute);margin-top:4px;font-size:16px}
.demo-b{display:flex;gap:10px;flex-wrap:wrap}
.demo-b .btn:not(.glass){background:var(--card);color:var(--ink)}
@media (max-width:560px){.demo-b{width:100%}.demo-b .btn{flex:1 1 100%}}
/* честные условия: таблица, на телефоне — карточки по строкам */
.fair-t{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1fr) minmax(0,1.15fr);background:var(--card);border:1px solid var(--line);border-radius:var(--r-l);box-shadow:var(--sh);overflow:hidden}
.fr{display:contents}
.fr>span{padding:18px 22px;border-top:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
.fh>span{border-top:0;font-size:19px;font-weight:800;letter-spacing:-.03em;padding-top:24px}
.fk{font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding-top:21px!important}
.fo{color:var(--muted);font-size:16px}
.fn{font-size:16px;font-weight:700;color:var(--on-g);background:linear-gradient(150deg,var(--g2),var(--g1));border-top-color:rgba(255,255,255,.14)!important}
.fh .fn{background:radial-gradient(300px 140px at 100% 0%,rgba(143,227,195,.35),transparent 60%),linear-gradient(150deg,var(--g3) -20%,var(--g2) 60%)}
.fair-t i{font-style:normal;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:12px;font-weight:800}
.fo i{background:var(--rose-soft);color:var(--rose)}
.fn i{background:rgba(255,255,255,.2);color:var(--on-g)}
@media (max-width:760px){
  .fair-t{display:flex;flex-direction:column;gap:10px;background:none;border:0;box-shadow:none;overflow:visible}
  .fr.fh{display:none}
  .fr{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 6px 18px -14px rgba(14,28,23,.3);overflow:hidden}
  .fr>span{border-top:0;padding:10px 16px}
  .fk{padding:14px 16px 2px!important}
  .fo{font-size:15px;padding-top:4px!important}
  .fn{font-size:15.5px;border-top:0!important}
}
/* телефон и WhatsApp */
.mail.tel{margin-top:12px}
.mail.tel .btn{flex:1 1 auto}
footer .ft3{flex-basis:100%;font-size:13.5px}
.mail.tel .btn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.consent a{color:var(--brand);font-weight:700}
/* футер */
footer .ft2{flex-basis:100%;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:13.5px;padding-top:16px;border-top:1px solid var(--line)}
/* 404 */
.nf{padding-block:90px 120px;text-align:center}
.nf .in{display:flex;flex-direction:column;align-items:center;gap:14px}
.nf-code{font-weight:800;font-size:96px;letter-spacing:-.06em;color:var(--brand);line-height:1}
.nf p{color:var(--muted)}
'''

ROBOTS = f'''# Finovo — robots.txt
# Публичные страницы открыты для поисковых систем и ИИ-поиска.
User-agent: *
Allow: /

# Поиск ChatGPT
User-agent: OAI-SearchBot
Allow: /

# Переходы по ссылкам из ChatGPT от имени пользователя
User-agent: ChatGPT-User
Allow: /

Sitemap: {SITE}/sitemap.xml
'''

def sitemap(pages, state):
    today = dt.date.today().isoformat(); new_state = {}
    rows = []
    for p in pages:
        digest = hashlib.sha256(p['html'].replace(str(dt.date.today().year), '').encode()).hexdigest()
        prev = state.get(p['path'], {})
        lastmod = p.get('lastmod') or (prev.get('lastmod') if prev.get('hash') == digest else today)
        new_state[p['path']] = {'hash': digest, 'lastmod': lastmod}
        alts = ''.join(f'\n    <xhtml:link rel="alternate" hreflang="{LANGS[lg]["html"]}" href="{ab(pp)}"/>' for lg, pp in p['alts'].items())
        alts += f'\n    <xhtml:link rel="alternate" hreflang="x-default" href="{ab(p["alts"]["pl"])}"/>'
        rows.append(f'  <url>\n    <loc>{ab(p["path"])}</loc>\n    <lastmod>{lastmod}</lastmod>{alts}\n  </url>')
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + '\n'.join(rows) + '\n</urlset>\n'
    return xml, new_state

REDIRECTS = f'''# основной домен без www
https://www.finovo.com.pl/*  {SITE}/:splat  301!
# старые/альтернативные языковые адреса
/ua      /uk/   301
/ua/*    /uk/:splat   301
/pl      /      301
/pl/*    /:splat      301
'''

HEADERS = '''/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
/assets/*
  Cache-Control: public, max-age=604800
/404.html
  X-Robots-Tag: noindex
/demo/*
  X-Robots-Tag: noindex
/polityka-prywatnosci/*
  X-Robots-Tag: noindex
/uk/polityka-konfidentsiinosti/*
  X-Robots-Tag: noindex
'''

def main():
    if OUT.exists(): shutil.rmtree(OUT)
    (OUT / 'assets').mkdir(parents=True)
    global ASSET_V
    _css = (SRC / 'site.css').read_text('utf-8') + EXTRA_CSS; _js = SITE_JS.replace('__LEADS_HOOK__', LEADS_HOOK)
    ASSET_V = hashlib.sha1((_css + _js).encode()).hexdigest()[:8]
    (OUT / 'assets' / 'site.css').write_text((SRC / 'site.css').read_text('utf-8') + EXTRA_CSS, 'utf-8')
    (OUT / 'assets' / 'site.js').write_text(SITE_JS.replace('__LEADS_HOOK__', LEADS_HOOK), 'utf-8')
    for f in (SRC / 'static').iterdir(): shutil.copy(f, OUT / f.name)
    pages = []
    for lang in LANGS:
        h = build_home(lang); pages.append({'path': HOME[lang]['path'], 'html': h, 'alts': {lg: HOME[lg]['path'] for lg in LANGS}})
    for a in ARTICLES:
        for lang in LANGS:
            h = build_article(a, lang); pages.append({'path': a[lang]['path'], 'html': h, 'alts': {lg: a[lg]['path'] for lg in LANGS}, 'lastmod': a['updated']})
    for p in pages:
        dest = OUT / p['path'].strip('/') / 'index.html' if p['path'] != '/' else OUT / 'index.html'
        dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(p['html'], 'utf-8')
    (OUT / '404.html').write_text(build_404(), 'utf-8')
    for lang in LANGS:
        dest = OUT / PRIVACY[lang].strip('/') / 'index.html'; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(build_privacy(lang), 'utf-8')
    if (SRC / 'demo' / 'index.html').exists():
        (OUT / DEMO_PATH.strip('/')).mkdir(parents=True, exist_ok=True); shutil.copy(SRC / 'demo' / 'index.html', OUT / DEMO_PATH.strip('/') / 'index.html')
    state_file = SRC / 'sitemap-state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    xml, new_state = sitemap(pages, state)
    (OUT / 'sitemap.xml').write_text(xml, 'utf-8'); state_file.write_text(json.dumps(new_state, indent=1))
    (OUT / 'robots.txt').write_text(ROBOTS, 'utf-8')
    (OUT / '_redirects').write_text(REDIRECTS, 'utf-8')
    (OUT / '_headers').write_text(HEADERS, 'utf-8')
    print('OK:', ', '.join(p['path'] for p in pages), '+ 404, polityka, demo, robots.txt, sitemap.xml')

if __name__ == '__main__':
    main()
