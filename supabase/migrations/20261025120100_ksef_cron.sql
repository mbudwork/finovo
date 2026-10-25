-- KSeF: загрузка фактур всех подключённых фирм каждый час (в 17 минут, чтобы не совпадать с другими задачами)
select cron.unschedule('kabinet-ksef-sync') where exists (select 1 from cron.job where jobname = 'kabinet-ksef-sync');
select cron.schedule('kabinet-ksef-sync', '17 * * * *', $$
  select net.http_post(
    url := 'https://heplihpjoxwsqpuyarul.supabase.co/functions/v1/ksef-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    body := '{"mode":"cron"}'::jsonb,
    timeout_milliseconds := 150000);
$$);
