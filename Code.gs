/**
 * Замовлення шкільного харчування.
 * БД — ця Google-таблиця. UI — Index.html (батьки) та Admin.html (адмін), веб-додаток Apps Script.
 *
 * Порядок запуску: меню «🍲 Харчування» → пункти 1..3, потім Deploy → Web app.
 * Детально — у README.md.
 */

const SHEETS = {
  SETTINGS: 'Налаштування',
  ROSTER: 'Список',
  PRICES: 'Ціни',
  RULES: 'Правила змін',  // вікна дозамовлення/скасування по прийомах
  MENU_RAW: 'Меню',       // сюди адмін вставляє лист «Склад» зі шкільної таблиці (як є)
  MENU: 'МенюДані',       // розібране меню (генерується скриптом)
  ORDERS: 'Замовлення',   // нормалізована БД замовлень: один рядок = дитина+тиждень
  PAYMENTS: 'Оплати',     // оплати (вручну або з адмін-панелі)
  TOKENS: 'Токени',       // персональні посилання (контакт -> токен)
  SUMMARY: 'Зведення',    // генерується: підрахунки для кухні + хто не замовив
  BALANCE: 'Баланс',      // генерується: замовлено/оплачено по кожній дитині
  LOG: 'Журнал змін',     // що саме змінили батьки — для передачі кейтерингу
  IMPORT: 'Імпорт',       // переїзд зі старої системи: список + стартові баланси
};

// увесь час у системі — львівський, незалежно від налаштувань акаунта/скрипта
const TZ = 'Europe/Kyiv';

const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця"];
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
const MEALS = ['Сніданок', 'Обід', 'Підвечірок'];
const NONE = '—';
const CHOICES = ['№1', '№2', NONE];

const MODE_RULES = 'за правилами прийомів';
const MODE_FORBID = 'заборонено';
const MODE_FREE = 'вільно';

const DAY_OFFSETS = { 'той самий день': 0, 'попередній день': 1, 'за 2 дні': 2, 'за 3 дні': 3 };

const DEFAULT_RULES = {
  'Сніданок':   { chOff: 1, chTime: { h: 17, m: 0 },  cnOff: 1, cnTime: { h: 17, m: 0 } },
  'Обід':       { chOff: 0, chTime: { h: 9,  m: 30 }, cnOff: 0, cnTime: { h: 9,  m: 30 } },
  'Підвечірок': { chOff: 0, chTime: { h: 9,  m: 30 }, cnOff: 0, cnTime: { h: 9,  m: 30 } },
};

const ROSTER_HEADERS = ['ПІБ', 'Клас', 'Телефон 1', 'Телефон 2', 'Статус', 'Email 1', 'Email 2', 'Примітка'];
const PAYMENT_HEADERS = ['Дата', 'ПІБ', 'Сума, грн', 'Коментар', 'Повідомлено'];

// лист переїзду: адмін вставляє сюди дані зі старої системи, далі пункт меню 4
const IMPORT_HEADERS = ['ПІБ', 'Клас', 'Телефон 1', 'Телефон 2', 'Email 1', 'Email 2',
  'Баланс на старті, грн', 'Примітка', 'Статус', 'Результат'];
// текст коментаря в «Оплатах», за яким видно вже перенесений баланс (захист від подвоєння)
const IMPORT_NOTE = 'Перенесення з попередньої системи';

// ---------------------------------------------------------------- меню адміна

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🍲 Харчування')
    .addItem('1. Створити/оновити службові листи', 'setupSheets')
    .addItem('2. Розібрати меню з листа «Меню»', 'parseMenuRaw')
    .addItem('3. Згенерувати персональні посилання', 'generateLinks')
    .addItem('4. Імпорт: перенести список і баланси з листа «Імпорт»', 'importFromSheet')
    .addSeparator()
    .addItem('Оновити «Зведення» і «Баланс»', 'refreshAll')
    .addItem('Позначити зміни як передані кейтерингу', 'markChangesSent')
    .addItem('Передати кейтерингу: скопіювати в їхню таблицю', 'exportToCatering')
    .addSeparator()
    .addItem('Показати посилання на адмін-панель', 'showAdminLink')
    .addItem('Увімкнути нагадування та email-сповіщення', 'installTriggers')
    .addItem('Надіслати баланси на email', 'sendBalanceEmails')
    .addSeparator()
    .addItem('ДЕМО: імпортувати дітей зі шкільної таблиці', 'seedRosterDemo')
    .addItem('ДЕМО: згенерувати тестові замовлення', 'seedDemoOrders')
    .addToUi();
}

function ss() { return SpreadsheetApp.getActive(); }

function sheet(name, createIfMissing) {
  let sh = ss().getSheetByName(name);
  if (!sh && createIfMissing) sh = ss().insertSheet(name);
  return sh;
}

function orderHeaders() {
  const h = ['Тиждень', 'ПІБ'];
  for (let d = 0; d < 5; d++) for (let m = 0; m < 3; m++) h.push(DAY_SHORT[d] + ' ' + MEALS[m]);
  return h.concat(['Сума', 'Оновлено', 'Контакт']);
}

function newToken(len) { return Utilities.getUuid().replace(/-/g, '').slice(0, len || 10); }

function setupSheets() {
  ss().setSpreadsheetTimeZone(TZ);

  const ensure = (name, headers) => {
    const sh = sheet(name, true);
    if (sh.getLastRow() === 0 && headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
    return sh;
  };
  const timeOptions = [];
  for (let h = 6; h <= 22; h++) {
    timeOptions.push(('0' + h).slice(-2) + ':00');
    if (h < 22) timeOptions.push(('0' + h).slice(-2) + ':30');
  }
  const dateRule = txt => SpreadsheetApp.newDataValidation()
    .requireDate().setAllowInvalid(false).setHelpText(txt).build();
  const listRule = (vals, strict, txt) => SpreadsheetApp.newDataValidation()
    .requireValueInList(vals, true).setAllowInvalid(!strict).setHelpText(txt).build();

  // ---- «Налаштування» ----
  const st = sheet(SHEETS.SETTINGS, true);
  st.setColumnWidth(1, 260);
  st.setColumnWidth(2, 300);
  const ORDER = [
    'Понеділок тижня (дата)',
    'Дедлайн: днів до понеділка',
    'Дедлайн: час',
    'Дедлайн першого замовлення (авто)',
    'Після дедлайну',
    'Тиждень закрито',
    'Нагадування: за годин до дедлайну',
    'URL веб-додатку',
    'Адмін-токен',
    'Кейтеринг: таблиця (посилання)',
    'Кейтеринг: лист для зведення',
    'Кейтеринг: лист для замовлень по дітях',
  ];
  const DEFAULTS = {
    'Дедлайн: днів до понеділка': 1,
    'Дедлайн: час': '17:00',
    'Після дедлайну': MODE_RULES,
    'Тиждень закрито': 'ні',
    'Нагадування: за годин до дедлайну': 2,
    'Адмін-токен': newToken(16),
    'Кейтеринг: лист для зведення': 'Зведення {тиждень}',
    'Кейтеринг: лист для замовлень по дітях': 'Діти {тиждень}',
  };
  const RENAME = { 'Дедлайн (час)': 'Дедлайн: час' };
  const OBSOLETE = ['Дедлайн (дата і час)', 'Дедлайн (дата)'];
  const cur = st.getLastRow() ? st.getRange(1, 1, st.getLastRow(), 2).getValues() : [];
  const valByKey = {}, extras = [];
  cur.forEach(r => {
    let k = String(r[0]).trim();
    if (!k || OBSOLETE.indexOf(k) !== -1) return;
    k = RENAME[k] || k;
    if (ORDER.indexOf(k) !== -1) { if (valByKey[k] === undefined) valByKey[k] = r[1]; }
    else extras.push([r[0], r[1]]);
  });
  const rows = ORDER.map(k => {
    let v = valByKey[k];
    if (v === undefined || v === '') v = (DEFAULTS[k] !== undefined ? DEFAULTS[k] : '');
    return [k, v];
  }).concat(extras);
  if (cur.length) st.getRange(1, 1, cur.length, 2).clearDataValidations();
  st.clearContents();
  st.getRange(1, 1, rows.length, 2).setValues(rows);
  const labels = () => st.getRange(1, 1, st.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  const rowOf = k => labels().indexOf(k) + 1;

  const CELL_FORMATS = {
    'Понеділок тижня (дата)': ['dd.mm.yyyy', dateRule('Лише дата, напр. 07.09.2026')],
    'Дедлайн: днів до понеділка': ['0', SpreadsheetApp.newDataValidation()
      .requireNumberBetween(0, 7).setAllowInvalid(false)
      .setHelpText('За скільки днів до понеділка закривається первинне замовлення (1 = неділя)').build()],
    'Дедлайн: час': ['@', listRule(timeOptions, false, 'Оберіть зі списку або впишіть свій час у форматі 17:00')],
    'Дедлайн першого замовлення (авто)': ['ddd, dd.mm.yyyy hh:mm', null],
    'Після дедлайну': ['@', listRule([MODE_RULES, MODE_FORBID, MODE_FREE], true,
      'за правилами прийомів — точкові зміни за листом «Правила змін»; заборонено — лише перегляд; вільно — без обмежень')],
    'Тиждень закрито': ['@', listRule(['ні', 'так'], true,
      'так — форма повністю закривається негайно, незалежно від дедлайнів і правил (форс-мажор)')],
    'Нагадування: за годин до дедлайну': ['0', SpreadsheetApp.newDataValidation()
      .requireNumberBetween(1, 48).setAllowInvalid(false)
      .setHelpText('За скільки годин до дедлайну надсилати email тим, хто ще не замовив').build()],
    'URL веб-додатку': ['@', null],
    'Адмін-токен': ['@', null],
    'Кейтеринг: таблиця (посилання)': ['@', null],
    'Кейтеринг: лист для зведення': ['@', null],
    'Кейтеринг: лист для замовлень по дітях': ['@', null],
  };
  st.getRange(1, 1, st.getLastRow(), 1).getValues().forEach((r, i) => {
    const f = CELL_FORMATS[String(r[0]).trim()];
    if (!f) return;
    const cell = st.getRange(i + 1, 2);
    cell.setNumberFormat(f[0]);
    cell.setDataValidation(f[1]);
  });
  const rM = rowOf('Понеділок тижня (дата)'), rD = rowOf('Дедлайн: днів до понеділка'),
        rT = rowOf('Дедлайн: час'), rA = rowOf('Дедлайн першого замовлення (авто)');
  st.getRange(rA, 2).setFormula(
    '=IF($B$' + rM + '="","",$B$' + rM + '-IF($B$' + rD + '="",1,$B$' + rD + ')' +
    '+IFERROR(TIMEVALUE($B$' + rT + '),TIMEVALUE("17:00")))');

  // ---- «Список» ----
  // порядок колонок: ПІБ | Клас | Телефон 1 | Телефон 2 | Статус | Email 1 | Email 2 | Примітка
  // якщо лист має старий порядок — переставляємо колонки, зберігаючи дані кожної дитини
  const roster = sheet(SHEETS.ROSTER, true);
  const W = ROSTER_HEADERS.length;
  const curCols = roster.getLastColumn();
  const curHead = curCols ? roster.getRange(1, 1, 1, curCols).getValues()[0].map(v => String(v || '').trim()) : [];
  const headOk = ROSTER_HEADERS.every((h, i) => curHead[i] === h);

  if (roster.getLastRow() === 0) {
    roster.getRange(1, 1, 1, W).setValues([ROSTER_HEADERS]);
    roster.setFrozenRows(1);
  } else if (!headOk && curHead[0] === 'ПІБ') {
    const dataRows = roster.getLastRow() > 1
      ? roster.getRange(2, 1, roster.getLastRow() - 1, Math.max(curCols, 1)).getValues() : [];
    const from = ROSTER_HEADERS.map(h => curHead.indexOf(h));
    const moved = dataRows
      .filter(r => String(r[0] || '').trim())
      .map(r => ROSTER_HEADERS.map((h, i) => (from[i] === -1 || r[from[i]] === undefined) ? '' : r[from[i]]));
    roster.getRange(1, 1, roster.getMaxRows(), Math.max(curCols, W)).clearDataValidations();
    roster.clearContents();
    roster.getRange(1, 1, 1, W).setValues([ROSTER_HEADERS]);
    if (moved.length) roster.getRange(2, 1, moved.length, W).setValues(moved);
    roster.setFrozenRows(1);
  } else if (!headOk) {
    SpreadsheetApp.getUi().alert(
      'Лист «Список»: очікую заголовки в 1-му рядку: ' + ROSTER_HEADERS.join(' | ') + '.\n' +
      'Приведіть лист до цього вигляду (дані дітей — з 2-го рядка).');
  }

  if (String(roster.getRange(1, 1).getValue() || '').trim() === 'ПІБ') {
    roster.getRange('A2:H1000').setNumberFormat('@');
    roster.getRange('B2:B1000').setDataValidation(
      listRule(['0', '1', '2', '3', '4', '5', '6'], true, 'Клас: число від 0 до 6'));
    roster.getRange('E2:E1000').setDataValidation(listRule(['активний', 'архів'], true,
      'активний — дитина видима у формі; архів — прихована, історія та баланс зберігаються'));
    roster.setColumnWidth(2, 70);
  }

  // ---- «Ціни» ----
  // ціни версіоновані: рядок діє з дати в колонці C (порожньо = від початку);
  // для тижня береться останній рядок з датою не пізніше його понеділка
  const prices = sheet(SHEETS.PRICES, true);
  if (prices.getLastRow() === 0) {
    prices.getRange(1, 1, 4, 3).setValues([
      ['Прийом', 'Ціна, грн', 'Діє з (дата)'], ['Сніданок', 90, ''], ['Обід', 200, ''], ['Підвечірок', 90, ''],
    ]);
    prices.setFrozenRows(1);
  }
  if (!String(prices.getRange(1, 3).getValue() || '').trim()) prices.getRange(1, 3).setValue('Діє з (дата)');
  prices.getRange('A2:A50').setDataValidation(listRule(MEALS, true, 'Сніданок / Обід / Підвечірок'));
  prices.getRange('B2:B50').setNumberFormat('0').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0)
      .setAllowInvalid(false).setHelpText('Ціна в гривнях — лише число, напр. 200').build());
  prices.getRange('C2:C50').setNumberFormat('dd.mm.yyyy')
    .setDataValidation(dateRule('З якого дня діє ціна (порожньо = від початку). Для тижня береться ціна, чинна на його понеділок.'));
  prices.setColumnWidth(3, 140);

  // ---- «Правила змін» ----
  const rules = ensure(SHEETS.RULES,
    ['Прийом', 'Змінити/дозамовити до (день)', 'Змінити/дозамовити до (час)', 'Скасувати до (день)', 'Скасувати до (час)']);
  if (rules.getLastRow() <= 1) {
    rules.getRange(2, 1, 3, 5).setValues([
      ['Сніданок', 'попередній день', '17:00', 'попередній день', '17:00'],
      ['Обід', 'той самий день', '09:30', 'той самий день', '09:30'],
      ['Підвечірок', 'той самий день', '09:30', 'той самий день', '09:30'],
    ]);
    rules.setColumnWidths(1, 5, 200);
  }
  const dayNames = Object.keys(DAY_OFFSETS);
  rules.getRange('B2:B10').setDataValidation(listRule(dayNames, true, 'До якого дня діє вікно'));
  rules.getRange('D2:D10').setDataValidation(listRule(dayNames, true, 'До якого дня діє вікно'));
  rules.getRange('C2:C10').setNumberFormat('@').setDataValidation(listRule(timeOptions, false, 'Час у форматі 09:30'));
  rules.getRange('E2:E10').setNumberFormat('@').setDataValidation(listRule(timeOptions, false, 'Час у форматі 09:30'));

  // ---- решта листів ----
  const raw = sheet(SHEETS.MENU_RAW, true);
  if (raw.getLastRow() === 0) {
    raw.getRange(1, 1).setValue('⬇ Вставте сюди вміст листа «Склад …» зі шкільної таблиці (Ctrl+A, Ctrl+C там → Ctrl+V тут), потім меню «🍲 Харчування» → пункт 2.');
  }
  ensure(SHEETS.MENU, ['День', 'Прийом', 'Варіант', 'Страви']);
  const ordersSh = ensure(SHEETS.ORDERS, orderHeaders());
  const paymentsSh = ensure(SHEETS.PAYMENTS, PAYMENT_HEADERS);
  if (!String(paymentsSh.getRange(1, 5).getValue() || '').trim()) paymentsSh.getRange(1, 5).setValue('Повідомлено');
  const tokensSh = ensure(SHEETS.TOKENS, ['Контакт', 'Токен', 'Посилання', 'Діти']);
  tokensSh.getRange(1, 1).setValue('Контакт');
  ensure(SHEETS.SUMMARY, []);
  ensure(SHEETS.BALANCE, []);
  const logSh = ensure(SHEETS.LOG, ['Час', 'Тиждень', 'ПІБ', 'Контакт', 'Зміни', 'Після дедлайну', 'Передано кейтерингу']);
  logSh.getRange('A2:A5000').setNumberFormat('dd.mm.yyyy hh:mm');
  logSh.getRange('G2:G5000').setDataValidation(listRule(['так'], false, 'так — зміну передано кейтерингу'));
  logSh.setColumnWidth(5, 420);

  // ---- формати та перевірки на листах, які заповнює адмін ----
  paymentsSh.getRange('A2:A1000').setNumberFormat('dd.mm.yyyy')
    .setDataValidation(dateRule('Дата оплати, напр. 07.09.2026'));
  paymentsSh.getRange('B2:B1000').setNumberFormat('@').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(roster.getRange('A2:A1000'), true)
      .setAllowInvalid(false).setHelpText('Оберіть дитину зі «Списку»').build());
  paymentsSh.getRange('C2:C1000').setNumberFormat('0').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(-100000, 100000)
      .setAllowInvalid(false).setHelpText('Сума в гривнях (число; від’ємна = повернення)').build());
  paymentsSh.getRange('D2:E1000').setNumberFormat('@');

  ordersSh.getRange('A2:B5000').setNumberFormat('@');
  ordersSh.getRange(2, 3, 4999, 15).setDataValidation(listRule(CHOICES, true, 'Лише №1, №2 або —'));
  ordersSh.getRange(2, 18, 4999, 1).setNumberFormat('0');
  ordersSh.getRange(2, 19, 4999, 1).setNumberFormat('dd.mm.yyyy hh:mm');
  ordersSh.getRange(2, 20, 4999, 1).setNumberFormat('@');

  // ---- «Імпорт» (переїзд зі старої системи) ----
  const imp = ensure(SHEETS.IMPORT, IMPORT_HEADERS);
  if (String(imp.getRange(1, 1).getValue() || '').trim() !== 'ПІБ') {
    imp.getRange(1, 1, 1, IMPORT_HEADERS.length).setValues([IMPORT_HEADERS]);
    imp.setFrozenRows(1);
  }
  imp.getRange(1, 1, 1, IMPORT_HEADERS.length).setFontWeight('bold').setBackground('#e3f1e9');
  imp.getRange(1, 1).setNote(
    'Сюди вставте дані зі старої системи (Paste values only), потім меню → пункт 4.\n\n' +
    '• ПІБ — обов’язковий; саме під цим написанням дитина житиме далі.\n' +
    '• Клас — число 0–6 або порожньо.\n' +
    '• Баланс: додатний = передоплата, від’ємний = борг, порожньо = 0.\n' +
    '• Статус: порожньо = активний.\n' +
    '• Колонку «Результат» заповнює скрипт — руками не чіпати.\n\n' +
    'Імпорт можна запускати повторно: контакти оновляться, а баланс кожної дитини перенесеться лише раз.');
  imp.getRange('A2:F1000').setNumberFormat('@');
  imp.getRange('B2:B1000').setDataValidation(listRule(['0', '1', '2', '3', '4', '5', '6'], false, 'Клас: число 0–6'));
  imp.getRange('G2:G1000').setNumberFormat('0').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(-1000000, 1000000)
      .setAllowInvalid(true).setHelpText('Баланс у гривнях: додатний = передоплата, від’ємний = борг').build());
  imp.getRange('H2:J1000').setNumberFormat('@');
  imp.getRange('I2:I1000').setDataValidation(listRule(['активний', 'архів'], false, 'Порожньо = активний'));
  imp.setColumnWidth(1, 220);
  imp.setColumnWidth(7, 160);
  imp.setColumnWidth(10, 300);

  SpreadsheetApp.getUi().alert(
    'Службові листи готові.\nЗаповніть «Список» (телефони/email, статус) — або, якщо переїжджаєте зі старої ' +
    'системи, вставте дані в лист «Імпорт» і запустіть пункт меню 4.\n' +
    'Перевірте «Ціни» і «Правила змін», у «Налаштуваннях» вкажіть понеділок тижня — ' +
    'дедлайн першого замовлення порахується сам.');
}

// ---------------------------------------------------------------- час (Львів)

function ymdOf(date) {
  const s = Utilities.formatDate(date, TZ, 'yyyy-MM-dd').split('-');
  return { y: +s[0], mo: +s[1], d: +s[2] };
}

function ymdAdd(ymd, n) {
  const u = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d + n));
  return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

function ymdWeekday(ymd) { return new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d)).getUTCDay(); } // 0 = нд

const pad2 = n => ('0' + n).slice(-2);
const dm = ymd => pad2(ymd.d) + '.' + pad2(ymd.mo);

function atTime(ymd, t) {
  return Utilities.parseDate(
    ymd.y + '-' + pad2(ymd.mo) + '-' + pad2(ymd.d) + ' ' + pad2(t.h) + ':' + pad2(t.m),
    TZ, 'yyyy-MM-dd HH:mm');
}

function parseTime(v, def) {
  if (v instanceof Date) return parseTime(Utilities.formatDate(v, ss().getSpreadsheetTimeZone(), 'HH:mm'), def);
  const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return { h: +m[1], m: +m[2] };
  return def;
}

function weekLabelOf(mondayYmd) { return dm(mondayYmd) + '-' + dm(ymdAdd(mondayYmd, 4)); }

function fmtDl(d) {
  const ymd = ymdOf(d);
  const wd = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][ymdWeekday(ymd)];
  return wd + ' ' + Utilities.formatDate(d, TZ, 'dd.MM HH:mm');
}

// ---------------------------------------------------------------- налаштування і правила

function getSettings() {
  const sh = sheet(SHEETS.SETTINGS);
  const map = {};
  if (sh) sh.getDataRange().getValues().forEach(r => { if (r[0]) map[String(r[0]).trim()] = r[1]; });
  const monday = map['Понеділок тижня (дата)'] instanceof Date ? map['Понеділок тижня (дата)'] : null;
  const mondayYmd = monday ? ymdOf(monday) : null;

  let deadline = null;
  if (mondayYmd) {
    const daysBefore = (typeof map['Дедлайн: днів до понеділка'] === 'number') ? map['Дедлайн: днів до понеділка'] : 1;
    const t = parseTime(map['Дедлайн: час'], { h: 17, m: 0 });
    deadline = atTime(ymdAdd(mondayYmd, -daysBefore), t);
  }
  let mode = String(map['Після дедлайну'] || '').trim();
  if ([MODE_RULES, MODE_FORBID, MODE_FREE].indexOf(mode) === -1) mode = MODE_RULES;
  const closed = String(map['Тиждень закрито'] || '').trim().toLowerCase() === 'так';

  return {
    monday, mondayYmd, deadline, mode, closed,
    weekLabel: mondayYmd ? weekLabelOf(mondayYmd) : '',
    dayLabels: mondayYmd ? DAYS.map((n, i) => n + ' ' + dm(ymdAdd(mondayYmd, i))) : [],
    appUrl: String(map['URL веб-додатку'] || '').trim(),
    adminToken: String(map['Адмін-токен'] || '').trim(),
    cateringUrl: String(map['Кейтеринг: таблиця (посилання)'] || '').trim(),
    cateringSummaryTab: exportTabName(map['Кейтеринг: лист для зведення'], 'Зведення {тиждень}'),
    cateringKidsTab: exportTabName(map['Кейтеринг: лист для замовлень по дітях'], 'Діти {тиждень}'),
    remindHours: (typeof map['Нагадування: за годин до дедлайну'] === 'number') ? map['Нагадування: за годин до дедлайну'] : 2,
    pastDeadline: !!(deadline && new Date() > deadline),
    deadlineText: deadline ? fmtDl(deadline) : '',
  };
}

function getRules() {
  const out = {};
  MEALS.forEach(m => { out[m] = Object.assign({}, DEFAULT_RULES[m]); });
  const sh = sheet(SHEETS.RULES);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
      const meal = String(r[0]).trim();
      if (!out[meal]) return;
      if (DAY_OFFSETS[String(r[1]).trim()] !== undefined) out[meal].chOff = DAY_OFFSETS[String(r[1]).trim()];
      out[meal].chTime = parseTime(r[2], out[meal].chTime);
      if (DAY_OFFSETS[String(r[3]).trim()] !== undefined) out[meal].cnOff = DAY_OFFSETS[String(r[3]).trim()];
      out[meal].cnTime = parseTime(r[4], out[meal].cnTime);
    });
  }
  return out;
}

function cellPermissions(st, rules) {
  const now = new Date();
  const out = [];
  for (let d = 0; d < 5; d++) for (let m = 0; m < 3; m++) {
    const r = rules[MEALS[m]];
    const dayYmd = ymdAdd(st.mondayYmd, d);
    const mk = (off, t) => atTime(ymdAdd(dayYmd, -off), t);
    const chDl = mk(r.chOff, r.chTime), cnDl = mk(r.cnOff, r.cnTime);
    let c, x;
    if (st.closed) { c = false; x = false; }
    else if (!st.deadline || now <= st.deadline || st.mode === MODE_FREE) { c = true; x = true; }
    else if (st.mode === MODE_FORBID) { c = false; x = false; }
    else { c = now <= chDl; x = now <= cnDl; }
    out.push({ c: c, x: x, ct: fmtDl(chDl), xt: fmtDl(cnDl) });
  }
  return out;
}

function rulesSummaryText(rules) {
  const offName = off => ['того ж дня', 'попереднього дня', 'за 2 дні', 'за 3 дні'][off] || '';
  return MEALS.map(m => {
    const r = rules[m];
    return m.toLowerCase() + ' — до ' + pad2(r.chTime.h) + ':' + pad2(r.chTime.m) + ' ' + offName(r.chOff);
  }).join('; ');
}

// ---------------------------------------------------------------- список, контакти

function normPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}
function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
/** Телефон або email → нормалізований контакт (або null). */
function normContact(v) {
  const s = String(v || '').trim();
  return s.indexOf('@') !== -1 ? normEmail(s) : normPhone(s);
}

function roster() {
  const sh = sheet(SHEETS.ROSTER);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, ROSTER_HEADERS.length).getValues()
    .map((r, i) => ({
      row: i + 2,
      name: String(r[0]).trim(),
      cls: String(r[1] || '').trim(),
      phones: [normPhone(r[2]), normPhone(r[3])].filter(Boolean),
      emails: [normEmail(r[5]), normEmail(r[6])].filter(Boolean),
      rawPhones: [String(r[2] || '').trim(), String(r[3] || '').trim()],
      rawEmails: [String(r[5] || '').trim(), String(r[6] || '').trim()],
      status: String(r[4] || '').trim(),
      active: !/архів/i.test(String(r[4] || '')),
      note: String(r[7] || '').trim(),
    }))
    .filter(k => k.name);
}

function childrenByContact(contact) {
  return roster().filter(k => k.active && (k.phones.indexOf(contact) !== -1 || k.emails.indexOf(contact) !== -1));
}

function familyEmails(name) {
  const k = roster().find(x => x.name === name);
  return k ? k.emails : [];
}

// ---------------------------------------------------------------- токени

function ensureToken(contact) {
  const sh = sheet(SHEETS.TOKENS, true);
  const vals = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  for (const r of vals) if (String(r[0]) === contact) return String(r[1]);
  const token = newToken(10);
  sh.appendRow([contact, token, '', '']);
  return token;
}

function contactByToken(key) {
  const sh = sheet(SHEETS.TOKENS);
  if (!sh || sh.getLastRow() < 2) return null;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (const r of vals) if (String(r[1]) === String(key).trim()) return String(r[0]);
  return null;
}

function linkFor(st, token) {
  return st.appUrl ? st.appUrl + (st.appUrl.indexOf('?') === -1 ? '?' : '&') + 'key=' + token : '';
}

function generateLinks() {
  const st = getSettings();
  const byContact = {};
  roster().forEach(k => { if (k.active) k.phones.concat(k.emails).forEach(c => { (byContact[c] = byContact[c] || []).push(k.name); }); });
  const rows = Object.keys(byContact).map(c => {
    const token = ensureToken(c);
    return [c, token, linkFor(st, token) || '(вкажіть «URL веб-додатку» в Налаштуваннях)', byContact[c].join(', ')];
  });
  const sh = sheet(SHEETS.TOKENS, true);
  sh.clearContents();
  sh.getRange(1, 1, 1, 4).setValues([['Контакт', 'Токен', 'Посилання', 'Діти']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
  SpreadsheetApp.getUi().alert('Готово: ' + rows.length + ' посилань у листі «Токени». Розішліть кожній сім’ї її посилання.');
}

function showAdminLink() {
  const st = getSettings();
  if (!st.appUrl) { SpreadsheetApp.getUi().alert('Спочатку вкажіть «URL веб-додатку» в Налаштуваннях.'); return; }
  const url = st.appUrl + (st.appUrl.indexOf('?') === -1 ? '?' : '&') + 'admin=' + st.adminToken;
  SpreadsheetApp.getUi().alert('Адмін-панель (не пересилайте батькам):\n\n' + url);
}

// ---------------------------------------------------------------- ціни та меню

/** Ціни, чинні на дату ymd (за замовчуванням — сьогодні): останній рядок з «Діє з» ≤ ymd. */
function getPrices(ymd) {
  ymd = ymd || ymdOf(new Date());
  const key = o => o.y * 10000 + o.mo * 100 + o.d;
  const target = key(ymd);
  const sh = sheet(SHEETS.PRICES);
  const best = {}; // meal -> { from, price }
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
    const k = String(r[0]).trim();
    if (MEALS.indexOf(k) === -1) return;
    const from = r[2] instanceof Date ? key(ymdOf(r[2])) : 0; // порожньо = від початку
    if (from > target) return;
    if (!best[k] || from >= best[k].from) best[k] = { from: from, price: Number(r[1]) || 0 };
  });
  const map = {};
  MEALS.forEach(m => { map[m] = best[m] ? best[m].price : 0; });
  return map;
}

const normAp = s => String(s || '').replace(/[`’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

function fmtWeight(v) {
  if (v === null || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  return String(v).trim();
}

function parseMenuRaw() {
  const raw = sheet(SHEETS.MENU_RAW);
  if (!raw || raw.getLastRow() === 0) { SpreadsheetApp.getUi().alert('Лист «Меню» порожній.'); return; }
  const vals = raw.getDataRange().getValues();
  let day = null, meal = null, variant = null;
  const acc = {};
  let dishes = 0;

  for (const r of vals) {
    const a = normAp(r[0]);
    if (!a || a.charAt(0) === '⬇') continue;
    const dayHit = DAYS.find(d => normAp(d).toLowerCase() === a.toLowerCase());
    if (dayHit) { day = dayHit; meal = variant = null; continue; }
    const m = a.match(/^(Сніданок|Обід|Підвечірок)\s*№\s*([12])/i);
    if (m) {
      meal = MEALS.find(x => x.toLowerCase() === m[1].toLowerCase());
      variant = '№' + m[2];
      if (day && meal) {
        acc[day] = acc[day] || {};
        acc[day][meal] = acc[day][meal] || {};
        acc[day][meal][variant] = [];
      }
      continue;
    }
    if (day && meal && variant) {
      const w = fmtWeight(r[1]);
      acc[day][meal][variant].push(w ? a + ' (' + w + ' г)' : a);
      dishes++;
    }
  }

  const out = [['День', 'Прийом', 'Варіант', 'Страви']];
  DAYS.forEach(d => MEALS.forEach(mm => CHOICES.slice(0, 2).forEach(v => {
    const list = acc[d] && acc[d][mm] && acc[d][mm][v];
    if (list && list.length) out.push([d, mm, v, list.join('; ')]);
  })));

  const menuSh = sheet(SHEETS.MENU, true);
  menuSh.clearContents();
  menuSh.getRange(1, 1, out.length, 4).setValues(out);
  SpreadsheetApp.getUi().alert('Меню розібрано: ' + (out.length - 1) + ' позицій, ' + dishes + ' страв.');
}

function getMenu() {
  const sh = sheet(SHEETS.MENU);
  const menu = {};
  if (!sh || sh.getLastRow() < 2) return menu;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(r => {
    const [d, m, v, txt] = [String(r[0]), String(r[1]), String(r[2]), String(r[3])];
    if (!d) return;
    menu[d] = menu[d] || {};
    menu[d][m] = menu[d][m] || {};
    menu[d][m][v] = txt;
  });
  return menu;
}

// ---------------------------------------------------------------- замовлення (БД)

function ordersForWeek(weekLabel) {
  const sh = sheet(SHEETS.ORDERS);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, orderHeaders().length).getValues().forEach(r => {
    if (String(r[0]) === weekLabel) map[String(r[1])] = r.slice(2, 17).map(c => CHOICES.indexOf(String(c)) !== -1 ? String(c) : NONE);
  });
  return map;
}

function upsertRow(sh, weekLabel, name, row) {
  if (sh.getLastRow() > 1) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === weekLabel && String(vals[i][1]) === name) {
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sh.appendRow(row);
}

function upsertOrder(weekLabel, name, choices, sum, contact) {
  upsertRow(sheet(SHEETS.ORDERS, true), weekLabel, name, [weekLabel, name].concat(choices).concat([sum, new Date(), contact]));
}

function logChanges(st, name, contact, parts) {
  if (!parts.length) return;
  sheet(SHEETS.LOG, true).appendRow([
    new Date(), st.weekLabel, name, contact, parts.join('; '), st.pastDeadline ? 'так' : 'ні', '',
  ]);
}

function markChangesSent() {
  const sh = sheet(SHEETS.LOG);
  if (!sh || sh.getLastRow() < 2) { SpreadsheetApp.getUi().alert('Журнал змін порожній.'); return; }
  const n = markSent('', true);
  SpreadsheetApp.getUi().alert(n ? 'Позначено переданими: ' + n + ' змін.' : 'Непереданих змін немає.');
}

/** Кількість непозначених змін (weekLabel порожній = усі тижні); write=true — ще й позначає їх «так». */
function markSent(weekLabel, write) {
  const sh = sheet(SHEETS.LOG);
  if (!sh || sh.getLastRow() < 2) return 0;
  const rng = sh.getRange(2, 1, sh.getLastRow() - 1, 7);
  const vals = rng.getValues();
  let n = 0;
  vals.forEach(r => {
    if (String(r[6]).trim() || (weekLabel && String(r[1]) !== weekLabel)) return;
    r[6] = 'так'; n++;
  });
  if (write && n) sh.getRange(2, 7, vals.length, 1).setValues(vals.map(r => [r[6]]));
  return n;
}

// ---------------------------------------------------------------- переїзд зі старої системи

/**
 * Читає лист «Імпорт»: додає нових дітей у «Список», оновлює контакти наявних
 * і переносить стартові баланси окремими рядками в «Оплати».
 *
 * Ідемпотентний: баланс дитини переноситься один раз — рядок у «Оплатах»
 * позначається коментарем IMPORT_NOTE, і повторний запуск його не дублює.
 * Результат по кожному рядку пишеться в колонку «Результат».
 */
function importFromSheet() {
  const ui = SpreadsheetApp.getUi();
  const sh = sheet(SHEETS.IMPORT);
  if (!sh || sh.getLastRow() < 2) {
    ui.alert('Лист «Імпорт» порожній.\n\nВставте туди список зі старої системи (ПІБ, клас, контакти, баланс) і запустіть пункт меню ще раз.');
    return;
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, IMPORT_HEADERS.length).getValues();
  const rosterSh = sheet(SHEETS.ROSTER, true);
  const byName = {};
  roster().forEach(k => { byName[k.name] = k; });

  // хто вже отримував стартовий баланс
  const pSh = sheet(SHEETS.PAYMENTS, true);
  const balDone = {};
  if (pSh.getLastRow() > 1) {
    pSh.getRange(2, 1, pSh.getLastRow() - 1, 4).getValues().forEach(r => {
      if (String(r[3] || '').indexOf(IMPORT_NOTE) === 0) balDone[String(r[1]).trim()] = true;
    });
  }

  const results = rows.map(() => '');
  const seen = {}, toAdd = [], toUpdate = [], toPay = [];
  let nSkip = 0, nBal = 0, sumBal = 0, nSame = 0;
  const today = new Date();

  rows.forEach((r, i) => {
    const name = String(r[0] || '').trim().replace(/\s+/g, ' ');
    if (!name) {
      if (r.slice(0, 9).some(v => String(v || '').trim())) { results[i] = '⚠ пропущено: немає ПІБ'; nSkip++; }
      return;
    }
    if (seen[name]) { results[i] = '⚠ пропущено: дубль ПІБ (рядок ' + seen[name] + ')'; nSkip++; return; }
    seen[name] = i + 2;

    const warn = [];
    let cls = String(r[1] === null || r[1] === undefined ? '' : r[1]).trim();
    if (cls && !/^[0-6]$/.test(cls)) { warn.push('клас «' + cls + '» не 0–6 → порожньо'); cls = ''; }

    const ph = [String(r[2] || '').trim(), String(r[3] || '').trim()];
    ph.forEach((v, j) => { if (v && !normPhone(v)) warn.push('телефон ' + (j + 1) + ': менше 9 цифр'); });
    const em = [String(r[4] || '').trim(), String(r[5] || '').trim()];
    em.forEach((v, j) => { if (v && !normEmail(v)) warn.push('email ' + (j + 1) + ': не схоже на адресу'); });

    let bal = 0;
    const rawBal = r[6];
    if (rawBal !== '' && rawBal !== null && rawBal !== undefined) {
      bal = Number(String(rawBal).replace(/\s/g, '').replace(',', '.'));
      if (isNaN(bal)) { warn.push('баланс «' + rawBal + '» не число → 0'); bal = 0; }
    }

    const note = String(r[7] || '').trim();
    let status = String(r[8] || '').trim().toLowerCase();
    if (status && status !== 'активний' && status !== 'архів') { warn.push('статус «' + status + '» → активний'); status = ''; }

    const old = byName[name];
    const done = [];
    if (old) {
      const cur = [old.name, old.cls, old.rawPhones[0], old.rawPhones[1], old.status,
                   old.rawEmails[0], old.rawEmails[1], old.note];
      // порожня комірка в «Імпорті» не затирає те, що вже є у «Списку»
      const merged = [name, cls || old.cls, ph[0] || old.rawPhones[0], ph[1] || old.rawPhones[1],
                      status || old.status, em[0] || old.rawEmails[0], em[1] || old.rawEmails[1], note || old.note];
      if (merged.join('\u0001') !== cur.join('\u0001')) { toUpdate.push({ row: old.row, values: merged }); done.push('оновлено у «Списку»'); }
      else { done.push('уже є, без змін'); nSame++; }
    } else {
      toAdd.push([name, cls, ph[0], ph[1], status, em[0], em[1], note]);
      byName[name] = { name: name };
      done.push('додано у «Список»');
    }

    if (bal) {
      if (balDone[name]) {
        done.push('баланс уже переносили — пропущено');
      } else {
        toPay.push([today, name, bal, IMPORT_NOTE, 'так']);
        balDone[name] = true;
        nBal++; sumBal += bal;
        done.push('баланс ' + (bal > 0 ? '+' : '') + bal + ' грн');
      }
    }

    results[i] = (warn.length ? '⚠ ' : '✅ ') + done.join('; ') + (warn.length ? ' | ' + warn.join('; ') : '');
  });

  const ok = ui.alert('Імпорт зі старої системи',
    'Рядків у листі: ' + rows.length + '\n\n' +
    'Додати дітей: ' + toAdd.length + '\n' +
    'Оновити наявних: ' + toUpdate.length + '\n' +
    'Без змін: ' + nSame + '\n' +
    'Перенести балансів: ' + nBal + ' (разом ' + (sumBal > 0 ? '+' : '') + sumBal + ' грн)\n' +
    'Пропустити: ' + nSkip + '\n\nПродовжити?', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) { ui.alert('Скасовано. У таблиці нічого не змінено.'); return; }

  if (toAdd.length) rosterSh.getRange(rosterSh.getLastRow() + 1, 1, toAdd.length, ROSTER_HEADERS.length).setValues(toAdd);
  toUpdate.forEach(u => rosterSh.getRange(u.row, 1, 1, ROSTER_HEADERS.length).setValues([u.values]));
  if (toPay.length) {
    pSh.getRange(pSh.getLastRow() + 1, 1, toPay.length, PAYMENT_HEADERS.length).setValues(toPay);
    pSh.getRange(pSh.getLastRow() - toPay.length + 1, 1, toPay.length, 1).setNumberFormat('dd.mm.yyyy');
  }
  sh.getRange(2, IMPORT_HEADERS.length, results.length, 1).setValues(results.map(v => [v]));

  refreshBalance();

  ui.alert('Імпорт завершено',
    'Додано: ' + toAdd.length + '\n' +
    'Оновлено: ' + toUpdate.length + '\n' +
    'Балансів перенесено: ' + nBal + ' (разом ' + (sumBal > 0 ? '+' : '') + sumBal + ' грн)\n' +
    'Пропущено: ' + nSkip + '\n\n' +
    'Деталі по кожному рядку — у колонці «Результат» листа «Імпорт».\n' +
    'Лист «Баланс» уже перерахований.', ui.ButtonSet.OK);
}

// ---------------------------------------------------------------- баланси

/** { ПІБ: { ordered, orderedBefore(без тижня excludeWeek), paid } } */
function computeBalances(excludeWeek) {
  const acc = {};
  const get = n => (acc[n] = acc[n] || { ordered: 0, orderedBefore: 0, paid: 0 });
  const oSh = sheet(SHEETS.ORDERS);
  if (oSh && oSh.getLastRow() > 1) {
    oSh.getRange(2, 1, oSh.getLastRow() - 1, orderHeaders().length).getValues().forEach(r => {
      const name = String(r[1]).trim();
      if (!name) return;
      const sum = Number(r[17]) || 0;
      get(name).ordered += sum;
      if (String(r[0]) !== excludeWeek) get(name).orderedBefore += sum;
    });
  }
  const pSh = sheet(SHEETS.PAYMENTS);
  if (pSh && pSh.getLastRow() > 1) {
    pSh.getRange(2, 1, pSh.getLastRow() - 1, 3).getValues().forEach(r => {
      const name = String(r[1]).trim();
      if (name) get(name).paid += Number(r[2]) || 0;
    });
  }
  return acc;
}

// ---------------------------------------------------------------- виписка за період

const WD_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const ymdKey = o => o.y * 10000 + o.mo * 100 + o.d;
const ymdStr = o => o.y + '-' + pad2(o.mo) + '-' + pad2(o.d);
function parseYmd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}
function ymdDiff(a, b) { return Math.round((Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(b.y, b.mo - 1, b.d)) / 864e5); }

/**
 * Ярлик тижня «07.09-11.09» не містить року. Відновлюємо його за датою поруч
 * (коли збережено замовлення / записано зміну): з трьох кандидатних років беремо
 * той, де ця дата — понеділок і найближча до «поруч». Переходи через Новий рік теж працюють.
 */
function mondayFromLabel(label, near) {
  const m = /^(\d{2})\.(\d{2})-/.exec(String(label || '').trim());
  if (!m) return null;
  const ref = ymdOf(near instanceof Date ? near : new Date());
  let best = null, bestScore = Infinity;
  [ref.y - 1, ref.y, ref.y + 1].forEach(y => {
    const c = { y: y, mo: +m[2], d: +m[1] };
    const score = Math.abs(ymdDiff(c, ref)) + (ymdWeekday(c) === 1 ? 0 : 10000);
    if (score < bestScore) { bestScore = score; best = c; }
  });
  return best;
}

/**
 * Виписка по дитині за [from, to]:
 *  - нарахування по днях харчування (не по даті замовлення) з фінального стану тижня;
 *  - якщо «Сума» тижня в «Замовленнях» відрізняється від розрахунку (ручна правка) — різниця
 *    окремим коригуванням в останній день тижня, тож підсумок завжди збігається з листом «Баланс»;
 *  - оплати за їхньою датою (без дати — вважаються давніми, входять у баланс на початок);
 *  - історія змін з «Журналу змін», прив'язана до дня, якого вона стосується.
 */
function buildStatement(name, from, to) {
  const days = {};
  const dayOf = ymd => (days[ymdKey(ymd)] = days[ymdKey(ymd)] ||
    { ymd: ymd, charge: 0, items: [], changes: [], fix: 0 });

  const oSh = sheet(SHEETS.ORDERS);
  if (oSh && oSh.getLastRow() > 1) {
    oSh.getRange(2, 1, oSh.getLastRow() - 1, orderHeaders().length).getValues().forEach(r => {
      if (String(r[1]).trim() !== name) return;
      const mon = mondayFromLabel(r[0], r[18]);
      if (!mon) return;
      const prices = getPrices(mon);
      let calc = 0, last = null;
      for (let d = 0; d < 5; d++) for (let m = 0; m < 3; m++) {
        const c = String(r[2 + d * 3 + m]);
        if (c !== '№1' && c !== '№2') continue;
        const ymd = ymdAdd(mon, d), price = prices[MEALS[m]] || 0, e = dayOf(ymd);
        e.charge += price; e.items.push({ meal: MEALS[m], v: c, price: price });
        calc += price; last = ymd;
      }
      const diff = (Number(r[17]) || 0) - calc;
      if (diff) { const e = dayOf(last || ymdAdd(mon, 4)); e.charge += diff; e.fix += diff; }
    });
  }

  const pays = [];
  const pSh = sheet(SHEETS.PAYMENTS);
  if (pSh && pSh.getLastRow() > 1) {
    pSh.getRange(2, 1, pSh.getLastRow() - 1, 4).getValues().forEach(r => {
      if (String(r[1]).trim() !== name) return;
      const sum = Number(r[2]) || 0;
      if (!sum) return;
      pays.push({ ymd: r[0] instanceof Date ? ymdOf(r[0]) : null, sum: sum, comment: String(r[3] || '').trim() });
    });
  }

  const lSh = sheet(SHEETS.LOG);
  if (lSh && lSh.getLastRow() > 1) {
    lSh.getRange(2, 1, lSh.getLastRow() - 1, 6).getValues().forEach(r => {
      if (String(r[2]).trim() !== name) return;
      const when = r[0] instanceof Date ? r[0] : null;
      const mon = mondayFromLabel(r[1], when);
      if (!mon) return;
      const late = String(r[5]).trim() === 'так';
      String(r[4] || '').split(/;\s*/).forEach(part => {
        const mm = /^(Пн|Вт|Ср|Чт|Пт)\s+(Сніданок|Обід|Підвечірок):\s*(.+)$/.exec(part.trim());
        if (!mm) return;
        dayOf(ymdAdd(mon, DAY_SHORT.indexOf(mm[1]))).changes.push({
          at: when ? when.getTime() : 0,
          when: when ? Utilities.formatDate(when, TZ, 'dd.MM HH:mm') : '',
          text: mm[2] + ': ' + mm[3],
          late: late,
        });
      });
    });
  }

  const fk = ymdKey(from), tk = ymdKey(to), today = ymdKey(ymdOf(new Date()));
  const label = ymd => WD_SHORT[ymdWeekday(ymd)] + ' ' + dm(ymd);
  let opening = 0;
  Object.keys(days).forEach(k => { if (+k < fk) opening -= days[k].charge; });
  pays.forEach(p => { if (!p.ymd || ymdKey(p.ymd) < fk) opening += p.sum; });

  const rows = [];
  pays.forEach(p => {
    if (!p.ymd || ymdKey(p.ymd) < fk || ymdKey(p.ymd) > tk) return;
    rows.push({ k: ymdKey(p.ymd), o: 0, kind: 'pay', date: ymdStr(p.ymd), label: label(p.ymd), amount: p.sum, comment: p.comment });
  });
  Object.keys(days).forEach(k => {
    if (+k < fk || +k > tk) return;
    const e = days[k];
    if (!e.charge && !e.changes.length) return;
    e.changes.sort((a, b) => a.at - b.at);
    rows.push({
      k: +k, o: 1, kind: 'day', date: ymdStr(e.ymd), label: label(e.ymd), amount: -e.charge,
      items: e.items, fix: e.fix, future: +k > today,
      changes: e.changes.map(c => ({ when: c.when, text: c.text, late: c.late })),
    });
  });
  rows.sort((a, b) => a.k - b.k || a.o - b.o);

  let bal = opening, paid = 0, charged = 0;
  rows.forEach(r => {
    bal += r.amount;
    r.balance = bal;
    if (r.kind === 'pay') paid += r.amount; else charged -= r.amount;
    delete r.k; delete r.o;
  });
  return {
    ok: true, name: name, from: ymdStr(from), to: ymdStr(to),
    fromLabel: dm(from) + '.' + from.y, toLabel: dm(to) + '.' + to.y,
    opening: opening, paid: paid, charged: charged, closing: bal, rows: rows,
  };
}

function statementRange(p) {
  const today = ymdOf(new Date());
  const from = parseYmd(p.from) || { y: today.y, mo: today.mo, d: 1 };
  const to = parseYmd(p.to) || today;
  if (ymdKey(from) > ymdKey(to)) return { error: 'Дата «з» пізніша за дату «по».' };
  return { from: from, to: to };
}

/** Виписка для батьків: лише для дитини, прив'язаної до контакту. p = {key, child, from, to} */
function api_statement(p) {
  try {
    p = p || {};
    const contact = resolveContact(p);
    if (!contact) return { error: 'Сесію не розпізнано. Оновіть сторінку.' };
    if (!childrenByContact(contact).some(k => k.name === p.child)) return { error: 'Ця дитина не прив’язана до вашого контакту.' };
    const rg = statementRange(p);
    if (rg.error) return rg;
    return buildStatement(p.child, rg.from, rg.to);
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

// ---------------------------------------------------------------- API для батьків

function resolveContact(p) {
  if (p.key) return contactByToken(p.key);
  if (p.contact) return normContact(p.contact);
  if (p.auto) {
    // Google віддає email лише коли користувач увійшов у акаунт того ж домену, що й власник скрипта
    try { return normEmail(Session.getActiveUser().getEmail()); } catch (e) { return null; }
  }
  return null;
}

function api_init(p) {
  try {
    p = p || {};
    const contact = resolveContact(p);
    if (!contact) {
      if (p.auto) return { needLogin: true };
      return { error: p.key ? 'Посилання недійсне. Увійдіть за телефоном або email.' : 'Введіть телефон (мінімум 9 цифр) або email.' };
    }
    const kids = childrenByContact(contact);
    if (!kids.length) {
      if (p.auto) return { needLogin: true };
      return { error: 'За цим контактом дітей не знайдено. Перевірте номер/email або зверніться до адміністратора.' };
    }
    const st = getSettings();
    if (!st.monday) return { error: 'Активний тиждень ще не налаштовано. Спробуйте пізніше.' };
    const rules = getRules();
    const perms = cellPermissions(st, rules);
    const allLocked = perms.every(pp => !pp.c && !pp.x);
    let bannerText = '';
    if (st.closed) bannerText = '🔒 Тиждень закрито адміністратором. Зміни — через чат Харчування.';
    else if (st.deadline) {
      if (!st.pastDeadline) bannerText = '⏰ Первинне замовлення — до ' + st.deadlineText;
      else if (st.mode === MODE_FORBID) bannerText = '🔒 Прийом замовлень закрито (дедлайн ' + st.deadlineText + '). Зміни — через адміністратора.';
      else if (st.mode === MODE_RULES) bannerText = 'Первинне замовлення закрито. Точкові зміни: ' + rulesSummaryText(rules) + '.';
    }
    const token = ensureToken(contact);
    const orders = ordersForWeek(st.weekLabel);
    const bal = computeBalances(st.weekLabel);
    return {
      token, contact,
      appUrl: st.appUrl,
      week: {
        label: st.weekLabel, dayLabels: st.dayLabels,
        deadlineText: st.deadlineText, bannerText: bannerText, allLocked: allLocked,
      },
      perms: perms,
      prices: getPrices(st.mondayYmd),
      menu: getMenu(),
      meals: MEALS,
      days: DAYS,
      children: kids.map(k => {
        const b = bal[k.name] || { orderedBefore: 0, paid: 0 };
        return {
          name: k.name,
          note: k.note,
          balanceStart: b.paid - b.orderedBefore, // баланс на початок тижня (без поточних замовлень)
          choices: orders[k.name] || Array(15).fill(NONE),
        };
      }),
    };
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

function api_save(p) {
  try {
    p = p || {};
    const st = getSettings();
    if (!st.monday) return { error: 'Тиждень не налаштовано.' };
    if (st.closed) return { error: 'Тиждень закрито адміністратором. Зміни — через чат Харчування.' };
    if (st.pastDeadline && st.mode === MODE_FORBID) {
      return { error: 'Прийом замовлень закрито (дедлайн ' + st.deadlineText + '). Зміни — лише через адміністратора.' };
    }
    const contact = resolveContact(p);
    if (!contact) return { error: 'Сесію не розпізнано. Оновіть сторінку.' };
    if (!childrenByContact(contact).some(k => k.name === p.child)) return { error: 'Ця дитина не прив’язана до вашого контакту.' };
    if (!Array.isArray(p.choices) || p.choices.length !== 15) return { error: 'Невірний формат замовлення.' };
    const choices = p.choices.map(c => CHOICES.indexOf(String(c)) !== -1 ? String(c) : NONE);

    const existing = ordersForWeek(st.weekLabel)[p.child] || Array(15).fill(NONE);
    const perms = cellPermissions(st, getRules());
    const problems = [];
    const cellName = i => DAY_SHORT[Math.floor(i / 3)] + ' ' + MEALS[i % 3];
    choices.forEach((nv, i) => {
      const ov = existing[i];
      if (nv === ov) return;
      const pp = perms[i];
      if (nv !== NONE && !pp.c) problems.push(cellName(i) + ': змінити можна було до ' + pp.ct);
      else if (ov !== NONE && !pp.x) problems.push(cellName(i) + ': скасувати можна було до ' + pp.xt);
    });
    if (problems.length) return { error: 'Не збережено — ці позиції вже закриті: ' + problems.join('; ') + '. Оновіть сторінку.' };

    const parts = [];
    choices.forEach((nv, i) => { if (nv !== existing[i]) parts.push(cellName(i) + ': ' + existing[i] + ' → ' + nv); });

    const prices = getPrices(st.mondayYmd);
    const sum = choices.reduce((s, c, i) => s + (c === NONE ? 0 : (prices[MEALS[i % 3]] || 0)), 0);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      upsertOrder(st.weekLabel, p.child, choices, sum, contact);
      logChanges(st, p.child, contact, parts);
      refreshBalance();
      // «Зведення» — живі формули, перебудова потрібна лише коли змінився активний тиждень
      if (summaryStale(st)) refreshSummary();
    } finally { lock.releaseLock(); }
    return { ok: true, sum };
  } catch (err) { return { error: 'Помилка збереження: ' + err.message }; }
}

// ---------------------------------------------------------------- API для адмін-панелі

function adminOk(token) {
  const st = getSettings();
  return !!(st.adminToken && token && String(token) === st.adminToken);
}

/** Порції на дату (yyyy-MM-dd): хто що отримує, для друку. */
function api_admin_today(token, dateStr, classes) {
  try {
    if (!adminOk(token)) return { error: 'Немає доступу.' };
    const st = getSettings();
    let ymd;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const s = dateStr.split('-'); ymd = { y: +s[0], mo: +s[1], d: +s[2] };
    } else ymd = ymdOf(new Date());
    const wd = ymdWeekday(ymd); // 1..5 = пн..пт
    if (wd === 0 || wd === 6) return { error: 'Вихідний день — замовлень немає.', dateStr: dateStr };
    const mondayYmd = ymdAdd(ymd, -(wd - 1));
    const label = weekLabelOf(mondayYmd);
    const dayIdx = wd - 1;
    const orders = ordersForWeek(label);
    const menu = (label === st.weekLabel) ? getMenu() : {};
    // фільтр за класами: порожній список = усі класи
    const actives = roster().filter(k => k.active);
    const pick = Array.isArray(classes) ? classes.map(c => String(c)) : [];
    const inFilter = k => !pick.length || pick.indexOf(k.cls || '') !== -1;
    const clsOf = {};
    actives.forEach(k => { clsOf[k.name] = k.cls || ''; });
    const shown = actives.filter(inFilter);
    const shownNames = {};
    shown.forEach(k => { shownNames[k.name] = true; });
    const meals = MEALS.map((meal, m) => {
      const idx = dayIdx * 3 + m;
      const variants = ['№1', '№2'].map(v => {
        const names = Object.keys(orders).filter(n => orders[n][idx] === v && shownNames[n]).sort()
          .map(n => ({ name: n, cls: clsOf[n] || '' }));
        return {
          v: v,
          desc: (menu[DAYS[dayIdx]] && menu[DAYS[dayIdx]][meal] && menu[DAYS[dayIdx]][meal][v]) || '',
          names: names,
          count: names.length,
        };
      });
      return { meal: meal, variants: variants, total: variants[0].count + variants[1].count };
    });
    // прямий зв'язок ПІБ ↔ варіант: рядок на кожну активну дитину, по всіх трьох прийомах цього дня
    const table = shown.map(k => {
      const o = orders[k.name];
      return {
        name: k.name,
        cls: k.cls || '',
        vals: [0, 1, 2].map(m => o ? o[dayIdx * 3 + m] : NONE),
        answered: !!o,
      };
    }).sort((a, b) => (a.cls || 'яяя').localeCompare(b.cls || 'яяя', 'uk') || a.name.localeCompare(b.name, 'uk'));
    // усі класи зі «Списку» — для чипів вибору у звіті
    const allClasses = [];
    actives.forEach(k => { const c = k.cls || ''; if (allClasses.indexOf(c) === -1) allClasses.push(c); });
    allClasses.sort((a, b) => (a || 'яяя').localeCompare(b || 'яяя', 'uk'));
    return {
      ok: true,
      dateStr: ymd.y + '-' + pad2(ymd.mo) + '-' + pad2(ymd.d),
      title: DAYS[dayIdx] + ' ' + dm(ymd) + '.' + ymd.y + ' · тиждень ' + label,
      meals: meals,
      table: table,
      classes: allClasses,
      picked: pick,
      answered: shown.filter(k => !!orders[k.name]).length,
      total: shown.length,
    };
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

/** Виписка для адміністратора — по будь-якій дитині зі «Списку», включно з архівом. */
function api_admin_statement(token, p) {
  try {
    if (!adminOk(token)) return { error: 'Немає доступу.' };
    p = p || {};
    const name = String(p.name || '').trim();
    if (!roster().some(k => k.name === name)) return { error: 'Оберіть дитину зі списку.' };
    const rg = statementRange(p);
    if (rg.error) return rg;
    return buildStatement(name, rg.from, rg.to);
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

function api_admin_roster(token) {
  try {
    if (!adminOk(token)) return { error: 'Немає доступу.' };
    const bal = computeBalances('');
    return {
      ok: true,
      children: roster().map(k => ({
        row: k.row, name: k.name, phone1: k.rawPhones[0], phone2: k.rawPhones[1],
        email1: k.rawEmails[0], email2: k.rawEmails[1], status: k.active ? 'активний' : 'архів', note: k.note, cls: k.cls,
        balance: bal[k.name] ? bal[k.name].paid - bal[k.name].ordered : 0,
      })),
    };
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

function api_admin_saveChild(token, c) {
  try {
    if (!adminOk(token)) return { error: 'Немає доступу.' };
    c = c || {};
    const name = String(c.name || '').trim();
    if (!name) return { error: 'ПІБ обов’язкове.' };
    const sh = sheet(SHEETS.ROSTER, true);
    const row = [name, String(c.cls || '').trim(),
      String(c.phone1 || '').trim(), String(c.phone2 || '').trim(),
      /архів/i.test(String(c.status || '')) ? 'архів' : 'активний',
      String(c.email1 || '').trim(), String(c.email2 || '').trim(), String(c.note || '').trim()];
    const r = Number(c.row) || 0;
    if (r >= 2 && r <= sh.getLastRow()) {
      // картка в панелі могла застаріти (лист відсортували / рядок видалили) — звіряємо ПІБ рядка
      const was = String(sh.getRange(r, 1).getValue() || '').trim();
      const orig = String(c.orig || '').trim();
      if (orig && was !== orig) return { error: 'Список змінився, поки картка була відкрита. Оновіть сторінку й повторіть.' };
      if (name !== was) {
        if (roster().some(k => k.name === name)) return { error: 'Дитина з таким ПІБ уже є у списку.' };
        renameEverywhere(was, name); // ПІБ — ключ: переносимо замовлення, оплати й журнал на нове ім'я
      }
      sh.getRange(r, 1, 1, row.length).setValues([row]);
    } else {
      if (roster().some(k => k.name === name)) return { error: 'Дитина з таким ПІБ уже є у списку.' };
      sh.appendRow(row);
    }
    return api_admin_roster(token);
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

/** Замінює ПІБ у «Замовленнях», «Оплатах» і «Журналі змін», щоб історія й баланс не загубилися. */
function renameEverywhere(oldName, newName) {
  if (!oldName || oldName === newName) return 0;
  let n = 0;
  [[SHEETS.ORDERS, 2], [SHEETS.PAYMENTS, 2], [SHEETS.LOG, 3]].forEach(([nm, col]) => {
    const sh = sheet(nm);
    if (!sh || sh.getLastRow() < 2) return;
    const rng = sh.getRange(2, col, sh.getLastRow() - 1, 1);
    const vals = rng.getValues();
    let changed = false;
    vals.forEach(v => { if (String(v[0]).trim() === oldName) { v[0] = newName; changed = true; n++; } });
    if (changed) rng.setValues(vals);
  });
  refreshBalance();
  return n;
}

function api_admin_addPayment(token, p) {
  try {
    if (!adminOk(token)) return { error: 'Немає доступу.' };
    p = p || {};
    const name = String(p.name || '').trim();
    const sum = Number(p.sum);
    if (!roster().some(k => k.name === name)) return { error: 'Оберіть дитину зі списку.' };
    if (!sum || isNaN(sum)) return { error: 'Сума має бути числом (не 0).' };
    let date = new Date();
    if (p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) date = Utilities.parseDate(p.date + ' 12:00', TZ, 'yyyy-MM-dd HH:mm');
    const sh = sheet(SHEETS.PAYMENTS, true);
    sh.appendRow([date, name, sum, String(p.comment || '').trim(), '']);
    const rowIdx = sh.getLastRow();
    refreshBalance();
    const sent = notifyPayment(name, sum, date);
    if (sent) sh.getRange(rowIdx, 5).setValue('так');
    const b = computeBalances('')[name] || { ordered: 0, paid: 0 };
    return { ok: true, balance: b.paid - b.ordered, emailed: sent };
  } catch (err) { return { error: 'Помилка: ' + err.message }; }
}

// ---------------------------------------------------------------- email (другорядне)

function sendMail(to, subject, body) {
  if (!to || !to.length) return false;
  try {
    MailApp.sendEmail({ to: to.join(','), subject: subject, body: body, name: 'Шкільне харчування' });
    return true;
  } catch (e) { return false; }
}

function notifyPayment(name, sum, date) {
  const to = familyEmails(name);
  if (!to.length) return false;
  const b = computeBalances('')[name] || { ordered: 0, paid: 0 };
  const balance = b.paid - b.ordered;
  return sendMail(to, 'Оплату зараховано: ' + name,
    'Доброго дня!\n\nЗараховано оплату ' + sum + ' грн за харчування (' + name + '), дата ' +
    Utilities.formatDate(date, TZ, 'dd.MM.yyyy') + '.\n' +
    'Поточний баланс: ' + (balance >= 0 ? '+' : '') + balance + ' грн.\n\nДякуємо!');
}

/** Надсилає всім сім’ям з email їхній баланс (пункт меню). */
function sendBalanceEmails() {
  const st = getSettings();
  const bal = computeBalances('');
  let n = 0;
  roster().filter(k => k.active && k.emails.length).forEach(k => {
    const b = bal[k.name] || { ordered: 0, paid: 0 };
    const balance = b.paid - b.ordered;
    const link = linkFor(st, ensureToken(k.emails[0]));
    if (sendMail(k.emails, 'Баланс харчування: ' + k.name,
      'Доброго дня!\n\n' + k.name + ':\n  замовлено всього: ' + b.ordered + ' грн\n  оплачено: ' + b.paid +
      ' грн\n  баланс: ' + (balance >= 0 ? '+' : '') + balance + ' грн' +
      (balance < 0 ? '\n\nПросимо поповнити баланс.' : '') +
      (link ? '\n\nЗамовлення: ' + link : '') + '\n\nДякуємо!')) n++;
  });
  SpreadsheetApp.getUi().alert('Надіслано листів: ' + n + '.');
}

/** Щогодинний тригер: за N годин до дедлайну нагадує тим, хто ще не замовив. */
function reminderTick() {
  const st = getSettings();
  if (!st.deadline || st.closed) return;
  const now = new Date();
  const from = new Date(st.deadline.getTime() - st.remindHours * 3600e3);
  if (now < from || now > st.deadline) return;
  const props = PropertiesService.getScriptProperties();
  const key = 'reminded_' + st.weekLabel;
  if (props.getProperty(key)) return;
  const orders = ordersForWeek(st.weekLabel);
  const byEmail = {};
  roster().filter(k => k.active && !orders[k.name]).forEach(k => {
    k.emails.forEach(e => { (byEmail[e] = byEmail[e] || []).push(k.name); });
  });
  Object.keys(byEmail).forEach(e => {
    const link = linkFor(st, ensureToken(e));
    sendMail([e], 'Нагадування: замовлення харчування на тиждень ' + st.weekLabel,
      'Доброго дня!\n\nЩе не зроблено замовлення на тиждень ' + st.weekLabel + ' для: ' + byEmail[e].join(', ') +
      '.\nПрийом первинних замовлень — до ' + st.deadlineText + '.' +
      (link ? '\n\nЗамовити: ' + link : '') + '\n\nДякуємо!');
  });
  props.setProperty(key, new Date().toISOString());
}

/** Тригер onEdit: оплата вписана вручну в «Оплати» → лист сім’ї. */
function onPaymentEdit(e) {
  try {
    const sh = e && e.range && e.range.getSheet();
    if (!sh || sh.getName() !== SHEETS.PAYMENTS) return;
    const r = e.range.getRow();
    if (r < 2) return;
    const vals = sh.getRange(r, 1, 1, 5).getValues()[0];
    const date = vals[0], name = String(vals[1] || '').trim(), sum = Number(vals[2]);
    if (!(date instanceof Date) || !name || !sum || String(vals[4] || '').trim()) return;
    if (notifyPayment(name, sum, date)) sh.getRange(r, 5).setValue('так');
  } catch (err) { /* тихо: тригер не має падати */ }
}

function installTriggers() {
  const have = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  if (have.indexOf('reminderTick') === -1) ScriptApp.newTrigger('reminderTick').timeBased().everyHours(1).create();
  if (have.indexOf('onPaymentEdit') === -1) ScriptApp.newTrigger('onPaymentEdit').forSpreadsheet(ss()).onEdit().create();
  SpreadsheetApp.getUi().alert(
    'Увімкнено:\n• щогодинна перевірка і нагадування на email за ' + getSettings().remindHours +
    ' год до дедлайну тим, хто не замовив;\n• лист сім’ї після внесення оплати в «Оплати».\n\n' +
    'Email беруться з колонок «Email 1/2» листа «Список».');
}

// ---------------------------------------------------------------- зведення і баланс

/** «Зведення» зібране під інший тиждень (адмін змінив понеділок) або ще не створене. */
function summaryStale(st) {
  const sh = sheet(SHEETS.SUMMARY);
  if (!sh || sh.getLastRow() === 0) return true;
  return String(sh.getRange(1, 1).getDisplayValue()).trim() !== String(st.dayLabels[0] || '').trim();
}

function refreshAll() {
  refreshSummary();
  refreshBalance();
}

/**
 * «Зведення» — аркуш для передачі кейтерингу: лише кількість порцій.
 * Вигляд той самий, що й «Підрахунки» у шкільній таблиці: 5 блоків «День | Підрахунки»
 * поруч, у кожному — Сніданок/Обід/Підвечірок по варіантах №1/№2.
 * Числа не записуються скриптом, а рахуються формулами COUNTIFS по листу «Замовлення»,
 * тому оновлюються самі, щойно батьки змінюють замовлення.
 */
function colLetter(n) {
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = (n - r - 1) / 26; }
  return out;
}

/**
 * Сітка «Зведення»: 5 блоків «День | Підрахунки».
 * counts = null → формули COUNTIFS (живий лист у нашій таблиці);
 * counts = [15 × {'№1': n, '№2': n}] → готові числа (для передачі в чужу таблицю).
 */
function summaryGrid(st, counts) {
  const BLOCK_W = 2, GAP = 1, STRIDE = BLOCK_W + GAP; // колонки на день + вузька колонка-роздільник
  const ORD = "'" + SHEETS.ORDERS + "'";              // лист-джерело для формул
  const grid = [];
  const put = (r, c, v) => { grid[r] = grid[r] || []; grid[r][c] = v; };

  DAYS.forEach((day, d) => {
    const c0 = d * STRIDE;
    put(0, c0, st.dayLabels[d] || day);
    put(0, c0 + 1, 'Підрахунки');
    let r = 1;
    MEALS.forEach((meal, m) => {
      put(r, c0, meal); r++;
      // колонка вибору в «Замовленнях»: C = Пн Сніданок, далі по три на день
      const col = colLetter(3 + d * 3 + m);
      ['№1', '№2'].forEach(v => {
        put(r, c0, meal + ' ' + v);
        put(r, c0 + 1, counts ? (counts[d * 3 + m][v] || 0)
          : '=COUNTIFS(' + ORD + '!$A:$A,"' + st.weekLabel + '",' + ORD + '!' + col + ':' + col + ',"' + v + '")');
        r++;
      });
    });
  });

  const cols = 5 * STRIDE - 1;
  return grid.map(r => { const a = (r || []).slice(0, cols); while (a.length < cols) a.push(''); return a; });
}

function formatSummary(sh, cols) {
  const GREEN = '#93c47d', PEACH = '#fce5cd', STRIDE = 3;
  for (let d = 0; d < 5; d++) {
    const c0 = d * STRIDE + 1; // 1-indexed колонка «День»
    sh.getRange(1, c0).setBackground(GREEN).setFontWeight('bold').setFontStyle('italic');
    sh.getRange(1, c0 + 1).setFontWeight('bold');
    [2, 5, 8].forEach(r => sh.getRange(r, c0).setBackground(PEACH).setFontWeight('bold').setFontStyle('italic'));
    [3, 4, 6, 7, 9, 10].forEach(r => sh.getRange(r, c0).setFontWeight('bold').setFontStyle('italic'));
  }
  sh.setColumnWidths(1, cols, 92);
  for (let d = 0; d < 4; d++) sh.setColumnWidth(d * STRIDE + 3, 18); // вузькі роздільники
  sh.setFrozenRows(1);
}

/** Кількість порцій тижня по кожному з 15 прийомів — так само, як рахують формули «Зведення». */
function countsForWeek(weekLabel) {
  const counts = [];
  for (let i = 0; i < 15; i++) counts.push({ '№1': 0, '№2': 0 });
  const orders = ordersForWeek(weekLabel);
  Object.keys(orders).forEach(n => orders[n].forEach((c, i) => { if (counts[i][c] !== undefined) counts[i][c]++; }));
  return counts;
}

function refreshSummary() {
  const st = getSettings();
  const sh = sheet(SHEETS.SUMMARY, true);
  sh.clear();
  if (!st.monday) { sh.getRange(1, 1).setValue('Тиждень не налаштовано.'); return; }
  const g = summaryGrid(st, null);
  sh.getRange(1, 1, g.length, g[0].length).setValues(g);
  formatSummary(sh, g[0].length);
}

function refreshBalance() {
  const sh = sheet(SHEETS.BALANCE, true);
  sh.clearContents();
  const bal = computeBalances('');
  const names = Object.keys(bal).sort();
  const out = [['ПІБ', 'Замовлено, грн', 'Оплачено, грн', 'Баланс, грн']];
  names.forEach(n => out.push([n, bal[n].ordered, bal[n].paid, bal[n].paid - bal[n].ordered]));
  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.setFrozenRows(1);
}

// ---------------------------------------------------------------- передача кейтерингу (ручний запуск)

// мітка в нотатці A1 листів, які створила ця система в чужій таблиці: лише їх дозволено перезаписувати
const EXPORT_MARK = 'Створено системою «Харчування Онлайн»';

/** Назва листа з налаштувань: порожньо → типова, «ні» / «—» → не передавати. */
function exportTabName(v, def) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (/^(ні|—|-|no)$/i.test(s)) return '';
  return s || def;
}

function fillWeek(tpl, st) { return String(tpl || '').replace(/\{тиждень\}/g, st.weekLabel).trim(); }

function openTarget(urlOrId) {
  const v = String(urlOrId || '').trim();
  return v.indexOf('/d/') !== -1 ? SpreadsheetApp.openByUrl(v) : SpreadsheetApp.openById(v);
}

function isOurTab(sh) {
  try { return String(sh.getRange(1, 1).getNote() || '').indexOf(EXPORT_MARK) === 0; } catch (e) { return false; }
}

/** Таблиця для кейтерингу: № | ПІБ | Клас | 15 виборів | Примітка (алергії тощо). */
function kidsGrid(st) {
  const orders = ordersForWeek(st.weekLabel);
  const byName = {};
  roster().forEach(k => { byName[k.name] = k; });
  // активні діти + ті, в кого є замовлення на тиждень (навіть якщо вже в архіві) — щоб збігалося зі «Зведенням»
  const names = Object.keys(byName).filter(n => byName[n].active);
  Object.keys(orders).forEach(n => { if (names.indexOf(n) === -1) names.push(n); });
  const clsOf = n => (byName[n] && byName[n].cls) || '';
  names.sort((a, b) => (clsOf(a) || 'яяя').localeCompare(clsOf(b) || 'яяя', 'uk') || a.localeCompare(b, 'uk'));
  const head = ['№', 'ПІБ', 'Клас'].concat(orderHeaders().slice(2, 17)).concat(['Примітка']);
  return [head].concat(names.map((n, i) => [i + 1, n, clsOf(n)]
    .concat(orders[n] || Array(15).fill(NONE))
    .concat([(byName[n] && byName[n].note) || ''])));
}

function formatKids(sh, g) {
  const W = g[0].length;
  sh.getRange(1, 1, 1, W).setFontWeight('bold').setBackground('#93c47d');
  if (g.length > 1) {
    const bg = g.slice(1).map(r => r.map((v, j) => (j >= 3 && j < 18)
      ? (v === '№1' ? '#fde3c8' : v === '№2' ? '#d9ead3' : null) : null));
    sh.getRange(2, 1, g.length - 1, W).setBackgrounds(bg);
  }
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 36);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 50);
  sh.setColumnWidths(4, 15, 92);
  sh.setColumnWidth(W, 320);
}

/**
 * Пункт меню: копіює «Зведення» (числами) і замовлення по дітях активного тижня в таблицю кейтерингу.
 * Пише лише в листи, які створила сама (мітка в нотатці A1) або яких ще немає, — чужі дані не чіпає.
 */
function exportToCatering() {
  const ui = SpreadsheetApp.getUi();
  const st = getSettings();
  if (!st.monday) { ui.alert('Спочатку вкажіть «Понеділок тижня (дата)» в «Налаштуваннях».'); return; }
  if (!st.cateringUrl) {
    ui.alert('Не вказано таблицю кейтерингу.\n\n«Налаштування» → «Кейтеринг: таблиця (посилання)» — вставте посилання на їхню Google-таблицю.\n' +
      'Якщо цього рядка немає — спершу запустіть пункт меню 1.');
    return;
  }
  const plan = [
    { kind: 'summary', name: fillWeek(st.cateringSummaryTab, st), what: 'кількість порцій' },
    { kind: 'kids', name: fillWeek(st.cateringKidsTab, st), what: 'замовлення по дітях' },
  ].filter(t => t.name);
  if (!plan.length) { ui.alert('Обидва листи для передачі вимкнені («ні») у «Налаштуваннях».'); return; }
  if (plan.length === 2 && plan[0].name === plan[1].name) { ui.alert('Назви листів для зведення і для дітей однакові — зробіть їх різними.'); return; }

  let target;
  try { target = openTarget(st.cateringUrl); }
  catch (e) {
    ui.alert('Не вдалося відкрити таблицю кейтерингу:\n' + e.message + '\n\nПеревірте посилання і що акаунт ' +
      Session.getEffectiveUser().getEmail() + ' має до неї доступ «Редактор».');
    return;
  }
  if (target.getId() === ss().getId()) { ui.alert('Посилання веде на цю саму таблицю. Вкажіть таблицю кейтерингу.'); return; }

  plan.forEach(t => { const sh = target.getSheetByName(t.name); t.exists = !!sh; t.ours = !sh || isOurTab(sh); });
  const foreign = plan.filter(t => !t.ours);
  if (foreign.length) {
    ui.alert('Передачу зупинено',
      'У таблиці «' + target.getName() + '» уже є ' + foreign.map(t => '«' + t.name + '»').join(', ') +
      ' — цей лист створено не нашою системою, тому перезаписувати його не буду, щоб не зіпсувати чужі дані.\n\n' +
      'Змініть назву листа в «Налаштуваннях» (наприклад, додайте «{тиждень}») або перейменуйте той лист у таблиці кейтерингу.',
      ui.ButtonSet.OK);
    return;
  }

  const ok = ui.alert('Передати кейтерингу',
    'Таблиця: ' + target.getName() + '\nТиждень: ' + st.weekLabel + '\n\n' +
    plan.map(t => '• «' + t.name + '» — ' + t.what + ' — ' + (t.exists ? 'буде оновлено' : 'буде створено')).join('\n') +
    '\n\nІнші листи їхньої таблиці не змінюються. Продовжити?', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  const stamp = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm');
  plan.forEach(t => {
    const sh = target.getSheetByName(t.name) || target.insertSheet(t.name);
    sh.clear();
    const g = t.kind === 'summary' ? summaryGrid(st, countsForWeek(st.weekLabel)) : kidsGrid(st);
    sh.getRange(1, 1, g.length, g[0].length).setValues(g);
    if (t.kind === 'summary') formatSummary(sh, g[0].length); else formatKids(sh, g);
    sh.getRange(1, 1).setNote(EXPORT_MARK + '\nТиждень ' + st.weekLabel + '\nОновлено ' + stamp +
      '\nЛист перезаписується при кожній передачі — не вносьте сюди власних правок.');
  });

  const pending = markSent(st.weekLabel, false);
  const done = 'Передано в «' + target.getName() + '»: ' + plan.map(t => '«' + t.name + '»').join(', ') + '.\n' + target.getUrl();
  if (pending) {
    const r = ui.alert('Готово', done + '\n\nУ «Журналі змін» ' + pending + ' непозначених змін за цей тиждень — ' +
      'вони вже враховані в переданих даних. Позначити їх як передані?', ui.ButtonSet.YES_NO);
    if (r === ui.Button.YES) markSent(st.weekLabel, true);
  } else ui.alert('Готово', done, ui.ButtonSet.OK);
}

// ---------------------------------------------------------------- веб-додаток


// ---------------------------------------------------------------- демо для показу в школі (одноразово)

/**
 * Додає в «Список» дітей зі шкільного джерела, яких там ще нема (за ПІБ, без дублів).
 * Безпечно перезапускати — вже наявні імена пропускаються. Видаліть цю функцію й
 * SCHOOL_IMPORT після демо, вони більше не потрібні.
 */
const SCHOOL_IMPORT = [
  ['Репак Дарина', ''],
  ['Зелик Данило', ''],
  ['Паламар Матвій', 'Завжди повне автоматичне'],
  ['Наганда Вероніка Василівна', ''],
  ['Марк Черниш', 'Не харчується'],
  ['Кузнєцов Денис', 'Завжди сніданок уточнити в мами. не харчується. Обід за наш рахунок.'],
  ['Рибалко Ніла Сергіївна', 'Алергія! Власне!'],
  ['Миронів Остап Віталійович', 'Обирають'],
  ['Остоверх Макар', 'Повне'],
  ['Теодор Савін', 'Обирають'],
  ['Синяк Дамір Дмитрович', ''],
  ['Аболмасова Мирослава', 'Своє харчування'],
  ['Корчагін-Крістенсен Іларій', ''],
  ['Кутейко Соломія', ''],
  ['Кацедан Емілія', 'Завжди повне. 2 семестр обирають'],
  ['Ніколаєв Максим Дмитрович', 'Завжди повне. 2 семестр обирають'],
  ['Ткач Мирослава', 'Завжди повне. але потім ще обирають'],
  ['Купрієнко Єва', 'Завжди повне.'],
  ['Мандзюк Андрій', ''],
  ['Ощепкова Ксенія', 'Завжди повне.'],
  ['Ковальова Рута', ''],
  ['Тетеря Анна', 'Завжди повне. Не буде до 19 січня'],
  ['Цілюрик Лук\'ян', 'Обирають'],
  ['Лазуренко Данило', 'Пишуть коли потрібно'],
  ['Амірова Кіра Євгенівна', 'Завжди повне'],
  ['Мазурик Вероніка Назарівна', 'Завжди повне'],
  ['Кузнєцов Назар', 'Обирають'],
  ['Осипов Домінік', ''],
  ['Перогей Анна', 'обирають, має алегрію на арахіс, ківі, селеру, уточнити в кейтерингу'],
  ['Перогей Лада', 'не харчується'],
  ['Луць Лука', 'т'],
  ['Сорокін Роман', 'Завжди повне. 2 семестр обирають'],
  ['Комар Ярослава', 'завжди повне'],
  ['Кулик Василіса', ''],
  ['Мельникович Катерина', 'завжди повне.Тепер обирає'],
  ['Черниш Божена', 'Завжди повне.'],
  ['Бондаренко Максим', 'завжди обіди'],
  ['Мосієнко Вероніка', 'Автоматично обід та підвеч (потім корегують), завжди без сніданків,'],
  ['Вялов Олексій', 'Завжди обіди!'],
  ['Костенко Святослав', 'Завжди повне.'],
  ['Романова Вероніка', 'Обирають'],
  ['Шляхов Ярослав', 'завжди обід5 клас (Без Хліба)'],
  ['Войцех Анна', 'тепер обирають'],
  ['Сухарєва Марія', ''],
  ['Устименко Кирило', ''],
  ['Бляшенко Злата', ''],
  ['Амірова Олівія', ''],
  ['Пелещишин Вікторія', ''],
  ['Радик Андріана', ''],
  ['Чуб Марк', ''],
  ['Моря Марк', ''],
  ['Чекан Марк', ''],
  ['Озкан Сеїт Мікаіл', ''],
  ['Мосієнко Валерія Романівна', ''],
  ['Марк 0 клас', ''],
  ['Роберт 2 клас', ''],
  ['Тимур 2 клас', ''],
  ['Емілія 2 клас', ''],
  ['Максим 3 клас', ''],
  ['Роман (4клас)', ''],
  ['Сахнюк Марк (4 клас)', ''],
];

function seedRosterDemo() {
  const sh = sheet(SHEETS.ROSTER, true);
  const have = {};
  roster().forEach(k => { have[k.name.trim().toLowerCase()] = true; });
  const toAdd = SCHOOL_IMPORT.filter(r => !have[r[0].trim().toLowerCase()]);
  // ПІБ | Клас | Телефон 1 | Телефон 2 | Статус | Email 1 | Email 2 | Примітка
  toAdd.forEach(r => sh.appendRow([r[0], '', '', '', 'активний', '', '', r[1]]));
  SpreadsheetApp.getUi().alert('Додано дітей: ' + toAdd.length + ' (пропущено як дублі: ' + (SCHOOL_IMPORT.length - toAdd.length) + ').');
}

/**
 * Генерує правдоподібні тестові замовлення на поточний активний тиждень (з «Налаштувань»)
 * для дітей, у яких на цей тиждень ще немає збереженого замовлення — існуючі (в т.ч. ваші
 * ручні тестові) не чіпає. Безпечно перезапускати. Видаліть після демо.
 */
function seedDemoOrders() {
  const st = getSettings();
  if (!st.monday) { SpreadsheetApp.getUi().alert('Спочатку вкажіть понеділок тижня в «Налаштуваннях».'); return; }
  const existing = ordersForWeek(st.weekLabel);
  const prices = getPrices(st.mondayYmd);
  const kids = roster().filter(k => k.active && !existing[k.name]);
  // один пакетний запис замість appendRow на кожну дитину — інакше на ~50+ дітях
  // послідовне сканування листа в upsertOrder перевищує 6-хвилинний ліміт виконання
  const rows = [];
  kids.forEach(k => {
    if (Math.random() > 0.85) return; // приблизно 15 відсотків ще «не відповіли» — правдоподібно для демо
    const choices = [];
    for (let i = 0; i < 15; i++) {
      const roll = Math.random();
      choices.push(roll < 0.42 ? '№1' : roll < 0.82 ? '№2' : NONE);
    }
    const sum = choices.reduce((s, c, i) => s + (c === NONE ? 0 : (prices[MEALS[i % 3]] || 0)), 0);
    const contact = k.phones[0] || k.emails[0] || '';
    rows.push([st.weekLabel, k.name].concat(choices).concat([sum, new Date(), contact]));
  });
  if (rows.length) {
    const sh = sheet(SHEETS.ORDERS, true);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  refreshAll();
  SpreadsheetApp.getUi().alert('Згенеровано замовлень: ' + rows.length + ' на тиждень ' + st.weekLabel + '.');
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const admin = String(params.admin || '').replace(/[^A-Za-z0-9]/g, '');
  if (admin && adminOk(admin)) {
    const a = HtmlService.createTemplateFromFile('Admin');
    a.admin = admin;
    return a.evaluate().setTitle('Адмін · Харчування')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.key = String(params.key || '').replace(/[^A-Za-z0-9]/g, '');
  return t.evaluate()
    .setTitle('Замовлення харчування')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
