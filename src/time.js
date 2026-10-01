// Час і форматування. Увесь час — у часовому поясі Europe/Kyiv, локаль uk-UA.
export const TZ = 'Europe/Kyiv';
export const LOCALE = 'uk-UA';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Розбирає unix-секунди на компоненти київського календаря. */
export function kyivParts(sec) {
  const p = Object.fromEntries(
    partsFmt.formatToParts(new Date(sec * 1000)).map((x) => [x.type, +x.value]),
  );
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}

/** Зсув Києва відносно UTC (секунди) у момент `sec`. */
function offsetAt(sec) {
  const p = kyivParts(sec);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000 - sec;
}

/** Unix-секунди північі Києва для календарної дати (y, m, d); d може виходити за межі місяця. */
export function kyivMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d) / 1000;
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // уточнення на межі переходу
  return t;
}

/** Початок київського дня, що містить `sec`. */
export function dayStart(sec) {
  const p = kyivParts(sec);
  return kyivMidnight(p.y, p.m, p.d);
}

/** Початок дня через `n` календарних днів (не +86400·n: у дні переходу доба 23 або 25 год). */
export function addDays(sec, n) {
  const p = kyivParts(sec);
  return kyivMidnight(p.y, p.m, p.d + n);
}

/** Понеділок тижня, що містить `sec`. */
export function weekStart(sec) {
  const p = kyivParts(sec);
  const dow = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
  return kyivMidnight(p.y, p.m, p.d - dow);
}

const fmt = (opts) => new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...opts });
const dayFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFmt = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateTimeFmt = fmt({
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const formatDay = (sec) => dayFmt.format(sec * 1000);
export const formatShortDay = (sec) => shortDayFmt.format(sec * 1000);
export const formatTime = (sec) => timeFmt.format(sec * 1000);
export const formatDateTime = (sec) => dateTimeFmt.format(sec * 1000);
export const weekdayShort = (sec) => fmt({ weekday: 'short' }).format(sec * 1000);

/** «08:30» з секунд від півночі (поле periods[].start_at). */
export function clock(secOfDay) {
  const h = Math.floor(secOfDay / 3600);
  const m = Math.floor((secOfDay % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const rules = new Intl.PluralRules('uk');
/** Множина: plural(5, {one:'завдання', few:'завдання', many:'завдань'}) → «5 завдань». */
export function plural(n, forms) {
  return `${n} ${forms[rules.select(n)] ?? forms.many}`;
}

/** Номер ISO-тижня київської дати, що містить `sec` (метод четверга). */
export function isoWeek(sec) {
  const p = kyivParts(sec);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + 1) / 7);
}

/** День тижня київської дати: 1 = понеділок … 7 = неділя. */
export function isoWeekday(sec) {
  const p = kyivParts(sec);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() || 7;
}
