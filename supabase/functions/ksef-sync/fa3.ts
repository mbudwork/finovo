/* Finovo — разбор фактуры FA(2)/FA(3) из KSeF: суммы, ставка, срок оплаты, оплата, курс, позиции. */
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: true,
  isArray: (name: string) => ['FaWiersz', 'TerminPlatnosci', 'ZaplataCzesciowa', 'RachunekBankowy'].includes(name) });

const n = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const s = (v: unknown) => (v == null ? '' : String(v)).trim();

// группы сумм FA → ставка в кабинете ('23' | '8' | '5' | '0' | 'zw' | 'np')
const GROUPS: [string, string, string | null][] = [
  ['P_13_1', '23', 'P_14_1'], ['P_13_2', '8', 'P_14_2'], ['P_13_3', '5', 'P_14_3'], ['P_13_4', '23', 'P_14_4'],
  ['P_13_5', 'np', null], ['P_13_6_1', '0', null], ['P_13_6_2', '0', null], ['P_13_6_3', '0', null],
  ['P_13_7', 'zw', null], ['P_13_8', 'np', null], ['P_13_9', 'np', null], ['P_13_10', 'np', null], ['P_13_11', 'np', null],
];

export type Parsed = {
  number: string; issueDate: string; currency: string; net: number; vat: number; vatPln: number | null; rate: string;
  fx: number | null; dueDate: string | null; paidAt: string | null; lines: string[];
  seller: { nip: string; name: string }; buyer: { nip: string; name: string }; type: string;
};

export function parseFa(xml: string): Parsed {
  const doc = parser.parse(xml);
  const F = doc.Faktura; if (!F) throw new Error('Это не FA: нет элемента Faktura');
  const Fa = F.Fa || {};
  const p1 = F.Podmiot1 || {}, p2 = F.Podmiot2 || {};
  const id1 = p1.DaneIdentyfikacyjne || {}, id2 = p2.DaneIdentyfikacyjne || {};

  let net = 0, vat = 0, vatW = 0, best = '23', bestAbs = -1;
  for (const [k, rate, vk] of GROUPS) {
    const v = n(Fa[k]); net += v;
    if (vk) { vat += n(Fa[vk]); vatW += n(Fa[vk + 'W']); }
    if (Math.abs(v) > bestAbs && Fa[k] !== undefined) { bestAbs = Math.abs(v); best = rate; }
  }
  const lines: any[] = Fa.FaWiersz || [];
  const currency = s(Fa.KodWaluty) || 'PLN';
  let fx: number | null = null;
  if (currency !== 'PLN') {
    if (vatW && vat) fx = Math.round((vatW / vat) * 10000) / 10000;
    else if (Fa.KursWalutyZ) fx = n(Fa.KursWalutyZ);
    else { const lk = lines.find(l => l.KursWaluty); if (lk) fx = n(lk.KursWaluty); }
  } else fx = 1;

  const pay = Fa.Platnosc || {};
  const terms = (pay.TerminPlatnosci || []).map((t: any) => s(t.Termin)).filter(Boolean).sort();
  const paidAt = s(pay.Zaplacono) === '1' ? (s(pay.DataZaplaty) || s(Fa.P_1)) : (s(pay.ZnacznikZaplatyCzesciowej) === '2' ? s((pay.ZaplataCzesciowa || []).slice(-1)[0]?.DataZaplatyCzesciowej) || null : null);

  return {
    number: s(Fa.P_2), issueDate: s(Fa.P_1), currency, net: r2(net), vat: r2(vat), vatPln: vatW ? r2(vatW) : null, rate: best, fx,
    dueDate: terms[0] || null, paidAt: paidAt || null,
    lines: lines.map(l => s(l.P_7)).filter(Boolean).slice(0, 20),
    seller: { nip: s(id1.NIP), name: s(id1.Nazwa) },
    buyer: { nip: s(id2.NIP) || s(id2.NrVatUE) || s(id2.NrID), name: s(id2.Nazwa) },
    type: s(Fa.RodzajFaktury),
  };
}

/* категория расходов по продавцу и позициям — те же названия, что в кабинете */
const CATS: [RegExp, string][] = [
  [/orlen|\bbp\b|shell|circle ?k|moya|amic|lotos|paliw|stacja paliw|diesel|benzyn/i, 'Топливо'],
  [/leasing|lease|wynajem d[łl]ugoterm/i, 'Лизинг'],
  [/biuro rachunk|ksi[ęe]gow|finovo/i, 'Бухгалтерия'],
  [/orange|\bplay\b|p4 sp|polkomtel|plus\b|t-mobile|netia|vectra|upc|internet|telefon|abonament|google|microsoft|adobe|hosting|home\.pl|\bovh\b|nazwa\.pl|licencj|oprogramow|software/i, 'Связь и софт'],
  [/narz[ęe]dzi|elektronarz|hilti|makita|bosch|dewalt|rusztow|wynajem sprz[ęe]tu/i, 'Инструмент'],
  [/podwykonaw|us[łl]ug[ai]? budowlan|robocizn|monta[żz]|instalac|elektryczn|hydraul|wykonanie prac/i, 'Субподряд'],
  [/hurtown|budowl|materia[łl]|\bstal\b|stal-|glazur|ceramik|castorama|leroy|\bobi\b|psb|bricoman|cement|farb|kamex|bud-chem|klej|p[łl]yt|drewn|izolac/i, 'Материалы'],
];
export function categorize(text: string) {
  for (const [re, c] of CATS) if (re.test(text)) return c;
  return 'Прочие расходы';
}
