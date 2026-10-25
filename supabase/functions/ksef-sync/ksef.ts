/* Finovo — минимальный клиент KSeF API 2.0 (только то, что нужно для загрузки фактур).
   Документация: https://github.com/CIRFMF/ksef-docs, OpenAPI: https://api-test.ksef.mf.gov.pl/docs/v2 */

export type Env = 'test' | 'demo' | 'prod';
export const HOSTS: Record<Env, string> = {
  test: 'https://api-test.ksef.mf.gov.pl/v2',
  demo: 'https://api-demo.ksef.mf.gov.pl/v2',
  prod: 'https://api.ksef.mf.gov.pl/v2',
};

export class KsefError extends Error {
  constructor(message: string, public status: number, public retryAfter = 0, public body: unknown = null) { super(message); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* ---- DER: достаём SubjectPublicKeyInfo из X.509 без внешних библиотек ---- */
function derRead(buf: Uint8Array, pos: number) {
  const tag = buf[pos]; let len = buf[pos + 1], off = pos + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[off + i]; off += n; }
  return { tag, start: pos, body: off, end: off + len };
}
function spkiFromCert(der: Uint8Array) {
  const cert = derRead(der, 0), tbs = derRead(der, cert.body);
  let p = tbs.body;
  if (der[p] === 0xa0) p = derRead(der, p).end;          // [0] version
  for (let i = 0; i < 5; i++) p = derRead(der, p).end;   // serial, sigAlg, issuer, validity, subject
  const spki = derRead(der, p);
  const bytes = der.slice(spki.start, spki.end);
  const hex = Array.from(bytes.slice(0, 40), x => x.toString(16).padStart(2, '0')).join('');
  const kind = hex.includes('2a864886f70d010101') ? 'rsa' : hex.includes('2a8648ce3d0201') ? 'ec' : 'unknown';
  return { spki: bytes, kind };
}

/* токен KSeF + timestamp: RSA-OAEP SHA-256 либо ECDH P-256 + AES-256-GCM (формат: SPKI эфемерного ключа | nonce | шифр+тег) */
async function encryptToken(certB64: string, plain: string) {
  const { spki, kind } = spkiFromCert(unb64(certB64));
  const data = new TextEncoder().encode(plain);
  if (kind === 'rsa') {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, data));
  }
  if (kind === 'ec') {
    const recv = await crypto.subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: recv }, eph.privateKey, 256);
    const aes = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));
    const ephSpki = new Uint8Array(await crypto.subtle.exportKey('spki', eph.publicKey));
    const out = new Uint8Array(ephSpki.length + 12 + ct.length);
    out.set(ephSpki); out.set(nonce, ephSpki.length); out.set(ct, ephSpki.length + 12);
    return out;
  }
  throw new Error('Неизвестный тип ключа KSeF');
}

export type InvoiceMetadata = {
  ksefNumber: string; invoiceNumber: string; issueDate: string; permanentStorageDate: string;
  seller: { nip: string; name?: string }; buyer: { identifier: { type: string; value?: string }; name?: string };
  netAmount: number; grossAmount: number; vatAmount: number; currency: string; invoiceType: string;
};
export type MetadataPage = { hasMore: boolean; isTruncated: boolean; permanentStorageHwmDate?: string; invoices: InvoiceMetadata[] };

export class Ksef {
  base: string; access = ''; calls = 0;
  constructor(public env: Env) { this.base = HOSTS[env]; }

  async req(method: string, path: string, o: { token?: string; body?: unknown; accept?: string } = {}) {
    const headers: Record<string, string> = { Accept: o.accept || 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const tok = o.token ?? this.access; if (tok) headers.Authorization = 'Bearer ' + tok;
    this.calls++;
    const r = await fetch(this.base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    if (r.status === 429) {
      const ra = +(r.headers.get('Retry-After') || 60);
      throw new KsefError(`KSeF: слишком много запросов, повтор через ${ra} с`, 429, ra);
    }
    const text = await r.text();
    if (!r.ok) {
      let body: any = text; try { body = JSON.parse(text); } catch { /* текст */ }
      const ex = body?.exception?.exceptionDetailList?.[0];
      const msg = ex ? `${ex.exceptionCode}: ${ex.exceptionDescription}${ex.details?.length ? ' — ' + ex.details.join('; ') : ''}`
        : body?.title || body?.detail || body?.status?.description || String(text).slice(0, 300);
      throw new KsefError(`KSeF ${r.status}: ${msg}`, r.status, 0, body);
    }
    if ((o.accept || 'application/json').includes('json')) return text ? JSON.parse(text) : null;
    return text;
  }

  /* Вход токеном KSeF в контексте NIP → accessToken */
  async loginWithToken(nip: string, ksefToken: string) {
    const certs: any[] = await this.req('GET', '/security/public-key-certificates', { token: '' });
    const now = Date.now();
    const cands = certs.filter(c => (c.usage || []).includes('KsefTokenEncryption'))
      .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
    const cert = cands.find(c => Date.parse(c.validFrom) <= now && now < Date.parse(c.validTo)) || cands[0];
    if (!cert) throw new Error('KSeF не вернул ключ для шифрования токена');

    const ch = await this.req('POST', '/auth/challenge', { token: '' });
    const ts = ch.timestampMs ?? Date.parse(ch.timestamp);
    const enc = await encryptToken(cert.certificate, `${ksefToken.trim()}|${ts}`);
    const init = await this.req('POST', '/auth/ksef-token', { token: '', body: {
      challenge: ch.challenge, contextIdentifier: { type: 'Nip', value: nip }, encryptedToken: b64(enc),
      ...(cert.publicKeyId ? { publicKeyId: cert.publicKeyId } : {}) } });
    const authTok = init.authenticationToken.token, ref = init.referenceNumber;
    let st: any = null;
    for (let i = 0; i < 30; i++) {
      await sleep(i < 5 ? 400 : 1000);
      st = await this.req('GET', `/auth/${encodeURIComponent(ref)}`, { token: authTok });
      if (st.status?.code !== 100) break;
    }
    if (st?.status?.code !== 200) {
      const d = st?.status?.details?.length ? ' — ' + st.status.details.join('; ') : '';
      throw new KsefError(`KSeF: вход не удался (${st?.status?.code} ${st?.status?.description || ''}${d})`, 401, 0, st);
    }
    const t = await this.req('POST', '/auth/token/redeem', { token: authTok });
    this.access = t.accessToken.token;
    return t;
  }

  async logout() { try { await this.req('DELETE', '/auth/sessions/current'); } catch { /* не важно */ } }

  queryMetadata(subjectType: string, from: string, to: string | undefined, page: number, pageSize = 250): Promise<MetadataPage> {
    return this.req('POST', `/invoices/query/metadata?sortOrder=Asc&pageOffset=${page}&pageSize=${pageSize}`, { body: {
      subjectType, dateRange: { dateType: 'PermanentStorage', from, ...(to ? { to } : {}), restrictToPermanentStorageHwmDate: true } } });
  }

  getInvoiceXml(ksefNumber: string): Promise<string> {
    return this.req('GET', `/invoices/ksef/${encodeURIComponent(ksefNumber)}`, { accept: 'application/xml' });
  }
}

/* NIP: 10 цифр и контрольная сумма */
export function validNip(n: string) {
  if (!/^\d{10}$/.test(n)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const s = w.reduce((a, x, i) => a + x * +n[i], 0) % 11;
  return s !== 10 && s === +n[9];
}
