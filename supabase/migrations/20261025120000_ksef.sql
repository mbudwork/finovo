-- Finovo — подключение к KSeF API 2.0
-- Одна строка на фирму: в каком окружении (test/demo/prod), под каким NIP, где лежит токен KSeF,
-- докуда уже загружены фактуры (контрольные точки по PermanentStorage, отдельно продажи и покупки).

create table if not exists public.ksef_connections (
  firm_id      uuid primary key references public.firms(id) on delete cascade,
  env          text not null default 'test' check (env in ('test', 'demo', 'prod')),
  nip          text not null check (nip ~ '^\d{10}$'),          -- контекст KSeF (NIP клиента)
  auth_method  text not null default 'token' check (auth_method in ('token')),
  secret_name  text,                                             -- имя секрета в Vault с токеном KSeF
  active       boolean not null default true,
  sync_from    timestamptz not null default '2026-01-01T00:00:00Z', -- с какой даты брать фактуры при первой загрузке
  cp_sale      timestamptz,                                      -- Subject1: фирма — продавец
  cp_cost      timestamptz,                                      -- Subject2: фирма — покупатель
  last_sync_at timestamptz,
  last_ok_at   timestamptz,
  last_error   text,
  blocked_until timestamptz,                                     -- после 429 — не стучимся до этого времени
  stats        jsonb,
  test_seller_nip text,                                          -- только для окружения test: NIP «поставщика» для тестовых фактур
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.ksef_connections is 'KSeF: подключение фирмы (окружение, NIP, токен в Vault, контрольные точки загрузки)';

alter table public.ksef_connections enable row level security;
drop policy if exists ksef_conn_read on public.ksef_connections;
create policy ksef_conn_read on public.ksef_connections for select using (public.can_see(firm_id));
-- запись только через серверную функцию ksef-sync (service role)

-- фактуры: номер KSeF уникален внутри фирмы (повторная загрузка не задваивает), путь к XML в хранилище
alter table public.invoices add column if not exists ksef_xml text;
alter table public.invoices add column if not exists ksef_type text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_firm_ksef_no_key') then
    alter table public.invoices add constraint invoices_firm_ksef_no_key unique (firm_id, ksef_no);
  end if;
end $$;
create index if not exists invoices_ksef_pending_idx on public.invoices (firm_id) where ksef_no is not null and ksef_xml is null;

-- токен KSeF хранится в Vault, а не в таблице. Функции доступны только серверу (service role).
create or replace function public.ksef_store_token(p_firm uuid, p_token text)
returns text language plpgsql security definer set search_path = public, vault as $$
declare n text := 'ksef_token_' || replace(p_firm::text, '-', ''); sid uuid;
begin
  select id into sid from vault.secrets where name = n;
  if sid is null then perform vault.create_secret(p_token, n, 'KSeF token for firm ' || p_firm);
  else perform vault.update_secret(sid, p_token); end if;
  return n;
end $$;

create or replace function public.ksef_drop_token(p_firm uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where name = 'ksef_token_' || replace(p_firm::text, '-', '');
$$;

revoke all on function public.ksef_store_token(uuid, text) from public, anon, authenticated;
revoke all on function public.ksef_drop_token(uuid) from public, anon, authenticated;
grant execute on function public.ksef_store_token(uuid, text) to service_role;
grant execute on function public.ksef_drop_token(uuid) to service_role;
