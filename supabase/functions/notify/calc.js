/* Расчётное ядро: польские налоги 2026 для JDG и sp. z o.o.
   Ставки ориентировочные — сверяет бухгалтер; цифры закрытого месяца берутся из month_close. */
(function (global) {
  const RATES = {
    year: 2026,
    minWage: 4806,
    zusSpol: { pelny: 1926.76, preferencyjny: 456.19, brak: 0 },
    zdrMin: 432.54,              // 2026: 9% от 100% płacy minimalnej (4806 zł); в 2025 было 75%
    zdrLin: 0.049, zdrSkala: 0.09,
    zdrLinLimit: 14100,          // годовой лимит вычета zdrowotnej при liniowym
    zdrRyczalt: [[60000, 498.35], [300000, 830.58], [Infinity, 1495.04]],
    pitLin: 0.19, skala: { rate1: 0.12, rate2: 0.32, threshold: 120000, kwotaZmn: 3600 },
    cit: { cit9: 0.09, cit19: 0.19 }, divPit: 0.19,
    empZus: { uop: 0.1371, zlec: 0.1126 }, erZus: 0.2048, zdrEmp: 0.09, pitEmp: 0.12, kwotaZmnM: 300, kosztyUop: 250,
    vatExemptLimit: 240000, smallCitEur: 2000000, smallCitPln: 8431000  // 2 mln € по курсу NBP 2.01.2026 (4,2156)
  };
  const r2 = x => Math.round(x * 100) / 100;
  const ymOf = d => String(d).slice(0, 7);
  const ymAdd = (ym, n) => { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + String(m).padStart(2, '0'); };
  const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  /* Праздники в Польше: срок, выпавший на выходной или праздник, переносится на следующий рабочий день */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, mo - 1, da);
  }
  function isHoliday(d) {
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if ([101, 106, 501, 503, 815, 1101, 1111, 1224, 1225, 1226].includes(md)) return true;   // Wigilia (24.12) — wolna od 2025 r.
    const diff = Math.round((d.getTime() - easter(d.getUTCFullYear())) / 864e5);
    return diff === 0 || diff === 1 || diff === 49 || diff === 60;   // Wielkanoc, Poniedziałek, Zielone Świątki, Boże Ciało
  }
  function dueDate(ym, day) {
    const n = ymAdd(ym, 1); let d = new Date(Date.UTC(+n.slice(0, 4), +n.slice(5) - 1, day));
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || isHoliday(d)) d = new Date(d.getTime() + 864e5);
    return d.toISOString().slice(0, 10);
  }

  function wage(b, type) {
    if (type === 'b2b') return { brutto: b, netto: b, cost: b, eZus: 0, zdr: 0, pit: 0, erZus: 0 };
    const eZus = r2(b * RATES.empZus[type]), hb = b - eZus, zdr = r2(hb * RATES.zdrEmp);
    const koszty = type === 'uop' ? RATES.kosztyUop : r2(hb * 0.2), base = Math.round(hb - koszty);
    const pit = Math.max(0, Math.round(base * RATES.pitEmp - RATES.kwotaZmnM)), erZus = r2(b * RATES.erZus);
    return { brutto: b, netto: r2(b - eZus - zdr - pit), cost: r2(b + erZus), eZus, zdr, pit, erZus };
  }
  const activeIn = (e, ym) => e.contract !== 'b2b' && e.active !== false && (!e.start_date || e.start_date <= monthEnd(ym)) && (!e.end_date || e.end_date >= ym + '-01');

  const pln = i => (+i.net) * (+i.fx || 1);
  const plnVat = i => (+i.vat) * (+i.fx || 1);

  /* Год целиком: месяц за месяцем, с нарастающим итогом */
  function computeYear(data, untilYm) {
    const { firm, invoices, employees, closes, payments } = data;
    const year = untilYm.slice(0, 4), months = [];
    for (let m = year + '-01'; m <= untilYm; m = ymAdd(m, 1)) months.push(m);
    const closeBy = {}; (closes || []).forEach(c => closeBy[c.ym] = c);
    const paidBy = {}; (payments || []).forEach(p => paidBy[p.ym + '|' + p.kind] = p.paid_at);
    const spol = RATES.zusSpol[firm.zus_mode] ?? 0;
    let cumIncome = 0, cumSpol = 0, cumZdr = 0, cumTaxPaid = 0, vatCarry = 0, cumRev = 0;
    const out = [];
    for (const ym of months) {
      const inv = invoices.filter(i => ymOf(i.issue_date) === ym);
      const sales = inv.filter(i => i.kind === 'sale'), costs = inv.filter(i => i.kind === 'cost');
      const rev = r2(sales.reduce((s, i) => s + pln(i), 0));
      const vatOut = r2(sales.reduce((s, i) => s + plnVat(i), 0));
      const exp = r2(costs.reduce((s, i) => s + pln(i), 0));
      const vatIn = r2(costs.reduce((s, i) => s + plnVat(i), 0));
      const byRate = {}; sales.forEach(i => { byRate[i.vat_rate] = (byRate[i.vat_rate] || 0) + pln(i); });
      const pay = { brutto: 0, netto: 0, cost: 0, eZus: 0, zdr: 0, pit: 0, erZus: 0, people: 0 };
      employees.filter(e => activeIn(e, ym)).forEach(e => { const w = wage(+e.brutto, e.contract); for (const k in w) pay[k] += w[k]; pay.people++; });
      const costsAll = r2(exp + pay.cost), profit = r2(rev - costsAll);
      // VAT с переносом излишка
      let vatCalc = r2(vatOut - vatIn - vatCarry); let vatDue = Math.max(0, vatCalc); vatCarry = vatCalc < 0 ? -vatCalc : 0;
      const staffZus = r2(pay.eZus + pay.zdr + pay.erZus), pit4 = Math.round(pay.pit);
      let ownerSpol = 0, ownerZdr = 0, incomeTax = 0, mine = 0, extra = {};
      cumRev += rev;
      if (firm.type === 'jdg') {
        ownerSpol = spol;
        const monthIncome = profit - spol;
        if (firm.tax_form === 'liniowy') ownerZdr = Math.max(RATES.zdrMin, r2(Math.max(0, monthIncome) * RATES.zdrLin));
        else if (firm.tax_form === 'skala') ownerZdr = Math.max(RATES.zdrMin, r2(Math.max(0, monthIncome) * RATES.zdrSkala));
        else ownerZdr = RATES.zdrRyczalt.find(([lim]) => (cumRev / (months.indexOf(ym) + 1)) * 12 <= lim)[1];
        cumIncome += profit; cumSpol += spol; cumZdr += ownerZdr;
        let taxCum;
        if (firm.tax_form === 'liniowy') {
          const base = Math.max(0, cumIncome - cumSpol - Math.min(cumZdr, RATES.zdrLinLimit));
          taxCum = Math.round(base) * RATES.pitLin;
        } else if (firm.tax_form === 'skala') {
          const base = Math.max(0, Math.round(cumIncome - cumSpol)), s = RATES.skala;
          taxCum = base <= s.threshold ? Math.max(0, base * s.rate1 - s.kwotaZmn) : s.threshold * s.rate1 - s.kwotaZmn + (base - s.threshold) * s.rate2;
        } else {
          // ryczałt: od przychodu minus społeczne ZUS i 50% zapłaconej składki zdrowotnej
          taxCum = Math.max(0, Math.round(cumRev - cumSpol - cumZdr * 0.5)) * (+firm.ryczalt_rate || 0.055);
        }
        incomeTax = Math.max(0, Math.round(taxCum - cumTaxPaid));
      } else {
        cumIncome += profit;
        const rate = RATES.cit[firm.tax_form] || 0.09;
        const taxCum = Math.max(0, Math.round(cumIncome) * rate);
        incomeTax = Math.max(0, Math.round(taxCum - cumTaxPaid));
      }
      const c = closeBy[ym] || {};
      const closed = c.status === 'closed';
      const fin = {
        vat: c.vat != null ? +c.vat : vatDue,
        it: c.income_tax != null ? +c.income_tax : incomeTax,
        zus: c.zus != null ? +c.zus : r2(ownerSpol + ownerZdr + staffZus),
        pit4: c.pit4 != null ? +c.pit4 : pit4
      };
      cumTaxPaid += fin.it;
      if (firm.type === 'jdg') {
        const ownerZusFin = fin.zus - staffZus;
        mine = r2(profit - ownerZusFin - fin.it);
      } else {
        const after = profit - fin.it;
        extra = { afterCit: r2(after), divTax: r2(Math.max(0, after) * RATES.divPit) };
        mine = r2(Math.max(0, after) * (1 - RATES.divPit));
      }
      const taxes = r2(fin.vat + fin.it + fin.zus + fin.pit4);
      const obligations = [
        { kind: 'zus', amt: fin.zus, due: dueDate(ym, firm.type === 'sp' ? 15 : 20) },   // sp. z o.o. (osoba prawna) — do 15., JDG — do 20.
        { kind: 'pit4', amt: fin.pit4, due: dueDate(ym, 20) },
        { kind: 'it', amt: fin.it, due: dueDate(ym, 20) },
        { kind: 'vat', amt: fin.vat, due: dueDate(ym, 25) }
      ].map(o => ({ ...o, ym, paid_at: paidBy[ym + '|' + o.kind] || null, closed }));
      out.push({ ym, sales, costs, rev, exp, vatOut, vatIn, vatCarry, byRate, pay, costsAll, profit, ownerSpol, ownerZdr, staffZus,
        calc: { vat: vatDue, it: incomeTax, zus: r2(ownerSpol + ownerZdr + staffZus), pit4 }, fin, taxes, mine, closed, note: c.note || '', extra, obligations,
        gross: r2(rev + vatOut) });
    }
    return out;
  }

  /* Прогноз денег на N дней */
  function forecast(data, year, today, startBalance, days = 30) {
    const end = new Date(Date.parse(today) + days * 864e5).toISOString().slice(0, 10);
    const ev = [];
    const add = (date, amt, label, kind, sure = true) => { if (date < today) date = today; if (date <= end && Math.abs(amt) > 0.5) ev.push({ date, amt: r2(amt), label, kind, sure }); };
    data.invoices.filter(i => !i.paid_at).forEach(i => {
      const g = pln(i) + plnVat(i); const due = i.due_date || i.issue_date;
      if (i.kind === 'sale') add(due < today ? new Date(Date.parse(today) + 7 * 864e5).toISOString().slice(0, 10) : due, g, i.counterparty, 'in', due >= today);
      else add(due, -g, i.counterparty, 'out');
    });
    const curYm = ymOf(today);
    // зарплаты к 10-му за прошлый и текущий месяц
    [ymAdd(curYm, -1), curYm].forEach(ym => {
      const pay = data.employees.filter(e => activeIn(e, ym)).reduce((s, e) => s + wage(+e.brutto, e.contract).netto, 0);
      const due = ymAdd(ym, 1) + '-10'; if (due >= today) add(due, -pay, 'Зарплаты за ' + ym.slice(5) + '.' + ym.slice(0, 4), 'pay');
    });
    year.forEach(m => m.obligations.forEach(o => { if (!o.paid_at && o.amt > 0) add(o.due, -o.amt, ({ zus: 'ZUS', pit4: 'PIT-4', it: data.firm.type === 'jdg' ? 'PIT' : 'CIT', vat: 'VAT' })[o.kind] + ' за ' + o.ym.slice(5), 'tax', true); }));
    // постоянные расходы следующего месяца (лизинг, бухгалтерия, связь) — по прошлому месяцу
    const last = year[year.length - 2];
    if (last) last.costs.filter(i => ['Лизинг', 'Бухгалтерия', 'Связь и софт'].includes(i.category)).forEach(i => {
      const d = ymAdd(curYm, 1) + i.issue_date.slice(7);
      add(new Date(Date.parse(d) + 14 * 864e5).toISOString().slice(0, 10), -(pln(i) + plnVat(i)), i.category, 'fixed');
    });
    ev.sort((a, b) => a.date.localeCompare(b.date));
    let bal = startBalance, min = { bal: startBalance, date: today };
    const points = [{ date: today, bal }];
    ev.forEach(e => { bal = r2(bal + e.amt); points.push({ date: e.date, bal }); if (bal < min.bal) min = { bal, date: e.date }; });
    return { events: ev, points, endBalance: bal, min, end };
  }

  global.Calc = { RATES, wage, computeYear, forecast, dueDate, isHoliday, ymAdd, ymOf, r2, pln, plnVat, activeIn };
})(typeof window !== 'undefined' ? window : globalThis);

