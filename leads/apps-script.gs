/**
 * Приёмник заявок с сайта FINOVO.COM.PL — пишет каждую заявку строкой в Google Sheet
 * и дублирует в Telegram. Основная копия заявок остаётся в Netlify → Forms.
 */

var SHEET_NAME = 'Заявки';

var NOTIFY_EMAIL = '';

var TG_TOKEN = '';   // токен бота — только в редакторе Apps Script, не в git (репозиторий публичный)
var TG_CHAT_ID = '';

var COLUMNS = [
  'submitted_at', 'lang', 'name', 'phone', 'email', 'form', 'message',
  'page', 'referrer', 'utm'
];

var HEADERS = {
  submitted_at: 'Дата', lang: 'Язык', name: 'Имя', phone: 'Телефон', email: 'E-mail',
  form: 'Форма фирмы', message: 'Сообщение', page: 'Страница', referrer: 'Откуда пришёл', utm: 'UTM'
};

var LANGS = { pl: 'польский', uk: 'украинский' };

function clip_(v, n) { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) + '…' : v; }

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    // простая защита от мусора: нужны имя и контакт
    if (!data.name || !(data.phone || data.email || data.contact)) {
      return json_({ ok: false, error: 'empty' });
    }
    if (!data.phone && !data.email && data.contact) data.phone = data.contact;

    var sheet = getOrCreateSheet_();
    var row = COLUMNS.map(function (key) {
      if (key === 'submitted_at') return data.submitted_at ? new Date(data.submitted_at) : new Date();
      if (key === 'utm') { try { var u = data.utm || {}; return Object.keys(u).length ? JSON.stringify(u) : ''; } catch (err) { return ''; } }
      if (key === 'lang') return LANGS[data.lang] || data.lang || '';
      return clip_(data[key], 2000);
    });
    sheet.appendRow(row);
    notify_(data);
    sendToTelegram_(data);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function notify_(data) {
  if (!NOTIFY_EMAIL) return;
  var body =
    'Имя: ' + (data.name || '') + '\n' +
    'Телефон: ' + (data.phone || '') + '\n' +
    (data.email ? 'E-mail: ' + data.email + '\n' : '') +
    'Форма фирмы: ' + (data.form || '') + '\n' +
    (data.message ? 'Сообщение: ' + data.message + '\n' : '') +
    'Язык сайта: ' + (LANGS[data.lang] || data.lang || '') + '\n' +
    'Страница: ' + (data.page || '');
  MailApp.sendEmail(NOTIFY_EMAIL, 'Новая заявка Finovo — ' + (data.name || ''), body);
}

function sendToTelegram_(data) {
  var utm = '';
  try { var u = data.utm || {}; utm = Object.keys(u).map(function (k) { return k + '=' + u[k]; }).join(', '); } catch (err) {}
  var text =
    '🟢 Новая заявка (FINOVO)\n' +
    'Имя: ' + clip_(data.name || '-', 200) + '\n' +
    'Телефон: ' + clip_(data.phone || '-', 100) + '\n' +
    (data.email ? 'E-mail: ' + clip_(data.email, 200) + '\n' : '') +
    'Форма фирмы: ' + clip_(data.form || '-', 100) + '\n' +
    (data.message ? 'Сообщение: ' + clip_(data.message, 1500) + '\n' : '') +
    'Язык сайта: ' + (LANGS[data.lang] || data.lang || '-') + '\n' +
    (data.referrer ? 'Откуда: ' + clip_(data.referrer, 200) + '\n' : '') +
    (utm ? 'UTM: ' + clip_(utm, 300) : '');

  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'post',
    payload: { chat_id: TG_CHAT_ID, text: text },
    muteHttpExceptions: true
  });
  Logger.log('TG response code: ' + resp.getResponseCode());
  Logger.log('TG response body: ' + resp.getContentText());
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS.map(function (k) { return HEADERS[k] || k; }));
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function testTelegram() {
  sendToTelegram_({
    name: 'Тест Имя',
    phone: '+48 500 000 000',
    form: 'JDG',
    message: 'Тестовая заявка Finovo',
    lang: 'pl'
  });
}
