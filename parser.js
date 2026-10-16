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

// Actions 의 Claude 는 답글만 쓴다. 본문 반영은 홈페이지 [본문에 반영] 버튼이 사용자 토큰으로 한다.
export const SOS_COMMENT =
  "@claude 이 할 일을 /todo-stuck 기준으로 진단하고, 하위 작업 3~7개를 '- [ ] ' 체크리스트 형식으로 답글에 적고, 첫 행동을 알려줘. 이슈 본문과 라벨은 바꾸지 마(홈페이지에서 반영함).";
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
// - 반복 표현 뒤 조사(에는/엔/은/는/과/와/마다/까지/에)도 함께 지운다. 은·는·과·와는 뒤에 한글이 이어지면(은행·과제) 조사로 보지 않는다.
// - '매주 월요일과 목요일', '매주 월,수'처럼 요일이 여럿이면 more1/more2 에 나머지 요일이 잡힌다(첫 요일만 규칙으로 쓰고 경고).
//   목록의 요일은 '요일'이 붙거나 한 글자로 끝나야 한다('매주 월요일과 목표 점검' 의 '목'은 요일 아님).
// - '매월 1일과 15일', '매월 1일, 15일'처럼 날이 여럿이면 mmore 에 나머지 날이 잡힌다(첫 날만 규칙으로 쓰고 경고).
//   목록의 날은 뒤에 한글이 없거나 조사만 와야 한다('매월 1일과 2일차 회의'의 '2일차'는 날 아님).
// - 조사 '엔·은·는·과·와'는 뒤에 한글이 이어지면(엔진·은행·과제) 조사로 보지 않는다.
//   '에는'은 그런 낱말이 없으므로 붙여 써도 조사로 지운다('월요일에는은행' → '은행').
const RECUR_DAY = '[월화수목금토일]';
const RECUR_SEP = '\\s*(?:[,，·/]|과|와|및|하고|이랑|랑)\\s*';
const RECUR_MORE = `(?:${RECUR_SEP}${RECUR_DAY}(?:요일|(?![가-힣])))`;
const RECUR_MDAY_MORE = `(?:${RECUR_SEP}\\d{1,2}\\s*일(?:(?![가-힣])|(?=마다|까지|에|엔|은|는|과|와)))`;
const RECUR_PARTICLE = '(?:마다|까지|에는|(?:엔|은|는|과|와)(?![가-힣])|에)?';
const RECUR_RE = new RegExp(
  '(?<![가-힣])(?:(?<daily>매일)(?:매일)?(?:\\s?마다)?|(?<weekdays>평일마다)' +
    `|매주\\s*(?<wd>${RECUR_DAY})(?:요일(?<more1>${RECUR_MORE}*)|(?<more2>${RECUR_MORE}+))${RECUR_PARTICLE}` +
    `|매월\\s*(?<md>\\d{1,2})\\s*일(?<mmore>${RECUR_MDAY_MORE}*)${RECUR_PARTICLE})`
);

// AI 분해 요청
const DECOMPOSE_RE = /쪼개서|단계별로/;
const DECOMPOSE_RE_G = /쪼개서|단계별로/g;

// 프로젝트 [코드]
const PROJECT_RE_G = /\[\s*([^[\]\s,]{1,40})\s*\]/g;

// 예상 소요: N시간 N분 | N시간 반 | N시간 | N분  (3분기 같은 단어는 제외)
// 앞의 '약 '과 뒤의 '정도·쯤·가량'(띄어 써도)은 함께 제거한다.
const EST_PREFIX = '(?:(?<!\\S)약\\s*)?';
const EST_SUFFIX = '(?:간|동안|짜리|\\s*(?:정도|쯤|가량))?(?![가-힣])';
const EST_HOURS = '(\\d{1,3})\\s*시간(?:\\s*(?:(\\d{1,2})\\s*분|(반)))?';
const EST_MINUTES = '(\\d{1,4})\\s*분';
const ESTIMATE_RE_G = new RegExp(
  `${EST_PREFIX}(?<![\\d.])${EST_HOURS}${EST_SUFFIX}|${EST_PREFIX}(?<![\\d.])${EST_MINUTES}${EST_SUFFIX}`,
  'g'
);
// 예상 소요가 아닌 것(제목에 그대로 둔다):
// - 시각 'N시 M분'의 분 (앞이 'N시' — 'N시간'은 아님): '10시 30분 병원 예약'
// - 상대 시간·거리 'N분 전', 'N시간 후·뒤', 'N분 거리', 'N분 만에', 'N분 째' (뒤에 붙는 조사까지 보고 판단: '30분 전에', '전화'는 해당 없음)
// (둘 다 sticky: lastIndex 위치에서만 검사 — 긴 본문 값에서도 매치마다 전체를 다시 훑지 않는다)
const EST_CLOCK_BEFORE_RE_Y = /(?<=\d\s*시\s*)/y;
const EST_RELATIVE_AFTER_RE_Y =
  /\s*(?:전|후|뒤|거리|만에|째)(?:에는|에도|에서|까지|부터|으로|에|엔|쯤|의|이|가|은|는|도)?(?![가-힣])/y;
// 다음 단계 괄호 속성 '예상 <값>'의 값 (예상 형식 전체 일치)
const EST_VALUE_RE = new RegExp(
  `^(?:약\\s*)?(?:${EST_HOURS}|${EST_MINUTES})(?:간|동안|짜리|\\s*(?:정도|쯤|가량))?$`
);

// 제출 대상
const SUBMIT_EXPLICIT_RE = /제출\s*[:：]\s*([^\s,()[\]]+)/;
const SUBMIT_TO_RE_G = /(?<![^\s(\[{"'“‘,])([^\s(){}[\]"'“”‘’,]+?)(에게|께)(?=$|[\s,.)\]}!?"'”’])/g;
// '께'가 '무렵'의 뜻인 경우(3시께, 월말께, 10일께, 오후께, 다음 주께)는 제출 대상이 아니다
// ('순'은 초순·중순·하순만 — 김영순께 같은 이름은 제출 대상)
const KKE_NOT_PERSON_RE =
  /(?:\d시|말|초|[초중하]순)$|^(?:\d+\s*(?:일|월|주)|오늘|내일|내일모레|모레|오전|오후|아침|점심|저녁|밤|낮|새벽|주|이번주|다음주|다다음주|담주|금주|차주|[월화수목금토일]요일)$/;

// 우선순위
const P1_WORD_RE = /긴급|급함|급하게/;
const P1_ASAP_RE = /(?<![a-z])asap(?![a-z])/i;
const P3_WORD_RE = /언젠가|나중에|여유/;
// '여유 있을 때' 같은 구절은 통째로 제거
const P3_PHRASE_RE_G = /(?<![가-힣])(?:시간\s*)?여유\s*(?:있을\s?때|있게|될\s?때|날\s?때|되면|있으면)(?![가-힣])/g;
// 독립 단어일 때만 제거. 뒤에 붙은 조사·부사형(언젠가는, 나중에는, 긴급히, 긴급하게)도 함께 제거. '긴급회의' 같은 합성어는 남긴다.
const PRIORITY_TOKEN_RE_G =
  /(?<![^\s,.(\[!?:])(?:긴급|급함|급하게|asap|언젠가|나중에|여유)(?:은|는|도|히|하게|으로)?(?=$|[\s,.)\]!?:])/gi;
// 5차 추가 낱말 — 독립 낱말일 때만 인식한다(위 기존 낱말의 부분 문자열 인식은 그대로 둔다).
//   독립 낱말: 앞이 문장 처음·공백·문장부호(한글·글자·숫자가 아님)이고, 뒤에 한글·글자·숫자가 바로 붙지 않음.
//   p1: 급한 · 빨리(빨리빨리) · 시급한 · 시급히 · 시급하게 · 시급함
//   p3: 천천히 · 다음 달(다음달)
//   '지급한 내역', '월급한도', '조급한 마음', '빨리감기'는 붙어 있는 낱말이라 인식하지 않는다.
//   맨몸 '시급'(시간당 급여: '알바 시급')과 '중요'(중요 ≠ 급함)는 인식하지 않는다.
const WORD_EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_EDGE_AFTER = '(?![\\p{L}\\p{N}])';
const P1_EXTRA_WORDS = '빨리빨리|빨리|시급하게|시급한|시급히|시급함|급한';
const P3_EXTRA_WORDS = '천천히';
const P1_EXTRA_RE = new RegExp(`${WORD_EDGE_BEFORE}(?:${P1_EXTRA_WORDS})${WORD_EDGE_AFTER}`, 'u');
const P3_EXTRA_RE = new RegExp(`${WORD_EDGE_BEFORE}(?:${P3_EXTRA_WORDS})${WORD_EDGE_AFTER}`, 'u');
// '다음 달'·'다음달': 뒤는 공백·문장부호·끝, 또는 조사(에·에는·까지·중·중에·안에·쯤) 뒤 비한글.
// 시점 정보라 제목에 그대로 남기고 마감(Due)도 만들지 않는다(날짜 아님). 다음 단계 구분자 '다음:'(NEXT_SEP_RE)과는 겹치지 않는다.
const P3_NEXT_MONTH_RE = new RegExp(
  `${WORD_EDGE_BEFORE}다음\\s?달(?:에는|에|까지|중에|중|안에|쯤)?${WORD_EDGE_AFTER}`,
  'u'
);
// 추가 낱말 제거('다음 달'은 제외 — 제목에 남긴다). 지워도 제목에 문장부호 잔재가 남지 않는 자리에서만 지운다
// (인식은 위 P1_EXTRA_RE·P3_EXTRA_RE 그대로 — 그 밖의 자리에서는 우선순위만 정하고 제목에 남긴다. 기존 낱말의 '"긴급"'·'#긴급'과 같다):
//  ① 짝 문장부호가 그 낱말만 감싸면 짝째 지운다: '"빨리" 보고서 작성하기'·'「급한」 …'·'(급한) …' → '보고서 작성'
//     ('[빨리]'는 프로젝트 [코드] 표기라 지우지 않는다 → 기존 '[긴급]'처럼 프로젝트로 읽힌다)
//  ② 따로 쓴 낱말: 앞이 문장 처음·공백·뒤에 붙는 문장부호(, . ! ? : ·)이고, 뒤가 끝·공백(또는 아래 문장부호)일 때.
//     (문장 맨 앞의 '-'·'~'·'/' 바로 뒤도 된다: '-빨리 보고서' → '보고서' — 남은 '-'는 cleanTitle 이 지운다.)
//     따옴표·괄호·#·/·- 에 붙어 있으면 지우지 않는다: '#빨리 …', '빨리/보고서 …', '보고서 작성(급한 건)하기'는 제목 그대로(p1).
//  붙어 있는 문장부호도 함께 지워 가운데 잔재를 막는다:
//  - 뒤 문장부호가 공백·끝 앞이면: '보고서 빨리! 작성하기' → '보고서 작성', '보고서, 빨리, 정리하기' → '보고서, 정리'
//  - 낱말을 잇는 '·'·','가 바로 글자 앞이면: '천천히·다음 달 정리하기' → '다음 달 정리' ('.'은 '.env' 같은 제목 보호를 위해 제외)
//  - 글자 바로 뒤에서 낱말을 잇는 '·'·',': '자료 정리·빨리 하기' → '자료 정리' ('정리·' 잔재 방지)
//  - 바로 뒤의 '!!'(p1 표시)는 따로 지운다: '빨리!!보고서' → '보고서'
const EXTRA_WORDS = `${P1_EXTRA_WORDS}|${P3_EXTRA_WORDS}`;
const EXTRA_WRAP_PAIRS = ['()', '（）', '""', "''", '“”', '‘’', '「」', '『』', '<>', '〈〉', '《》'];
const escapeRe = (ch) => ch.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const EXTRA_WRAPPED = EXTRA_WRAP_PAIRS.map(([o, c]) => `${escapeRe(o)}(?:${EXTRA_WORDS})${escapeRe(c)}`).join('|');
const EXTRA_TOKEN_RE_G = new RegExp(
  `(?:${EXTRA_WRAPPED})|` +
    '(?:(?<=[\\p{L}\\p{N}])[·,，])?' +
    `(?:(?<![^\\s,，.。!！?？:：·])|(?<=^[-–—~/]))(?:${EXTRA_WORDS})` +
    '(?:[,，!！?？.。~～…:：·]+(?=\\s|$)|[·,，](?=[\\p{L}\\p{N}])|(?=$|\\s|[!！]{2}))',
  'gu'
);

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
// 완료 대상 매칭에서 '없어도 되는' 낱말: 등록할 때 제목에서 빠지는 우선순위 낱말(긴급·나중에·빨리·급한·천천히 …).
// '보고서 빨리 작성하기'로 등록하면 제목이 '보고서 작성'이 되므로, '보고서 빨리 작성 완료'도 그 할 일을 바로 찾게 한다.
// (제목에 그 낱말이 실제로 있으면 다른 낱말처럼 점수에 넣는다. '다음 달'은 제목에 남으므로 해당 없음.)
const PRIORITY_ONLY_TOKEN_RE = new RegExp(
  `^(?:(?:긴급|급함|급하게|asap|언젠가|나중에|여유)(?:은|는|도|히|하게|으로)?|${P1_EXTRA_WORDS}|${P3_EXTRA_WORDS})$`,
  'iu'
);

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

/** 우선순위 판정(할 일 문장·다음 단계 문장 공용). p1·p3 말이 함께 있으면 p1 + conflict. */
function detectPriority(raw) {
  const s = String(raw ?? '');
  const p1 = /[!！]{2}/.test(s) || P1_WORD_RE.test(s) || P1_ASAP_RE.test(s) || P1_EXTRA_RE.test(s);
  const p3 = P3_WORD_RE.test(s) || P3_EXTRA_RE.test(s) || P3_NEXT_MONTH_RE.test(s);
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

/** ESTIMATE_RE_G / EST_VALUE_RE 매치 → '2시간' | '1시간 30분' | '30분' | null */
function estimateOf(m) {
  return m[1] !== undefined ? formatEstimate(m[1], m[3] ? 30 : m[2]) : formatEstimate(0, m[4]);
}

/** 값 전체가 예상 형식('2시간', '1시간 반', '약 30분')이면 정규화한 값, 아니면 null */
function estimateValue(v) {
  const m = EST_VALUE_RE.exec(String(v ?? '').trim());
  return m ? estimateOf(m) : null;
}

/** 문장의 첫 예상 소요 {estimate, index, length} — 시각의 분·상대 시간은 건너뛴다 */
function findEstimate(s) {
  ESTIMATE_RE_G.lastIndex = 0;
  for (const m of s.matchAll(ESTIMATE_RE_G)) {
    if (m[4] !== undefined) {
      EST_CLOCK_BEFORE_RE_Y.lastIndex = m.index;
      if (EST_CLOCK_BEFORE_RE_Y.test(s)) continue;
    }
    EST_RELATIVE_AFTER_RE_Y.lastIndex = m.index + m[0].length;
    if (EST_RELATIVE_AFTER_RE_Y.test(s)) continue;
    const estimate = estimateOf(m);
    if (estimate) return { estimate, index: m.index, length: m[0].length };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 마감 날짜 찾기

// 날짜 표현 뒤 조사(허용 목록): 까지·까지는·까지만·에·에는·엔(에는의 준말)·중·중에·중으로·은·는·께(무렵).
// 그 밖의 한글이 바로 붙으면(10월 20일부터·20일자·20일경·3/4분기) 날짜(마감)가 아니다 — 한글 날짜어(오늘·요일)와
// 숫자 날짜(10/20, 10월 20일, 2026-10-20, 2026년 10월 20일) 모두 같은 규칙.
// 띄어 쓴 '에·엔·중'은 뒤에 한글이 이어지면(에어컨·엔화·중요) 조사가 아니므로 조사 없이 날짜만 잡는다(끝의 (?![가-힣]) 로 되돌아감).
const HANGUL_SUFFIX = '(?:\\s*(?:까지는|까지만|까지|에는|엔|에|중으로|중에|중)|은|는|께)?(?![가-힣])';
// 숫자 날짜 뒤 조사: 위와 같되 '까지·까지는·까지만' 뒤에 띄어쓰기 없이 낱말(두 글자 이상)이 이어져도 된다
// (10/20까지보고서 — 예전 M/D 규칙). 한 글자 조사가 더 붙은 '까지의·까지로·까지요'는 마감 아님(제목 유지 — '의 보고서' 같은 잔재 방지).
// M/D(10/20)는 '은·는'을 받지 않는다 — 분수('1/2는', '2/3은')가 마감이 되지 않게(예전 규칙 유지).
const numSuffix = (bare) =>
  `(?:\\s*(?:까지는|까지만|까지)(?=[^가-힣]|$|[가-힣]{2})|(?:\\s*(?:에는|엔|에|중으로|중에|중)|${bare})(?![가-힣])|(?![가-힣]))`;
const NUM_SUFFIX = numSuffix('은|는|께');
const MD_SLASH_SUFFIX = numSuffix('께');
// 날짜 뒤 요일 괄호: 10/16(금), 10월 16일 (금). 괄호가 뒤에 있으면 반드시 함께 잡는다
// (괄호를 건너뛰고 날짜만 잡으면 '10/20(화)부터'의 '(화)부터'가 조사 검사를 피해 마감이 된다).
const DOW_PAREN = '(?:\\s*\\([일월화수목금토]\\)|(?!\\s*\\([일월화수목금토]\\)))';

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
  { kind: 'md', re: new RegExp(`(?<![\\d./-])(\\d{1,2})/(\\d{1,2})(?![\\d/])일?${DOW_PAREN}${MD_SLASH_SUFFIX}`, 'g') },
  { kind: 'rel', re: new RegExp(`(?<![가-힣])(오늘|내일모레|내일|모레)${HANGUL_SUFFIX}`, 'g') },
  {
    kind: 'wd',
    re: new RegExp(`(?<![가-힣])(?:(이번\\s?주|금주|다다음\\s?주|다음\\s?주|담주|차주)\\s*)?([월화수목금토일])요일${HANGUL_SUFFIX}`, 'g'),
  },
];

/**
 * 날짜 매치 해석 → {due, warning} 또는 {notDate:true}.
 * - 월 1~12·일 1~31 밖(15/20 점수, 2026-13-01)은 날짜가 아니다(notDate: 경고 없이 제목에 남긴다).
 * - 범위 안이지만 실존하지 않는 날짜(2/30)는 due null + 경고(제목에 남긴다).
 */
function resolveDateMatch(kind, m, today) {
  const text = m[0].trim();
  if (kind === 'ymd' || kind === 'md') {
    const mo = Number(kind === 'ymd' ? m[2] : m[1]);
    const d = Number(kind === 'ymd' ? m[3] : m[2]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return { notDate: true, due: null, warning: null };
  }
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
  if (prefix === '다다음주') return { due: weekdayInWeek(today, wd, 2), warning: null };
  return { due: weekdayInWeek(today, wd, 1), warning: null };
}

// '다음 달 금요일', '다음 달 첫째 주 화요일'의 요일은 다음 달의 어느 날인지 알 수 없다 — 가장 가까운 요일(이번 주)로
// 마감을 잡지 않고 제목에 남긴다(경고). '다음 달'은 마감을 만들지 않는다(5차 A). 날짜(11/20, 11월 20일)는 그대로 마감이 된다.
// 요일 바로 앞 짧은 구간(NEXT_MONTH_WINDOW 글자)만 본다 — 긴 본문 값에서 요일마다 앞부분 전체를 다시 훑지 않게.
const NEXT_MONTH_BEFORE_WD_RE = /다음\s?달\s*(?:(?:(?:첫|둘|셋|넷|다섯)\s*째|첫|마지막)\s*(?:주\s*)?)?$/;
const NEXT_MONTH_WINDOW = 24;

/** 요일 매치 m 바로 앞이 '다음 달 (첫째 주 …)'이면 그 구절('다음 달 금요일'), 아니면 null */
function nextMonthWeekdayPhrase(s, m) {
  if (m[1]) return null; // '이번 주·다음 주 …' 처럼 주가 정해진 요일은 해당 없음
  const start = Math.max(0, m.index - NEXT_MONTH_WINDOW);
  const nm = NEXT_MONTH_BEFORE_WD_RE.exec(s.slice(start, m.index));
  return nm ? collapse(`${s.slice(start + nm.index, m.index)}${m[2]}요일`) : null;
}

/**
 * 문장 속 날짜 표현 전부 (위치 순, 겹침 제거). 날짜가 아닌 매치(notDate)는 빼고,
 * 실존하지 않는 날짜(due null + 경고)는 남긴다(호출부가 경고만 내고 건너뛴다).
 * '다음 달 X요일'은 due null + soft 경고(다른 날짜가 마감이 되면 경고하지 않음).
 */
function findDates(s, today) {
  const found = [];
  for (const { kind, re } of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      let r = resolveDateMatch(kind, m, today);
      if (r.notDate) continue;
      const phrase = kind === 'wd' ? nextMonthWeekdayPhrase(s, m) : null;
      if (phrase) {
        r = {
          due: null,
          soft: true,
          warning: `"${phrase}"은 어느 날인지 알 수 없어 마감으로 쓰지 않았습니다(마감이 필요하면 날짜로 입력하세요)`,
        };
      }
      found.push({ index: m.index, end: m.index + m[0].length, kind, m, ...r });
    }
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.index < lastEnd) continue;
    out.push(f);
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

  // 추가 우선순위어(급한·빨리·시급히·천천히 …)는 인식한 바로 그 문자열(원문)에서 같은 정규식으로 지운다.
  // 다른 추출(끝 표현 '하기' 등)이 끝난 뒤에 지우면 새로 생긴 경계 때문에 인식하지 않은 낱말까지 지워진다
  // ('보고서 빨리하기' → 인식 안 함(p2)인데 제목에서 '빨리'가 사라짐). 기존 낱말은 8) 에서 지운다(동작 그대로).
  let s = raw.replace(EXTRA_TOKEN_RE_G, ' ').replace(/[!！]{2,}/g, ' ');
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

  // 5) 예상 소요 (시각의 분·상대 시간은 제외)
  let estimate = null;
  const em = findEstimate(s);
  if (em) {
    estimate = em.estimate;
    s = cut(s, em.index, em.length);
  }

  // 6) 마감
  let due = null;
  const dates = findDates(s, today);
  if (dates.length) {
    if (noDue) {
      warnings.push('반복 할 일에는 마감일을 적용하지 않습니다(날짜 표현은 제목에 남겼습니다)');
    } else {
      // 실존하지 않는 날짜(2/30)는 경고만 내고 제목에 남긴 채 다음 날짜 표현을 쓴다
      const valid = [];
      const soft = [];
      for (const d of dates) {
        if (d.due) valid.push(d);
        else if (d.soft) soft.push(d.warning);
        else if (d.warning) warnings.push(d.warning);
      }
      if (!valid.length) warnings.push(...soft);
      if (valid.length) {
        const d = valid[0];
        s = cut(s, d.index, d.end - d.index);
        due = d.due;
        if (d.warning) warnings.push(d.warning);
        if (valid.length > 1) warnings.push('마감 표현이 여러 개라 첫 번째만 사용했습니다');
      }
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
  // 저장 형식 그대로 쓴 경우("회신 확인 (Due 2026-10-16, 제출 김과장)"): 괄호 속성을 먼저 해석한다.
  // 저장 형식이 아닌 괄호('(제출 전 검토)')는 일반 제목 텍스트로 둔다.
  // 저장 형식으로 보이지만 쓸 수 없는 괄호('(Due 2026-13-40)')는 괄호 밖에서만 추출하고 괄호는 제목에 남긴다.
  const parsed = parseNextAttrs(collapse(t));
  const attrs = parsed && !parsed.keep ? parsed : null;
  const keep = parsed && parsed.keep ? parsed.keep : null;
  const text = attrs ? attrs.title : keep ? keep.head : t;
  const r = extractCore(text, today, { stripEnd: true });
  for (const w of r.warnings) warnings.push(`다음 단계: ${w}`);
  // 'Due 2026-13-40'처럼 형식은 맞지만 실존하지 않는 날짜: 괄호는 제목에 남기고 경고(같은 날짜 경고가 이미 있으면 생략)
  if (parsed && parsed.badDue && !r.warnings.some((w) => w.startsWith('존재하지 않는 날짜'))) {
    warnings.push(`다음 단계: 존재하지 않는 날짜입니다: Due ${parsed.badDue}`);
  }
  if (r.decompose) warnings.push('다음 단계의 AI 분해 요청은 무시했습니다');
  let next = keep ? { ...r.task, title: titleWithParen(r.task.title, keep.paren) } : r.task;
  if (!next.title) {
    warnings.push('다음 단계 내용이 없습니다');
    return { next: null, warnings };
  }
  if (attrs) {
    next = {
      ...next,
      due: attrs.due ?? next.due,
      submitTo: attrs.submitTo ? sanitizeText(attrs.submitTo) : next.submitTo,
      priority: attrs.priority !== 'p2' ? attrs.priority : next.priority,
      estimate: attrs.estimate ?? next.estimate,
    };
  }
  // 저장 형식(formatNextValue → parseNextAttrs)으로 다시 읽을 수 없는 제출 대상은 저장하지 않고 알린다
  // (완료 시 원래 할 일의 제출 대상을 따름). 엄격 형식이 아니어도 확실한 속성(마감·p1·p3·예상)과 함께면 다시 읽힌다.
  const why = next.submitTo ? nextSubmitProblem(next) : null;
  if (why) {
    warnings.push(`다음 단계의 제출 대상 "${next.submitTo}"은(는) 저장되지 않습니다(${why} — 완료 시 원래 할 일의 제출 대상을 따릅니다)`);
    next = { ...next, submitTo: null };
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

/** 다음 단계 제출 대상을 저장할 수 없는 이유(저장할 수 있으면 null) */
function nextSubmitProblem(next) {
  const s = String(next.submitTo ?? '');
  if (isNextSubmitValue(s)) return null;
  if (NEXT_SUBMIT_NOT_TARGET_RE.test(s)) return '"전·후·완료·예정·마감·준비·검토·전달" 같은 낱말은 제출 대상으로 저장하지 않습니다';
  const anchored =
    Boolean(next.due) || next.priority === 'p1' || next.priority === 'p3' || Boolean(estimateValue(next.estimate));
  if (anchored && /^[^,()]+$/.test(s)) return null;
  if (/[\s,()]/.test(s)) return '제출 대상은 한 단어만 저장됩니다';
  return '한 글자 대상은 마감·우선순위·예상 시간과 함께 적을 때만 저장됩니다';
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
  const rg = rm ? rm.groups : null;
  let recurBlocked = null;
  if (rg && rg.md !== undefined) {
    const n = Number(rg.md);
    if (n < 1 || n > 31) recurBlocked = '매월 반복은 1~31일만 지정할 수 있습니다';
  }
  if (rm && !recurBlocked) {
    let rule;
    const ruleWarnings = [];
    if (rg.daily) rule = { kind: 'daily' };
    else if (rg.weekdays) rule = { kind: 'weekdays' };
    else if (rg.wd) {
      rule = { kind: 'weekly', weekday: WEEKDAY_KO.indexOf(rg.wd) };
      if (rg.more1 || rg.more2) ruleWarnings.push(`반복은 한 요일만 지원합니다. 첫 요일(${rg.wd})만 등록했습니다`);
    } else {
      rule = { kind: 'monthly', day: Number(rg.md) };
      if (rg.mmore) ruleWarnings.push(`반복은 하루만 지원합니다. 첫 날(${Number(rg.md)}일)만 등록했습니다`);
    }
    const rest = cut(main, rm.index, rm[0].length);
    const r = extractCore(rest, day, { stripEnd: true, noDue: true });
    const warnings = [...ruleWarnings, ...r.warnings];
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
    // '#N'은 문장 어디든 번호 — 단 '#' 바로 뒤가 숫자(공백 불가)이고 '#' 앞이 영문자·숫자·'#'이 아닐 때만
    // ('C# 3장 실습', 'F# 2회차'는 번호 아님). '#' 없는 'N번'은 키워드 전체가 그것뿐일 때만 번호('12번 완료').
    // '1번 과제 제출 완료', '3번 출구 사진 정리 끝'의 N번은 제목 키워드로 남긴다.
    const hm = /(?<![A-Za-z0-9#])#(\d+)(?:\s*번(?![가-힣\d]))?/.exec(kw) || /^\s*(\d+)\s*번\s*$/.exec(kw);
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

// 괄호 속성 '제출 X'의 X(엄격 형식): 공백 없는 한 단어, 2자 이상, 일반 낱말(전·후·완료·예정·마감·준비·검토·전달
// — 뒤에 '까지·일·됨' 같은 꼬리가 붙은 형태 포함: '전까지', '마감일', '완료됨')은 제외. '전임·후임·전무님'(사람)은 대상이다.
const NEXT_SUBMIT_NOT_TARGET_RE =
  /^(?:전|후|완료|예정|마감|준비|검토|전달)(?:까지|에는|에|엔|일|날|됨|함|중|용|본|분|하기|할|요)?$/;
function isNextSubmitValue(x) {
  const v = String(x ?? '');
  return /^\S+$/.test(v) && charLen(v) >= 2 && !NEXT_SUBMIT_NOT_TARGET_RE.test(v);
}

const NEXT_DUE_PART_RE = /^due\s*[:：]?\s*(\d{4}-\d{1,2}-\d{1,2})$/i;
const NEXT_SUBMIT_PART_RE = /^제출\s*[:：]?\s*(.+)$/;
const NEXT_EST_PART_RE = /^예상\s*[:：]?\s*(.+)$/;

/**
 * 'X (Due YYYY-MM-DD, 제출 Y, p1, 예상 N시간)' 형식의 끝 괄호 해석. v 는 collapse 된 문자열. 두 단계로 본다.
 *  (1) 쉼표로 나눈 모든 부분이 엄격 형식이면 속성:
 *      'Due YYYY-MM-DD'(실존 날짜) / 'p1' / 'p3' / '예상 <예상 형식 전체>' / '제출 <isNextSubmitValue>'
 *  (2) 엄격 형식이 아닌 부분이 있어도, 확실한 속성(실존 Due·p1·p3·예상 형식)이 하나라도 있으면 저장 형식으로 보고
 *      예전에 저장한 값과 같은 너그러운 해석을 한다: '제출 <아무 값>'(제출 팀, 제출 김 과장), 'p2'(무시), '예상 <아무 값>'(예상 반나절).
 *  그 밖('(제출 전 검토)', '(예상 질문 정리)', '(due diligence)', '(p2)', '(제출 팀)')은 null — 일반 제목 텍스트.
 * 반환:
 *  - 속성: {title, due, submitTo, priority, estimate, badDue: null, keep: null}
 *  - 저장 형식으로 보이지만 속성으로 쓸 수 없음(실존하지 않는 Due, 또는 확실한 속성 옆에 모르는 부분): {badDue, keep: {head, paren}}
 *    — 호출부는 괄호 밖(head)에서만 추출하고 괄호는 제목에 그대로 둔다('X (Due , …)' 같은 잔재 방지).
 */
function parseNextAttrs(v) {
  const m = /^(.*\S)\s*\(([^()]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[2].split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const t = { due: null, submitTo: null, priority: 'p2', estimate: null };
  let badDue = null;
  let anchor = false; // 확실한 속성이 있음
  let loose = false; // 엄격 형식은 아니지만 예전 저장 형식으로는 읽히는 부분이 있음
  let unknown = false; // 속성으로 읽을 수 없는 부분이 있음
  for (const p of parts) {
    let mm;
    if ((mm = NEXT_DUE_PART_RE.exec(p))) {
      if (isValidYMD(mm[1])) {
        t.due = mm[1];
        anchor = true;
      } else badDue = mm[1];
    } else if (/^p[13]$/i.test(p)) {
      t.priority = p.toLowerCase();
      anchor = true;
    } else if (/^p2$/i.test(p)) {
      loose = true;
    } else if ((mm = NEXT_EST_PART_RE.exec(p))) {
      const est = estimateValue(mm[1]);
      if (est) anchor = true;
      else loose = true;
      t.estimate = est || mm[1].trim();
    } else if ((mm = NEXT_SUBMIT_PART_RE.exec(p))) {
      t.submitTo = mm[1].trim();
      if (!isNextSubmitValue(t.submitTo)) loose = true;
    } else {
      unknown = true;
    }
  }
  const keep = { head: m[1].trim(), paren: `(${m[2]})` };
  if (badDue) return { badDue, keep };
  if (unknown) return anchor ? { badDue: null, keep } : null;
  if (loose && !anchor) return null;
  return { title: m[1].trim(), ...t, badDue: null, keep: null };
}

/** 괄호를 제목에 그대로 둘 때: 괄호 밖에서 뽑은 제목 + 원래 괄호 */
function titleWithParen(title, paren) {
  return collapse(`${title} ${sanitizeText(paren)}`);
}

export function parseNextValue(value, today) {
  const v = collapse(value ?? '');
  if (!v) return null;
  const a = parseNextAttrs(v);
  if (a && !a.keep) {
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
  const r = extractCore(a ? a.keep.head : v, normToday(today), { stripEnd: true });
  if (a) return { ...r.task, title: titleWithParen(r.task.title, a.keep.paren) };
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

// 마크다운 제목 줄(# ~ ######)
const HEADING_LINE_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * 본문의 마감(Due) 줄만 바꾼다(홈페이지 [✏ 변경]). due: 'YYYY-MM-DD'(실존 날짜) 또는 null(마감 없음), 그 밖은 TypeError.
 * 줄 판정은 parseBody 와 같다(CHECK_RE 를 먼저 보고, 체크리스트가 아닌 줄만 BODY_KEY_RE — 대소문자·전각 콜론 포함).
 * - 바꾸기: parseBody 가 Due 로 읽는 바로 그 줄(첫 `Due:` 키 줄 — 값이 잘못돼 마감이 없던 줄 포함)을 `Due: YYYY-MM-DD` 로.
 * - 넣기(Due 키 줄이 없을 때): `반복:` 줄 바로 뒤 → 없으면 첫 키 줄(완료 기준·제출·예상·다음·메모) 바로 앞 → 키 줄이 없으면 맨 앞
 *   (본문이 비었으면 `Due: X` 만, 첫 줄이 `#` 제목이면 사이에 빈 줄 하나). 넣는 줄바꿈은 본문의 첫 줄바꿈 형식(없으면 \n).
 * - 지우기(null): 그 줄을 줄바꿈째 지운다(빈 줄을 남기지 않음, 마지막 줄이면 앞 줄바꿈을 지움). 없으면 본문 그대로.
 *   손으로 고친 본문에 `Due:` 키 줄이 여럿이면 뒤 줄이 새로 읽히지 않도록 모두 지운다.
 * - 그 밖의 줄(회차 표지 `메모: 반복원본: #N / 회차: …`, `다음: … (Due …)`, 하위 작업)과 줄바꿈(\r\n / \n / \r)은 한 글자도 바꾸지 않는다.
 * 성질: parseBody(setDueInBody(b, d)).due === d 이고 나머지 parseBody 필드는 그대로다. body 가 null·undefined 면 빈 본문으로 본다.
 */
export function setDueInBody(body, due) {
  if (!(due === null || (typeof due === 'string' && isValidYMD(due)))) {
    throw new TypeError(`마감은 'YYYY-MM-DD'(실존 날짜) 또는 null 이어야 합니다: ${String(due)}`);
  }
  const text = body === null || body === undefined ? '' : String(body);
  // 줄과 줄바꿈 문자를 분리해 보존: [줄, 구분자, 줄, 구분자, ..., 줄] (toggleChecklist 와 같은 방식)
  const parts = text.split(/(\r\n|\n|\r)/);
  const dueAt = [];
  let recurAt = -1;
  let firstKeyAt = -1;
  for (let i = 0; i < parts.length; i += 2) {
    if (CHECK_RE.test(parts[i])) continue;
    const m = BODY_KEY_RE.exec(parts[i]);
    if (!m) continue;
    const key = keyName(m[1]);
    if (!key) continue;
    if (firstKeyAt < 0) firstKeyAt = i;
    if (key === 'due') dueAt.push(i);
    else if (key === 'recurrence' && recurAt < 0) recurAt = i;
  }

  if (due === null) {
    if (!dueAt.length) return text;
    // 뒤에서부터 지운다(앞쪽 인덱스가 바뀌지 않게)
    for (let k = dueAt.length - 1; k >= 0; k -= 1) {
      const i = dueAt[k];
      if (i + 1 < parts.length) parts.splice(i, 2); // 줄 + 뒤 줄바꿈
      else if (i > 0) parts.splice(i - 1, 2); // 마지막 줄: 앞 줄바꿈 + 줄
      else parts.splice(0, 1, ''); // 유일한 줄
    }
    return parts.join('');
  }

  const line = `Due: ${due}`;
  if (dueAt.length) {
    parts[dueAt[0]] = line;
    return parts.join('');
  }
  const nl = parts.length > 1 ? parts[1] : '\n';
  if (recurAt >= 0) {
    parts.splice(recurAt + 1, 0, nl, line);
    return parts.join('');
  }
  if (firstKeyAt >= 0) {
    parts.splice(firstKeyAt, 0, line, nl);
    return parts.join('');
  }
  if (text === '') return line;
  return HEADING_LINE_RE.test(parts[0]) ? `${line}${nl}${nl}${text}` : `${line}${nl}${text}`;
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

const PRIORITY_LABELS = ['p1', 'p2', 'p3'];

/**
 * 라벨 이름 배열에서 우선순위 라벨(p1·p2·p3)을 모두 빼고 priority 하나만 넣은 새 배열(홈페이지 [✏ 변경]).
 * - 다른 라벨은 순서 그대로 둔다. priority 는 원래 첫 p 라벨 자리에, p 라벨이 없었으면 맨 앞(taskLabels 순서)에 넣는다.
 * - 이름 대신 라벨 객체({name})가 섞여 있어도 이름으로 읽는다. null·undefined 는 빈 배열로 본다. 입력 배열은 바꾸지 않는다.
 * - priority 가 'p1'|'p2'|'p3' 가 아니면(또는 이름 배열이 배열이 아니면) TypeError.
 */
export function withPriorityLabel(names, priority) {
  if (!PRIORITY_LABELS.includes(priority)) {
    throw new TypeError(`우선순위는 p1·p2·p3 중 하나여야 합니다: ${String(priority)}`);
  }
  if (names !== null && names !== undefined && !Array.isArray(names)) {
    throw new TypeError('라벨 이름은 배열이어야 합니다');
  }
  const out = [];
  let placed = false;
  for (const l of names || []) {
    const name = typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : '';
    if (!name) continue;
    if (PRIORITY_LABELS.includes(name)) {
      if (!placed) out.push(priority);
      placed = true;
      continue;
    }
    out.push(name);
  }
  if (!placed) out.unshift(priority);
  return out;
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
  const edge = (ch) => TOKEN_EDGE.has(ch);
  const optional = tokens.map((t) => PRIORITY_ONLY_TOKEN_RE.test(trimEndWhile(trimStartWhile(t, edge), edge)));

  const candidates = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isTask(issue)) continue;
    if ((issue.state ?? 'open') !== 'open') continue;
    const title = String(issue.title ?? '').toLowerCase().replace(/\s+/g, '');
    let score = 0;
    // need: 이 제목이 명확(clear)하려면 맞아야 하는 토큰 수 — 제목에 없는 우선순위 낱말은 빼고 센다
    let need = tokens.length;
    tokens.forEach((t, i) => {
      if (title.includes(t)) score += 1;
      // 끝 조사 1개 떼기: 뗀 뒤 2자 이상 남는 토큰(3자 이상)만 — '회의'→'회', '문의'→'문' 같은 1자 어간으로는 점수 없음
      else if (charLen(t) >= 3 && PARTICLES.has(t.slice(-1)) && title.includes(t.slice(0, -1))) score += 1;
      else if (optional[i]) need -= 1;
    });
    if (score > 0) candidates.push({ issue, score, need });
  }
  candidates.sort((a, b) => b.score - a.score || (Number(a.issue.number) || 0) - (Number(b.issue.number) || 0));
  let clear = null;
  if (candidates.length) {
    const top = candidates[0].score;
    const tied = candidates.filter((c) => c.score === top).length;
    if (tied === 1 && top === candidates[0].need) clear = candidates[0].issue;
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
