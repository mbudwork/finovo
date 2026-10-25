-- Finovo — база кабинета (клиенты, бюро, фактуры, деньги, люди, документы, уведомления).
-- Права: сотрудники бюро (staff) видят и меняют всё; клиент (firm_members) видит только свою фирму
-- и может загружать документы; уведомления, push и настройки — каждый только свои.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── таблицы ────────────────────────────────────────────────────────────────
create table public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short text,
  nip text,
  type text not null check (type in ('jdg', 'sp')),
  tax_form text not null default 'liniowy' check (tax_form in ('liniowy', 'skala', 'ryczalt', 'cit9', 'cit19')),
  ryczalt_rate numeric,
  vat_payer boolean not null default true,
  zus_mode text not null default 'pelny' check (zus_mode in ('pelny', 'preferencyjny', 'brak')),
  opening_balance numeric not null default 0,
  opening_date date not null default '2026-01-01',
  created_at timestamptz not null default now()
);

create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text not null default 'accountant' check (role in ('admin', 'accountant'))
);

create table public.firm_members (
  firm_id uuid not null references public.firms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  role text not null default 'owner',
  primary key (firm_id, user_id)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  kind text not null check (kind in ('sale', 'cost')),
  number text,
  issue_date date not null,
  due_date date,
  counterparty text,
  cp_nip text,
  net numeric not null,
  vat numeric not null default 0,
  vat_rate text not null default '23',
  currency text not null default 'PLN',
  fx numeric not null default 1,
  category text,
  source text not null default 'manual',
  ksef_no text,
  paid_at date,
  created_at timestamptz not null default now()
);
create index invoices_firm_date_idx on public.invoices (firm_id, issue_date);

create table public.bank_tx (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  date date not null,
  amount numeric not null,
  description text,
  category text,
  invoice_id uuid references public.invoices(id) on delete set null,
  hash text not null,
  created_at timestamptz not null default now(),
  unique (firm_id, hash)
);

create table public.bank_balances (
  firm_id uuid not null references public.firms(id) on delete cascade,
  date date not null,
  balance numeric not null,
  source text,
  primary key (firm_id, date)
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  name text not null,
  role text,
  contract text not null check (contract in ('uop', 'zlec', 'b2b')),
  brutto numeric not null,
  start_date date,
  end_date date,
  active boolean not null default true
);

create table public.employee_docs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  firm_id uuid not null references public.firms(id) on delete cascade,
  kind text not null,
  valid_to date not null
);

create table public.month_close (
  firm_id uuid not null references public.firms(id) on delete cascade,
  ym text not null check (ym ~ '^\d{4}-\d{2}$'),
  status text not null default 'open' check (status in ('open', 'closed')),
  vat numeric, income_tax numeric, zus numeric, pit4 numeric,
  note text,
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  primary key (firm_id, ym)
);

create table public.payments (
  firm_id uuid not null references public.firms(id) on delete cascade,
  ym text not null,
  kind text not null check (kind in ('zus', 'pit4', 'it', 'vat')),
  paid_at date,
  primary key (firm_id, ym, kind)
);

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  title text not null,
  note text,
  due date,
  status text not null default 'open' check (status in ('open', 'uploaded', 'done')),
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  request_id uuid references public.requests(id) on delete set null,
  path text not null,
  name text not null,
  kind text not null default 'document',
  uploaded_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigserial primary key,
  firm_id uuid references public.firms(id) on delete cascade,
  user_id uuid default auth.uid(),
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid references public.firms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  url text,
  dedup text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed boolean not null default false,
  emailed boolean not null default false,
  unique (user_id, dedup)
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz not null default now()
);

create table public.notify_prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  push boolean not null default true,
  email boolean not null default true,
  lang text not null default 'pl' check (lang in ('pl', 'uk'))
);
comment on column public.notify_prefs.lang is 'Язык интерфейса и уведомлений: pl или uk';

-- ── функции доступа ────────────────────────────────────────────────────────
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.staff where user_id = auth.uid()) $$;
create or replace function public.is_member(fid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.firm_members where firm_id = fid and user_id = auth.uid()) $$;
create or replace function public.can_see(fid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select public.is_staff() or public.is_member(fid) $$;

-- секреты из Vault — только для серверных функций
create or replace function public.app_secret(secret_name text) returns text language sql stable security definer set search_path = public, vault as
$$ select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1 $$;
revoke all on function public.app_secret(text) from public, anon, authenticated;
grant execute on function public.app_secret(text) to service_role;

-- документ по запросу → запрос «загружено», запись в журнал
create or replace function public.doc_answers_request() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.request_id is not null then
    update public.requests set status = 'uploaded' where id = new.request_id and firm_id = new.firm_id and status = 'open';
  end if;
  insert into public.audit_log(firm_id, user_id, action, detail) values (new.firm_id, auth.uid(), 'document_uploaded', jsonb_build_object('name', new.name));
  return new;
end $$;
create trigger documents_answer_request after insert on public.documents for each row execute function public.doc_answers_request();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['firms','staff','firm_members','invoices','bank_tx','bank_balances','employees','employee_docs','month_close','payments','requests','documents','audit_log','notifications','push_subscriptions','notify_prefs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- данные фирмы: читает бюро и клиент этой фирмы, меняет только бюро
  foreach t in array array['invoices','bank_tx','bank_balances','employees','employee_docs','month_close','payments','requests','documents','audit_log'] loop
    execute format('create policy %I on public.%I for select using (public.can_see(firm_id))', t || '_read', t);
    execute format('create policy %I on public.%I for all using (public.is_staff()) with check (public.is_staff())', t || '_staff_write', t);
  end loop;
end $$;

create policy firms_read on public.firms for select using (public.can_see(id));
create policy firms_staff_write on public.firms for all using (public.is_staff()) with check (public.is_staff());

create policy staff_read on public.staff for select using (user_id = auth.uid() or public.is_staff());

create policy firm_members_read on public.firm_members for select using (user_id = auth.uid() or public.is_staff());
create policy firm_members_staff_write on public.firm_members for all using (public.is_staff()) with check (public.is_staff());

-- клиент загружает документы своей фирмы
create policy documents_member_insert on public.documents for insert with check (public.can_see(firm_id));

create policy notifications_own_read on public.notifications for select using (user_id = auth.uid());
create policy notifications_own_update on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy push_own on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy prefs_own on public.notify_prefs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── хранилище документов: docs/<firm_id>/... ───────────────────────────────
insert into storage.buckets (id, name, public) values ('docs', 'docs', false) on conflict (id) do nothing;
create policy docs_read on storage.objects for select using (bucket_id = 'docs' and public.can_see(((storage.foldername(name))[1])::uuid));
create policy docs_insert on storage.objects for insert with check (bucket_id = 'docs' and public.can_see(((storage.foldername(name))[1])::uuid));
create policy docs_staff_delete on storage.objects for delete using (bucket_id = 'docs' and public.is_staff());
