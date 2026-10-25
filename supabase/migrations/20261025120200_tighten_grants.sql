-- функции доступа нужны только вошедшим (для RLS), триггерную функцию напрямую вызывать нельзя
revoke execute on function public.is_staff(), public.is_member(uuid), public.can_see(uuid) from public, anon;
grant execute on function public.is_staff(), public.is_member(uuid), public.can_see(uuid) to authenticated, service_role;
revoke execute on function public.doc_answers_request() from public, anon, authenticated;
