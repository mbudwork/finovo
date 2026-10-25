import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function password(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => a[x % a.length]).join('') + '!7';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: caller, error: ce } = await admin.auth.getUser(jwt);
    if (ce || !caller?.user) return json({ error: 'Нужно войти' }, 401);
    const { data: st } = await admin.from('staff').select('user_id').eq('user_id', caller.user.id).maybeSingle();
    if (!st) return json({ error: 'Только для сотрудников бюро' }, 403);

    const { firm_id, email, name } = await req.json();
    if (!firm_id || !email) return json({ error: 'Нужны фирма и почта' }, 400);
    const { data: firm } = await admin.from('firms').select('id').eq('id', firm_id).maybeSingle();
    if (!firm) return json({ error: 'Фирма не найдена' }, 404);

    const mail = String(email).trim().toLowerCase();
    let userId: string | null = null; let pw: string | null = null;
    const created = await admin.auth.admin.createUser({ email: mail, password: (pw = password()), email_confirm: true, user_metadata: { name } });
    if (created.error) {
      pw = null;
      for (let page = 1; page <= 20 && !userId; page++) {
        const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        const u = data?.users.find(x => (x.email || '').toLowerCase() === mail);
        if (u) userId = u.id;
        if (!data || data.users.length < 200) break;
      }
      if (!userId) return json({ error: created.error.message }, 400);
    } else userId = created.data.user.id;

    const { error: me } = await admin.from('firm_members').upsert({ firm_id, user_id: userId, name: name || null, role: 'owner' });
    if (me) return json({ error: me.message }, 400);
    await admin.from('audit_log').insert({ firm_id, user_id: caller.user.id, action: 'client_invited', detail: { email: mail } });
    return json({ ok: true, password: pw ?? '(у клиента уже есть доступ — пароль прежний)' });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
