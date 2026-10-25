# Finovo — сайт, кабинет и KSeF

Один репозиторий — один сайт на Netlify:

| Адрес | Что это | Откуда |
|---|---|---|
| `/` , `/uk/` | сайт бюро (PL / UA) | `site/` |
| `/demo/` | демо кабинета для сайта (вымышленные фирмы) | собирается из `kabinet/` |
| `/app/` | настоящий кабинет клиента и пульт бюро (Supabase) | `kabinet/` |
| `app.finovo.com.pl` | тот же кабинет на поддомене — когда домен добавлен в Netlify | правило в `_redirects` |

```
build.py                 общая сборка → dist/
netlify.toml             Netlify: python3 build.py, публикует dist/
site/                    сайт: build.py + src/ (тексты в src/i18n.json)
kabinet/                 кабинет: app.html (один исходник), dict.py (переводы), make_app.py
supabase/functions/      серверные функции Supabase
  notify/                напоминания (push, e-mail)
  invite-client/         доступ клиенту
  ksef-sync/             загрузка фактур из KSeF API 2.0
  ksef-testkit/          тестовая среда KSeF: тестовое подключение и тестовые фактуры
supabase/migrations/     изменения базы (KSeF)
```

## Сборка

```
python3 build.py
```

Нужен только Python 3. Netlify делает это сам при каждом push в `main`.

## Деплой: GitHub → Netlify

1. Репозиторий на GitHub (этот код в ветке `main`).
2. Netlify → **Add new site → Import an existing project → GitHub** → выбрать репозиторий.
   Настройки подтянутся из `netlify.toml` (build: `python3 build.py`, publish: `dist`).
3. **Domain management**: `finovo.com.pl` (+ `www`), позже `app.finovo.com.pl` — кабинет откроется и там.
4. После первого деплоя — адрес кабинета для писем в Supabase (секрет `app_url` в Vault),
   например `https://finovo.com.pl/app`.

Дальше любой push в `main` = новый деплой. Pull request = отдельный предпросмотр.

## KSeF

Как работает:

1. Бюро подключает фирму во вкладке **Импорт** пульта: среда (тестовая / предпродакшен / боевая),
   NIP клиента и **токен KSeF** с правом просмотра фактур. Токен проверяется входом в KSeF
   и хранится в Supabase Vault, в таблицу не попадает.
2. Каждый час (`pg_cron`, задача `kabinet-ksef-sync`) и по кнопке «Загрузить сейчас»:
   вход токеном → метаданные новых фактур с прошлой контрольной точки
   (`PermanentStorage` + High Water Mark, отдельно продажи и покупки) → строки в `invoices`
   с номером KSeF. Повторная загрузка не задваивает: `unique (firm_id, ksef_no)`.
3. XML FA(3) дозагружается порциями (лимит KSeF — 16 в минуту, 64 в час): точная ставка VAT,
   срок оплаты, отметка «оплачено», курс, позиции → категория расхода. XML лежит в хранилище
   `docs/<фирма>/ksef/…xml`, в кабинете открывается по значку KSEF у фактуры.
4. Валюта: курс из фактуры, иначе NBP (таблица A) за последний рабочий день перед датой.
5. 429 от KSeF → пауза до `Retry-After`, без повторных запросов.

Тестовая среда: кнопка «Тестовое подключение с примерами фактур» создаёт самоподписанную печать
на NIP фирмы (или случайный корректный NIP), получает токен KSeF в тестовой среде и отправляет туда
две продажи и две покупки (одна в евро). Настоящие данные в тестовую среду не отправлять.
Техработы на тестовых средах KSeF — ежедневно 16:00–18:00.

Для боевой работы нужно: NIP spółki Finovo, сертификат KSeF или квалифицированная подпись бюро,
доступ (право просмотра фактур) от каждого клиента, затем токен KSeF для контекста клиента.

Документация KSeF: https://github.com/CIRFMF/ksef-docs ·
API: https://api-test.ksef.mf.gov.pl/docs/v2 (тест), https://api.ksef.mf.gov.pl/docs/v2 (боевая).

### Выкладка серверной части

Миграции из `supabase/migrations/` применяются к проекту Supabase `ahijrnilsjbbhonxhvtw`,
функции — `supabase functions deploy ksef-sync ksef-testkit` (или через панель Supabase).
`ksef-sync` и `ksef-testkit` выкладываются с `verify_jwt = false` и проверяют доступ сами:
из кабинета — JWT сотрудника бюро, из cron — заголовок `x-cron-secret` (как у `notify`).
