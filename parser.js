// parser.js — 입력 문장 해석 · 본문 형식 · 그룹 분류 (순수 함수, DOM 없음, dates.js 만 import)

import {
  WEEKDAY_KO,
  todayKST,
  isValidYMD,
  addDays,
  daysBetween,
  nextWeekday,
  weekdayInWeek,
  resolveMonthDay,
  startOfWeek,
  kstMidnightISO,
  formatRecurrence,
} from './dates.js';

export const SOS_COMMENT =
  '@claude 이 할 일을 /todo-stuck 기준으로 진단하고, 하위 작업 3~7개를 본문 체크리스트로 반영하고, 첫 행동을 답글로 알려줘. stuck 라벨이 있으면 제거해줘.';
export const COMPLETE_COMMENT = '완료: 홈페이지에서 처리';
export const DEFAULT_MEMO = '홈페이지에서 등록';

// ---------------------------------------------------------------------------
// 경고 문구
const W_EMPTY = '할 일 내용이 없습니다';
const W_PAST = '이미 지난 날짜입니다';
const W_COMPLETE_NEXT = '완료 문장의 다음 단계는 무시했습니다';

// ---------------------------------------------------------------------------
// 공통 정규식

// 끝 문장부호(판정 전 제거): 공백 . ! ? ~ 。 , …  (+ 전각 변형)
// 정규식 `[…]+$` 는 긴 입력에서 역추적이 제곱으로 늘어나므로(이슈 본문 `다음:` 값 등) 뒤에서부터 도는 루프로 지운다.
const TRAILING_PUNCT = new Set([...'.!?~。,…！？～，']);
// 다음 단계 구분자: → / -> / 다음:
const NEXT_SEP_RE = /→|->|다음\s*[:：]/;

// 끝 표현 (끝 고정이므로 정규식 엔진이 가장 앞에서 시작하는 = 가장 긴 표현을 고른다)
const COMPLETE_END_RE =
  /(?:완료했어|완료했음|완료함|완료|끝났어|끝났음|끝남|끝|다\s?했어|다\s?했음|했음|(?<![a-z0-9])done)$/i;
const WAIT_END_RE = /(?:기다리는\s?중|대기\s?중|대기)$/;
const REGISTER_END_RE = /(?:해야\s?(?:함|해|됨|돼)|할\s?것|하기|필요|예정)$/;

// 반복: 매일 | 평일마다 | 매주 X요일 | 매월 N일 (문장 어디든)
const RECUR_RE =
  /(?<![가-힣])(?:(매일)(?:매일)?(?:\s?마다)?|(평일마다)|매주\s*([월화수목금토일])요일(?:마다|까지|에)?|매월\s*(\d{1,2})\s*일(?:마다|까지|에)?)/;

// AI 분해 요청
const DECOMPOSE_RE = /쪼개서|단계별로/;
const DECOMPOSE_RE_G = /쪼개서|단계별로/g;

// 프로젝트 [코드]
const PROJECT_RE_G = /\[\s*([^[\]\s,]{1,40})\s*\]/g;

// 예상 소요: N시간 N분 | N시간 반 | N시간 | N분  (3분기 같은 단어는 제외)
// 앞의 '약 '과 뒤의 '정도·쯤·가량'(띄어 써도)은 함께 제거한다.
const EST_PREFIX = '(?:(?<!\\S)약\\s*)?';
const EST_SUFFIX = '(?:간|동안|짜리|\\s*(?:정도|쯤|가량))?(?![가-힣])';
const ESTIMATE_RE = new RegExp(
  `${EST_PREFIX}(?<![\\d.])(\\d{1,3})\\s*시간(?:\\s*(?:(\\d{1,2})\\s*분|(반)))?${EST_SUFFIX}` +
    `|${EST_PREFIX}(?<![\\d.])(\\d{1,4})\\s*분${EST_SUFFIX}`
);

// 제출 대상
const SUBMIT_EXPLICIT_RE = /제출\s*[:：]\s*([^\s,()[\]]+)/;
const SUBMIT_TO_RE_G = /(?<![^\s(\[{"'“‘,])([^\s(){}[\]"'“”‘’,]+?)(에게|께)(?=$|[\s,.)\]}!?"'”’])/g;
// '께'가 '무렵'의 뜻인 경우(3시께, 월말께, 10일께, 오후께, 다음 주께)는 제출 대상이 아니다
// ('순'은 초순·중순·하순만 — 김영순께 같은 이름은 제출 대상)
const KKE_NOT_PERSON_RE =
  /(?:\d시|말|초|[초중하]순)$|^(?:\d+\s*(?:일|월|주)|오늘|내일|내일모레|모레|오전|오후|아침|점심|저녁|밤|낮|새벽|주|이번주|다음주|담주|금주|차주|[월화수목금토일]요일)$/;

// 우선순위
const P1_WORD_RE = /긴급|급함|급하게/;
const P1_ASAP_RE = /(?<![a-z])asap(?![a-z])/i;
const P3_WORD_RE = /언젠가|나중에|여유/;
// '여유 있을 때' 같은 구절은 통째로 제거
const P3_PHRASE_RE_G = /(?<![가-힣])(?:시간\s*)?여유\s*(?:있을\s?때|있게|될\s?때|날\s?때|되면|있으면)(?![가-힣])/g;
// 독립 단어일 때만 제거. 뒤에 붙은 조사·부사형(언젠가는, 나중에는, 긴급히, 긴급하게)도 함께 제거. '긴급회의' 같은 합성어는 남긴다.
const PRIORITY_TOKEN_RE_G =
  /(?<![^\s,.(\[!?:])(?:긴급|급함|급하게|asap|언젠가|나중에|여유)(?:은|는|도|히|하게|으로)?(?=$|[\s,.)\]!?:])/gi;

// 영역
const PERSONAL_SUBSTR_RE = /개인|병원|은행/;
const HOME_TOKEN_RE = /^집(?:$|에서|에|안|안일|청소|정리)/;
const TOKEN_EDGE = new Set([...'.,!?~。…·:;()[]{}"\'“”‘’<>「」『』']);

// 제목 정리
// 앞쪽: 추출 뒤에 남는 구분자만 지운다. '.', '-', '~', '/' 는 뒤가 공백(또는 끝)일 때만 지운다
// (.env, -5kg, ~/.bashrc, /api 처럼 사용자가 쓴 제목 앞 문자는 보존). '...' 같은 연속 점은 지운다.
const EDGE_PUNCT_START_RE = /^(?:[\s,!?。…·:;：、>→|]|\.{2,}|[.\-–—~/](?=\s|$))+/u;
// 뒤쪽(루프로 제거): 공백 . , ! ? ~ 。 … · : ; ： 、 - – — > → / |
const EDGE_PUNCT_END = new Set([...'.,!?~。…·:;：、-–—>→/|']);
const ORPHAN_TOKENS = new Set(['까지', '까지는', '까지만', '에', '에는', '에게', '께']);

// 완료 대상 매칭에서 떼어볼 조사
const PARTICLES = new Set(['을', '를', '은', '는', '이', '가', '도', '에', '의', '과', '와']);

// ---------------------------------------------------------------------------
// 작은 도우미

function normToday(today) {
  return isValidYMD(today) ? today : todayKST();
}

const isSpaceChar = (ch) => /\s/.test(ch);

/** 뒤에서부터 pred 에 맞는 글자를 지운다(정규식 `[…]+$` 대신 — 역추적 없음) */
function trimEndWhile(s, pred) {
  let i = s.length;
  while (i > 0 && pred(s[i - 1])) i -= 1;
  return s.slice(0, i);
}

function trimStartWhile(s, pred) {
  let i = 0;
  while (i < s.length && pred(s[i])) i += 1;
  return s.slice(i);
}

function stripTrailing(s) {
  return trimEndWhile(String(s), (ch) => TRAILING_PUNCT.has(ch) || isSpaceChar(ch));
}

function cut(s, index, length) {
  return `${s.slice(0, index)} ${s.slice(index + length)}`;
}

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function charLen(s) {
  return [...s].length;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 제목 정리: 빈 괄호·공백·고아 조사·앞뒤 구두점 제거 */
function cleanTitle(s) {
  let t = String(s);
  for (let i = 0; i < 3; i += 1) {
    const before = t;
    t = t.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ');
    t = collapse(t);
    t = t
      .split(' ')
      .filter((w) => w && !ORPHAN_TOKENS.has(w))
      .join(' ');
    t = trimEndWhile(t.replace(EDGE_PUNCT_START_RE, ''), (ch) => EDGE_PUNCT_END.has(ch) || isSpaceChar(ch));
    t = collapse(t);
    if (t === before) break;
  }
  return t;
}

function areaOf(text) {
  const s = String(text ?? '');
  if (PERSONAL_SUBSTR_RE.test(s)) return 'area:personal';
  const edge = (ch) => TOKEN_EDGE.has(ch);
  const tokens = s.split(/\s+/).map((w) => trimEndWhile(trimStartWhile(w, edge), edge));
  if (tokens.some((w) => w && HOME_TOKEN_RE.test(w))) return 'area:personal';
  return 'area:work';
}

function detectPriority(raw) {
  const s = String(raw ?? '');
  const p1 = /[!！]{2}/.test(s) || P1_WORD_RE.test(s) || P1_ASAP_RE.test(s);
  const p3 = P3_WORD_RE.test(s);
  return { priority: p1 ? 'p1' : p3 ? 'p3' : 'p2', conflict: p1 && p3 };
}

/**
 * 끝 표현(대기 → 등록 순) 하나 제거.
 * 반환 {text, spaced, end}: spaced = 끝 표현을 띄어 썼는지("X를 해야 함"), end = 제거한 끝 표현.
 * 조사 정리는 다른 추출(날짜·제출 등)이 끝난 뒤 stripEndParticle 로 한다.
 */
function stripEndExpression(s) {
  const base = stripTrailing(s);
  for (const re of [WAIT_END_RE, REGISTER_END_RE]) {
    const m = re.exec(base);
    if (m) {
      const rest = base.slice(0, m.index);
      return { text: stripTrailing(rest), spaced: /\s$/.test(rest), end: m[0] };
    }
  }
  return { text: base, spaced: false, end: null };
}

// '이'로 끝나는 흔한 명사(옷걸이·손잡이·책꽂이·해돋이·손님맞이·어린이·고양이)는 조사로 보지 않는다
const NOUN_ENDING_I_RE = /(?:걸|잡|꽂|받|돋|맞)이$|^(?:어린이|고양이)$/;

/** 마지막 글자(한글 음절)에 받침이 있는지. 한글 음절이 아니면 null. */
function hasBatchim(ch) {
  const c = String(ch).codePointAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return null;
  return (c - 0xac00) % 28 !== 0;
}

/**
 * 끝 표현을 띄어 쓴 경우 제목 마지막 단어의 조사 정리(제목이 완성된 뒤 적용).
 * - 목적격: "보고서를 금요일까지 해야 함" → "보고서" (를: 2자 이상, 을: 3자 이상)
 * - 주격(끝 표현이 '필요'일 때만): "보고서 검토가 필요" → "보고서 검토", "서명이 필요" → "서명"
 *   3자 이상이고 받침 규칙이 맞을 때만(가: 앞 글자 받침 없음, 이: 받침 있음) — '전문가', '종이' 같은 단어 보호
 */
function stripEndParticle(title, end) {
  const words = title.split(' ');
  const last = words[words.length - 1] || '';
  const n = charLen(last);
  const prev = last.slice(-2, -1);
  let drop = false;
  if ((last.endsWith('를') && n >= 2) || (last.endsWith('을') && n >= 3)) drop = true;
  else if (end === '필요' && n >= 3) {
    if (last.endsWith('가') && hasBatchim(prev) === false) drop = true;
    else if (last.endsWith('이') && hasBatchim(prev) === true && !NOUN_ENDING_I_RE.test(last)) drop = true;
  }
  if (!drop) return title;
  words[words.length - 1] = last.slice(0, -1);
  return words.join(' ');
}

function formatEstimate(h, m) {
  const hh = Number(h) || 0;
  const mm = Number(m) || 0;
  if (hh && mm) return `${hh}시간 ${mm}분`;
  if (hh) return `${hh}시간`;
  if (mm) return `${mm}분`;
  return null;
}

// ---------------------------------------------------------------------------
// 마감 날짜 찾기

// 한글 날짜어 뒤 조사: 까지·에·에는·엔(에는의 준말)·께(무렵) 등
const HANGUL_SUFFIX = '(?:\\s*(?:까지는|까지만|까지|에는|엔|에|중으로|중에|중)|은|는|께)?(?![가-힣])';
// 숫자 날짜 뒤 조사. '에·에는·엔'은 뒤에 한글이 바로 이어지면(에어컨·엔화) 조사로 보지 않는다.
const NUM_SUFFIX_BODY = '\\s*(?:까지는|까지만|까지)|\\s*(?:에는|엔|에)(?![가-힣])';
const NUM_SUFFIX = `(?:${NUM_SUFFIX_BODY})?`;
// 날짜 뒤 요일 괄호: 10/16(금), 10월 16일 (금)
const DOW_PAREN = '(?:\\s*\\([일월화수목금토]\\))?';

const DATE_PATTERNS = [
  {
    kind: 'ymd',
    re: new RegExp(`(?<!\\d)(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일${DOW_PAREN}${NUM_SUFFIX}`, 'g'),
  },
  {
    kind: 'ymd',
    re: new RegExp(`(?<![\\d./-])(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})(?![\\d])${DOW_PAREN}${NUM_SUFFIX}`, 'g'),
  },
  { kind: 'md', re: new RegExp(`(?<![\\d./-])(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일${DOW_PAREN}${NUM_SUFFIX}`, 'g') },
  // M/D: '일'(10/20일)·요일 괄호·조사는 허용. 그 외 한글이 바로 붙으면(3/4분기) 날짜가 아니다.
  {
    kind: 'md',
    re: new RegExp(`(?<![\\d./-])(\\d{1,2})/(\\d{1,2})(?![\\d/])일?${DOW_PAREN}(?:${NUM_SUFFIX_BODY}|(?![가-힣]))`, 'g'),
  },
  { kind: 'rel', re: new RegExp(`(?<![가-힣])(오늘|내일모레|내일|모레)${HANGUL_SUFFIX}`, 'g') },
  {
    kind: 'wd',
    re: new RegExp(`(?<![가-힣])(?:(이번\\s?주|금주|다음\\s?주|담주|차주)\\s*)?([월화수목금토일])요일${HANGUL_SUFFIX}`, 'g'),
  },
];

function resolveDateMatch(kind, m, today) {
  const text = m[0].trim();
  if (kind === 'ymd') {
    const ymd = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    if (!isValidYMD(ymd)) return { due: null, warning: `존재하지 않는 날짜입니다: ${text}` };
    return { due: ymd, warning: ymd < today ? W_PAST : null };
  }
  if (kind === 'md') {
    const due = resolveMonthDay(today, Number(m[1]), Number(m[2]));
    if (!due) return { due: null, warning: `존재하지 않는 날짜입니다: ${text}` };
    return { due, warning: null };
  }
  if (kind === 'rel') {
    const add = { 오늘: 0, 내일: 1, 모레: 2, 내일모레: 2 }[m[1]];
    return { due: addDays(today, add), warning: null };
  }
  // wd
  const wd = WEEKDAY_KO.indexOf(m[2]);
  const prefix = (m[1] || '').replace(/\s/g, '');
  if (!prefix) return { due: nextWeekday(today, wd), warning: null };
  if (prefix === '이번주' || prefix === '금주') {
    const due = weekdayInWeek(today, wd, 0);
    return { due, warning: due < today ? W_PAST : null };
  }
  return { due: weekdayInWeek(today, wd, 1), warning: null };
}

/** 문장 속 날짜 표현 전부 (위치 순, 겹침 제거) */
function findDates(s, today) {
  const found = [];
  for (const { kind, re } of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      found.push({ index: m.index, end: m.index + m[0].length, kind, m });
    }
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.index < lastEnd) continue;
    out.push({ ...f, ...resolveDateMatch(f.kind, f.m, today) });
    lastEnd = f.end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 할 일 추출

function extractCore(text, today, { stripEnd = true, noDue = false } = {}) {
  const warnings = [];
  const raw = String(text ?? '');

  // 1) 우선순위: 원문에서 먼저 ('!!' 포함)
  const pr = detectPriority(raw);
  if (pr.conflict) warnings.push('우선순위 표현이 겹쳐 p1(긴급)으로 정했습니다');

  let s = raw.replace(/[!！]{2,}/g, ' ');
  s = stripTrailing(s);

  // 2) 끝 표현 (조사 정리는 맨 끝에서)
  let endInfo = { spaced: false, end: null };
  if (stripEnd) {
    endInfo = stripEndExpression(s);
    s = endInfo.text;
  }

  // 3) AI 분해 요청
  let decompose = false;
  if (DECOMPOSE_RE.test(s)) {
    decompose = true;
    s = s.replace(DECOMPOSE_RE_G, ' ');
  }

  // 4) 프로젝트 [코드]
  let project = null;
  const projects = [...s.matchAll(PROJECT_RE_G)];
  if (projects.length) {
    project = projects[0][1];
    s = cut(s, projects[0].index, projects[0][0].length);
    if (projects.length > 1) warnings.push('프로젝트는 하나만 지정할 수 있어 첫 번째를 사용했습니다');
  }

  // 5) 예상 소요
  let estimate = null;
  const em = ESTIMATE_RE.exec(s);
  if (em) {
    estimate = em[1] !== undefined ? formatEstimate(em[1], em[3] ? 30 : em[2]) : formatEstimate(0, em[4]);
    if (estimate) s = cut(s, em.index, em[0].length);
  }

  // 6) 마감
  let due = null;
  const dates = findDates(s, today);
  if (dates.length) {
    if (noDue) {
      warnings.push('반복 할 일에는 마감일을 적용하지 않습니다(날짜 표현은 제목에 남겼습니다)');
    } else {
      const d = dates[0];
      s = cut(s, d.index, d.end - d.index);
      due = d.due;
      if (d.warning) warnings.push(d.warning);
      if (dates.length > 1) warnings.push('마감 표현이 여러 개라 첫 번째만 사용했습니다');
    }
  }

  // 7) 제출 대상
  let submitTo = null;
  const ex = SUBMIT_EXPLICIT_RE.exec(s);
  if (ex) {
    submitTo = ex[1];
    s = cut(s, ex.index, ex[0].length);
  } else {
    for (const m of s.matchAll(SUBMIT_TO_RE_G)) {
      const who = m[1];
      if (/함께$/.test(who + m[2])) continue; // 함께, 다함께
      if (m[2] === '께' && KKE_NOT_PERSON_RE.test(who)) continue; // 3시께, 월말께, 10일께, 오후께 (≈ 무렵)
      submitTo = who;
      s = cut(s, m.index, m[0].length);
      break;
    }
  }

  // 8) 우선순위어 제거 (독립 단어일 때만; 붙어 있으면 제목에 둔다)
  s = s.replace(P3_PHRASE_RE_G, ' ').replace(PRIORITY_TOKEN_RE_G, ' ');

  // 9) 영역 (영역어는 제목에서 제거하지 않음)
  const area = areaOf(raw);

  let cleaned = cleanTitle(s);
  if (endInfo.spaced) cleaned = stripEndParticle(cleaned, endInfo.end);
  const title = sanitizeText(cleaned);
  return {
    task: {
      title,
      due,
      priority: pr.priority,
      area,
      project,
      submitTo: submitTo ? sanitizeText(submitTo) : null,
      estimate,
    },
    decompose,
    warnings,
  };
}

export function extractTask(text, today) {
  return extractCore(text, normToday(today), { stripEnd: true });
}

// ---------------------------------------------------------------------------
// parse

function splitNext(text) {
  const m = NEXT_SEP_RE.exec(text);
  if (!m) return { main: text, nextText: null };
  return { main: text.slice(0, m.index), nextText: text.slice(m.index + m[0].length) };
}

/** 다음 단계 텍스트 → {next, warnings} */
function buildNext(nextText, today) {
  const warnings = [];
  if (nextText === null) return { next: null, warnings };
  let t = nextText;
  const again = NEXT_SEP_RE.exec(t);
  if (again) {
    t = t.slice(0, again.index);
    warnings.push('다음 단계는 하나만 등록할 수 있어 그 이후 단계는 무시했습니다');
  }
  if (!t.trim()) {
    warnings.push('다음 단계 내용이 없습니다');
    return { next: null, warnings };
  }
  // 저장 형식 그대로 쓴 경우("회신 확인 (Due 2026-10-16, 제출 김과장)"): 괄호 속성을 먼저 해석한다
  const attrs = parseNextAttrs(collapse(t));
  const text = attrs ? attrs.title : t;
  const r = extractCore(text, today, { stripEnd: true });
  for (const w of r.warnings) warnings.push(`다음 단계: ${w}`);
  if (attrs && attrs.badDue) warnings.push(`다음 단계: 존재하지 않는 날짜입니다: Due ${attrs.badDue}`);
  if (r.decompose) warnings.push('다음 단계의 AI 분해 요청은 무시했습니다');
  if (!r.task.title) {
    warnings.push('다음 단계 내용이 없습니다');
    return { next: null, warnings };
  }
  let next = r.task;
  if (attrs) {
    next = {
      ...next,
      due: attrs.due ?? next.due,
      submitTo: attrs.submitTo ? sanitizeText(attrs.submitTo) : next.submitTo,
      priority: attrs.priority !== 'p2' ? attrs.priority : next.priority,
      estimate: attrs.estimate ?? next.estimate,
    };
  }
  // 저장 형식(formatNextValue)에 자리가 없는 속성은 조용히 사라지지 않도록 알린다
  if (next.project) {
    warnings.push(`다음 단계의 프로젝트 [${next.project}]는 저장되지 않습니다(완료 시 원래 할 일의 프로젝트를 따릅니다)`);
  }
  if (WAIT_END_RE.test(stripTrailing(text))) {
    warnings.push('다음 단계의 대기 표시는 저장되지 않습니다(완료 시 일반 할 일로 등록됩니다)');
  }
  return { next, warnings };
}

function unknownResult(original, warnings, task = null) {
  return { kind: 'unknown', text: original, task, warnings };
}

export function parse(text, today) {
  const day = normToday(today);
  const original = String(text ?? '').trim();
  if (!original) return unknownResult('', [W_EMPTY]);

  const { main, nextText } = splitNext(original);
  if (!stripTrailing(main).trim()) return unknownResult(original, [W_EMPTY]);

  // 1) 반복 (문장 어디든)
  const rm = RECUR_RE.exec(main);
  let recurBlocked = null;
  if (rm && rm[4] !== undefined) {
    const n = Number(rm[4]);
    if (n < 1 || n > 31) recurBlocked = '매월 반복은 1~31일만 지정할 수 있습니다';
  }
  if (rm && !recurBlocked) {
    let rule;
    if (rm[1]) rule = { kind: 'daily' };
    else if (rm[2]) rule = { kind: 'weekdays' };
    else if (rm[3]) rule = { kind: 'weekly', weekday: WEEKDAY_KO.indexOf(rm[3]) };
    else rule = { kind: 'monthly', day: Number(rm[4]) };
    const rest = cut(main, rm.index, rm[0].length);
    const r = extractCore(rest, day, { stripEnd: true, noDue: true });
    const warnings = [...r.warnings];
    if (r.decompose) warnings.push('반복 할 일에는 AI 분해를 적용하지 않습니다');
    if (nextText !== null) warnings.push('반복 문장의 다음 단계는 무시했습니다');
    if (!r.task.title) return unknownResult(original, [...warnings, W_EMPTY]);
    return {
      kind: 'recurring',
      rule,
      ruleText: formatRecurrence(rule),
      task: { ...r.task, due: null },
      warnings,
    };
  }
  const preWarnings = [];
  if (recurBlocked) preWarnings.push(recurBlocked);
  else if (/(?<![가-힣])매주/.test(main)) preWarnings.push('반복은 "매주 X요일"처럼 한 요일로 입력하세요');
  else if (/(?<![가-힣])매월/.test(main)) preWarnings.push('반복은 "매월 N일" 형식으로 입력하세요');

  const s = stripTrailing(main).trim();

  // 2) 완료 (끝)
  const cm = COMPLETE_END_RE.exec(s);
  if (cm) {
    const warnings = [...preWarnings];
    if (nextText !== null) warnings.push(W_COMPLETE_NEXT);
    let kw = s.slice(0, cm.index);
    let number = null;
    // '#N'은 문장 어디든 번호. '#' 없는 'N번'은 키워드 전체가 그것뿐일 때만 번호('12번 완료').
    // '1번 과제 제출 완료', '3번 출구 사진 정리 끝'의 N번은 제목 키워드로 남긴다.
    const hm = /#\s*(\d+)(?:\s*번(?![가-힣\d]))?/.exec(kw) || /^\s*(\d+)\s*번\s*$/.exec(kw);
    if (hm) {
      const n = Number(hm[1]);
      if (Number.isSafeInteger(n) && n > 0) number = n;
      kw = cut(kw, hm.index, hm[0].length);
    }
    const keyword = cleanTitle(kw);
    if (number === null && !keyword) return unknownResult(original, [...warnings, W_EMPTY]);
    return { kind: 'complete', number, keyword, warnings };
  }

  // 3) 대기 (끝) / 4) 등록 (끝)
  const waiting = WAIT_END_RE.test(s);
  const register = waiting || REGISTER_END_RE.test(s);
  const r = extractCore(main, day, { stripEnd: true });
  const nx = buildNext(nextText, day);
  const warnings = [...preWarnings, ...r.warnings, ...nx.warnings];

  if (register) {
    if (!r.task.title) return unknownResult(original, [...warnings, W_EMPTY]);
    return { kind: 'register', task: r.task, waiting, decompose: r.decompose, next: nx.next, warnings };
  }

  // 5) 판정 불가 — 등록 확인 버튼용 task (계약 형태 유지: next/decompose 는 담지 않고 경고로 알린다)
  if (!r.task.title) return unknownResult(original, [...warnings, W_EMPTY]);
  if (nx.next) warnings.push('할 일로 판정되지 않은 문장이라 다음 단계는 함께 등록되지 않습니다');
  if (r.decompose) warnings.push('할 일로 판정되지 않은 문장이라 AI 분해 요청은 처리되지 않습니다');
  return unknownResult(original, warnings, r.task);
}

// ---------------------------------------------------------------------------
// 라벨 · 다음 단계 값

export function taskLabels(task, { waiting = false, recurring = false } = {}) {
  const labels = [task?.priority || 'p2', task?.area || 'area:work'];
  if (task?.project) labels.push(`proj:${task.project}`);
  if (waiting) labels.push('waiting');
  if (recurring) labels.push('recurring');
  return labels;
}

export function formatNextValue(task) {
  if (!task) return '';
  const title = collapse(task.title ?? '');
  const attrs = [];
  if (task.due) attrs.push(`Due ${task.due}`);
  if (task.submitTo) attrs.push(`제출 ${task.submitTo}`);
  if (task.priority === 'p1' || task.priority === 'p3') attrs.push(task.priority);
  if (task.estimate) attrs.push(`예상 ${task.estimate}`);
  return attrs.length ? `${title} (${attrs.join(', ')})` : title;
}

/**
 * 'X (Due YYYY-MM-DD, 제출 Y, p1, 예상 N시간)' 형식의 괄호 속성 해석.
 * 괄호 안 속성을 모두 알아보면 {title, due, submitTo, priority, estimate}, 아니면 null. v 는 collapse 된 문자열.
 */
function parseNextAttrs(v) {
  const m = /^(.*\S)\s*\(([^()]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[2].split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const t = { due: null, submitTo: null, priority: 'p2', estimate: null, badDue: null };
  for (const p of parts) {
    let mm;
    if ((mm = /^due\s*[:：]?\s*(\S+)$/i.exec(p))) {
      if (isValidYMD(mm[1])) t.due = mm[1];
      else t.badDue = mm[1];
    } else if ((mm = /^제출\s*[:：]?\s*(.+)$/.exec(p))) {
      t.submitTo = mm[1].trim();
    } else if (/^p[123]$/i.test(p)) {
      t.priority = p.toLowerCase();
    } else if ((mm = /^예상\s*[:：]?\s*(.+)$/.exec(p))) {
      t.estimate = mm[1].trim();
    } else {
      return null;
    }
  }
  return { title: m[1].trim(), ...t };
}

export function parseNextValue(value, today) {
  const v = collapse(value ?? '');
  if (!v) return null;
  const a = parseNextAttrs(v);
  if (a) {
    return {
      title: a.title,
      due: a.due,
      priority: a.priority,
      area: areaOf(a.title),
      project: null,
      submitTo: a.submitTo,
      estimate: a.estimate,
    };
  }
  const r = extractCore(v, normToday(today), { stripEnd: true });
  return r.task.title ? r.task : null;
}

// ---------------------------------------------------------------------------
// 본문

function bodyValue(v) {
  return sanitizeText(String(v).replace(/\r?\n|\r/g, ' ')).trim();
}

export function buildBody(fields = {}) {
  const f = fields || {};
  const lines = [];
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  if (has(f.recurrence)) lines.push(`반복: ${bodyValue(f.recurrence)}`);
  if (has(f.due) && isValidYMD(String(f.due).trim())) lines.push(`Due: ${String(f.due).trim()}`);
  lines.push(`완료 기준: ${has(f.criteria) ? bodyValue(f.criteria) : '(미정)'}`);
  if (has(f.submitTo)) lines.push(`제출: ${bodyValue(f.submitTo)}`);
  if (has(f.estimate)) lines.push(`예상: ${bodyValue(f.estimate)}`);
  if (has(f.next)) lines.push(`다음: ${bodyValue(f.next)}`);
  lines.push(`메모: ${has(f.memo) ? bodyValue(f.memo) : DEFAULT_MEMO}`);
  const subtasks = Array.isArray(f.subtasks) ? f.subtasks : [];
  if (subtasks.length) {
    lines.push('', '## 하위 작업');
    for (const st of subtasks) lines.push(`- [${st && st.done ? 'x' : ' '}] ${bodyValue(st?.text ?? '')}`);
  }
  return lines.join('\n');
}

// 줄은 이미 \r\n|\n|\r 로 나눠 두었다. 값 부분을 `(.*)$` 로 쓰면 U+2028/2029 가 섞인 긴 줄에서
// 역추적이 제곱으로 늘어나므로 `([^\r\n]*)$` 로 쓴다(parseBody·toggleChecklist 공용 → index 대응 유지).
const BODY_KEY_RE = /^\s*(due|완료\s*기준|제출|예상|다음|메모|반복)\s*[:：]\s*([^\r\n]*)$/i;
const CHECK_RE = /^\s*[-*]\s+\[( |x|X)\]\s+([^\r\n]*)$/;
const CHECK_MARK_RE = /^(\s*[-*]\s+\[)( |x|X)(\])/;

function keyName(k) {
  const s = k.replace(/\s+/g, '');
  if (/^due$/i.test(s)) return 'due';
  return { 완료기준: 'criteria', 제출: 'submitTo', 예상: 'estimate', 다음: 'next', 메모: 'memo', 반복: 'recurrence' }[s];
}

export function parseBody(body) {
  const out = {
    due: null,
    criteria: null,
    submitTo: null,
    estimate: null,
    next: null,
    memo: null,
    recurrence: null,
    subtasks: [],
  };
  if (body === null || body === undefined) return out;
  const seen = new Set();
  for (const line of String(body).split(/\r\n|\n|\r/)) {
    const c = CHECK_RE.exec(line);
    if (c) {
      out.subtasks.push({ done: c[1] !== ' ', text: c[2].trim() });
      continue;
    }
    const m = BODY_KEY_RE.exec(line);
    if (!m) continue;
    const key = keyName(m[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const value = m[2].trim();
    if (key === 'due') {
      const d = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(value);
      const ymd = d ? `${d[1]}-${pad2(d[2])}-${pad2(d[3])}` : null;
      out.due = ymd && isValidYMD(ymd) ? ymd : null;
    } else {
      out[key] = value === '' ? null : value;
    }
  }
  return out;
}

export function checklistProgress(body) {
  const { subtasks } = parseBody(body);
  return { done: subtasks.filter((t) => t.done).length, total: subtasks.length };
}

export function toggleChecklist(body, { index, text } = {}, checked) {
  if (body === null || body === undefined) return null;
  // 줄과 줄바꿈 문자를 분리해 보존: [줄, 구분자, 줄, 구분자, ..., 줄]
  const parts = String(body).split(/(\r\n|\n|\r)/);
  const items = [];
  for (let i = 0; i < parts.length; i += 2) {
    const c = CHECK_RE.exec(parts[i]);
    if (c) items.push({ part: i, text: c[2].trim() });
  }
  const want = text === undefined || text === null ? null : String(text).trim();
  let target = Number.isInteger(index) ? items[index] : undefined;
  if (target && want !== null && target.text !== want) target = undefined;
  if (!target && want !== null) target = items.find((it) => it.text === want);
  if (!target) return null;
  parts[target.part] = parts[target.part].replace(CHECK_MARK_RE, `$1${checked ? 'x' : ' '}$3`);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 이슈 도우미

export function sanitizeText(s) {
  return String(s ?? '').replace(/@claude/gi, '@ claude');
}

export function labelNames(issue) {
  const labels = issue && Array.isArray(issue.labels) ? issue.labels : [];
  return labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter((n) => typeof n === 'string' && n);
}

export function isTask(issue) {
  if (!issue || issue.pull_request) return false;
  const names = labelNames(issue);
  return !names.includes('recurring') && !names.includes('briefing');
}

export function priorityOf(issue) {
  const names = labelNames(issue);
  if (names.includes('p1')) return 'p1';
  if (names.includes('p2')) return 'p2';
  if (names.includes('p3')) return 'p3';
  return 'p2';
}

export function dueOf(issue) {
  return parseBody(issue?.body).due;
}

function groupsWith(issue, today, due) {
  const names = labelNames(issue);
  const diff = due ? daysBetween(today, due) : null;
  if (names.includes('waiting')) return due && diff < 0 ? ['overdue', 'waiting'] : ['waiting'];
  if (due && diff < 0) return ['overdue'];
  const p = priorityOf(issue);
  if (p === 'p1' || (due && diff <= 1)) return ['urgent'];
  if (p === 'p2' || (due && diff <= 7)) return ['week'];
  return ['later'];
}

export function groupsOf(issue, today) {
  return groupsWith(issue, normToday(today), dueOf(issue));
}

const PRIORITY_RANK = { p1: 1, p2: 2, p3: 3 };

export function groupIssues(issues, today, { project = null } = {}) {
  const day = normToday(today);
  const result = { overdue: [], urgent: [], week: [], later: [], waiting: [], total: 0 };
  const seen = new Set();
  const rows = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isTask(issue)) continue;
    if (issue.state === 'closed') continue;
    if (project && !labelNames(issue).includes(`proj:${project}`)) continue;
    const key = issue.number ?? issue.id ?? issue;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ issue, due: dueOf(issue), rank: PRIORITY_RANK[priorityOf(issue)], number: Number(issue.number) || 0 });
  }
  rows.sort((a, b) => {
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.rank - b.rank || a.number - b.number;
  });
  for (const row of rows) {
    for (const g of groupsWith(row.issue, day, row.due)) result[g].push(row.issue);
  }
  result.total = rows.length;
  return result;
}

export function isCompletedThisWeek(issue, today) {
  if (!issue || !issue.closed_at) return false;
  if (issue.state && issue.state !== 'closed') return false;
  if (issue.state_reason === 'not_planned') return false;
  if (!isTask(issue)) return false;
  const closed = Date.parse(issue.closed_at);
  if (Number.isNaN(closed)) return false;
  return closed >= Date.parse(kstMidnightISO(startOfWeek(normToday(today))));
}

export function matchCandidates(keyword, issues) {
  const words = String(keyword ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const long = words.filter((w) => charLen(w) >= 2);
  const tokens = long.length ? long : words;
  if (!tokens.length) return { clear: null, candidates: [] };

  const candidates = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isTask(issue)) continue;
    if ((issue.state ?? 'open') !== 'open') continue;
    const title = String(issue.title ?? '').toLowerCase().replace(/\s+/g, '');
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += 1;
      else if (charLen(t) >= 2 && PARTICLES.has(t.slice(-1)) && title.includes(t.slice(0, -1))) score += 1;
    }
    if (score > 0) candidates.push({ issue, score });
  }
  candidates.sort((a, b) => b.score - a.score || (Number(a.issue.number) || 0) - (Number(b.issue.number) || 0));
  let clear = null;
  if (candidates.length) {
    const top = candidates[0].score;
    const tied = candidates.filter((c) => c.score === top).length;
    if (tied === 1 && top === tokens.length) clear = candidates[0].issue;
  }
  return { clear, candidates };
}

export function shouldSuggestReplyCheck(issue) {
  if (!issue) return false;
  if (parseBody(issue.body).next) return false;
  const title = String(issue.title ?? '');
  // 이미 "회신 확인" 할 일이면 다시 제안하지 않는다(무한 연쇄 방지)
  if (/회신\s*확인/.test(title)) return false;
  return /송부|발송|제출|요청|전달|문의/.test(title);
}
