// dates.js — KST 달력 날짜 유틸 (순수 함수, DOM·외부 의존 없음)
// 날짜 문자열은 모두 'YYYY-MM-DD' (한국 시간 기준 달력 날짜).
// 잘못된 날짜가 들어오면 날짜를 반환하는 함수는 null, 숫자를 반환하는 함수는 NaN 을 돌려준다.

export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

const DAY_MS = 86400000;
const KST_OFFSET_MS = 9 * 3600000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fromUTCms(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' → [y, m, d] (실존 날짜만), 아니면 null */
function splitYMD(s) {
  if (typeof s !== 'string') return null;
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  if (d > lastDayOfMonth(y, mo)) return null;
  return [y, mo, d];
}

/** 그 날짜 00:00 UTC 의 epoch ms (날짜 산술 전용), 잘못되면 NaN */
function toUTCms(ymd) {
  const p = splitYMD(ymd);
  if (!p) return NaN;
  return Date.UTC(p[0], p[1] - 1, p[2]);
}

export function lastDayOfMonth(year, month) {
  // month: 1..12. Date.UTC(year, month, 0) = 그 달의 마지막 날
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

export function todayKST(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(t)) return null;
  return fromUTCms(t + KST_OFFSET_MS);
}

export function isValidYMD(s) {
  return splitYMD(s) !== null;
}

export function addDays(ymd, n) {
  const t = toUTCms(ymd);
  if (Number.isNaN(t)) return null;
  return fromUTCms(t + Math.trunc(Number(n) || 0) * DAY_MS);
}

/** to - from (일) */
export function daysBetween(from, to) {
  const a = toUTCms(from);
  const b = toUTCms(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / DAY_MS);
}

/** 0=일 .. 6=토 */
export function weekdayOf(ymd) {
  const t = toUTCms(ymd);
  if (Number.isNaN(t)) return NaN;
  return new Date(t).getUTCDay();
}

/** 그 주(월~일)의 월요일 */
export function startOfWeek(ymd) {
  const wd = weekdayOf(ymd);
  if (Number.isNaN(wd)) return null;
  return addDays(ymd, -((wd + 6) % 7));
}

/** 그 날 00:00 KST 를 UTC ISO 문자열로. 예: '2026-10-12' → '2026-10-11T15:00:00.000Z' */
export function kstMidnightISO(ymd) {
  const t = toUTCms(ymd);
  if (Number.isNaN(t)) return null;
  return new Date(t - KST_OFFSET_MS).toISOString();
}

/** 순간(ISO 문자열) → KST 날짜 */
export function toKSTDate(isoString) {
  if (isoString === null || isoString === undefined || isoString === '') return null;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return null;
  return fromUTCms(t + KST_OFFSET_MS);
}

/** today 제외, 가장 가까운 요일 wd(0..6) */
export function nextWeekday(today, wd) {
  const cur = weekdayOf(today);
  if (Number.isNaN(cur)) return null;
  const diff = ((Number(wd) - cur) % 7 + 7) % 7 || 7;
  return addDays(today, diff);
}

/** weekOffset 0=이번 주(월~일), 1=다음 주, 2=다다음 주. wd 0=일요일은 그 주의 마지막 날 */
export function weekdayInWeek(today, wd, weekOffset = 0) {
  const mon = startOfWeek(today);
  if (!mon) return null;
  const idx = (Number(wd) + 6) % 7; // 월=0 .. 일=6
  return addDays(mon, Number(weekOffset || 0) * 7 + idx);
}

/**
 * 연도 없는 월/일 → 올해, 이미 지났으면(< today) 내년. 오늘은 지난 것이 아니다.
 * 결정된 해에 그 날짜가 없으면 null (예: 2/30, 평년의 2/29).
 */
export function resolveMonthDay(today, month, day) {
  const p = splitYMD(today);
  if (!p) return null;
  const mo = Number(month);
  const d = Number(day);
  if (!Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const [ty, tm, td] = p;
  const year = mo < tm || (mo === tm && d < td) ? ty + 1 : ty;
  if (d > lastDayOfMonth(year, mo)) return null;
  return `${String(year).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
}

/** '10/20(화) · D-6' / 오늘 'D-day' / 지남 'D+n' */
export function formatDue(due, today) {
  const p = splitYMD(due);
  if (!p) return '';
  const n = daysBetween(today, due);
  let tag;
  if (Number.isNaN(n)) tag = '';
  else if (n > 0) tag = `D-${n}`;
  else if (n === 0) tag = 'D-day';
  else tag = `D+${-n}`;
  const head = `${p[1]}/${p[2]}(${WEEKDAY_KO[weekdayOf(due)]})`;
  return tag ? `${head} · ${tag}` : head;
}

// ---------------------------------------------------------------------------
// 반복 규칙
// Rule = {kind:'daily'} | {kind:'weekdays'} | {kind:'weekly', weekday:0..6} | {kind:'monthly', day:1..31}

export function formatRecurrence(rule) {
  if (!rule || typeof rule !== 'object') return '';
  switch (rule.kind) {
    case 'daily':
      return '매일';
    case 'weekdays':
      return '평일';
    case 'weekly':
      return `매주 ${WEEKDAY_KO[rule.weekday] ?? ''}`.trim();
    case 'monthly':
      return `매월 ${rule.day}일`;
    default:
      return '';
  }
}

export function parseRecurrenceValue(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^매일(?: ?마다)?$/.test(s)) return { kind: 'daily' };
  if (/^(?:평일|평일 ?마다|매 ?평일)$/.test(s)) return { kind: 'weekdays' };
  let m = /^매주 ?([일월화수목금토])(?:요일)?(?: ?마다)?$/.exec(s);
  if (m) return { kind: 'weekly', weekday: WEEKDAY_KO.indexOf(m[1]) };
  m = /^매월 ?(\d{1,2}) ?일(?: ?마다)?$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return { kind: 'monthly', day };
  }
  return null;
}

/** monthly: day > 그 달 말일이면 말일에 true. weekdays = 월~금 */
export function isRecurrenceDue(rule, ymd) {
  const p = splitYMD(ymd);
  if (!p || !rule) return false;
  const wd = weekdayOf(ymd);
  switch (rule.kind) {
    case 'daily':
      return true;
    case 'weekdays':
      return wd >= 1 && wd <= 5;
    case 'weekly':
      return wd === Number(rule.weekday);
    case 'monthly': {
      const day = Number(rule.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) return false;
      return p[2] === Math.min(day, lastDayOfMonth(p[0], p[1]));
    }
    default:
      return false;
  }
}
