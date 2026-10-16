/**
 * docs/app.js — 할 일 홈페이지 (할 일 = GitHub Issue, 완료 = Close)
 *
 * - GitHub REST API(api.github.com)만 호출한다. 토큰은 이 브라우저 localStorage에만 저장한다.
 * - 화면은 createElement + textContent로만 그린다(HTML 문자열을 해석하는 API는 쓰지 않는다).
 * - Node에서 import해도 안전하다: DOM·localStorage 접근은 boot() 안에서만 한다.
 * - 토큰은 어떤 경우에도 콘솔·화면·오류 메시지에 출력하지 않는다.
 */
import {
  WEEKDAY_KO,
  todayKST,
  addDays,
  weekdayOf,
  startOfWeek,
  kstMidnightISO,
  toKSTDate,
  formatDue,
  formatRecurrence,
  parseRecurrenceValue,
  isValidYMD,
} from './dates.js';
import {
  SOS_COMMENT,
  COMPLETE_COMMENT,
  DEFAULT_MEMO,
  parse,
  taskLabels,
  formatNextValue,
  parseNextValue,
  buildBody,
  parseBody,
  checklistProgress,
  toggleChecklist,
  sanitizeText,
  isTask,
  labelNames,
  priorityOf,
  groupIssues,
  isCompletedThisWeek,
  matchCandidates,
  shouldSuggestReplyCheck,
  setDueInBody,
  withPriorityLabel,
  groupsOf,
  setBodyField,
  setSubtasks,
  splitMemoMarker,
  joinMemoMarker,
  normalizeBodyField,
  normalizeSubtasks,
  stripInstanceMarkers,
  BODY_FIELD_MAX_CHARS,
  SUBTASK_MAX_CHARS,
} from './parser.js';

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────
export const OWNER = 'LEEYONGJAE-1';
export const REPO = 'my-todo';
export const ISSUE_URL_BASE = `https://github.com/${OWNER}/${REPO}/issues/`;
export const TOKEN_GUIDE_URL = 'https://github.com/settings/personal-access-tokens/new';
export const SOS_INTERVAL_MS = 10 * 60 * 1000; // 🆘 연타 방지: 1회/항목/10분
export const UNDO_MS = 5000; // 완료 되돌리기 가능 시간
export const REPLY_CHECK_LABEL = '회신 확인도 등록할까요? (3일 뒤 마감, 대기 중)';

const REQUEST_TIMEOUT_MS = 30000;
const MAX_PAGES = 50;
const RECENT_WINDOW_MS = 120000; // 목록 지연(최대 약 60초) 동안 방금 바꾼 항목은 로컬 상태 우선
const TOKEN_KEY = 'my-todo.token';
const PROJECT_KEY = 'my-todo.project';
const SOS_KEY_PREFIX = 'my-todo.sos.';

const labelEntry = (color, description) => Object.freeze({ color, description });
export const LABEL_DEFS = Object.freeze({
  p1: labelEntry('d73a4a', '오늘/긴급'),
  p2: labelEntry('fbca04', '이번 주'),
  p3: labelEntry('0e8a16', '언젠가'),
  'area:work': labelEntry('1d76db', '업무'),
  'area:personal': labelEntry('c5def5', '개인'),
  stuck: labelEntry('5319e7', '막힘'),
  waiting: labelEntry('f9d0c4', '회신·타인 대기'),
  recurring: labelEntry('006b75', '반복 규칙 원본'),
  briefing: labelEntry('cccccc', '아침 브리핑'),
  hidden: labelEntry('bfbfbf', '완료 목록에서 숨김'), // 닫힌 이슈 전용: 홈페이지 "이번 주 완료한 일"의 [지우기]
});
export const PROJECT_LABEL_DEF = labelEntry('d4c5f9', '프로젝트');

/** 라벨 이름 → {name, color, description}. proj:* 는 프로젝트 색. */
export function labelDef(name) {
  const n = String(name ?? '');
  if (Object.prototype.hasOwnProperty.call(LABEL_DEFS, n)) return { name: n, ...LABEL_DEFS[n] };
  if (n.startsWith('proj:')) return { name: n, ...PROJECT_LABEL_DEF };
  return { name: n, color: 'ededed', description: '' };
}

// ─────────────────────────────────────────────────────────────
// 오류
// ─────────────────────────────────────────────────────────────
export const MSG = Object.freeze({
  network: '네트워크 오류: 인터넷 연결을 확인한 뒤 다시 시도하세요.',
  timeout: '응답이 너무 늦어 요청을 중단했습니다. 네트워크를 확인한 뒤 다시 시도하세요.',
  noToken: 'GitHub 토큰이 없습니다. ⚙ 설정에서 토큰을 저장하세요.',
  unauthorized: '토큰이 올바르지 않거나 만료되었습니다. ⚙ 설정에서 새 토큰을 저장하세요.',
  rateLimited: 'GitHub API 사용량 제한에 걸렸습니다. 잠시 후 다시 시도하세요.',
  forbidden:
    '권한이 없습니다. 토큰에 my-todo 저장소의 Issues 읽기·쓰기(Read and write) 권한이 있는지 확인하세요.',
  notFound:
    '저장소를 찾을 수 없거나 접근 권한이 없습니다. 토큰을 만들 때 my-todo 저장소를 선택했는지 확인하세요.',
  gone: '삭제되었거나 이슈 기능이 꺼진 항목입니다.',
  unprocessable: '입력값 오류: GitHub가 요청을 받아들이지 않았습니다. 입력 내용을 확인하세요.',
  badResponse: 'GitHub 응답을 해석하지 못했습니다. 잠시 후 다시 시도하세요.',
  blockedUrl: '허용되지 않은 주소로의 요청을 막았습니다.',
  tooManyPages: '목록이 너무 많아 모두 불러오지 못했습니다.',
  bodyChanged: '본문이 바뀌었습니다. 새로고침 후 다시 시도하세요',
  alreadyClosed: '이미 완료된 할 일입니다(다른 곳에서 처리됨). 목록을 새로고침하세요.',
  applyClosed: '이미 완료된 할 일이라 하위 작업을 반영하지 않았습니다.',
  hideOpen: '아직 완료되지 않은 할 일은 지울 수 없습니다',
  hiddenKept: '완료는 됐지만 남아 있던 hidden 라벨(완료 목록에서 숨김)을 떼지 못해 "이번 주 완료한 일" 목록에는 보이지 않습니다. GitHub에서 hidden 라벨을 떼면 다시 보입니다.',
  metaClosed: '이미 완료된 할 일입니다', // [✏ 변경] 최신 상태가 닫힘(409)
  metaNotTask: '할 일이 아니라 바꿀 수 없습니다', // [✏ 변경] PR·recurring·briefing(400)
  metaBadDue: '마감 날짜가 올바르지 않습니다(YYYY-MM-DD)',
  // [✏ 변경] 세부 내용(완료 기준·메모·하위 작업) 충돌(409, kind 'conflict' — '이미 완료된 할 일입니다' 409(kind 'closed')와 구분)
  metaConflict: '다른 곳에서 이 할 일의 세부 내용이 바뀌었습니다',
  unexpected: '처리 중 예기치 못한 오류가 발생했습니다. 새로고침 후 다시 시도하세요.',
});

/** 사용자에게 그대로 보여 줄 한국어 메시지를 가진 오류. status: HTTP 상태(네트워크 오류 0, 로컬 검증 400/409). */
export class ApiError extends Error {
  constructor(message, status = 0, info = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = Array.isArray(info.errors) ? info.errors : [];
    this.githubMessage = typeof info.githubMessage === 'string' ? info.githubMessage : '';
    // 화면이 목록을 정리할 수 있도록 서버의 최신 이슈를 담을 수 있다(예: 이미 닫힌 이슈 409).
    if (info.issue && typeof info.issue === 'object') this.issue = info.issue;
    // 같은 상태 코드의 오류를 구분하는 표시: [✏ 변경]의 409 는 'closed'(이미 완료) / 'conflict'(세부 내용 충돌), 400 은 'notTask'.
    if (typeof info.kind === 'string' && info.kind) this.kind = info.kind;
    // kind 'conflict': 다른 곳에서 바뀐 칸 ['criteria'|'memo'|'subtasks', …]
    if (Array.isArray(info.conflicts)) this.conflicts = info.conflicts.slice();
  }
}

function errorText(e) {
  return e instanceof ApiError ? e.message : MSG.unexpected;
}

function getHeader(res, name) {
  const hs = res && res.headers;
  if (!hs) return null;
  if (typeof hs.get === 'function') return hs.get(name);
  const want = name.toLowerCase();
  for (const k of Object.keys(hs)) if (k.toLowerCase() === want) return hs[k];
  return null;
}

/** 응답 본문 JSON. 본문 없음 → null, 해석 불가 → undefined. */
async function readJson(res) {
  if (!res || Number(res.status) === 204) return null;
  if (typeof res.text === 'function') {
    const t = await res.text();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (typeof res.json === 'function') {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  return null;
}

function messageForStatus(status, data, res, ctx) {
  const gh = data && typeof data.message === 'string' ? data.message : '';
  if (status === 401) return MSG.unauthorized;
  if (status === 403 || status === 429) {
    const limited =
      status === 429 ||
      getHeader(res, 'x-ratelimit-remaining') === '0' ||
      getHeader(res, 'retry-after') != null ||
      /rate limit/i.test(gh);
    return limited ? MSG.rateLimited : MSG.forbidden;
  }
  if (status === 404) return ctx.notFound || MSG.notFound;
  if (status === 410) return MSG.gone;
  if (status === 422) return ctx.unprocessable || MSG.unprocessable;
  if (status >= 500) return `GitHub 서버 오류(${status})입니다. 잠시 후 다시 시도하세요.`;
  return `GitHub 요청이 실패했습니다(HTTP ${status}).`;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function positiveInt(n, what = '이슈 번호') {
  const x = Number(n);
  if (!Number.isSafeInteger(x) || x <= 0) throw new ApiError(`잘못된 ${what}입니다.`, 400);
  return x;
}

/** Link 헤더에서 rel="next" URL을 찾는다. 없으면 null. */
export function parseNextLink(header) {
  if (!header) return null;
  const re = /<([^>]*)>([^<]*)/g;
  let m;
  while ((m = re.exec(String(header)))) {
    const rel = /rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2]);
    if (rel && (rel[1] ?? rel[2]).split(/\s+/).includes('next')) return m[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GitHub REST API
// ─────────────────────────────────────────────────────────────
export function createApi({ token, fetchImpl = globalThis.fetch, base = 'https://api.github.com' } = {}) {
  const apiBase = String(base || 'https://api.github.com').replace(/\/+$/, '');
  const apiOrigin = originOf(apiBase);
  const repoPath = `/repos/${OWNER}/${REPO}`;
  const doFetch = fetchImpl;

  async function request(method, target, { body, notFound, unprocessable } = {}) {
    if (!token) throw new ApiError(MSG.noToken, 401);
    if (typeof doFetch !== 'function') throw new ApiError(MSG.network, 0);
    const url = /^https?:\/\//i.test(target) ? target : apiBase + target;
    // 토큰이 api.github.com(또는 지정한 base) 밖으로 나가지 않도록 막는다.
    if (!apiOrigin || originOf(url) !== apiOrigin) throw new ApiError(MSG.blockedUrl, 0);

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (method === 'GET') init.cache = 'no-store';

    let timer = null;
    let timedOut = false;
    if (typeof AbortController === 'function') {
      const ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, REQUEST_TIMEOUT_MS);
    }
    try {
      let res;
      try {
        res = await doFetch(url, init);
      } catch {
        throw new ApiError(timedOut ? MSG.timeout : MSG.network, 0);
      }
      if (!res || typeof res !== 'object') throw new ApiError(MSG.badResponse, 0);
      const status = Number(res.status) || 0;
      const ok = typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
      let data;
      try {
        data = await readJson(res);
      } catch {
        if (timedOut) throw new ApiError(MSG.timeout, 0);
        data = undefined;
      }
      if (!ok) {
        throw new ApiError(messageForStatus(status, data, res, { notFound, unprocessable }), status, {
          errors: data && data.errors,
          githubMessage: data && data.message,
        });
      }
      if (data === undefined) throw new ApiError(MSG.badResponse, status);
      return { data, res };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function paginate(first) {
    const out = [];
    let url = first;
    for (let page = 0; url; page += 1) {
      if (page >= MAX_PAGES) throw new ApiError(MSG.tooManyPages, 0);
      const { data, res } = await request('GET', url);
      if (!Array.isArray(data)) throw new ApiError(MSG.badResponse, 0);
      out.push(...data);
      url = parseNextLink(getHeader(res, 'link'));
    }
    return out;
  }

  const onlyIssues = (list) => list.filter((i) => i && typeof i === 'object' && !i.pull_request);
  const issuePath = (n) => `${repoPath}/issues/${positiveInt(n)}`;
  async function updateIssue(n, patch) {
    const { data } = await request('PATCH', issuePath(n), {
      body: patch,
      notFound: `#${n} 할 일을 찾을 수 없습니다(없는 번호이거나 접근 권한이 없습니다).`,
    });
    return data;
  }

  return {
    async listOpenIssues() {
      return onlyIssues(await paginate(`${repoPath}/issues?state=open&per_page=100`));
    },
    async listClosedSince(isoSince) {
      let q = `${repoPath}/issues?state=closed&per_page=100`;
      if (isoSince) q += `&since=${encodeURIComponent(isoSince)}`;
      return onlyIssues(await paginate(q));
    },
    // (아침 작업 scripts/daily.mjs 용) isoSince 이후 updated 된 이슈. state: 'open'|'closed'|'all'(기본). PR 제외.
    async listIssuesSince(isoSince, state = 'all') {
      const st = ['open', 'closed', 'all'].includes(state) ? state : 'all';
      let q = `${repoPath}/issues?state=${st}&per_page=100`;
      if (isoSince) q += `&since=${encodeURIComponent(isoSince)}`;
      return onlyIssues(await paginate(q));
    },
    // (아침 작업 scripts/daily.mjs 용) 이슈 이벤트(labeled/unlabeled 등) 전체, 오래된 것부터.
    async listIssueEvents(n) {
      return paginate(`${issuePath(n)}/events?per_page=100`);
    },
    // 이슈 댓글 전체(오래된 것부터). 🆘 Claude 답변 확인용.
    async listComments(n) {
      return paginate(`${issuePath(n)}/comments?per_page=100`);
    },
    async getIssue(n) {
      const { data } = await request('GET', issuePath(n), {
        notFound: `#${n} 할 일을 찾을 수 없습니다(없는 번호이거나 접근 권한이 없습니다).`,
      });
      return data;
    },
    async createIssue({ title, body, labels } = {}) {
      const payload = { title, body };
      if (Array.isArray(labels)) payload.labels = labels;
      const { data } = await request('POST', `${repoPath}/issues`, { body: payload });
      return data;
    },
    updateIssue,
    closeIssue(n, stateReason = 'completed') {
      return updateIssue(n, { state: 'closed', state_reason: stateReason });
    },
    reopenIssue(n) {
      return updateIssue(n, { state: 'open' });
    },
    async addComment(n, body) {
      const { data } = await request('POST', `${issuePath(n)}/comments`, { body: { body } });
      return data;
    },
    async deleteComment(commentId) {
      await request('DELETE', `${repoPath}/issues/comments/${positiveInt(commentId, '댓글 번호')}`, {
        notFound: '삭제할 댓글을 찾을 수 없습니다.',
      });
      return null;
    },
    async listLabels() {
      return paginate(`${repoPath}/labels?per_page=100`);
    },
    async createLabel({ name, color, description } = {}) {
      const payload = { name, color: String(color || 'ededed').replace(/^#/, '') };
      if (description) payload.description = description;
      try {
        const { data } = await request('POST', `${repoPath}/labels`, {
          body: payload,
          unprocessable: `라벨을 만들 수 없습니다: ${name} — 이름이 너무 길거나(50자 이하) 쓸 수 없는 문자가 있는지 확인하세요.`,
        });
        return data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 422 && e.errors.some((x) => x && x.code === 'already_exists')) {
          return { name, color: payload.color, description: payload.description ?? '', alreadyExists: true };
        }
        throw e;
      }
    },
    async addLabels(n, labels) {
      const { data } = await request('POST', `${issuePath(n)}/labels`, { body: { labels } });
      return data;
    },
    async removeLabel(n, name) {
      try {
        const { data } = await request('DELETE', `${issuePath(n)}/labels/${encodeURIComponent(name)}`);
        return data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    async testConnection() {
      const { data } = await request('GET', repoPath);
      return data;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 할 일 동작 (UI 없이 api만 사용 — 테스트 가능)
// ─────────────────────────────────────────────────────────────
function projectsOf(labels) {
  return labels.filter((l) => typeof l === 'string' && l.startsWith('proj:') && l.length > 5).map((l) => l.slice(5));
}

/** 없는 라벨만 만든다(이슈 생성 전에 호출). cache: 존재가 확인된 라벨 이름 Set(소문자) 또는 null. */
export async function ensureLabels(api, names, cache = null) {
  const wanted = [...new Set((names || []).filter((n) => typeof n === 'string' && n))];
  const known = (n) => Boolean(cache) && (cache.has(n) || cache.has(n.toLowerCase()));
  let missing = wanted.filter((n) => !known(n));
  if (!missing.length) return;
  if (typeof api.listLabels === 'function') {
    const existing = await api.listLabels();
    const have = new Set();
    for (const l of existing || []) {
      const nm = typeof l === 'string' ? l : l && l.name;
      if (typeof nm === 'string' && nm) {
        have.add(nm.toLowerCase());
        if (cache) cache.add(nm.toLowerCase());
      }
    }
    missing = missing.filter((n) => !have.has(n.toLowerCase()));
  }
  for (const n of missing) {
    await api.createLabel(labelDef(n));
    if (cache) cache.add(n.toLowerCase());
  }
  if (cache) for (const n of wanted) cache.add(n.toLowerCase());
}

/** Task를 이슈로 등록. 라벨을 먼저 만들고, 제목은 sanitize, 본문은 buildBody. */
export async function registerTask(
  api,
  task,
  { waiting = false, recurring = null, next = null, memo = DEFAULT_MEMO, labelCache = null } = {},
) {
  if (!task) throw new ApiError('등록할 할 일이 없습니다.', 400);
  const title = sanitizeText(String(task.title ?? '')).trim();
  if (!title) throw new ApiError('할 일 내용이 없습니다.', 400);
  const labels = taskLabels(task, { waiting: Boolean(waiting), recurring: Boolean(recurring) });
  await ensureLabels(api, labels, labelCache);
  const body = buildBody({
    recurrence: recurring ? formatRecurrence(recurring) : undefined,
    due: recurring ? null : (task.due ?? null),
    submitTo: task.submitTo ?? null,
    estimate: task.estimate ?? null,
    next: next ? formatNextValue(next) : null,
    memo,
  });
  return api.createIssue({ title, body, labels });
}

/** close 요청 실패가 "서버에서는 닫혔을 수도 있는" 경우인지: 네트워크·시간 초과(0), 응답 해석 실패(2xx), 서버 오류(5xx) */
function closeOutcomeUncertain(e) {
  if (!(e instanceof ApiError)) return true;
  const st = e.status;
  return st === 0 || (st >= 200 && st < 300) || st >= 500;
}

/**
 * 완료: 최신 상태 확인(GET) → 댓글 → close(completed) → `다음:` 있으면 다음 단계 등록(상속) → 회신 확인 제안 여부.
 * 화면 목록은 새로고침 전까지(또는 목록 응답 지연으로) 낡을 수 있으므로, 댓글을 달기 전에 단건 조회로 확인한다.
 * 서버에서 이미 닫혀 있으면 댓글·close·다음 단계 없이 ApiError(409, MSG.alreadyClosed)를 던지고, 오류의 issue 에 최신 이슈를 담는다.
 * close 요청이 실패하면:
 *   - 결과가 불확실한 오류(네트워크·응답 해석 실패·5xx)는 단건 조회로 다시 확인해, 이미 닫혔으면 정상 완료로 계속한다.
 *   - 닫히지 않았음이 확실할 때(4xx 거부, 또는 재조회 결과 open)만 방금 단 완료 댓글을 지우고 오류를 던진다.
 *   - 재조회도 실패하면 댓글은 그대로 두고(닫혔을 수 있으므로) 오류를 던진다.
 * 다음 단계 등록 실패는 완료를 유지하고 nextError(한국어)로 알린다.
 * 닫은 이슈에 예전 [지우기]의 hidden 라벨이 남아 있으면(다시 연 이슈) 떼어 완료 목록에 보이게 한다(404 무시).
 * 떼지 못하면 완료는 유지하고 hiddenError(한국어)로 알린다.
 */
export async function completeIssue(api, issue, today, { labelCache = null } = {}) {
  if (!issue || !Number.isInteger(issue.number)) throw new ApiError('완료할 할 일을 찾을 수 없습니다.', 400);
  if (issue.state === 'closed') throw new ApiError(`#${issue.number}은(는) 이미 완료된 할 일입니다.`, 409);
  const n = issue.number;

  const latest = await api.getIssue(n);
  if (!latest || typeof latest !== 'object') throw new ApiError(MSG.badResponse, 0);
  if (latest.state === 'closed') throw new ApiError(MSG.alreadyClosed, 409, { issue: latest });

  const comment = await api.addComment(n, COMPLETE_COMMENT);
  let closed;
  try {
    closed = await api.closeIssue(n, 'completed');
  } catch (e) {
    let notClosed = !closeOutcomeUncertain(e);
    if (!notClosed) {
      try {
        const fresh = await api.getIssue(n);
        if (fresh && typeof fresh === 'object' && fresh.state === 'closed') closed = fresh;
        else if (fresh && typeof fresh === 'object' && fresh.state === 'open') notClosed = true;
      } catch {
        /* 재조회 실패: 닫혔는지 알 수 없음 → 댓글을 지우지 않는다 */
      }
    }
    if (!closed) {
      if (notClosed && comment && comment.id != null) {
        try {
          await api.deleteComment(comment.id);
        } catch {
          /* 댓글 정리 실패는 무시하고 원래 오류를 알린다 */
        }
      }
      throw e;
    }
  }

  // close 응답이 최신 본문·라벨을 담고 있으므로 그것을 우선한다(없으면 방금 조회한 최신 이슈).
  const merged = { ...issue, ...latest, ...(closed && typeof closed === 'object' ? closed : {}), state: 'closed' };
  if (!merged.closed_at) merged.closed_at = new Date().toISOString();
  if (merged.state_reason == null) merged.state_reason = 'completed';

  // 예전에 완료 목록에서 지웠다가(hidden) 다시 연 이슈: 이번 완료는 지운 적이 없으므로 남은 hidden 을 떼어 목록에 보이게 한다.
  let hiddenRemoved = false;
  let hiddenError = null;
  if (isHiddenDone(merged)) {
    try {
      const labels = await api.removeLabel(n, HIDDEN_LABEL);
      merged.labels = Array.isArray(labels) ? labels : withoutLabel(merged.labels, HIDDEN_LABEL);
      hiddenRemoved = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        merged.labels = withoutLabel(merged.labels, HIDDEN_LABEL);
        hiddenRemoved = true;
      } else hiddenError = `${MSG.hiddenKept} ${errorText(e)}`;
    }
  }

  const fields = parseBody(merged.body);
  let nextIssue = null;
  let nextError = null;
  if (fields.next) {
    try {
      const nextTask = parseNextValue(fields.next, today);
      if (nextTask && String(nextTask.title ?? '').trim()) {
        const srcLabels = labelNames(merged);
        const inherited = {
          ...nextTask,
          priority: nextTask.priority || 'p2',
          area:
            nextTask.area === 'area:personal' || srcLabels.includes('area:personal')
              ? 'area:personal'
              : nextTask.area || 'area:work',
          project: nextTask.project || projectsOf(srcLabels)[0] || null,
          submitTo: nextTask.submitTo || fields.submitTo || null,
        };
        // 다음 단계는 1단계만(연쇄 없음) → next 없이 등록
        nextIssue = await registerTask(api, inherited, { memo: `이전 단계: #${n}`, labelCache });
      } else {
        nextError = `다음 단계 내용을 해석하지 못해 자동 등록하지 않았습니다: ${fields.next}`;
      }
    } catch (e) {
      nextError = `다음 단계 등록에 실패했습니다(완료는 유지됨): ${errorText(e)}`;
    }
  }
  return {
    issue: merged,
    comment,
    nextIssue,
    suggestReply: Boolean(shouldSuggestReplyCheck(merged)),
    nextError,
    hiddenRemoved,
    hiddenError,
  };
}

/**
 * 되돌리기: reopen → 완료 댓글 삭제 → 자동 등록된 다음 단계 close(not_planned)
 * → (완료 직후 제안 버튼으로 등록한 회신 확인 result.replyIssue 가 있으면) 그것도 close(not_planned).
 * 부분 실패는 errors에 담는다.
 */
export async function undoComplete(api, result) {
  const original = result && result.issue;
  if (!original || !Number.isInteger(original.number)) throw new ApiError('되돌릴 할 일을 찾을 수 없습니다.', 400);
  const reopened = await api.reopenIssue(original.number);
  const issue = {
    ...original,
    ...(reopened && typeof reopened === 'object' ? reopened : {}),
    state: 'open',
    closed_at: null,
  };
  if (!reopened || reopened.state_reason === undefined) issue.state_reason = null;

  const errors = [];
  if (result.comment && result.comment.id != null) {
    try {
      await api.deleteComment(result.comment.id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        errors.push(`완료 댓글을 지우지 못했습니다: ${errorText(e)}`);
      }
    }
  }
  let nextIssue = null;
  const next = result.nextIssue;
  if (next && Number.isInteger(next.number)) {
    try {
      const c = await api.closeIssue(next.number, 'not_planned');
      nextIssue = {
        ...next,
        ...(c && typeof c === 'object' ? c : {}),
        state: 'closed',
        state_reason: 'not_planned',
      };
    } catch (e) {
      errors.push(`자동 등록된 다음 단계 #${next.number}을(를) 닫지 못했습니다: ${errorText(e)}`);
    }
  }
  let replyIssue = null;
  const reply = result.replyIssue;
  if (reply && Number.isInteger(reply.number)) {
    try {
      const c = await api.closeIssue(reply.number, 'not_planned');
      replyIssue = {
        ...reply,
        ...(c && typeof c === 'object' ? c : {}),
        state: 'closed',
        state_reason: 'not_planned',
      };
    } catch (e) {
      errors.push(`등록했던 회신 확인 #${reply.number}을(를) 닫지 못했습니다: ${errorText(e)}`);
    }
  }
  return { issue, nextIssue, replyIssue, errors };
}

/** 회신 확인 등록(가정 19): `<원제목> 회신 확인`, Due 오늘+3일, waiting, p2, 영역·프로젝트·제출 상속. */
export async function registerReplyCheck(api, issue, today, opts = {}) {
  if (!issue || !Number.isInteger(issue.number)) throw new ApiError('원래 할 일을 찾을 수 없습니다.', 400);
  const fields = parseBody(issue.body);
  const labels = labelNames(issue);
  const task = {
    title: `${String(issue.title ?? '').trim()} 회신 확인`,
    due: addDays(today, 3),
    priority: 'p2',
    area: labels.includes('area:personal') ? 'area:personal' : 'area:work',
    project: projectsOf(labels)[0] || null,
    submitTo: fields.submitTo || null,
    estimate: null,
  };
  return registerTask(api, task, {
    waiting: true,
    memo: `이전 단계: #${issue.number}`,
    labelCache: (opts && opts.labelCache) || null,
  });
}

/** 🆘 막막해요 / AI 분해 요청: 정해진 @claude 댓글을 단다. */
export async function requestDecompose(api, number) {
  return api.addComment(number, SOS_COMMENT);
}

// ─────────────────────────────────────────────────────────────
// 🆘 Claude 답변(댓글) — 순수 함수 (답글 본문은 신뢰할 수 없는 텍스트로 다룬다)
// ─────────────────────────────────────────────────────────────
export const REPLY_POLL_MS = 30 * 1000; // 🆘 후 자동 확인 간격
export const REPLY_WATCH_MS = 6 * 60 * 1000; // 🆘 후 자동 확인 최대 시간
// [✏ 변경] 날짜 칸에 입력하는 중이면 자동 확인(화면 다시 그리기)을 이만큼 미룬다 — 다시 그리면 날짜 칸이 새로 만들어져
// 덜 친 연·월·일이 사라지고 이어 치는 숫자가 엉뚱한 칸에 들어가기 때문
// (6차: 완료 기준·메모·하위 작업 글자 칸도 같다 — 다시 그리면 한글 조합 중인 글자가 끊긴다. 그 밖의 화면 다시 그리기도 이만큼씩 미룬다)
export const EDIT_DEFER_MS = 1500;
/** '입력 중'으로 보는 편집 패널 칸: 날짜, 완료 기준·메모·하위 작업 글자 칸 */
const EDIT_FIELD_SEL = 'form.edit-panel input[type="date"], form.edit-panel input[type="text"]';
export const REPLY_MAX_CHARS = 20000; // 화면에 그리는 답글 최대 길이
export const REPLY_TRUNCATED_TEXT = '…(GitHub에서 전체 보기)';
export const SAFE_LINK_PREFIX = 'https://github.com/';
const REPLY_MAX_ITEMS = 20;
const REPLY_ITEM_MAX_CHARS = 200;
const LINE_SPLIT_RE = /\r\n|\n|\r/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const MD_HEADING_RE = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const MD_HR_RE = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const MD_QUOTE_RE = /^\s{0,3}(?:>[ \t]?)+(.*)$/;
const MD_CHECK_RE = /^\s*[-*+][ \t]+\[( |x|X)\](?:[ \t]+(.*))?$/;
const MD_BULLET_RE = /^\s*[-*+][ \t]+(.*)$/;
const BOLD_LINE_RE = /^\s*\*\*(.+?)\*\*/; // 굵은 글씨로 시작하는 줄(**3. 하위 작업** 등)
const BOLD_NUMBER_RE = /^\s*\*\*\s*\d+\s*[.)]/; // 굵은 번호 줄(**4. 첫 행동** 등)
const BODY_CHECK_RE = /^\s*[-*]\s+\[( |x|X)\]\s+([^\r\n]*)$/; // parser.js 의 본문 체크리스트 형식과 같다

/** 하위 작업 비교용: @claude 치환 → 공백 정규화 → 대소문자 무시 */
function subtaskKey(s) {
  return sanitizeText(String(s ?? '')).replace(/\s+/g, ' ').trim().toLowerCase();
}

function cutChars(s, max) {
  const cps = Array.from(String(s));
  return cps.length > max ? cps.slice(0, max).join('') : String(s);
}

/** 링크 화이트리스트: https://github.com/ 로 시작하고 URL 로 해석했을 때 출처가 github.com 인 것만. 아니면 null. */
export function safeGithubUrl(href) {
  const h = typeof href === 'string' ? href : '';
  if (!h.startsWith(SAFE_LINK_PREFIX)) return null;
  if (/[\s\u0000-\u001f\u007f<>"'`\\]/.test(h)) return null;
  try {
    return new URL(h).origin === 'https://github.com' ? h : null;
  } catch {
    return null;
  }
}

/** Claude(GitHub 앱 claude[bot]) 댓글인지: user.type 이 Bot 이고 login 이 claude 또는 claude[bot](대소문자 무시). */
export function isClaudeComment(c) {
  const u = c && typeof c === 'object' ? c.user : null;
  if (!u || typeof u !== 'object') return false;
  return u.type === 'Bot' && typeof u.login === 'string' && /^claude(\[bot\])?$/i.test(u.login);
}

/**
 * 답글 상태: 첫 비어있지 않은 줄 기준. 'working' | 'error' | 'done'
 * claude-code-action 은 실행 중 Claude 가 같은 댓글을 머리줄 없이 통째로 바꿔 쓰고(진행 체크리스트 등),
 * 실행이 끝날 때만 "**Claude finished …**" / "**Claude encountered an error …**" 머리줄을 붙인다.
 * 그래서 머리줄이 없는 본문은 아직 작성 중으로 본다(중간 진행 목록을 답으로 알리거나 본문에 반영하지 않게).
 */
export function replyState(body) {
  let first = '';
  for (const line of String(body ?? '').split(LINE_SPLIT_RE)) {
    if (line.trim()) {
      first = line;
      break;
    }
  }
  // 처음 문구는 "Claude Code is working…" 이므로 ' Code' 도 허용한다.
  if (/Claude(?: Code)? (?:is )?working|작업 중/i.test(first)) return 'working';
  if (/encountered an error/i.test(first)) return 'error';
  if (/Claude finished/i.test(first)) return 'done';
  return 'working';
}

/** '작성 중' 답글이 이 시간 넘게 바뀌지 않으면 실행이 끝난 것으로 본다(claude.yml timeout-minutes 15 + 여유). */
export const STALE_WORKING_MS = 20 * 60 * 1000;

/**
 * Claude 댓글 중 updated_at 이 가장 늦은 것. since(ISO)가 있으면 created_at 또는 updated_at 이 since 이후(같은 시각 포함)인 것만.
 * → { id, html_url, body, created_at, updated_at, state, stale } 또는 null
 * 머리줄이 끝내 붙지 않은 답글(실행이 중간에 끊긴 경우)이 영영 '작성 중'으로 남지 않도록,
 * updated_at 이 now 기준 STALE_WORKING_MS 보다 오래된 'working' 은 'done' 으로 보고 stale=true 로 표시한다.
 */
export function findClaudeReply(comments, { since, now = Date.now() } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  const sinceMs = since ? Date.parse(since) : NaN;
  let best = null;
  let bestT = -Infinity;
  for (const c of list) {
    if (!isClaudeComment(c)) continue;
    const created = Date.parse(c.created_at);
    const updated = Date.parse(c.updated_at);
    if (Number.isFinite(sinceMs)) {
      const after = (Number.isFinite(created) && created >= sinceMs) || (Number.isFinite(updated) && updated >= sinceMs);
      if (!after) continue;
    }
    const t = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : 0;
    if (!best || t >= bestT) {
      best = c;
      bestT = t;
    }
  }
  if (!best) return null;
  const body = typeof best.body === 'string' ? best.body : '';
  let state = replyState(body);
  let stale = false;
  if (state === 'working' && Number.isFinite(bestT) && bestT > 0 && Number(now) - bestT > STALE_WORKING_MS) {
    state = 'done';
    stale = true;
  }
  return {
    id: best.id ?? null,
    html_url: typeof best.html_url === 'string' ? best.html_url : null,
    body,
    created_at: best.created_at ?? null,
    updated_at: best.updated_at ?? best.created_at ?? null,
    state,
    stale,
  };
}

/**
 * 답글의 체크리스트 항목 텍스트 배열.
 * '하위 작업'이 들어간 제목(### …하위 작업…) 또는 굵은 줄(**…하위 작업…**) 다음부터 다음 제목/굵은 번호 줄 전까지의
 * `- [ ]`·`- [x]`·`* [ ]` 항목을 취하고, 그런 구획(의 항목)이 없으면 답글 전체의 체크리스트 항목을 취한다.
 * 코드 블록(```) 안은 무시. trim, 빈 것·중복(공백·대소문자 무시) 제거, 각 200자, 최대 20개.
 */
export function parseReplyChecklist(body) {
  const all = [];
  const section = [];
  let inSection = false;
  let fence = null;
  for (const line of String(body ?? '').split(LINE_SPLIT_RE)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = MD_HEADING_RE.exec(line);
    const b = h ? null : BOLD_LINE_RE.exec(line);
    const headText = h ? h[2] : b ? b[1] : null;
    if (headText != null && headText.includes('하위 작업')) {
      inSection = true;
      continue;
    }
    if (h || BOLD_NUMBER_RE.test(line)) {
      inSection = false;
      continue;
    }
    const c = MD_CHECK_RE.exec(line);
    if (!c) continue;
    const text = String(c[2] ?? '').trim();
    if (!text) continue;
    all.push(text);
    if (inSection) section.push(text);
  }
  const src = section.length ? section : all;
  const out = [];
  const seen = new Set();
  for (const t of src) {
    const text = cutChars(t, REPLY_ITEM_MAX_CHARS).trim();
    const key = subtaskKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= REPLY_MAX_ITEMS) break;
  }
  return out;
}

/**
 * 본문의 `## 하위 작업` 구획(줄 시작)에 미체크 항목 `- [ ] text` 를 추가한다. 구획이 없으면 본문 끝에 빈 줄 + `## 하위 작업` 을 만든다.
 * 본문 어디든 같은 텍스트(공백 정규화·대소문자 무시)의 체크 항목이 이미 있으면 건너뛴다.
 * 원래 줄바꿈(\r\n/\n) 스타일과 나머지 본문은 그대로 둔다. 추가 텍스트는 sanitizeText(@claude → @ claude).
 * → { body, added: [...], skipped: [...] }
 */
export function mergeSubtasksIntoBody(body, items) {
  const src = body === null || body === undefined ? '' : String(body);
  const parts = src.split(/(\r\n|\n|\r)/); // [줄, 구분자, 줄, …, 줄]
  const eol = src.includes('\r\n') ? '\r\n' : src.includes('\n') ? '\n' : src.includes('\r') ? '\r' : '\n';
  const have = new Set();
  for (let i = 0; i < parts.length; i += 2) {
    const c = BODY_CHECK_RE.exec(parts[i]);
    if (c) have.add(subtaskKey(c[2]));
  }
  const added = [];
  const skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const text = sanitizeText(String(it ?? ''))
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const key = subtaskKey(text);
    if (have.has(key)) {
      skipped.push(text);
      continue;
    }
    have.add(key);
    added.push(text);
  }
  if (!added.length) return { body: src, added, skipped };
  const newLines = added.map((t) => `${eol}- [ ] ${t}`).join('');

  let head = -1;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].startsWith('## 하위 작업')) {
      head = i;
      break;
    }
  }
  if (head >= 0) {
    let target = head;
    for (let i = head + 2; i < parts.length; i += 2) {
      if (/^#{1,6}\s/.test(parts[i])) break; // 다음 제목에서 구획 끝
      if (BODY_CHECK_RE.test(parts[i])) target = i;
    }
    const out = parts.slice();
    out[target] += newLines;
    return { body: out.join(''), added, skipped };
  }
  let prefix;
  if (src === '' || /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)[ \t]*$/.test(src)) prefix = '';
  else if (/(?:\r\n|\n|\r)$/.test(src)) prefix = eol;
  else prefix = eol + eol;
  return { body: `${src}${prefix}## 하위 작업${newLines}`, added, skipped };
}

const INLINE_ESCAPABLE = new Set([...'\\`*_[]()#+-.!>~|{}']);
const LINK_RE = /\[([^\]\r\n]{0,500})\]\([ \t]*([^()\s]{0,2000})(?:[ \t]+"[^"\r\n]{0,200}")?[ \t]*\)/y;

/** 한 줄 → 인라인 세그먼트 [{t:'text'|'bold'|'code'|'link', v, href?}]. link 는 safeGithubUrl 을 통과할 때만. */
export function inlineSegments(text) {
  const s = String(text ?? '');
  const out = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += buf;
    else out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && INLINE_ESCAPABLE.has(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n += 1;
      const mark = '`'.repeat(n);
      const end = s.indexOf(mark, i + n);
      if (end > i + n) {
        flush();
        out.push({ t: 'code', v: s.slice(i + n, end) });
        i = end + n;
        continue;
      }
      buf += mark;
      i += n;
      continue;
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2 && s.slice(i + 2, end).trim()) {
        flush();
        out.push({ t: 'bold', v: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      buf += '**';
      i += 2;
      continue;
    }
    if (ch === '[' && s[i - 1] !== '!') {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(s);
      if (m) {
        const label = m[1].trim() || m[2];
        const href = safeGithubUrl(m[2]);
        if (href) {
          flush();
          out.push({ t: 'link', v: label, href });
        } else {
          buf += label; // 허용하지 않은 링크는 글자만 남긴다
        }
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/**
 * 답글 마크다운 → 안전 렌더링용 블록 배열(일부 문법만):
 * {type:'heading', level:1~3, inline} · {type:'paragraph', inline} · {type:'bullet', inline} · {type:'check', checked, inline}
 * · {type:'hr'} · {type:'blockquote', inline}. 코드 블록 줄은 code 세그먼트 문단, HTML 태그·이미지·표는 글자 그대로.
 * 입력이 REPLY_MAX_CHARS 를 넘으면 잘라 내고 마지막에 '…(GitHub에서 전체 보기)' 문단(truncated:true)을 붙인다.
 */
export function replyBlocks(markdown) {
  let src = String(markdown ?? '');
  let truncated = false;
  if (src.length > REPLY_MAX_CHARS) {
    let cut = REPLY_MAX_CHARS;
    const code = src.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 서로게이트 쌍을 가르지 않는다
    src = src.slice(0, cut);
    truncated = true;
  }
  const blocks = [];
  let fence = null;
  for (const line of src.split(LINE_SPLIT_RE)) {
    const f = FENCE_RE.exec(line);
    if (f && (!fence || f[1][0] === fence)) {
      fence = fence ? null : f[1][0];
      continue;
    }
    if (fence) {
      if (line.trim()) blocks.push({ type: 'paragraph', inline: [{ t: 'code', v: line }] });
      continue;
    }
    if (!line.trim()) continue;
    if (MD_HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      continue;
    }
    let m = MD_HEADING_RE.exec(line);
    if (m) {
      if (m[2].trim()) blocks.push({ type: 'heading', level: Math.min(3, m[1].length), inline: inlineSegments(m[2].trim()) });
      continue;
    }
    m = MD_QUOTE_RE.exec(line);
    if (m) {
      if (m[1].trim()) blocks.push({ type: 'blockquote', inline: inlineSegments(m[1].trim()) });
      continue;
    }
    m = MD_CHECK_RE.exec(line);
    if (m) {
      blocks.push({ type: 'check', checked: m[1] !== ' ', inline: inlineSegments(String(m[2] ?? '').trim()) });
      continue;
    }
    m = MD_BULLET_RE.exec(line);
    if (m) {
      blocks.push({ type: 'bullet', inline: inlineSegments(m[1].trim()) });
      continue;
    }
    blocks.push({ type: 'paragraph', inline: inlineSegments(line.trim()) });
  }
  if (truncated) blocks.push({ type: 'paragraph', truncated: true, inline: [{ t: 'text', v: REPLY_TRUNCATED_TEXT }] });
  return blocks;
}

// 답글 표시 정리용 (cleanReplyForDisplay)
// 상태 줄: claude-code-action 머리줄 "**Claude finished …** —— [View job](…)", "**Claude encountered an error after …**",
// 작성 중 "Claude Code is working…" 류. 'Claude' 로 시작하는 줄만 본다(본문 내용을 지우지 않게).
const STATUS_LINE_RE = /^\s*(?:\*\*)?\s*Claude(?:\s+Code)?(?:\s+is)?\s*(?:working|finished|encountered\s+an\s+error|(?:가|는)?\s*작업\s*중)/i;
const TODO_STUCK_RE = /todo-stuck/i;
// 제목 속 괄호 묶음(한 단계 중첩까지, '(`/todo-stuck` 기준 (가정))' 포함) — 안에 todo-stuck 이 들면 괄호째 지운다
const HEAD_PAREN_RE = /[(（](?:[^()（）\r\n]|[(（][^()（）\r\n]*[)）])*[)）]/g;
// 제목 속 대괄호 묶음 '[/todo-stuck 기준]'(링크 '[글](주소)'는 제외)
const HEAD_BRACKET_RE = /\[[^[\]\r\n]*\](?!\()/g;
// 명령 표기 토큰: '/todo-stuck', '`/todo-stuck 10`', '/todo-stuck #10', 'todo-stuck 스킬 기준', '/todo-stuck 기준으로'
const TODO_STUCK_TOKEN_RE =
  /(?<![\w/-])(?:`\/?todo-stuck(?:[ \t]+#?\d+)?`|\/?todo-stuck(?:[ \t]+#?\d+(?![\w가-힣]))?)(?![\w-])(?:[ \t]+스킬)?(?:[ \t]*기준(?:으로)?(?![\w가-힣]))?/gi;
const HEADING_PREFIX_RE = /^(\s{0,3}#{1,6}[ \t]+)(.*)$/;
const STRIP_MARK = '\u0000';
const STRIP_SPLIT_RE = /\u0000(?:[ \t]*\u0000)*/;
const HEAD_LEAD_SEP_RE = /^[ \t]*(?:[—–\-:：|·,][ \t]*)*/; // 지운 자리 뒤에 남은 구분자
const HEAD_TRAIL_SEP_RE = /[ \t]*(?:[—–\-:：|·,][ \t]*)*$/; // 지운 자리 앞에 남은 구분자
const HEAD_SEP_END_RE = /[—–\-:：|·,]$/;
const HEAD_SEP_START_RE = /^[—–\-:：|·,]/;
const NO_SPACE_BEFORE_RE = /^[.,!?。、;:：)）\]」』…]/;
const TABLE_ROW_RE = /^\s*\|/;
const ORDERED_ITEM_RE = /^\s*\d+[.)][ \t]/;
// 안내 문장 '홈페이지 항목의 [본문에 반영]을 누르면 …'(줄 첫머리 — 목록·인용 표시, '참고:' 머리말 허용)
const GUIDE_LEAD = String.raw`^\s*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*(?:\*\*|__)?[ \t]*(?:(?:참고|안내)[ \t]*(?:\*\*|__)?[ \t]*[:：][ \t]*(?:\*\*|__)?[ \t]*)?`;
const GUIDE_BUTTON = String.raw`(?:\*\*|__)?\[본문에 반영(?:[ \t]*\(\d+개\))?\](?:\*\*|__)?[ \t]*(?:버튼)?[ \t]*[을를]?[ \t]*누르면`;
const APPLY_GUIDE_RE = new RegExp(`${GUIDE_LEAD}홈페이지[ \\t]*항목의[ \\t]*${GUIDE_BUTTON}`);
// '[본문에 반영]을 누르면 … 본문에 추가됩니다'(줄 첫머리) — 본문 내용 문장('… 누르면 아래 하위 작업이 추가되고 …')은 남긴다
const APPLY_GUIDE_ADDED_RE = new RegExp(`${GUIDE_LEAD}(?:홈페이지(?:에서|의)?[ \\t]*)?${GUIDE_BUTTON}[^\\r\\n]*본문에[ \\t]*추가됩니다`);
// 문장이 끝난 줄(다음 줄과 한 문장으로 잇지 않음)
const SENTENCE_END_RE = /(?:[.!?。！？…]|다)["'”’)\]）*_`]*\s*$/;

/**
 * 제목·굵은 제목 글자에서 /todo-stuck 표기를 지운다: 괄호·대괄호 안에 든 것은 괄호째, 그 밖의 '/todo-stuck'(뒤의 번호·'기준(으로)' 포함) 토큰,
 * 지운 자리 앞뒤에 남는 구분자(' — ', ':')도 정리한다. '진단 (`/todo-stuck` 기준)' → '진단', '/todo-stuck 진단 — #8' → '진단 — #8',
 * '진단 — /todo-stuck 기준' → '진단', '🆘 /todo-stuck 진단' → '🆘 진단'. 표기가 없으면 그대로.
 */
function stripTodoStuck(text) {
  const src = String(text);
  if (!TODO_STUCK_RE.test(src)) return src;
  const marked = src
    .replace(HEAD_PAREN_RE, (g, off, s) => (s[off - 1] !== ']' && TODO_STUCK_RE.test(g) ? STRIP_MARK : g))
    .replace(HEAD_BRACKET_RE, (g) => (TODO_STUCK_RE.test(g) ? STRIP_MARK : g))
    .replace(TODO_STUCK_TOKEN_RE, STRIP_MARK);
  if (!marked.includes(STRIP_MARK)) return src;
  const pieces = marked.split(STRIP_SPLIT_RE);
  let out = pieces[0];
  for (let i = 1; i < pieces.length; i += 1) {
    const raw = pieces[i];
    const left = out.replace(/[ \t]+$/, '');
    const right = raw.replace(/^[ \t]+/, '');
    if (!left.trim()) {
      out = left + right.replace(HEAD_LEAD_SEP_RE, '');
    } else if (!right.replace(HEAD_LEAD_SEP_RE, '')) {
      out = left.replace(HEAD_TRAIL_SEP_RE, '');
    } else if (HEAD_SEP_END_RE.test(left) && HEAD_SEP_START_RE.test(right)) {
      out = `${left.replace(HEAD_TRAIL_SEP_RE, '')} ${right}`;
    } else {
      const spaced = (left !== out || right !== raw) && !NO_SPACE_BEFORE_RE.test(right);
      out = left + (spaced ? ' ' : '') + right;
    }
  }
  return out;
}

// 굵은 제목 바로 뒤에 붙은 표기: '**진단** (`/todo-stuck` 기준)', '**진단** [/todo-stuck]', '**진단** /todo-stuck 기준: …'
const BOLD_TAIL_ANNOT_RE = new RegExp(`^[ \\t]*(?:${HEAD_PAREN_RE.source}|${HEAD_BRACKET_RE.source}|${TODO_STUCK_TOKEN_RE.source})`, 'i');

/** 굵은 제목 뒤 글자: 표기뿐이면 비우고, 맨 앞에 표기가 붙어 있으면 그것만 뗀다. 그 밖의 본문('… 연다(/todo-stuck 기준 15분).')은 그대로. */
function stripBoldTail(after) {
  if (!TODO_STUCK_RE.test(after)) return after;
  if (!stripTodoStuck(after).replace(HEAD_LEAD_SEP_RE, '').trim()) return '';
  const a = BOLD_TAIL_ANNOT_RE.exec(after);
  return a && TODO_STUCK_RE.test(a[0]) ? after.slice(a[0].length) : after;
}

/** 반영 방법 안내 문장: '홈페이지 항목의 [본문에 반영]을 누르면 …'(줄 첫머리) 또는 'todo-stuck'·'반영해'가 함께 든 것 */
function isApplyGuidance(text) {
  const t = String(text);
  return (TODO_STUCK_RE.test(t) && t.includes('반영해')) || APPLY_GUIDE_RE.test(t) || APPLY_GUIDE_ADDED_RE.test(t);
}

/**
 * 🆘 답글을 화면에 보여 주기 전에 정리한다(원문은 바꾸지 않는다 — [본문에 반영]은 원문으로 parseReplyChecklist).
 * 1) 본문 첫 비어있지 않은 줄이 상태 줄이면 지우고, 바로 뒤(빈 줄 건너) `---` 구분선도 지운다(상태는 패널 머리 배지로 보여 줌).
 * 2) 제목(#~######)·굵은 제목(줄 첫머리의 **…**)에서 /todo-stuck 표기 제거(stripTodoStuck). 정리 후 비어 버린 제목 줄은 지운다.
 * 3) 반영 방법 안내 줄 제거('홈페이지 항목의 [본문에 반영]을 누르면 …'으로 시작하는 줄, 'todo-stuck'·'반영해'가 함께 든 줄).
 *    한 문장이 두 줄로 나뉜 안내(앞 줄이 문장으로 끝나지 않은 일반 문단 줄 2개)는 두 줄을 함께 지운다.
 *    체크리스트 항목·표(| …) 줄은 건드리지 않고, 번호 목록 줄은 줄 단위로만 본다.
 * 지운 줄 바로 앞의 빈 줄도 함께 지운다(맨 앞이면 앞뒤의 빈 줄). 코드 블록 안, 그 밖의 줄과 줄바꿈(\r\n/\n)은 그대로 둔다.
 * 정리할 것이 없으면 입력 문자열을 그대로 돌려준다. 줄 수에 비례하는 시간만 쓴다(긴 답글도 화면을 멈추지 않게).
 */
export function cleanReplyForDisplay(body) {
  const src = body === null || body === undefined ? '' : String(body);
  const parts = src.split(/(\r\n|\n|\r)/); // [줄, 구분자, 줄, …, 줄]
  const rows = [];
  for (let i = 0; i < parts.length; i += 2) rows.push({ text: parts[i], sep: parts[i + 1] ?? '', kind: 'text', drop: false });

  // 줄 종류(replyBlocks 와 같은 순서로 판정 + 표 줄·번호 목록 줄 구분)
  let fence = null;
  for (const r of rows) {
    const f = FENCE_RE.exec(r.text);
    if (f && (!fence || f[1][0] === fence)) {
      fence = fence ? null : f[1][0];
      r.kind = 'fence';
    } else if (fence) r.kind = 'code';
    else if (!r.text.trim()) r.kind = 'blank';
    else if (MD_HR_RE.test(r.text)) r.kind = 'hr';
    else if (MD_HEADING_RE.test(r.text)) r.kind = 'heading';
    else if (MD_QUOTE_RE.test(r.text)) r.kind = 'quote';
    else if (MD_CHECK_RE.test(r.text)) r.kind = 'check';
    else if (MD_BULLET_RE.test(r.text)) r.kind = 'bullet';
    else if (TABLE_ROW_RE.test(r.text)) r.kind = 'table';
    else if (ORDERED_ITEM_RE.test(r.text)) r.kind = 'olist';
  }
  const blank = (r) => r.kind === 'blank';
  let changed = false;

  // 1) 상태 줄 + 바로 뒤 구분선
  const first = rows.findIndex((r) => !blank(r));
  if (first >= 0 && rows[first].kind === 'text' && STATUS_LINE_RE.test(rows[first].text)) {
    rows[first].drop = true;
    const next = rows.findIndex((r, i) => i > first && !blank(r));
    if (next >= 0 && rows[next].kind === 'hr') rows[next].drop = true;
    changed = true;
  }

  // 2) 제목·굵은 제목 줄의 /todo-stuck 표기
  for (const r of rows) {
    if (r.drop || !TODO_STUCK_RE.test(r.text)) continue;
    if (r.kind === 'heading') {
      const m = HEADING_PREFIX_RE.exec(r.text);
      const rest = stripTodoStuck(m[2]);
      if (rest !== m[2]) {
        r.text = m[1] + rest;
        if (!rest.replace(/[#*_\s]/g, '')) r.drop = true;
        changed = true;
      }
    } else if (r.kind === 'text') {
      const m = BOLD_LINE_RE.exec(r.text);
      if (!m) continue;
      const inner = stripTodoStuck(m[1]); // 굵은 제목 부분
      const after = r.text.slice(m[0].length);
      const tail = stripBoldTail(after); // 굵은 제목 바로 뒤의 표기만(뒤 본문은 그대로)
      if (inner === m[1] && tail === after) continue;
      const lead = r.text.slice(0, r.text.indexOf('**'));
      if (inner.replace(/[*_\s]/g, '')) r.text = `${lead}**${inner}**${tail}`;
      else {
        const rest = tail.replace(HEAD_LEAD_SEP_RE, '');
        if (rest.replace(/[*_\s]/g, '')) r.text = lead + rest;
        else r.drop = true;
      }
      changed = true;
    }
  }

  // 3) 반영 방법 안내: 줄 단위(문단·목록·번호 목록·인용), 두 줄로 나뉜 한 문장(일반 문단 줄)
  for (const r of rows) {
    if (!r.drop && ['text', 'bullet', 'quote', 'olist'].includes(r.kind) && isApplyGuidance(r.text)) {
      r.drop = true;
      changed = true;
    }
  }
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const a = rows[i];
    const b = rows[i + 1];
    if (a.drop || b.drop || a.kind !== 'text' || b.kind !== 'text' || SENTENCE_END_RE.test(a.text)) continue;
    if (isApplyGuidance(`${a.text.trim()} ${b.text.trim()}`)) {
      a.drop = true;
      b.drop = true;
      changed = true;
      i += 1;
    }
  }
  if (!changed) return src;

  // 지운 줄 주변의 빈 줄 정리: 앞에 남은 내용이 있으면 바로 앞 빈 줄들을, 없으면(맨 앞) 앞뒤의 빈 줄들을 함께 지운다.
  let lastContent = -1; // 남는 내용 줄의 마지막 위치
  let swept = -1; // 여기까지 앞쪽 빈 줄 정리함
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.drop) {
      if (!blank(r)) lastContent = i;
      continue;
    }
    for (let k = Math.max(lastContent, swept) + 1; k < i; k += 1) rows[k].drop = true;
    swept = i;
    if (lastContent < 0) {
      for (let k = i + 1; k < rows.length && blank(rows[k]) && !rows[k].drop; k += 1) rows[k].drop = true;
    }
  }
  const kept = rows.filter((r) => !r.drop);
  return kept.map((r, i) => (i === kept.length - 1 ? r.text : r.text + r.sep)).join('');
}

/**
 * [본문에 반영]: 최신 이슈 GET → mergeSubtasksIntoBody → 추가할 항목이 있을 때만 PATCH body
 * → (최신 라벨에) stuck 이 있으면 제거(404 무시).
 * → { issue: PATCH 응답 또는 최신 이슈(라벨 반영), added, skipped, stuckRemoved, stuckError }
 * - 최신 이슈가 이미 닫혀 있으면(다른 곳에서 완료) 쓰지 않고 ApiError(409) — 오류의 issue 에 최신 이슈.
 * - 본문을 이미 고친 뒤 stuck 제거만 실패하면 던지지 않고 stuckError 에 담아 돌려준다(본문 반영은 성공이므로 화면을 갱신해야 함).
 *   본문을 고치지 않았으면(추가할 항목 없음) 그대로 던진다.
 */
export async function applyReplySubtasks(api, number, items) {
  const n = positiveInt(number);
  const fresh = await api.getIssue(n);
  if (!fresh || typeof fresh !== 'object') throw new ApiError(MSG.badResponse, 0);
  if (fresh.state === 'closed') throw new ApiError(MSG.applyClosed, 409, { issue: fresh });
  const merged = mergeSubtasksIntoBody(typeof fresh.body === 'string' ? fresh.body : '', items);
  let issue = fresh;
  let patchedBody = false;
  if (merged.added.length > 0) {
    const patched = await api.updateIssue(n, { body: merged.body });
    issue = patched && typeof patched === 'object' ? patched : { ...fresh, body: merged.body };
    patchedBody = true;
  }
  let stuckRemoved = false;
  let stuckError = null;
  if (labelNames(issue).includes('stuck')) {
    let labels;
    try {
      labels = await api.removeLabel(n, 'stuck');
    } catch (e) {
      if (!patchedBody) throw e;
      stuckError = e;
    }
    if (!stuckError) {
      stuckRemoved = Array.isArray(labels);
      const rest = Array.isArray(labels)
        ? labels
        : (Array.isArray(issue.labels) ? issue.labels : []).filter((l) => (typeof l === 'string' ? l : l && l.name) !== 'stuck');
      issue = { ...issue, labels: rest };
    }
  }
  return { issue, added: merged.added, skipped: merged.skipped, stuckRemoved, stuckError };
}

/** waiting 라벨 추가/제거. opts.waiting(boolean)으로 원하는 상태를 지정할 수 있다. 라벨이 반영된 issue 반환. */
export async function toggleWaiting(api, issue, opts = {}) {
  if (!issue || !Number.isInteger(issue.number)) throw new ApiError('할 일을 찾을 수 없습니다.', 400);
  const has = labelNames(issue).includes('waiting');
  const want = typeof (opts && opts.waiting) === 'boolean' ? opts.waiting : !has;
  if (want === has) return issue;
  let labels;
  if (want) {
    await ensureLabels(api, ['waiting'], (opts && opts.labelCache) || null);
    labels = await api.addLabels(issue.number, ['waiting']);
  } else {
    labels = await api.removeLabel(issue.number, 'waiting');
  }
  if (!Array.isArray(labels)) {
    const cur = Array.isArray(issue.labels) ? issue.labels : [];
    labels = want
      ? [...cur, { name: 'waiting' }]
      : cur.filter((l) => (typeof l === 'string' ? l : l && l.name) !== 'waiting');
  }
  return { ...issue, labels };
}

// ─────────────────────────────────────────────────────────────
// 이번 주 완료한 일 [지우기] = `hidden` 라벨(닫힌 이슈 전용). 이슈·기록은 GitHub 에 남고 라벨을 떼면 다시 보인다.
// ─────────────────────────────────────────────────────────────
export const HIDDEN_LABEL = 'hidden';

/** 완료 목록에서 숨긴 이슈인지: 라벨 이름이 정확히 'hidden'. (열린 할 일 목록·개수·그룹에는 쓰지 않는다) */
export function isHiddenDone(issue) {
  return labelNames(issue).includes(HIDDEN_LABEL);
}

const withoutLabel = (labels, name) =>
  (Array.isArray(labels) ? labels : []).filter((l) => (typeof l === 'string' ? l : l && l.name) !== name);

/**
 * [지우기]: 최신 상태 확인(GET) → 열려 있으면 ApiError(409, MSG.hideOpen)(오류의 issue 에 최신 이슈)
 * → ensureLabels(['hidden']) → addLabels(n, ['hidden']) → 라벨이 반영된 issue 반환.
 * 이미 hidden 이면 쓰지 않고 최신 이슈를 돌려준다.
 */
export async function hideDone(api, issue, opts = {}) {
  if (!issue || !Number.isInteger(issue.number)) throw new ApiError('지울 할 일을 찾을 수 없습니다.', 400);
  const n = issue.number;
  const latest = await api.getIssue(n);
  if (!latest || typeof latest !== 'object') throw new ApiError(MSG.badResponse, 0);
  if (latest.state !== 'closed') throw new ApiError(MSG.hideOpen, 409, { issue: latest });
  const merged = { ...issue, ...latest };
  if (isHiddenDone(latest)) return merged;
  await ensureLabels(api, [HIDDEN_LABEL], (opts && opts.labelCache) || null);
  const labels = await api.addLabels(n, [HIDDEN_LABEL]);
  return {
    ...merged,
    labels: Array.isArray(labels) ? labels : [...withoutLabel(merged.labels, HIDDEN_LABEL), { name: HIDDEN_LABEL }],
  };
}

/** [지우기] 되돌리기: removeLabel(n, 'hidden')(404 = 이미 없음, 무시) → 라벨이 반영된 issue 반환. */
export async function unhideDone(api, issue) {
  if (!issue || !Number.isInteger(issue.number)) throw new ApiError('되돌릴 할 일을 찾을 수 없습니다.', 400);
  let labels = null;
  try {
    labels = await api.removeLabel(issue.number, HIDDEN_LABEL);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  return { ...issue, labels: Array.isArray(labels) ? labels : withoutLabel(issue.labels, HIDDEN_LABEL) };
}

// ─────────────────────────────────────────────────────────────
// [✏ 변경] 우선순위·마감 바꾸기: p 라벨을 하나로 바꾸고(나머지 라벨 유지) 본문 `Due:` 줄만 고친다(다른 줄·회차 표지 유지).
// ─────────────────────────────────────────────────────────────
const PRIORITY_KEYS = Object.freeze(['p1', 'p2', 'p3']);
/** 편집 패널 라디오·결과 메시지의 우선순위 이름: 'p1 긴급' / 'p1(긴급)' */
export const PRIORITY_TEXT = Object.freeze({ p1: '긴급', p2: '이번 주', p3: '나중에' });
/** [✏ 변경] 화면 문구(설명서와 맞춘다). 결과 문장은 metaChangeText 가 만든다. */
export const META_TEXT = Object.freeze({
  hint: '목록 위치는 마감일에도 따라 정해집니다: 마감이 지나면 🔴 지연, 오늘·내일이면 🟠 긴급, 7일 이내면 🟡 이번 주.',
  noChange: '바뀐 내용이 없습니다',
  dueRemoved: '마감을 없앴습니다',
  pastDue: '이미 지난 날짜라 🔴 지연에 표시됩니다',
  waitingStays: '대기 중인 할 일이라 ⏳ 대기 중에 그대로 표시됩니다(대기를 해제하면 우선순위·마감에 따라 옮겨집니다).',
  alreadySame: '다른 곳에서 이미 같은 값으로 바뀌어 있어 목록만 최신으로 고쳤습니다.',
  listUpdated: '목록을 GitHub의 최신 상태로 고쳤습니다. 다른 항목도 바뀌었을 수 있으니 [목록 새로고침]을 누르세요.',
  needDate: '마감 날짜를 고르거나 [마감 없음]을 체크하세요.',
  badDate: '마감 날짜가 올바르지 않습니다. 날짜를 다시 고르세요.',
  // ── 6차: 세부 내용(완료 기준·메모·하위 작업) ──
  criteriaLabel: '완료 기준',
  criteriaPlaceholder: '무엇이 되면 끝인가요? 예: 견적서를 김과장께 메일로 보냄',
  memoLabel: '메모',
  memoPlaceholder: '자료 위치·관련자 등',
  sensitive: '금액·계약 조건·개인정보는 적지 말고 자료 위치만 적으세요.',
  markerPrefix: '반복 회차 표지: ',
  markerSuffix: ' (바꿀 수 없음)',
  subtasksLegend: '하위 작업',
  subtasksEmpty: '하위 작업이 없습니다',
  subtaskAdd: '+ 하위 작업 추가',
  subtaskHelp: 'Enter 키로 다음 줄을 추가합니다. 빈 줄은 저장하지 않습니다.',
  subtaskLimit: '하위 작업은 50개까지 적을 수 있습니다.',
  editingSubtasks: '편집 중에는 [✏ 변경] 패널에서 바꾸세요.',
  editingApply: '편집 중에는 [✏ 변경] 패널을 닫은 뒤 반영하세요.',
  criteriaTooLong: '완료 기준은 500자까지 적을 수 있습니다.',
  memoTooLong: '메모는 500자까지 적을 수 있습니다.',
  conflictHelp: '[내 내용으로 저장]을 누르면 지금 입력한 내용으로 덮어쓰고, [최신 내용 불러오기]를 누르면 입력한 내용을 버리고 GitHub의 최신 내용으로 다시 채웁니다.',
  conflictChoose: '[✏ 변경] 패널에서 [내 내용으로 저장] 또는 [최신 내용 불러오기]를 고르세요.',
  forceSave: '내 내용으로 저장',
  reloadLatest: '최신 내용 불러오기',
  reloaded: '최신 내용을 불러왔습니다. 다시 고친 뒤 [저장]을 누르세요.',
});

/** [✏ 변경]/[✏ 닫기] 버튼 aria-label 의 괄호 속 범위: '✏ 변경(우선순위·마감·완료 기준·메모·하위 작업): #N 제목' */
export const EDIT_SCOPE_TEXT = '우선순위·마감·완료 기준·메모·하위 작업';

/** 세부 내용 칸 이름(결과 문장·충돌 메시지). 순서 = 본문 형식·결과 문장 순서 */
export const DETAIL_KEYS = Object.freeze(['criteria', 'memo', 'subtasks']);
export const DETAIL_NAME = Object.freeze({ criteria: '완료 기준', memo: '메모', subtasks: '하위 작업' });
/** [✏ 변경] 하위 작업 편집기 줄 수 상한(넘으면 [+ 하위 작업 추가] 비활성 + 안내). 이미 그보다 많은 본문은 그대로 저장한다. */
export const SUBTASK_LIMIT = 50;
export { BODY_FIELD_MAX_CHARS, SUBTASK_MAX_CHARS };
const CRITERIA_UNSET = '(미정)';

/** 'N번째 하위 작업은 200자까지 적을 수 있습니다.' */
export function subtaskTooLongText(i) {
  return `${i}번째 하위 작업은 ${SUBTASK_MAX_CHARS}자까지 적을 수 있습니다.`;
}

/** 충돌 메시지: '다른 곳에서 이 할 일의 세부 내용이 바뀌었습니다(바뀐 칸: 완료 기준·하위 작업)' */
export function conflictText(fields) {
  const names = DETAIL_KEYS.filter((k) => Array.isArray(fields) && fields.includes(k)).map((k) => DETAIL_NAME[k]);
  return names.length ? `${MSG.metaConflict}(바뀐 칸: ${names.join('·')})` : MSG.metaConflict;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 입력 글자 수(코드 포인트, parser.js 와 같은 기준 — 이미 정리된 '@ claude' 는 '@claude' 로 센다) */
export function detailInputLength(s) {
  return Array.from(oneLine(s).replace(/@ claude/gi, '@claude')).length;
}

/**
 * 비교용 값(저장하면 parseBody 가 읽을 값). 완료 기준: 비면 '(미정)', 메모: 비면 null.
 * normalizeBodyField 와 같고, 그 한도(500자)를 넘는 값(GitHub 에서 직접 고친 본문)은 던지지 않고 같은 방식으로 정리만 한다.
 */
function canonDetail(key, v) {
  try {
    return normalizeBodyField(key, v === null || v === undefined ? null : String(v));
  } catch {
    const s = sanitizeText(oneLine(v));
    return s || (key === 'criteria' ? CRITERIA_UNSET : null);
  }
}

/**
 * 비교용 하위 작업 목록 [{text, done}] (normalizeSubtasks(list, { keep }) 와 같고, 200자를 넘는 줄도 던지지 않음).
 * keep: 본문에 이미 있던 하위 작업(패널을 열 때 읽은 것 + 최신) — 그 글자 그대로의 줄은 표기를 떼지 않고 그대로 비교한다.
 */
function canonSubtasks(list, keep = []) {
  const arr = Array.isArray(list) ? list : [];
  try {
    return normalizeSubtasks(arr, { keep });
  } catch {
    return arr
      .map((s) => ({ text: sanitizeText(oneLine(s && typeof s === 'object' ? s.text : s)), done: Boolean(s && s.done) }))
      .filter((s) => s.text);
  }
}

function sameSubtasks(a, b) {
  return a.length === b.length && a.every((s, i) => s.text === b[i].text && s.done === b[i].done);
}

/** 메모 입력에서 회차 표지 글자를 모두 뗀 사용자 메모(표지는 늘 최신 본문의 것을 쓴다). 비면 null. */
function memoUserText(v) {
  return stripInstanceMarkers(v) || null;
}

/**
 * 행(카드/표) 제목 아래에 보여 줄 완료 기준·메모(parseBody 결과 → { criteria, memo }, 없으면 null).
 * - 완료 기준: '(미정)'·빈 값이면 null.
 * - 메모: 빈 값·기본값('홈페이지에서 등록')이면 null. 회차 표지(반복원본: #N / 회차: …)는 숨기고 사용자 메모만(없으면 null).
 */
export function rowDetailOf(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const crit = typeof f.criteria === 'string' ? f.criteria.trim() : '';
  let memo = null;
  if (typeof f.memo === 'string' && f.memo.trim()) {
    const { marker, text } = splitMemoMarker(f.memo);
    const t = marker ? text || '' : f.memo.trim();
    memo = t && t !== DEFAULT_MEMO ? t : null;
  }
  return { criteria: crit && crit !== CRITERIA_UNSET ? crit : null, memo };
}

/** parser.js 의 TypeError(글자 수·형식) → 한국어 ApiError(400) */
function detailValueError(key, e) {
  const msg = e && typeof e.message === 'string' ? e.message : '';
  if (key === 'subtasks') return new ApiError(msg ? `${msg}.`.replace(/\.\.$/, '.') : '하위 작업 형식이 잘못됐습니다.', 400);
  if (/\d+자/.test(msg)) return new ApiError(key === 'criteria' ? META_TEXT.criteriaTooLong : META_TEXT.memoTooLong, 400);
  return new ApiError(`${DETAIL_NAME[key]} 값이 올바르지 않습니다.`, 400);
}

/**
 * [✏ 변경] 마감으로 받는 날짜 범위(편집 패널 날짜 칸의 min·max 와 같다). 키보드로 연도를 덜 친 값(0202-10-30)이나
 * 연·월·일 순서를 잘못 친 값(1030-02-02)이 그대로 본문에 들어가지 않게 저장 전에 막는다.
 */
export const DUE_MIN = '2000-01-01';
export const DUE_MAX = '2999-12-31';
/** 'YYYY-MM-DD' 이고 DUE_MIN~DUE_MAX 안이면 true */
export function isDueInRange(due) {
  return typeof due === 'string' && isValidYMD(due) && due >= DUE_MIN && due <= DUE_MAX;
}

/** 'p1' → 'p1(긴급)' (결과 메시지용) */
export function priorityText(p) {
  const k = PRIORITY_KEYS.includes(p) ? p : 'p2';
  return `${k}(${PRIORITY_TEXT[k]})`;
}

/**
 * [✏ 변경]: 우선순위(p 라벨)·마감(본문 `Due:` 줄)을 PATCH 한 번으로 바꾼다.
 * change.priority: 'p1'|'p2'|'p3'|undefined(그대로), change.due: 'YYYY-MM-DD'|null(마감 없음)|undefined(그대로).
 * 1) 최신 상태 GET — 닫혀 있으면 ApiError(409, '이미 완료된 할 일입니다'),
 *    할 일이 아니면(PR·recurring·briefing) ApiError(400, '할 일이 아니라 바꿀 수 없습니다'). 두 오류 모두 issue 에 최신 이슈를 담는다.
 * 2) 바꿀 것 계산(최신 기준): 라벨 = priority 가 주어지고 priorityOf(최신)와 다르거나 p 라벨이 1개가 아니면(2개 이상·없음) withPriorityLabel.
 *    본문 = due 가 주어지고 parseBody(최신).due 와 다르면 setDueInBody(Due 줄만 바꾸기·넣기·지우기).
 * 3) 바꿀 것이 없으면 쓰지 않고 { issue: 최신, changed: [] }.
 * 4) 라벨을 바꾸면 먼저 ensureLabels([priority]).
 * 5) PATCH 한 번(api.updateIssue(n, { labels?, body? })) → { issue: 응답, changed: ['priority'?, 'due'?, 'criteria'?, 'memo'?, 'subtasks'?] }.
 *    GitHub REST 의 PATCH labels 는 이슈 라벨 전체를 그 배열로 바꾼다 → 다른 라벨(area·proj·waiting·stuck 등)도 최신 순서 그대로 넣는다.
 * 값이 잘못되면(p4, '2026-02-30', 범위(DUE_MIN~DUE_MAX) 밖의 '0202-10-30' 등) 요청 없이 ApiError(400).
 *
 * 6차 — 세부 내용(본문 줄만 고치고 나머지 줄·줄바꿈 형식은 그대로, 같은 PATCH 한 번에 함께):
 *   change.criteria: string|null(비우면 '(미정)'), change.memo: string|null(사용자 메모 — 회차면 표지 뒤 부분, 비우면 줄 삭제·회차면 표지만),
 *   change.subtasks: [{ text, done }](순서 그대로 전체 — 빈 줄은 무시). 주어지지 않은(undefined) 칸은 최신 값 그대로.
 *   - 회차 메모: 최신 메모의 표지(반복원본: #N / 회차: YYYY-MM-DD)를 그대로 두고 사용자 부분만 바꾼다(change.memo 에 표지 글자가 들어 있어도 떼고 최신 표지를 쓴다).
 *   - 충돌 검사(opts.base = 패널을 열 때 읽은 { criteria, memo, subtasks } 원래 값, opts.force 가 아니면): change 에 있는 세부 칸마다
 *     최신 값이 base 와 다르고(다른 곳에서 바뀜) 내 값과도 다르면 충돌 → 쓰기 없이 ApiError(409, MSG.metaConflict,
 *     { kind: 'conflict', conflicts: ['criteria'|'memo'|'subtasks'…], issue: 최신 }). 최신 값이 내 값과 같으면 충돌 아님.
 *     base 에 없는 칸은 검사하지 않는다. 우선순위·마감은 충돌 검사 없음(5차 그대로).
 *   - 비교는 저장 뒤 parseBody 가 읽을 값 기준(한 줄·@claude 정리, 완료 기준 빈 값 = '(미정)', 줄 모양만 다른 하위 작업은 같음).
 *   - 글자 수(완료 기준·메모 500자, 하위 작업 200자) 초과·형식 오류는 요청 없이 ApiError(400). 검사는 change 에 든 칸만 한다
 *     (GitHub 에서 길게 적어 둔 칸이 있어도 다른 칸만 바꾸면 저장된다).
 *   - 하위 작업 중 본문에 이미 있던 줄(opts.base.subtasks 와 최신 본문의 하위 작업 — 글자 그대로)은 손대지 않은 줄로 보고
 *     200자 검사·앞 표기(`- `·`* ` 등) 떼기를 하지 않는다(normalizeSubtasks 의 keep) — 한 줄만 고쳐도 다른 긴 줄·`- 3단계` 같은 줄은 그대로.
 *   - 완료 기준과 새로 적거나 고친 하위 작업 줄의 회차 표지 글자(반복원본: #N / 회차: …)는 뗀다(표지는 메모에만 — 아침 작업이 잘못 알아보지 않게).
 */
export async function updateTaskMeta(api, issue, change = {}, opts = {}) {
  const num = typeof issue === 'number' ? issue : issue && typeof issue === 'object' ? issue.number : null;
  if (!Number.isSafeInteger(num) || num <= 0) throw new ApiError('바꿀 할 일을 찾을 수 없습니다.', 400);
  const c = change && typeof change === 'object' ? change : {};
  const { priority, due } = c;
  if (priority !== undefined && !PRIORITY_KEYS.includes(priority)) {
    throw new ApiError(`우선순위는 p1·p2·p3 중 하나여야 합니다: ${String(priority)}`, 400);
  }
  if (due !== undefined && due !== null && !isDueInRange(due)) {
    throw new ApiError(`${MSG.metaBadDue}: ${String(due)}`, 400);
  }
  // 세부 내용: 요청 전에 값 검사·정리(저장할 값)
  const want = {};
  if (c.criteria !== undefined) {
    if (c.criteria !== null && typeof c.criteria !== 'string') throw detailValueError('criteria', null);
    try {
      want.criteria = normalizeBodyField('criteria', c.criteria);
    } catch (e) {
      throw detailValueError('criteria', e);
    }
  }
  let memoText;
  if (c.memo !== undefined) {
    if (c.memo !== null && typeof c.memo !== 'string') throw detailValueError('memo', null);
    memoText = memoUserText(c.memo);
    try {
      normalizeBodyField('memo', memoText); // 사용자 메모 글자 수
    } catch (e) {
      throw detailValueError('memo', e);
    }
  }
  const o = opts && typeof opts === 'object' ? opts : {};
  const base = o.base && typeof o.base === 'object' ? o.base : null;
  // 패널을 열 때 읽은 하위 작업(본문에 이미 있던 줄 — 200자 검사·표기 떼기 없이 그대로 둔다)
  const baseSubs = base && Array.isArray(base.subtasks) ? base.subtasks.filter((x) => typeof x === 'string' || (x && typeof x === 'object')) : [];
  if (c.subtasks !== undefined) {
    if (!Array.isArray(c.subtasks)) throw detailValueError('subtasks', null);
    try {
      want.subtasks = normalizeSubtasks(c.subtasks, { keep: baseSubs });
    } catch (e) {
      throw detailValueError('subtasks', e);
    }
  }

  const latest = await api.getIssue(num);
  if (!latest || typeof latest !== 'object') throw new ApiError(MSG.badResponse, 0);
  if (latest.state === 'closed') throw new ApiError(MSG.metaClosed, 409, { issue: latest, kind: 'closed' });
  if (!isTask(latest)) throw new ApiError(MSG.metaNotTask, 400, { issue: latest, kind: 'notTask' });

  const body0 = typeof latest.body === 'string' ? latest.body : '';
  const cur = parseBody(body0);
  if (c.memo !== undefined) {
    // 표지는 최신 본문의 것(없으면 없음) + 사용자 메모
    want.memo = canonDetail('memo', joinMemoMarker(splitMemoMarker(cur.memo).marker, memoText));
  }
  // 본문에 이미 있던 하위 작업 = 패널을 열 때 읽은 것 + 최신 본문의 것(비교·저장 모두 같은 기준)
  const keep = [...baseSubs, ...cur.subtasks];
  if (c.subtasks !== undefined) {
    try {
      want.subtasks = normalizeSubtasks(c.subtasks, { keep });
    } catch (e) {
      throw detailValueError('subtasks', e);
    }
  }

  // 충돌 검사(세부 칸만)
  const inBase = (k) => Boolean(base) && Object.prototype.hasOwnProperty.call(base, k);
  if (!o.force && base) {
    const conflicts = [];
    for (const k of ['criteria', 'memo']) {
      if (!(k in want) || !inBase(k)) continue;
      const now = canonDetail(k, cur[k]);
      if (now !== canonDetail(k, base[k]) && now !== want[k]) conflicts.push(k);
    }
    if ('subtasks' in want && inBase('subtasks')) {
      const now = canonSubtasks(cur.subtasks, keep);
      if (!sameSubtasks(now, canonSubtasks(base.subtasks, keep)) && !sameSubtasks(now, want.subtasks)) conflicts.push('subtasks');
    }
    if (conflicts.length) throw new ApiError(MSG.metaConflict, 409, { kind: 'conflict', conflicts, issue: latest });
  }

  const names = labelNames(latest);
  const pCount = names.filter((x) => PRIORITY_KEYS.includes(x)).length;
  const patch = {};
  const changed = [];
  if (priority !== undefined && (priorityOf(latest) !== priority || pCount !== 1)) {
    patch.labels = withPriorityLabel(names, priority);
    changed.push('priority');
  }
  let body = body0;
  if (due !== undefined && cur.due !== due) {
    const next = setDueInBody(body, due);
    if (next !== body) {
      body = next;
      changed.push('due');
    }
  }
  for (const k of ['criteria', 'memo']) {
    if (k in want && canonDetail(k, cur[k]) !== want[k]) {
      body = setBodyField(body, k, want[k]);
      changed.push(k);
    }
  }
  if ('subtasks' in want && !sameSubtasks(canonSubtasks(cur.subtasks, keep), want.subtasks)) {
    body = setSubtasks(body, want.subtasks, { keep: baseSubs });
    changed.push('subtasks');
  }
  if (body !== body0) patch.body = body;
  if (!changed.length) return { issue: latest, changed };

  if (patch.labels) await ensureLabels(api, [priority], (opts && opts.labelCache) || null);
  const updated = await api.updateIssue(num, patch);
  const result =
    updated && typeof updated === 'object'
      ? updated
      : {
          ...latest,
          ...(patch.labels ? { labels: patch.labels.map((name) => ({ name })) } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
        };
  return { issue: result, changed };
}

/**
 * 날짜 표시('10/20(화) · D-16') 뒤에 붙일 조사 '로'/'으로'. 끝이 숫자면 읽는 소리의 받침으로 고른다:
 * 0(십·백·천·만 …)·3(삼)·6(육) → '으로', 1(일)·7(칠)·8(팔)(ㄹ 받침)·2·4·5·9 → '로'. 'D-day'(데이) 등 그 밖은 '로'.
 */
export function roParticle(text) {
  const last = String(text ?? '').trim().slice(-1);
  return '036'.includes(last) && last !== '' ? '으로' : '로';
}

/**
 * [✏ 변경] 결과 문장(번호 뒤에 붙인다). 날짜는 마감 칸과 같은 formatDue('10/20(화) · D-6'), 조사는 roParticle.
 * '우선순위를 p1(긴급)로, 마감을 10/20(화) · D-5로 바꿨습니다' / '우선순위를 p1(긴급)로 바꿨습니다' / '마감을 10/30(금) · D-16으로 바꿨습니다'
 * / '마감을 없앴습니다' / '우선순위를 p1(긴급)로 바꾸고 마감을 없앴습니다' / (바뀐 것 없음) '바뀐 내용이 없습니다'
 * 6차 — 세부 내용이 바뀌면 그 이름을 '·'로 이어 붙이고(하위 작업은 저장 뒤 개수) 끝에 '을/를 바꿨습니다':
 * '완료 기준·메모·하위 작업(3개)을 바꿨습니다' / 우선순위·마감과 함께면 앞 문장을 '…바꾸고'·'…없애고'로 이어서
 * '우선순위를 p1(긴급)로 바꾸고 메모를 바꿨습니다' / '우선순위를 p1(긴급)로, 마감을 10/20(화) · D-5로 바꾸고 하위 작업(2개)을 바꿨습니다'
 * / '마감을 없애고 완료 기준을 바꿨습니다' / '우선순위를 p1(긴급)로 바꾸고 마감을 없애고 메모를 바꿨습니다'.
 */
export function metaChangeText(issue, changed, today) {
  const list = Array.isArray(changed) ? changed : [];
  const prio = list.includes('priority') ? priorityText(priorityOf(issue)) : null;
  const dueChanged = list.includes('due');
  const detail = detailChangeText(issue, list);
  if (!prio && !dueChanged && !detail) return META_TEXT.noChange;
  const due = dueChanged ? parseBody(issue && issue.body).due : null;
  const dueShown = due ? formatDue(due, today) : '';
  const dueText = due ? `마감을 ${dueShown}${roParticle(dueShown)}` : null;
  if (!detail) {
    if (prio && dueChanged) return due ? `우선순위를 ${prio}로, ${dueText} 바꿨습니다` : `우선순위를 ${prio}로 바꾸고 ${META_TEXT.dueRemoved}`;
    if (prio) return `우선순위를 ${prio}로 바꿨습니다`;
    return due ? `${dueText} 바꿨습니다` : META_TEXT.dueRemoved;
  }
  const tail = `${detail}${objectParticle(detail)} 바꿨습니다`;
  if (!prio && !dueChanged) return tail;
  let head;
  if (prio && dueChanged) head = due ? `우선순위를 ${prio}로, ${dueText} 바꾸고` : `우선순위를 ${prio}로 바꾸고 마감을 없애고`;
  else if (prio) head = `우선순위를 ${prio}로 바꾸고`;
  else head = due ? `${dueText} 바꾸고` : '마감을 없애고';
  return `${head} ${tail}`;
}

/** 바뀐 세부 칸 이름: '완료 기준·메모·하위 작업(3개)' (없으면 null). 하위 작업 개수는 issue(저장 뒤) 본문 기준. */
export function detailChangeText(issue, changed) {
  const list = Array.isArray(changed) ? changed : [];
  const parts = DETAIL_KEYS.filter((k) => list.includes(k)).map((k) =>
    k === 'subtasks' ? `${DETAIL_NAME.subtasks}(${parseBody(issue && issue.body).subtasks.length}개)` : DETAIL_NAME[k],
  );
  return parts.length ? parts.join('·') : null;
}

/**
 * 목적격 조사 '을'/'를': 끝 글자(끝의 괄호 묶음 '(3개)' 는 건너뜀 — 괄호 앞 말에 맞춘다)의 받침 유무.
 * '하위 작업(3개)' → '을', '메모' → '를', '완료 기준' → '을'. 한글이 아니면 '를'.
 */
export function objectParticle(text) {
  const s = String(text ?? '').trim().replace(/\s*\([^()]*\)$/, '');
  const code = s.charCodeAt(s.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '을' : '를';
  return '를';
}

/**
 * [✏ 변경] 결과에 덧붙일 안내: 마감이 지났으면 '이미 지난 날짜라 🔴 지연에 표시됩니다', (지나지 않은) 대기 중이면 그대로 ⏳ 대기 중.
 * 목록 위치에 관한 안내라 우선순위·마감을 바꿨을 때만 붙인다(세부 내용만 바꾸면 안내 없음).
 */
export function metaChangeNotes(issue, changed, today) {
  if (!Array.isArray(changed) || !changed.length) return [];
  if (!changed.includes('priority') && !changed.includes('due')) return [];
  const due = parseBody(issue && issue.body).due;
  if (due && due < today) return [META_TEXT.pastDue];
  if (labelNames(issue).includes('waiting')) return [META_TEXT.waitingStays];
  return [];
}

/** 체크박스 1개 토글: 최신 본문 GET → toggleChecklist → PATCH. 항목을 못 찾으면 409 ApiError. */
export async function toggleSubtask(api, number, item, checked) {
  const fresh = await api.getIssue(number);
  const body = fresh && typeof fresh.body === 'string' ? fresh.body : '';
  const next = toggleChecklist(body, item, Boolean(checked));
  if (next == null) throw new ApiError(MSG.bodyChanged, 409);
  if (next === body) return fresh;
  return api.updateIssue(number, { body: next });
}

/** 반복 원본 삭제 = close(not_planned). */
export async function deleteRecurring(api, number) {
  return api.closeIssue(number, 'not_planned');
}

/** 🆘 다시 요청할 수 있을 때까지 남은 ms(0이면 가능). storage는 localStorage 호환 객체. */
export function sosRemainingMs(storage, number, nowMs = Date.now()) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 0;
    const raw = storage.getItem(SOS_KEY_PREFIX + number);
    if (raw == null) return 0;
    const t = Number(raw);
    if (!Number.isFinite(t)) return 0;
    const elapsed = nowMs - t;
    if (elapsed < 0) return 0; // 기기 시계가 뒤로 간 경우: 막지 않는다
    return Math.max(0, SOS_INTERVAL_MS - elapsed);
  } catch {
    return 0;
  }
}

export function canRequestSos(storage, number, nowMs = Date.now()) {
  return sosRemainingMs(storage, number, nowMs) === 0;
}

export function markSos(storage, number, nowMs = Date.now()) {
  try {
    if (storage && typeof storage.setItem === 'function') storage.setItem(SOS_KEY_PREFIX + number, String(nowMs));
  } catch {
    /* 저장 실패해도 동작은 계속 */
  }
}

// ─────────────────────────────────────────────────────────────
// 화면 (브라우저 전용 — boot() 안에서만 DOM 접근)
// ─────────────────────────────────────────────────────────────
const GROUPS = [
  { key: 'overdue', icon: '🔴', name: '지연', short: '지연' },
  { key: 'urgent', icon: '🟠', name: '긴급', short: '긴급' },
  { key: 'week', icon: '🟡', name: '이번 주', short: '이번 주' },
  { key: 'later', icon: '🟢', name: '나중에', short: '나중에' },
  { key: 'waiting', icon: '⏳', name: '대기 중', short: '대기' },
];
const COLUMNS = [
  { label: '할 일', cls: 'col-title' },
  { label: '마감', cls: 'col-due' },
  { label: '제출', cls: 'col-submit' },
  { label: '우선순위', cls: 'col-meta' },
  { label: '영역', cls: 'col-meta' },
  { label: '프로젝트', cls: 'col-meta' },
  { label: '예상', cls: 'col-meta' },
  { label: '작업', cls: 'col-actions' },
];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    node.append(typeof c === 'object' ? c : String(c)); // 문자열은 텍스트 노드로만 들어간다
  }
}

function issueLink(n) {
  return el(
    'a',
    {
      class: 'issue-link',
      href: ISSUE_URL_BASE + positiveInt(n),
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    `#${n}`,
  );
}

function shortDate(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}(${WEEKDAY_KO[weekdayOf(ymd)]})`;
}

function timeOf(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function clockText(ms) {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Seoul',
    }).format(ms);
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/** ISO 시각 → 한국 시간 '10/15(목) 09:34'. 해석 불가면 ''. */
function dateTimeText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = shortDate(toKSTDate(iso));
  return d ? `${d} ${clockText(t)}` : clockText(t);
}

const REPLY_STATE_TEXT = Object.freeze({ working: '작성 중', done: '완료', error: '오류' });

function describeTask(task, today, { waiting = false } = {}) {
  if (!task) return '';
  const parts = [];
  parts.push(task.due ? `마감 ${formatDue(task.due, today)}` : '마감 없음');
  parts.push(task.priority || 'p2');
  parts.push(task.area === 'area:personal' ? '개인' : '업무');
  if (task.project) parts.push(`프로젝트 ${task.project}`);
  if (task.submitTo) parts.push(`제출 ${task.submitTo}`);
  if (task.estimate) parts.push(`예상 ${task.estimate}`);
  if (waiting) parts.push('대기 중');
  return parts.join(' · ');
}

/** localStorage를 try/catch로 감싸고, 쓸 수 없으면 메모리로 대신한다(페이지는 계속 동작). */
function createSafeStorage() {
  const mem = new Map();
  let ls = null;
  try {
    ls = window.localStorage;
    const k = 'my-todo.__probe';
    ls.setItem(k, '1');
    ls.removeItem(k);
  } catch {
    ls = null;
  }
  return {
    persistent: Boolean(ls),
    getItem(k) {
      try {
        if (ls) {
          const v = ls.getItem(k);
          if (v != null) return v;
        }
      } catch {
        /* 무시 */
      }
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(k, v) {
      mem.set(k, String(v));
      try {
        if (!ls) return false;
        ls.setItem(k, String(v));
        return true;
      } catch {
        return false;
      }
    },
    removeItem(k) {
      mem.delete(k);
      try {
        if (ls) ls.removeItem(k);
      } catch {
        /* 무시 */
      }
    },
  };
}

function boot() {
  const byId = (id) => document.getElementById(id);
  const els = {
    app: byId('app'),
    totalCount: byId('total-count'),
    groupBadges: byId('group-badges'),
    doneWeek: byId('done-week'),
    chips: byId('project-chips'),
    refreshBtn: byId('refresh-btn'),
    settingsBtn: byId('settings-btn'),
    settings: byId('settings'),
    tokenState: byId('token-state'),
    tokenInput: byId('token-input'),
    tokenSave: byId('token-save'),
    tokenDelete: byId('token-delete'),
    tokenTest: byId('token-test'),
    settingsStatus: byId('settings-status'),
    mainContent: byId('main-content'),
    form: byId('input-form'),
    input: byId('task-input'),
    inputBtn: byId('input-btn'),
    message: byId('message'),
    listStatus: byId('list-status'),
    groups: byId('groups'),
    doneCount: byId('done-count'),
    doneList: byId('done-list'),
    recurringCount: byId('recurring-count'),
    recurringList: byId('recurring-list'),
    notices: byId('notices'),
  };
  if (Object.values(els).some((v) => !v)) {
    els.app.replaceChildren(el('p', { class: 'fatal' }, '페이지 구성 요소를 찾지 못했습니다. 새로고침해 주세요.'));
    return;
  }

  const storage = createSafeStorage();
  const S = {
    token: null,
    tokenPersisted: false,
    api: null,
    issues: new Map(), // number → issue (열린 할 일 + 이번 주 닫힌 것 + 반복 원본)
    recent: new Map(), // number → {issue, at}: 방금 바꾼 항목(새로고침 시 지연된 목록보다 우선)
    labelCache: new Set(),
    loaded: false,
    loading: false,
    loadError: null,
    loadedAt: 0,
    loadSeq: 0,
    project: null,
    busy: new Set(),
    expanded: new Set(),
    groupOpen: new Map(),
    confirmDelete: null,
    today: todayKST(),
    replies: new Map(), // number → {loading, error, reply, latest, count, at, seq}: 댓글(Claude 답변) 조회 결과
    replyOpen: new Set(), // 답변 패널을 펼친 이슈 번호
    replySeq: 0,
    watch: new Map(), // number → 🆘 후 자동 확인 상태(이슈당 타이머 1개)
    notices: new Map(), // number → 🆘 답변 도착/시간 초과 알림
    edits: new Map(), // number → [✏ 변경] 편집 패널 상태 {group, origPriority, origDue, priority, due, noDue, lastDue}
  };
  let editAt = new Map(); // number → 편집 패널을 그리는 그룹(같은 이슈가 🔴·⏳ 두 그룹에 있어도 패널은 한 곳)
  let subSeq = 0; // [✏ 변경] 하위 작업 편집기 줄 번호(줄마다 고유 — 순서를 바꿔도 id·포커스가 그 줄을 따라간다)
  let renderDeferTimer = null; // 입력 중이라 미룬 다시 그리기
  let msgState = null;
  let undoTimer = null;
  let noticeSig = '';

  // ── 상태 헬퍼 ─────────────────────────────────────────
  const issueKey = (n) => `issue:${n}`;
  const openIssues = () => [...S.issues.values()].filter((i) => i.state !== 'closed' && !i.pull_request);
  const matchesProject = (i) => !S.project || labelNames(i).includes(`proj:${S.project}`);
  // 이번 주 완료(상단 "이번 주 완료 n건" 개수용 — [지우기]로 숨긴 것도 센다)
  const completedList = (today) =>
    [...S.issues.values()]
      .filter((i) => i.state === 'closed' && !i.pull_request && isTask(i) && isCompletedThisWeek(i, today) && matchesProject(i))
      .sort((a, b) => timeOf(a.closed_at) - timeOf(b.closed_at) || a.number - b.number);
  const recurringList = () =>
    [...S.issues.values()]
      .filter((i) => i.state !== 'closed' && !i.pull_request && labelNames(i).includes('recurring') && matchesProject(i))
      .sort((a, b) => a.number - b.number);

  /**
   * 라벨만 바꾼 결과(라벨 API 응답에는 updated_at 이 없음)가 새로고침 때 지연된 목록 응답(최대 약 60초)에 밀리지 않도록
   * 로컬 사본의 updated_at 을 지금 시각으로 올린다(더 새로운 서버 응답이 오면 그것이 이긴다).
   */
  function touchLocal(issue) {
    const now = Date.now();
    return timeOf(issue && issue.updated_at) >= now ? issue : { ...issue, updated_at: new Date(now).toISOString() };
  }

  /** API 응답 객체로 메모리 상태를 즉시 갱신(재조회하지 않음). */
  function upsert(issue, { local = true } = {}) {
    if (!issue || typeof issue !== 'object' || !Number.isInteger(issue.number)) return;
    const prev = S.issues.get(issue.number);
    const merged = prev ? { ...prev, ...issue } : issue;
    S.issues.set(issue.number, merged);
    if (local) S.recent.set(issue.number, { issue: merged, at: Date.now() });
  }

  /**
   * 포커스 위치 기억: {id, fkey}. 같은 이슈가 두 그룹(🔴·⏳)에 그려지므로 id 에는 그룹이 들어 있고,
   * fkey(data-fkey)는 그룹과 무관한 "이 이슈의 이 버튼" 표시다 — 처리 후 항목이 다른 그룹으로 옮겨 가도 따라간다.
   */
  function activeIdInApp() {
    const a = document.activeElement;
    if (!(a && a.id && a !== document.body && els.app.contains(a))) return null;
    return { id: a.id, fkey: (a.dataset && a.dataset.fkey) || null };
  }

  function restoreFocus(target) {
    if (!target) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const spec = typeof target === 'string' ? { id: target, fkey: null } : target;
    let t = spec.id ? byId(spec.id) : null;
    if ((!t || t.disabled) && spec.fkey) {
      t = [...els.app.querySelectorAll('[data-fkey]')].find((x) => x.dataset.fkey === spec.fkey && !x.disabled) || null;
    }
    if (t && !t.disabled) t.focus({ preventScroll: true });
  }

  /** 글자 칸의 커서·선택 범위(다시 그린 뒤 되살리기용). 글자 칸이 아니면 null. */
  function selectionOf(a) {
    if (!a || a.tagName !== 'INPUT' || a.type !== 'text' || !a.id) return null;
    try {
      return { id: a.id, start: a.selectionStart, end: a.selectionEnd, dir: a.selectionDirection || 'none' };
    } catch {
      return null;
    }
  }

  function restoreSelection(sel) {
    const a = document.activeElement;
    if (!sel || !a || a.id !== sel.id || a.type !== 'text' || sel.start == null) return;
    try {
      a.setSelectionRange(sel.start, sel.end ?? sel.start, sel.dir);
    } catch {
      /* 무시 */
    }
  }

  // ── 렌더링 ───────────────────────────────────────────
  /**
   * 화면 다시 그리기. 편집 패널 칸에 입력 중이면(editingField) EDIT_DEFER_MS 뒤로 미룬다 — 칸이 새로 만들어지면
   * 덜 친 날짜·한글 조합이 끊기기 때문(그사이 바뀐 상태는 미룬 다시 그리기가 한 번에 반영). 입력 중인 패널의 항목을 처리 중이면 미루지 않는다.
   * opts.now: 패널 안의 동작(줄 추가·이동·삭제, 열기·닫기, 그 항목의 저장)처럼 지금 그려야 하는 경우.
   * 다시 그린 뒤에는 포커스(id → data-fkey)와 글자 칸의 커서 위치를 되살린다.
   */
  function render(opts = null) {
    if (!(opts && opts.now) && editingField()) {
      const en = editingIssue();
      if (en == null || !S.busy.has(issueKey(en))) {
        if (renderDeferTimer === null) {
          renderDeferTimer = setTimeout(() => {
            renderDeferTimer = null;
            render();
          }, EDIT_DEFER_MS);
        }
        return;
      }
    }
    if (renderDeferTimer !== null) {
      clearTimeout(renderDeferTimer);
      renderDeferTimer = null;
    }
    const today = todayKST(); // 매번 다시 계산
    S.today = today;
    const focus = activeIdInApp();
    const sel = selectionOf(document.activeElement);
    renderTop(today);
    renderStatus();
    renderGroups(today);
    renderDone(today);
    renderRecurring();
    renderNotices();
    els.inputBtn.disabled = S.busy.has('input');
    if (focus && document.activeElement !== byId(focus.id)) {
      restoreFocus(focus);
      restoreSelection(sel);
    }
  }

  function renderTop(today) {
    const g = S.loaded ? groupIssues(openIssues(), today, { project: S.project }) : null;
    els.totalCount.textContent = g ? String(g.total) : '–';
    els.groupBadges.replaceChildren(
      ...GROUPS.map((d) => {
        const count = g ? g[d.key].length : null;
        return el(
          'li',
          null,
          el(
            'button',
            {
              type: 'button',
              class: `gbadge g-${d.key}${count === 0 ? ' is-zero' : ''}`,
              disabled: !g,
              'aria-label': `${d.short} ${count ?? 0}개 — 목록으로 이동`,
              onclick: () => jumpToGroup(d.key),
            },
            el('span', { 'aria-hidden': 'true' }, d.icon),
            ` ${d.short} `,
            el('strong', null, count == null ? '–' : String(count)),
          ),
        );
      }),
    );
    els.doneWeek.textContent = S.loaded ? `이번 주 완료 ${completedList(today).length}건` : '이번 주 완료 –건';
    renderChips();
    els.refreshBtn.disabled = !S.api || S.loading;
    els.refreshBtn.textContent = S.loading ? '불러오는 중…' : '새로고침';
    els.refreshBtn.setAttribute('aria-busy', String(S.loading));
  }

  function renderChips() {
    if (!S.loaded) {
      els.chips.replaceChildren();
      els.chips.hidden = true;
      return;
    }
    const counts = new Map();
    for (const i of openIssues()) {
      if (!isTask(i)) continue;
      for (const p of projectsOf(labelNames(i))) counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (S.project && !counts.has(S.project)) counts.set(S.project, 0);
    const projects = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
    const chip = (label, value, count) =>
      el(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(S.project === value),
          onclick: () => setProject(value),
        },
        label,
        count == null ? null : el('span', { class: 'chip-count' }, String(count)),
      );
    els.chips.hidden = false;
    els.chips.replaceChildren(
      el('span', { class: 'chips-label' }, '프로젝트'),
      chip('전체', null, null),
      ...projects.map((p) => chip(p, p, counts.get(p))),
    );
  }

  function renderStatus() {
    const parts = [];
    if (!S.api) {
      parts.push(el('p', null, '먼저 ⚙ 설정에서 GitHub 토큰을 저장하세요.'));
    } else if (S.loadError) {
      parts.push(
        el('p', { class: 'status-error' }, `목록을 불러오지 못했습니다: ${errorText(S.loadError)}`),
        el('div', { class: 'status-actions' },
          el('button', { type: 'button', id: 'retry-load', disabled: S.loading, onclick: () => loadAll() }, '다시 시도'),
          S.loadError instanceof ApiError && S.loadError.status === 401
            ? el('button', { type: 'button', onclick: () => openSettings(true) }, '⚙ 설정 열기')
            : null,
        ),
      );
    } else if (S.loading && !S.loaded) {
      parts.push(el('p', { class: 'status-loading' }, '할 일 목록을 불러오는 중…'));
    } else if (S.loaded) {
      parts.push(
        el(
          'p',
          { class: 'status-muted' },
          `${clockText(S.loadedAt)} 기준`,
          S.project ? ` · 프로젝트 ${S.project}만 표시` : '',
          S.loading ? ' · 새로고침 중…' : '',
        ),
      );
    }
    els.listStatus.replaceChildren(...parts);
  }

  function renderGroups(today) {
    if (!S.api || !S.loaded) {
      els.groups.replaceChildren();
      return;
    }
    const g = groupIssues(openIssues(), today, { project: S.project });
    // [✏ 변경] 패널: 닫혔거나 할 일이 아니게 된 항목의 편집 상태는 버린다. 패널은 연 그룹에(그 그룹에 없으면 첫 그룹에) 하나만 그린다.
    editAt = new Map();
    for (const [n, d] of [...S.edits]) {
      const i = S.issues.get(n);
      if (!i || i.state === 'closed' || !isTask(i)) {
        S.edits.delete(n);
        continue;
      }
      const inGroup = (k) => (g[k] || []).some((x) => x.number === n);
      const k = inGroup(d.group) ? d.group : GROUPS.map((x) => x.key).find(inGroup);
      if (k) editAt.set(n, k);
    }
    els.groups.replaceChildren(...GROUPS.map((d) => renderGroup(d, g[d.key] || [], today)));
  }

  function renderGroup(def, items, today) {
    const empty = items.length === 0;
    const pref = S.groupOpen.get(def.key);
    const details = el('details', {
      class: `group g-${def.key}${empty ? ' is-empty' : ''}`,
      id: `group-${def.key}`,
      open: !empty && pref !== false,
    });
    details.append(
      el(
        'summary',
        { id: `group-${def.key}-summary` },
        el('span', { class: 'g-icon', 'aria-hidden': 'true' }, def.icon),
        el('span', { class: 'g-name' }, def.name),
        el('span', { class: 'g-count' }, empty ? '없음' : `${items.length}개`),
      ),
    );
    if (empty) {
      details.append(el('p', { class: 'empty' }, '없음'));
    } else {
      const tbody = el(
        'tbody',
        null,
        items.map((issue) =>
          editAt.get(issue.number) === def.key ? [renderRow(issue, def.key, today), renderEditRow(issue, def.key)] : renderRow(issue, def.key, today),
        ),
      );
      details.append(
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'tasks' },
            el('caption', { class: 'visually-hidden' }, `${def.name} 할 일 목록`),
            el('thead', null, el('tr', null, COLUMNS.map((c) => el('th', { scope: 'col', class: c.cls }, c.label)))),
            tbody,
          ),
        ),
      );
    }
    details.addEventListener('toggle', () => {
      if (!empty) S.groupOpen.set(def.key, details.open);
    });
    return details;
  }

  function cell(label, content, cls = '') {
    const emptyVal = content == null || content === '';
    return el(
      'td',
      { class: `${cls}${emptyVal ? ' is-empty' : ''}`.trim(), 'data-label': label },
      emptyVal ? '—' : content,
    );
  }

  function renderRow(issue, groupKey, today) {
    const n = issue.number;
    const labels = labelNames(issue);
    const f = parseBody(issue.body);
    const prio = priorityOf(issue);
    const isWaiting = labels.includes('waiting');
    const busy = S.busy.has(issueKey(n));
    const area = labels.includes('area:personal') ? '개인' : labels.includes('area:work') ? '업무' : '';
    const title = issue.title || '(제목 없음)';
    const projects = projectsOf(labels);
    const comments = Number.isSafeInteger(issue.comments) && issue.comments > 0 ? issue.comments : 0;
    const rowDetail = rowDetailOf(f);
    // 중간 폭(641~999px)에서는 우선순위·영역·프로젝트·예상 열을 숨기고 제목 아래 한 줄로 보여 준다(CSS로 전환)
    const metaInline = el(
      'p',
      { class: 'meta-inline' },
      el('span', { class: `badge prio prio-${prio}` }, prio),
      area ? el('span', null, area) : null,
      projects.length ? el('span', null, `프로젝트 ${projects.join(', ')}`) : null,
      f.estimate ? el('span', null, `예상 ${f.estimate}`) : null,
    );

    const titleCell = el(
      'td',
      { class: 'c-title', 'data-label': '할 일' },
      el(
        'div',
        { class: 'title-line' },
        issueLink(n),
        el('span', { class: 'title-text' }, title),
        groupKey === 'overdue' && isWaiting ? el('span', { class: 'badge badge-waiting' }, '대기') : null,
        labels.includes('stuck') ? el('span', { class: 'badge badge-stuck' }, '막힘') : null,
        comments ? el('span', { class: 'badge badge-comments', title: `댓글 ${comments}개` }, `💬 ${comments}`) : null,
      ),
      metaInline,
      detailLine('criteria', rowDetail.criteria, n),
      f.next ? el('p', { class: 'next-step' }, el('span', { class: 'next-key' }, '다음:'), ' ', f.next) : null,
      detailLine('memo', rowDetail.memo, n),
      renderSubtasks(issue, f.subtasks, busy, groupKey),
      renderReplyPanel(issue, groupKey, busy),
    );

    const due = f.due;
    let dueCls = 'c-field c-due';
    if (due && due < today) dueCls += ' due-over';
    else if (due && due <= addDays(today, 1)) dueCls += ' due-soon';

    const sosSent = !canRequestSos(storage, n, Date.now());
    const replyOpen = S.replyOpen.has(n);
    const showReply = comments > 0 || sosSent || replyOpen || S.watch.has(n) || S.replies.has(n);
    const replyLabel = replyOpen ? '💬 답변 닫기' : '💬 답변 보기';
    const editOpen = editAt.get(n) === groupKey;
    const actions = el(
      'td',
      { class: 'c-actions', 'data-label': '작업' },
      el(
        'div',
        { class: 'actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'primary',
            id: `btn-done-${groupKey}-${n}`,
            dataset: { fkey: `btn-done-${n}` },
            disabled: busy,
            'aria-label': `완료: #${n} ${title}`,
            onclick: () => onCompleteClick(n),
          },
          '완료',
        ),
        el(
          'button',
          {
            type: 'button',
            id: `btn-wait-${groupKey}-${n}`,
            dataset: { fkey: `btn-wait-${n}` },
            disabled: busy,
            'aria-label': `${isWaiting ? '⏳ 대기 해제' : '⏳ 대기 전환'}: #${n} ${title}`,
            onclick: () => onWaitingClick(n),
          },
          isWaiting ? '⏳ 대기 해제' : '⏳ 대기 전환',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'edit-btn',
            id: `btn-edit-${groupKey}-${n}`,
            dataset: { fkey: `btn-edit-${n}` },
            disabled: busy,
            'aria-expanded': String(editOpen),
            'aria-controls': editOpen ? `edit-${groupKey}-${n}` : null,
            'aria-label': `${editOpen ? '✏ 닫기' : '✏ 변경'}(${EDIT_SCOPE_TEXT}): #${n} ${title}`,
            onclick: () => onEditToggle(n, groupKey),
          },
          editOpen ? '✏ 닫기' : '✏ 변경',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'sos',
            id: `btn-sos-${groupKey}-${n}`,
            dataset: { fkey: `btn-sos-${n}` },
            disabled: busy,
            'aria-label': `${sosSent ? '🆘 요청됨' : '🆘 막막해요'}: #${n} ${title}`,
            onclick: () => onSosClick(n),
          },
          sosSent ? '🆘 요청됨' : '🆘 막막해요',
        ),
        showReply
          ? el(
              'button',
              {
                type: 'button',
                class: 'reply-btn',
                id: `btn-reply-${groupKey}-${n}`,
                dataset: { fkey: `btn-reply-${n}` },
                'aria-expanded': String(replyOpen),
                'aria-controls': replyOpen ? `reply-${groupKey}-${n}` : null,
                'aria-label': `${replyLabel}: #${n} ${title}`,
                onclick: () => onReplyToggle(n),
              },
              replyLabel,
            )
          : null,
      ),
    );

    return el(
      'tr',
      { class: `task prio-${prio}${busy ? ' is-busy' : ''}${editOpen ? ' is-editing' : ''}`, 'aria-busy': busy ? 'true' : null },
      titleCell,
      cell('마감', due ? formatDue(due, today) : '', dueCls),
      cell('제출', f.submitTo, 'c-field c-submit'),
      cell('우선순위', el('span', { class: `badge prio prio-${prio}` }, prio), 'c-field c-meta c-prio'),
      cell('영역', area, 'c-field c-meta c-area'),
      cell('프로젝트', projects.join(', '), 'c-field c-meta c-proj'),
      cell('예상', f.estimate, 'c-field c-meta c-est'),
      actions,
    );
  }

  /**
   * 행의 '완료 기준: …'·'메모: …' 한 줄(제목 아래 작은 글씨, 길면 한 줄 말줄임 — 하위 작업을 펼치면 전체, 전체는 [✏ 변경] 패널에서도).
   * 값이 없으면 줄 없음(rowDetailOf 가 정한다).
   */
  function detailLine(key, value, n) {
    if (!value) return null;
    return el(
      'p',
      { class: `detail-line detail-${key}${S.expanded.has(n) ? ' is-full' : ''}` },
      el('span', { class: 'detail-key' }, `${DETAIL_NAME[key]}:`),
      ' ',
      value, // 값은 글자 그대로(말줄임은 p 가 잘라 보여 준다 — 화면 밖으로 넘치는 요소를 만들지 않게 감싸지 않는다)
    );
  }

  function renderSubtasks(issue, subtasks, busy, groupKey) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
    const n = issue.number;
    const { done, total } = checklistProgress(issue.body);
    if (!total) return null;
    const expanded = S.expanded.has(n);
    // 같은 항목의 [✏ 변경] 패널이 열려 있으면 여기서는 체크하지 않는다(패널의 하위 작업과 서로 덮어쓰지 않게)
    const editing = S.edits.has(n);
    const pct = Math.round((done / total) * 100);
    const fill = el('span', { class: 'bar-fill' });
    fill.style.width = `${pct}%`; // CSSOM — CSP style-src 영향 없음
    const listId = `subs-${groupKey}-${n}`; // 같은 이슈가 🔴·⏳ 두 그룹에 그려질 수 있어 id에 그룹을 넣는다
    const wrap = el(
      'div',
      { class: `subtasks${done === total ? ' all-done' : ''}` },
      el(
        'div',
        { class: 'sub-head' },
        el(
          'span',
          {
            class: 'bar',
            role: 'progressbar',
            'aria-label': '하위 작업 진행률',
            'aria-valuemin': '0',
            'aria-valuemax': String(total),
            'aria-valuenow': String(done),
            'aria-valuetext': `${total}개 중 ${done}개 완료`,
          },
          fill,
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'sub-toggle',
            id: `btn-sub-${groupKey}-${n}`,
            dataset: { fkey: `btn-sub-${n}` },
            'aria-expanded': String(expanded),
            'aria-controls': expanded ? listId : null,
            onclick: () => {
              if (S.expanded.has(n)) S.expanded.delete(n);
              else S.expanded.add(n);
              render();
            },
          },
          `하위 작업 ${done}/${total}`,
          el('span', { class: 'chev', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
        ),
      ),
    );
    if (expanded) {
      const ul = el('ul', { class: 'sub-list', id: listId });
      subtasks.forEach((s, index) => {
        const id = `chk-${groupKey}-${n}-${index}`;
        const box = el('input', {
          type: 'checkbox',
          id,
          dataset: { fkey: `chk-${n}-${index}` },
          checked: Boolean(s.done),
          disabled: busy || editing,
          'aria-describedby': editing ? `subs-lock-${groupKey}-${n}` : null,
        });
        box.addEventListener('change', () => onSubtaskToggle(n, { index, text: s.text }, box.checked));
        ul.append(el('li', null, el('label', { class: `${s.done ? 'is-done' : ''}${editing ? ' is-locked' : ''}`.trim() || null }, box, el('span', null, s.text))));
      });
      wrap.append(ul);
      if (editing) wrap.append(el('p', { class: 'sub-lock', id: `subs-lock-${groupKey}-${n}` }, META_TEXT.editingSubtasks));
    }
    return wrap;
  }

  // ── [✏ 변경] 편집 패널 (행 아래 한 줄): 우선순위·마감·완료 기준·메모·하위 작업 ──────
  /**
   * 편집 패널은 S.edits 의 상태로 매번 다시 그린다(🆘 답변 패널처럼 render() 를 거쳐도 열림·입력값이 유지된다).
   * 입력 요소마다 id(그룹 포함)와 data-fkey(그룹 무관)를 두어 다시 그린 뒤에도 키보드 포커스가 제자리로 돌아온다.
   * 글자 칸은 입력할 때마다 상태에 적어 두고(input 이벤트), 다시 그리면 커서 위치도 되살린다(render 의 restoreSelection).
   * 하위 작업 줄은 줄마다 고유 번호(s.id)로 id 를 만든다 — 순서를 바꿔도 같은 줄의 버튼으로 포커스가 돌아온다.
   */
  function renderEditRow(issue, groupKey) {
    const n = issue.number;
    const d = S.edits.get(n);
    if (!d) return null;
    const busy = S.busy.has(issueKey(n));
    const sfx = `${groupKey}-${n}`;
    const hintId = `edit-hint-${sfx}`;
    const dateId = `edit-due-${sfx}`;
    const noDueId = `edit-nodue-${sfx}`;

    const radios = PRIORITY_KEYS.map((p) => {
      const id = `edit-${p}-${sfx}`;
      const input = el('input', {
        type: 'radio',
        name: `edit-prio-${sfx}`,
        id,
        value: p,
        dataset: { fkey: `edit-${p}-${n}` },
        checked: d.priority === p,
        disabled: busy,
      });
      input.addEventListener('change', () => {
        if (input.checked) d.priority = p;
      });
      return el('label', { class: 'edit-opt', for: id }, input, ' ', el('span', { class: `badge prio prio-${p}` }, p), ` ${PRIORITY_TEXT[p]}`);
    });

    const date = el('input', {
      type: 'date',
      id: dateId,
      class: 'edit-date',
      dataset: { fkey: `edit-due-${n}` },
      value: d.noDue ? '' : d.due,
      min: DUE_MIN,
      max: DUE_MAX,
      disabled: busy || d.noDue,
    });
    const syncDate = () => {
      d.due = date.value;
    };
    date.addEventListener('input', syncDate);
    date.addEventListener('change', syncDate);
    const noDue = el('input', { type: 'checkbox', id: noDueId, dataset: { fkey: `edit-nodue-${n}` }, checked: d.noDue, disabled: busy });
    noDue.addEventListener('change', () => {
      d.noDue = noDue.checked;
      if (d.noDue) {
        // 체크하면 날짜 입력을 비우고 막는다(체크를 풀면 직전 날짜 → 원래 마감 순으로 되살린다)
        if (d.due) d.lastDue = d.due;
        d.due = '';
        date.value = '';
        date.disabled = true;
      } else {
        date.disabled = false;
        if (!d.due) {
          d.due = d.lastDue || d.origDue || '';
          date.value = d.due;
        }
      }
    });

    // 완료 기준·메모: 한 줄 입력(최대 500자). 입력값은 상태에 적어 두어 다시 그려도 남는다.
    const textInput = (what, value, attrs) => {
      const input = el('input', {
        type: 'text',
        id: `edit-${what}-${sfx}`,
        class: 'edit-text',
        dataset: { fkey: `edit-${what}-${n}` },
        maxlength: String(BODY_FIELD_MAX_CHARS),
        autocomplete: 'off',
        enterkeyhint: 'done',
        disabled: busy,
        ...attrs,
      });
      input.value = value;
      return input;
    };
    const crit = textInput('crit', d.criteria, { placeholder: META_TEXT.criteriaPlaceholder });
    crit.addEventListener('input', () => {
      d.criteria = crit.value;
    });
    const markerId = `edit-marker-${sfx}`;
    const memoNoteId = `edit-memo-note-${sfx}`;
    const memo = textInput('memo', d.memo, {
      placeholder: META_TEXT.memoPlaceholder,
      'aria-describedby': d.marker ? `${markerId} ${memoNoteId}` : memoNoteId,
    });
    memo.addEventListener('input', () => {
      d.memo = memo.value;
    });

    const form = el(
      'form',
      {
        class: 'edit-panel',
        id: `edit-${sfx}`,
        dataset: { editFor: n },
        'aria-label': `#${n} 할 일 변경`,
        'aria-describedby': hintId,
        'aria-busy': busy ? 'true' : null,
        autocomplete: 'off',
        novalidate: true, // 날짜·글자 수 확인은 브라우저 말풍선 대신 앱 메시지로(onEditSave)
      },
      el('fieldset', { class: 'edit-prio' }, el('legend', null, '우선순위'), el('div', { class: 'edit-opts' }, radios)),
      el(
        'div',
        { class: 'edit-due' },
        el('label', { class: 'edit-due-label', for: dateId }, '마감'),
        date,
        el('label', { class: 'edit-check', for: noDueId }, noDue, ' 마감 없음'),
      ),
      el('div', { class: 'edit-field' }, el('label', { class: 'edit-field-label', for: crit.id }, META_TEXT.criteriaLabel), crit),
      el(
        'div',
        { class: 'edit-field' },
        el('label', { class: 'edit-field-label', for: memo.id }, META_TEXT.memoLabel),
        d.marker ? el('p', { class: 'edit-marker', id: markerId }, `${META_TEXT.markerPrefix}${d.marker}${META_TEXT.markerSuffix}`) : null,
        memo,
        el('p', { class: 'edit-note', id: memoNoteId }, META_TEXT.sensitive),
      ),
      renderSubtaskEditor(n, d, sfx, busy),
      el('p', { class: 'edit-hint', id: hintId }, META_TEXT.hint),
      d.conflict ? renderEditConflict(n, d, sfx, busy) : null,
      el(
        'div',
        { class: 'edit-actions' },
        el(
          'button',
          {
            type: 'submit',
            class: 'primary',
            id: `btn-esave-${sfx}`,
            dataset: { fkey: `btn-esave-${n}` },
            disabled: busy,
            'aria-label': `${busy ? '저장 중…' : '저장'}: #${n} 할 일 변경`,
          },
          busy ? '저장 중…' : '저장',
        ),
        el(
          'button',
          {
            type: 'button',
            id: `btn-ecancel-${sfx}`,
            dataset: { fkey: `btn-ecancel-${n}` },
            disabled: busy,
            'aria-label': `취소: #${n} 할 일 변경`,
            onclick: () => onEditCancel(n),
          },
          '취소',
        ),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault(); // 페이지 이동 없음(CSP form-action 'none')
      onEditSave(n);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        onEditCancel(n);
      }
    });
    return el('tr', { class: 'edit-row' }, el('td', { class: 'c-edit', colspan: String(COLUMNS.length) }, form));
  }

  /**
   * 하위 작업 편집기: 줄마다 [완료 체크] [글자 칸] [▲][▼][삭제], 맨 아래 [+ 하위 작업 추가](Enter 로도 다음 줄 추가).
   * 0개면 '하위 작업이 없습니다', SUBTASK_LIMIT(50)줄이면 추가 버튼을 막고 안내. 빈 줄은 저장할 때 버린다.
   */
  function renderSubtaskEditor(n, d, sfx, busy) {
    const subs = d.subs;
    const total = subs.length;
    const atLimit = total >= SUBTASK_LIMIT;
    const helpId = `edit-subhelp-${sfx}`;
    const limitId = `edit-sublimit-${sfx}`;
    const rows = subs.map((s, i) => {
      const k = i + 1;
      const rid = `${sfx}-${s.id}`;
      const fk = `${n}-${s.id}`;
      const doneId = `edit-subdone-${rid}`;
      const textId = `edit-subtext-${rid}`;
      const box = el('input', { type: 'checkbox', id: doneId, dataset: { fkey: `edit-subdone-${fk}` }, checked: Boolean(s.done), disabled: busy });
      const text = el('input', {
        type: 'text',
        id: textId,
        class: 'edit-text sub-edit-text',
        dataset: { fkey: `edit-subtext-${fk}` },
        maxlength: String(SUBTASK_MAX_CHARS),
        autocomplete: 'off',
        enterkeyhint: 'next',
        'aria-describedby': atLimit ? `${helpId} ${limitId}` : helpId, // 50줄이면 Enter 로 줄이 생기지 않는다는 안내도
        disabled: busy,
      });
      text.value = s.text;
      const li = el('li', { class: `sub-edit-row${s.done ? ' is-done' : ''}` });
      box.addEventListener('change', () => {
        s.done = box.checked;
        li.classList.toggle('is-done', s.done);
      });
      text.addEventListener('input', () => {
        s.text = text.value;
      });
      text.addEventListener('keydown', (e) => {
        // Enter: 이 줄 바로 아래에 새 줄(한글 조합 중 Enter 는 글자 확정이므로 건드리지 않음). 폼 저장으로 넘어가지 않게 막는다.
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          onSubAdd(n, s.id);
        }
      });
      const btn = (kind, label, aria, off, run) =>
        el(
          'button',
          {
            type: 'button',
            class: `sub-edit-btn sub-edit-${kind}`,
            id: `btn-sub${kind}-${rid}`,
            dataset: { fkey: `btn-sub${kind}-${fk}` },
            disabled: busy || off,
            'aria-label': aria,
            onclick: run,
          },
          label,
        );
      li.append(
        el('label', { class: 'sub-edit-check', for: doneId }, box, el('span', { class: 'visually-hidden' }, `${k}번째 하위 작업 완료`)),
        el('label', { class: 'visually-hidden', for: textId }, `${k}번째 하위 작업`),
        text,
        el(
          'div',
          { class: 'sub-edit-btns' },
          btn('up', '▲', `${k}번째 하위 작업 위로`, i === 0, () => onSubMove(n, s.id, -1)),
          btn('down', '▼', `${k}번째 하위 작업 아래로`, i === total - 1, () => onSubMove(n, s.id, 1)),
          btn('del', '삭제', `${k}번째 하위 작업 삭제`, false, () => onSubDelete(n, s.id)),
        ),
      );
      return li;
    });
    return el(
      'fieldset',
      { class: 'edit-subs' },
      el('legend', null, META_TEXT.subtasksLegend),
      total ? el('ol', { class: 'sub-edit-list' }, rows) : el('p', { class: 'edit-note sub-edit-empty' }, META_TEXT.subtasksEmpty),
      el(
        'div',
        { class: 'sub-edit-foot' },
        el(
          'button',
          {
            type: 'button',
            class: 'sub-add',
            id: `btn-subadd-${sfx}`,
            dataset: { fkey: `btn-subadd-${n}` },
            disabled: busy || atLimit,
            'aria-describedby': atLimit ? limitId : null,
            onclick: () => onSubAdd(n, null),
          },
          META_TEXT.subtaskAdd,
        ),
      ),
      atLimit ? el('p', { class: 'edit-note', id: limitId }, META_TEXT.subtaskLimit) : null,
      total ? el('p', { class: 'edit-note', id: helpId }, META_TEXT.subtaskHelp) : null,
    );
  }

  /** 충돌 안내(패널 안): 바뀐 칸 + [내 내용으로 저장](덮어쓰기) [최신 내용 불러오기](내 입력 버리기). 패널·입력값은 그대로. */
  function renderEditConflict(n, d, sfx, busy) {
    const textId = `edit-conflict-${sfx}`;
    const helpId = `edit-conflict-help-${sfx}`;
    return el(
      'div',
      { class: 'edit-conflict' },
      el('p', { class: 'edit-conflict-text', id: textId }, `#${n} ${conflictText(d.conflict.fields)}`),
      el('p', { class: 'edit-note', id: helpId }, META_TEXT.conflictHelp),
      el(
        'div',
        { class: 'edit-conflict-actions' },
        el(
          'button',
          {
            type: 'button',
            id: `btn-eforce-${sfx}`,
            dataset: { fkey: `btn-eforce-${n}` },
            disabled: busy,
            'aria-describedby': `${textId} ${helpId}`,
            onclick: () => onEditSave(n, { force: true }),
          },
          META_TEXT.forceSave,
        ),
        el(
          'button',
          {
            type: 'button',
            id: `btn-ereload-${sfx}`,
            dataset: { fkey: `btn-ereload-${n}` },
            disabled: busy,
            'aria-describedby': `${textId} ${helpId}`,
            onclick: () => onEditReload(n),
          },
          META_TEXT.reloadLatest,
        ),
      ),
    );
  }

  // ── 🆘 Claude 답변 패널 ───────────────────────────────
  function renderInline(segs) {
    return (segs || []).map((sg) => {
      if (sg.t === 'bold') return el('strong', null, sg.v);
      if (sg.t === 'code') return el('code', null, sg.v);
      const href = sg.t === 'link' ? safeGithubUrl(sg.href) : null;
      if (href) return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, sg.v);
      return String(sg.v ?? '');
    });
  }

  /** replyBlocks 결과 → DOM(createElement/textContent만). 연속된 bullet/check 는 한 목록으로 묶는다. */
  function renderReplyBlocks(blocks) {
    const out = [];
    let list = null;
    for (const b of blocks) {
      if (b.type === 'bullet' || b.type === 'check') {
        if (!list) {
          list = el('ul', { class: 'r-list' });
          out.push(list);
        }
        if (b.type === 'check') {
          list.append(
            el(
              'li',
              { class: `r-check${b.checked ? ' is-done' : ''}` },
              el('span', { class: 'r-box', 'aria-hidden': 'true' }, b.checked ? '☑' : '☐'),
              b.checked ? el('span', { class: 'visually-hidden' }, '(완료) ') : null,
              el('span', null, renderInline(b.inline)),
            ),
          );
        } else {
          list.append(el('li', null, renderInline(b.inline)));
        }
        continue;
      }
      list = null;
      if (b.type === 'heading') out.push(el(`h${Math.min(3, Math.max(1, b.level || 1)) + 3}`, { class: 'r-h' }, renderInline(b.inline)));
      else if (b.type === 'hr') out.push(el('hr', { class: 'r-hr' }));
      else if (b.type === 'blockquote') out.push(el('blockquote', { class: 'r-quote' }, renderInline(b.inline)));
      else out.push(el('p', { class: b.truncated ? 'r-p r-trunc' : 'r-p' }, renderInline(b.inline)));
    }
    return out;
  }

  /** [본문에 반영] 버튼 상태: 항목·아직 본문에 없는 개수·문구 */
  function applyInfo(issue, reply) {
    if (!reply) return { items: [], pending: 0, label: '반영할 하위 작업 없음', enabled: false };
    const items = parseReplyChecklist(reply.body);
    if (!items.length) return { items, pending: 0, label: '반영할 하위 작업 없음', enabled: false };
    if (reply.state === 'working') return { items, pending: 0, label: '작성 중 — 완료 후 반영', enabled: false };
    if (issue && issue.state === 'closed') return { items, pending: 0, label: '완료된 할 일 — 반영 안 함', enabled: false };
    const pending = mergeSubtasksIntoBody(issue && issue.body, items).added.length;
    if (!pending) return { items, pending, label: '이미 반영됨', enabled: false };
    return { items, pending, label: `본문에 반영 (${pending}개)`, enabled: true };
  }

  function renderReplyPanel(issue, groupKey, busy) {
    const n = issue.number;
    if (!S.replyOpen.has(n)) return null;
    const entry = S.replies.get(n) || { loading: true, error: null, reply: null, latest: null };
    const reply = entry.reply;
    const head = el('div', { class: 'reply-head' }, el('strong', { class: 'reply-title' }, '답변'));
    if (reply) {
      head.append(el('span', { class: `reply-state st-${reply.state}` }, REPLY_STATE_TEXT[reply.state] || '완료'));
      const when = dateTimeText(reply.updated_at || reply.created_at);
      if (when) head.append(el('span', { class: 'reply-time' }, when));
      const href = safeGithubUrl(reply.html_url);
      if (href) head.append(el('a', { class: 'reply-gh', href, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub에서 보기'));
    }
    const kids = [head];
    if (entry.loading) kids.push(el('p', { class: 'reply-note' }, reply ? '최신 답변을 확인하는 중…' : '답변을 불러오는 중…'));
    if (entry.error) kids.push(el('p', { class: 'reply-error' }, `답변을 불러오지 못했습니다: ${errorText(entry.error)}`));
    if (S.watch.has(n)) kids.push(el('p', { class: 'reply-note' }, '🆘 답변을 자동으로 확인하는 중입니다(30초 간격, 최대 6분).'));
    const reload = el(
      'button',
      {
        type: 'button',
        id: `btn-rreload-${groupKey}-${n}`,
        dataset: { fkey: `btn-rreload-${n}` },
        disabled: Boolean(entry.loading),
        onclick: () => loadReply(n),
      },
      '다시 불러오기',
    );
    if (reply) {
      if (reply.state === 'working') kids.push(el('p', { class: 'reply-note' }, 'Claude가 답변을 작성하고 있습니다. 잠시 뒤 [다시 불러오기]를 누르세요.'));
      if (reply.state === 'error') kids.push(el('p', { class: 'reply-note st-error' }, 'Claude 실행이 오류로 끝났습니다. 아래 내용이 완전하지 않을 수 있습니다.'));
      if (reply.stale) kids.push(el('p', { class: 'reply-note' }, '이 답변은 20분 넘게 바뀌지 않아 실행이 끝난 것으로 봅니다. 내용이 완전하지 않을 수 있습니다.'));
      // 표시용 정리(상태 줄·/todo-stuck 표기·반영 안내 줄 제거). [본문에 반영]은 원문(reply.body)으로 계산한다.
      kids.push(el('div', { class: 'reply-body' }, renderReplyBlocks(replyBlocks(cleanReplyForDisplay(reply.body)))));
      const info = applyInfo(issue, reply);
      // 같은 항목의 [✏ 변경] 패널이 열려 있으면 반영하지 않는다(패널의 하위 작업 목록과 서로 덮어쓰지 않게)
      const editing = S.edits.has(n);
      const lockId = `apply-lock-${groupKey}-${n}`;
      kids.push(
        el(
          'div',
          { class: 'reply-actions' },
          el(
            'button',
            {
              type: 'button',
              class: info.enabled && !editing ? 'primary' : null,
              id: `btn-apply-${groupKey}-${n}`,
              dataset: { fkey: `btn-apply-${n}` },
              disabled: busy || !info.enabled || editing,
              'aria-label': `${info.label}: #${n}`,
              'aria-describedby': editing && info.enabled ? lockId : null,
              onclick: () => onApplyReply(n),
            },
            info.label,
          ),
          reload,
        ),
      );
      if (editing && info.enabled) kids.push(el('p', { class: 'reply-note', id: lockId }, META_TEXT.editingApply));
    } else if (!entry.loading) {
      if (!entry.error) kids.push(el('p', { class: 'reply-empty' }, '아직 Claude 답변이 없습니다'));
      const c = entry.latest;
      if (!entry.error && c && typeof c === 'object') {
        const who = c.user && typeof c.user.login === 'string' && c.user.login ? c.user.login : '알 수 없음';
        const raw = typeof c.body === 'string' ? c.body.trim() : '';
        const text = Array.from(raw).length > 300 ? `${cutChars(raw, 300)}…` : raw;
        const when = dateTimeText(c.created_at);
        kids.push(
          el(
            'div',
            { class: 'reply-ref' },
            el('p', { class: 'reply-ref-head' }, `최근 댓글(참고): ${who}${when ? ` · ${when}` : ''}`),
            text ? el('p', { class: 'reply-ref-body' }, text) : null,
          ),
        );
      }
      kids.push(el('div', { class: 'reply-actions' }, reload));
    }
    return el(
      'section',
      { class: 'reply-panel', id: `reply-${groupKey}-${n}`, dataset: { replyFor: n }, tabindex: '-1', 'aria-label': `#${n} 답변` },
      kids,
    );
  }

  /**
   * 🆘 알림 영역. render() 마다 불리지만, 내용(알림·버튼 상태)이 같으면 DOM 을 바꾸지 않는다
   * (aria-live 영역을 매번 갈아 끼우면 화면 읽기 프로그램이 같은 알림을 되풀이해 읽는다).
   */
  function renderNotices() {
    const sig = JSON.stringify(
      [...S.notices.values()].map((nt) => {
        const entry = S.replies.get(nt.n);
        const info = nt.kind === 'arrived' ? applyInfo(S.issues.get(nt.n) || { number: nt.n, body: '' }, entry && entry.reply) : null;
        return [nt.n, nt.kind, nt.state || '', nt.message || '', info && info.label, info && info.enabled, S.busy.has(issueKey(nt.n)), S.edits.has(nt.n)];
      }),
    );
    if (sig === noticeSig && els.notices.childNodes.length === S.notices.size) return;
    noticeSig = sig;
    const cards = [];
    for (const nt of S.notices.values()) {
      const n = nt.n;
      const lines = [];
      const actions = [];
      let tone = 'info';
      if (nt.kind === 'arrived') {
        tone = 'success';
        lines.push(['🆘 ', issueLink(n), ' 에 답변이 도착했습니다']);
        if (nt.state === 'error') lines.push('Claude 실행은 오류로 끝났지만 답변 내용은 볼 수 있습니다.');
        const entry = S.replies.get(n);
        const info = applyInfo(S.issues.get(n) || { number: n, body: '' }, entry && entry.reply);
        const editing = S.edits.has(n); // [✏ 변경] 패널이 열려 있으면 반영 버튼은 잠근다
        // 잠금 안내 줄은 버튼 설명(aria-describedby)으로도 잇는다(답변 칸의 같은 버튼과 같게)
        const lockId = editing && info.enabled ? `napply-lock-${n}` : null;
        if (lockId) lines.push({ id: lockId, text: META_TEXT.editingApply });
        actions.push(
          el('button', { type: 'button', id: `btn-nview-${n}`, onclick: () => onNoticeView(n) }, '답변 보기'),
          el(
            'button',
            {
              type: 'button',
              class: info.enabled && !editing ? 'primary' : null,
              id: `btn-napply-${n}`,
              disabled: S.busy.has(issueKey(n)) || !info.enabled || editing,
              'aria-describedby': lockId,
              onclick: () => onApplyReply(n),
            },
            info.label,
          ),
        );
      } else if (nt.kind === 'timeout') {
        lines.push(['🆘 ', issueLink(n), ' 아직 답변이 없습니다. 잠시 뒤 항목의 [💬 답변 보기]로 확인하세요.']);
      } else {
        tone = 'warn';
        lines.push(['🆘 ', issueLink(n), ` 답변 자동 확인을 멈췄습니다: ${nt.message || MSG.unexpected}`]);
      }
      const card = el(
        'div',
        { class: `msg-card notice tone-${tone}`, dataset: { noticeFor: n } },
        el('div', { class: 'msg-text' }, lines.map((ln) => (ln && typeof ln === 'object' && !Array.isArray(ln) && ln.id ? el('p', { id: ln.id }, ln.text) : el('p', null, ln)))),
        actions.length ? el('div', { class: 'msg-actions' }, actions) : null,
        el(
          'button',
          {
            type: 'button',
            class: 'msg-close',
            'aria-label': `#${n} 알림 닫기`,
            onclick: () => {
              S.notices.delete(n);
              render();
            },
          },
          '×',
        ),
      );
      cards.push(card);
    }
    els.notices.replaceChildren(...cards);
  }

  function renderDone(today) {
    if (!S.loaded) {
      els.doneCount.textContent = '';
      els.doneList.replaceChildren(el('p', { class: 'empty' }, '목록을 불러오면 표시됩니다.'));
      return;
    }
    const all = completedList(today);
    const list = all.filter((i) => !isHiddenDone(i));
    const hiddenCount = all.length - list.length;
    // 섹션 제목에는 '보이는 개수'(숨긴 것이 있으면 · 숨김 k). 상단 "이번 주 완료 n건"은 숨긴 것도 센다.
    els.doneCount.textContent = `${list.length}건${hiddenCount ? ` · 숨김 ${hiddenCount}` : ''}`;
    const note = el(
      'p',
      { class: 'extra-note' },
      '다음 주(월요일 0시)가 되면 이 목록에서 저절로 빠집니다. [지우기]는 모든 기기의 이 목록에서 숨깁니다(GitHub 이슈와 기록은 남고, 이슈의 hidden 라벨을 떼면 다시 보입니다).',
    );
    if (!list.length) {
      els.doneList.replaceChildren(
        el(
          'p',
          { class: 'empty' },
          hiddenCount
            ? `이번 주에 완료한 일을 모두 목록에서 지웠습니다(숨김 ${hiddenCount}건).`
            : '이번 주(월요일 0시 이후)에 완료한 일이 없습니다.',
        ),
        hiddenCount ? note : null,
      );
      return;
    }
    els.doneList.replaceChildren(
      el(
        'ol',
        { class: 'plain-list done-list' },
        list.map((i) => {
          const n = i.number;
          const title = i.title || '(제목 없음)';
          return el(
            'li',
            null,
            el('span', { class: 'when' }, i.closed_at ? shortDate(toKSTDate(i.closed_at)) : ''),
            issueLink(n),
            el('span', { class: 'title-text' }, title),
            el(
              'button',
              {
                type: 'button',
                class: 'mini done-hide',
                id: `btn-hide-${n}`,
                disabled: S.busy.has(issueKey(n)),
                'aria-label': `지우기: #${n} ${title} (완료 목록에서 숨김)`,
                onclick: () => onHideDone(n),
              },
              '지우기',
            ),
          );
        }),
      ),
      note,
    );
  }

  function ruleTextOf(issue) {
    const raw = parseBody(issue.body).recurrence;
    if (!raw) return '규칙 없음';
    const rule = parseRecurrenceValue(raw);
    return rule ? formatRecurrence(rule) : `${raw} (해석 불가)`;
  }

  function renderRecurring() {
    const list = S.loaded ? recurringList() : [];
    els.recurringCount.textContent = S.loaded ? `${list.length}개` : '';
    if (!list.length) {
      els.recurringList.replaceChildren(
        el(
          'p',
          { class: 'empty' },
          S.loaded ? '등록된 반복 할 일이 없습니다. 예: "매주 월요일 주간보고 작성하기"' : '목록을 불러오면 표시됩니다.',
        ),
      );
      return;
    }
    els.recurringList.replaceChildren(
      el(
        'ul',
        { class: 'plain-list recurring-list' },
        list.map((i) => {
          const n = i.number;
          const labels = labelNames(i);
          const busy = S.busy.has(issueKey(n));
          const meta = [priorityOf(i), labels.includes('area:personal') ? '개인' : '업무', ...projectsOf(labels)];
          const confirming = S.confirmDelete === n;
          const actions = confirming
            ? el(
                'div',
                { class: 'actions confirm' },
                el('span', { class: 'confirm-text' }, '삭제할까요? (GitHub에서 닫힘 처리)'),
                el(
                  'button',
                  { type: 'button', class: 'danger', id: `btn-rdel-yes-${n}`, disabled: busy, onclick: () => onRecurringDelete(n) },
                  '삭제',
                ),
                el(
                  'button',
                  {
                    type: 'button',
                    id: `btn-rdel-no-${n}`,
                    disabled: busy,
                    onclick: () => {
                      S.confirmDelete = null;
                      render();
                      restoreFocus(`btn-rdel-${n}`);
                    },
                  },
                  '취소',
                ),
              )
            : el(
                'div',
                { class: 'actions' },
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'danger-outline',
                    id: `btn-rdel-${n}`,
                    disabled: busy,
                    'aria-label': `삭제: #${n} ${i.title || ''}`,
                    onclick: () => {
                      S.confirmDelete = n;
                      render();
                      const yes = byId(`btn-rdel-yes-${n}`);
                      if (yes) yes.focus({ preventScroll: true });
                    },
                  },
                  '삭제',
                ),
              );
          return el(
            'li',
            null,
            el(
              'div',
              { class: 'r-main' },
              el('div', { class: 'title-line' }, issueLink(n), el('span', { class: 'title-text' }, i.title || '(제목 없음)')),
              el('p', { class: 'r-rule' }, el('span', { class: 'next-key' }, '반복:'), ' ', ruleTextOf(i), ' · ', meta.join(' · ')),
            ),
            actions,
          );
        }),
      ),
    );
  }

  // ── 메시지 영역 ───────────────────────────────────────
  function stopUndoTimer() {
    if (undoTimer !== null) {
      clearInterval(undoTimer);
      undoTimer = null;
    }
  }

  function clearMessage() {
    stopUndoTimer();
    msgState = null;
    renderMessage();
  }

  /** m = {tone, lines: (string|Node|Array)[], warnings?: string[], actions?: [{label, run, kind}], undo?: {result, endsAt}, focus?: boolean} */
  function showMessage(m) {
    stopUndoTimer();
    msgState = m;
    renderMessage();
    if (m.focus) {
      const first = els.message.querySelector('.msg-actions button');
      if (first) first.focus({ preventScroll: true });
    }
  }

  function setMessageButtonsDisabled(v) {
    for (const b of els.message.querySelectorAll('.msg-actions button')) b.disabled = v;
  }

  function makeActionButton(a) {
    const b = el('button', { type: 'button', class: a.kind || null }, a.label);
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const current = msgState;
      setMessageButtonsDisabled(true);
      try {
        await a.run();
      } catch (e) {
        showError(e);
      } finally {
        if (msgState === current) setMessageButtonsDisabled(false);
      }
    });
    return b;
  }

  function makeUndoButton(m) {
    const b = el('button', { type: 'button', class: 'undo' }, '되돌리기');
    const tick = () => {
      if (m.undo.running) return;
      const left = Math.ceil((m.undo.endsAt - Date.now()) / 1000);
      if (left <= 0) {
        m.undo.expired = true;
        stopUndoTimer();
        const hadFocus = document.activeElement === b;
        b.remove();
        if (hadFocus) focusAfterUndoExpired(m);
        return;
      }
      b.textContent = `되돌리기 (${left}초)`;
    };
    tick();
    undoTimer = setInterval(tick, 250);
    b.addEventListener('click', () => onUndo(m, b));
    return b;
  }

  /**
   * 포커스가 있던 [되돌리기]가 5초가 지나 사라질 때 키보드 포커스가 페이지 처음(body)으로 떨어지지 않게 옮긴다:
   * [지우기]의 되돌리기면 지운 항목 자리의 이웃 항목 [지우기] → "이번 주 완료한 일" 제목, 그 밖에는 메시지의 다른 버튼 → 닫기(×).
   */
  function focusAfterUndoExpired(m) {
    const u = m.undo || {};
    const doneSummary = u.kind === 'hide' ? els.doneList.closest('details')?.querySelector('summary') : null;
    const candidates = [
      u.focusAfter ? byId(u.focusAfter) : null,
      doneSummary,
      els.message.querySelector('.msg-actions button'),
      els.message.querySelector('.msg-close'),
    ];
    const t = candidates.find((x) => x && x.isConnected && !x.disabled);
    if (t) t.focus({ preventScroll: true });
  }

  function renderMessage() {
    stopUndoTimer();
    const m = msgState;
    if (!m) {
      els.message.replaceChildren();
      els.message.className = 'message';
      return;
    }
    els.message.className = `message tone-${m.tone || 'info'}`;
    const text = el('div', { class: 'msg-text' }, (m.lines || []).map((ln) => el('p', null, ln)));
    if (Array.isArray(m.warnings) && m.warnings.length) {
      text.append(el('ul', { class: 'msg-warnings' }, m.warnings.map((w) => el('li', null, `주의: ${w}`))));
    }
    const actions = el('div', { class: 'msg-actions' });
    if (m.undo && !m.undo.expired) actions.append(makeUndoButton(m));
    for (const a of m.actions || []) actions.append(makeActionButton(a));
    const card = el('div', { class: 'msg-card' }, text);
    if (actions.childNodes.length) card.append(actions);
    card.append(el('button', { type: 'button', class: 'msg-close', 'aria-label': '메시지 닫기', onclick: clearMessage }, '×'));
    els.message.replaceChildren(card);
  }

  function errorActions(e) {
    return e instanceof ApiError && e.status === 401 ? [{ label: '⚙ 설정 열기', run: () => openSettings(true) }] : [];
  }

  function showError(e) {
    showMessage({ tone: 'error', lines: [errorText(e)], actions: errorActions(e) });
  }

  // ── 동작 실행 래퍼(중복 클릭 방지) ─────────────────────
  async function runIssueAction(n, fn) {
    const key = issueKey(n);
    if (S.busy.has(key)) return false;
    const focusId = activeIdInApp();
    S.busy.add(key);
    render();
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      S.busy.delete(key);
      // 이 항목의 편집 패널 칸에 포커스가 남아 있으면(저장 결과로 패널을 닫는 등) 미루지 않고 그린다
      render({ now: editingIssue() === n });
      restoreFocus(focusId);
    }
    return true;
  }

  async function runInput(fn) {
    if (S.busy.has('input')) return;
    S.busy.add('input');
    els.inputBtn.disabled = true;
    els.form.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      S.busy.delete('input');
      els.inputBtn.disabled = false;
      els.form.removeAttribute('aria-busy');
      render();
    }
  }

  function clearInputIf(text) {
    if (text != null && els.input.value.trim() === text) els.input.value = '';
  }

  function requireApi() {
    if (S.api) return true;
    showMessage({
      tone: 'warn',
      lines: ['먼저 ⚙ 설정에서 GitHub 토큰을 저장하세요.'],
      actions: [{ label: '⚙ 설정 열기', run: () => openSettings(true) }],
    });
    return false;
  }

  // ── 입력 처리 ─────────────────────────────────────────
  function onSubmit() {
    const text = els.input.value.trim();
    if (!text) {
      showMessage({ tone: 'info', lines: ['할 일을 입력하세요. 예: 금요일까지 견적서 송부해야 함 / 견적서 송부 완료'] });
      return;
    }
    if (!requireApi()) return;
    runInput(() => handleInput(text));
  }

  async function handleInput(text) {
    const today = todayKST();
    let r;
    try {
      r = parse(text, today);
    } catch {
      throw new ApiError('입력 문장을 해석하지 못했습니다. 표현을 바꿔 다시 입력하세요.', 400);
    }
    const warnings = r && Array.isArray(r.warnings) ? r.warnings : [];
    switch (r && r.kind) {
      case 'register':
        return registerFromInput(r.task, {
          waiting: Boolean(r.waiting),
          next: r.next || null,
          decompose: Boolean(r.decompose),
          warnings,
          sourceText: text,
        });
      case 'recurring':
        return registerRecurringFromInput(r, warnings, text);
      case 'complete':
        return completeFromInput(r, warnings, text);
      default:
        return unknownFromInput(r || {}, warnings, text);
    }
  }

  async function registerFromInput(task, { waiting = false, next = null, decompose = false, warnings = [], sourceText = null } = {}) {
    const issue = await registerTask(S.api, task, { waiting, next, labelCache: S.labelCache });
    upsert(issue);
    clearInputIf(sourceText);
    const today = todayKST();
    const lines = [
      [waiting ? '대기 중으로 등록했습니다: ' : '등록했습니다: ', issueLink(issue.number), ' ', issue.title || ''],
      describeTask(task, today, { waiting }),
    ];
    if (next) lines.push(`다음 단계(완료하면 자동 등록): ${formatNextValue(next)}`);
    let tone = 'success';
    if (decompose) {
      try {
        const sosComment = await requestDecompose(S.api, issue.number);
        markSos(storage, issue.number, Date.now());
        afterSosRequested(issue.number, sosComment);
        lines.push('AI 분해(🆘)를 요청했습니다. 1~3분 후 GitHub에 답글이 달립니다.');
        lines.push('이 페이지를 열어 두면 30초마다(최대 6분) 확인해 답변이 오면 알려 드립니다.');
      } catch (e) {
        tone = 'warn';
        lines.push(`AI 분해 요청은 실패했습니다: ${errorText(e)} 목록의 🆘 막막해요 버튼으로 다시 요청할 수 있습니다.`);
      }
    }
    showMessage({ tone, lines, warnings });
  }

  async function registerRecurringFromInput(r, warnings, text) {
    const issue = await registerTask(S.api, r.task, { recurring: r.rule, labelCache: S.labelCache });
    upsert(issue);
    clearInputIf(text);
    showMessage({
      tone: 'success',
      lines: [
        ['반복 할 일을 등록했습니다: ', issueLink(issue.number), ' ', issue.title || ''],
        `반복: ${r.ruleText || formatRecurrence(r.rule)}`,
        '회차(할 일)는 해당일 아침 07:50(한국 시간) 자동 작업이 만듭니다. 오늘 아침 작업이 이미 지났다면 다음 해당일부터 생깁니다.',
      ],
      warnings,
    });
  }

  async function completeFromInput(r, warnings, text) {
    if (r.number != null) {
      const n = positiveInt(r.number);
      let issue = S.issues.get(n);
      if (!issue) {
        issue = await S.api.getIssue(n);
        if (issue && !issue.pull_request) upsert(issue, { local: false });
      }
      if (!issue || issue.pull_request) {
        showMessage({ tone: 'warn', lines: [`#${n}은(는) 할 일(Issue)이 아닙니다.`], warnings });
        return;
      }
      const labels = labelNames(issue);
      if (issue.state === 'closed') {
        showMessage({ tone: 'info', lines: [[issueLink(n), ' ', issue.title || '', ' — 이미 완료된 할 일입니다.']], warnings });
        return;
      }
      if (labels.includes('recurring')) {
        showMessage({
          tone: 'warn',
          lines: [[issueLink(n), ' 은(는) 반복 규칙 원본입니다. 그만하려면 아래 "반복 할 일 목록"에서 [삭제]를 누르세요.']],
          warnings,
        });
        return;
      }
      if (labels.includes('briefing')) {
        showMessage({ tone: 'warn', lines: [[issueLink(n), ' 은(는) 아침 브리핑이라 할 일 완료 대상이 아닙니다.']], warnings });
        return;
      }
      return confirmAndComplete(issue, { warnings, sourceText: text });
    }

    const keyword = String(r.keyword ?? '').trim();
    if (!keyword) {
      showMessage({
        tone: 'warn',
        lines: ['어떤 할 일을 완료할지 알 수 없습니다. 번호(#12)나 제목 일부를 함께 입력하세요. 예: 견적서 송부 완료'],
        warnings,
      });
      return;
    }
    if (!S.loaded) {
      await loadAll();
      if (!S.loaded) throw S.loadError || new ApiError('할 일 목록을 불러오지 못했습니다.', 0);
    }
    const { clear, candidates } = matchCandidates(keyword, [...S.issues.values()]);
    if (clear) return confirmAndComplete(clear, { warnings, sourceText: text });
    if (candidates && candidates.length) {
      const shown = candidates.slice(0, 8);
      const lines = ['어떤 할 일을 완료할까요?', `검색어: ${keyword}`];
      if (candidates.length > shown.length) lines.push(`후보가 ${candidates.length}개입니다. 더 구체적으로 입력하면 좁혀집니다.`);
      showMessage({
        tone: 'info',
        lines,
        warnings,
        focus: true,
        actions: [
          ...shown.map(({ issue }) => ({
            label: `#${issue.number} ${issue.title || ''}`,
            kind: 'candidate',
            run: () => confirmAndComplete(S.issues.get(issue.number) || issue, { sourceText: text }),
          })),
          { label: '취소', run: clearMessage },
        ],
      });
      return;
    }
    showMessage({ tone: 'warn', lines: ['일치하는 할 일이 없습니다', `검색어: ${keyword}`], warnings });
  }

  function unknownFromInput(r, warnings, text) {
    if (!r.task) {
      showMessage({ tone: 'warn', lines: ['할 일로 인식하지 못했습니다. 예: 금요일까지 견적서 송부해야 함'], warnings });
      return;
    }
    const task = r.task;
    showMessage({
      tone: 'info',
      lines: [`“${r.text || text}”`, '할 일로 등록할까요?', `제목: ${task.title} · ${describeTask(task, todayKST())}`],
      warnings,
      actions: [
        {
          label: '등록',
          kind: 'primary',
          run: () => runInput(() => registerFromInput(task, { sourceText: text })),
        },
        { label: '취소', run: clearMessage },
      ],
    });
  }

  // ── 완료 / 되돌리기 / 제안 ─────────────────────────────
  function confirmAndComplete(issue, opts = {}) {
    const { done, total } = checklistProgress(issue.body);
    const left = total - done;
    if (left > 0) {
      showMessage({
        tone: 'warn',
        lines: [[issueLink(issue.number), ' ', issue.title || ''], `하위 작업 ${left}개가 남았습니다. 완료할까요?`],
        warnings: opts.warnings,
        focus: true,
        actions: [
          { label: '완료', kind: 'primary', run: () => doComplete(issue.number, opts) },
          { label: '취소', run: clearMessage },
        ],
      });
      return Promise.resolve();
    }
    return doComplete(issue.number, opts);
  }

  function doComplete(n, { warnings = [], sourceText = null } = {}) {
    return runIssueAction(n, async () => {
      const issue = S.issues.get(n);
      if (!issue) throw new ApiError('할 일을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.', 404);
      let res;
      try {
        res = await completeIssue(S.api, issue, todayKST(), { labelCache: S.labelCache });
      } catch (e) {
        // 다른 곳에서 이미 완료됨(409): 서버의 최신 이슈로 목록을 정리한 뒤 안내한다(🆘 자동 확인도 멈춤).
        if (e instanceof ApiError && e.status === 409 && e.issue && Number.isInteger(e.issue.number)) {
          upsert(e.issue);
          stopReplyWatch(n);
        }
        throw e;
      }
      // 완료한 할 일의 🆘 자동 확인은 멈춘다(닫힌 이슈에 "답변 도착 · 본문에 반영"을 띄우지 않게)
      stopReplyWatch(n);
      // hidden 을 뗀 경우: 라벨 응답에는 updated_at 이 없으므로 지연된 목록 응답에 밀리지 않게 로컬 시각을 올린다
      upsert(res.hiddenRemoved ? touchLocal(res.issue) : res.issue);
      if (res.nextIssue) upsert(res.nextIssue);
      clearInputIf(sourceText);
      const lines = [['완료했습니다: ', issueLink(n), ' ', res.issue.title || '']];
      if (res.nextIssue) lines.push(['다음 단계 등록: ', issueLink(res.nextIssue.number), ' ', res.nextIssue.title || '']);
      if (res.nextError) lines.push(res.nextError);
      if (res.hiddenError) lines.push(res.hiddenError);
      const actions = [];
      const msg = {
        tone: res.nextError || res.hiddenError ? 'warn' : 'success',
        lines,
        warnings,
        actions,
        undo: { result: res, endsAt: Date.now() + UNDO_MS },
      };
      if (res.suggestReply) actions.push({ label: REPLY_CHECK_LABEL, run: () => onReplyCheck(res.issue, msg.undo) });
      showMessage(msg);
    });
  }

  async function onUndo(m, button) {
    if (!m.undo || m.undo.running || m.undo.expired) return;
    if (m.undo.kind === 'hide') return onUndoHide(m, button);
    m.undo.running = true;
    stopUndoTimer();
    setMessageButtonsDisabled(true);
    button.textContent = '되돌리는 중…';
    const result = m.undo.result;
    await runIssueAction(result.issue.number, async () => {
      const u = await undoComplete(S.api, result);
      upsert(u.issue);
      if (u.nextIssue) upsert(u.nextIssue);
      if (u.replyIssue) upsert(u.replyIssue);
      const lines = [['되돌렸습니다: ', issueLink(u.issue.number), ' ', u.issue.title || '', ' — 다시 열린 할 일입니다.']];
      if (u.nextIssue) lines.push(['자동 등록됐던 다음 단계 ', issueLink(u.nextIssue.number), ' 도 닫았습니다.']);
      if (u.replyIssue) lines.push(['등록했던 회신 확인 ', issueLink(u.replyIssue.number), ' 도 닫았습니다.']);
      showMessage({ tone: u.errors.length ? 'warn' : 'info', lines: [...lines, ...u.errors] });
    });
  }

  // ── 이번 주 완료한 일 [지우기] / 되돌리기 ───────────────
  /** [지우기]: 확인창 없이 즉시 hidden 라벨(모든 기기의 완료 목록에서 숨김) + 5초 되돌리기. 이번 주 완료 개수는 그대로. */
  function onHideDone(n) {
    if (!requireApi()) return;
    const focusAfter = neighborHideButtonId(n);
    return runIssueAction(n, async () => {
      const issue = S.issues.get(n);
      if (!issue) throw new ApiError('할 일을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.', 404);
      let updated;
      try {
        updated = await hideDone(S.api, issue, { labelCache: S.labelCache });
      } catch (e) {
        // 다른 곳에서 다시 열린 할 일(409): 서버의 최신 상태로 목록을 정리한다(열린 할 일 목록으로 돌아감).
        if (e instanceof ApiError && e.status === 409 && e.issue && Number.isInteger(e.issue.number)) upsert(e.issue);
        throw e;
      }
      upsert(touchLocal(updated));
      // 누른 [지우기]는 항목과 함께 사라지므로 키보드 포커스를 [되돌리기]로 옮긴다(focus: true).
      showMessage({
        tone: 'success',
        lines: [[issueLink(n), ' 을(를) 완료 목록에서 지웠습니다']],
        undo: { kind: 'hide', result: { issue: updated }, endsAt: Date.now() + UNDO_MS, focusAfter },
        focus: true,
      });
    });
  }

  /** 완료 목록에서 #n 바로 다음(없으면 바로 앞) 항목의 [지우기] id — 되돌리기 시간이 지나면 포커스를 옮길 자리 */
  function neighborHideButtonId(n) {
    const li = byId(`btn-hide-${n}`)?.closest('li');
    const sib = li ? li.nextElementSibling || li.previousElementSibling : null;
    const b = sib ? sib.querySelector('button.done-hide') : null;
    return b && b.id ? b.id : null;
  }

  async function onUndoHide(m, button) {
    m.undo.running = true;
    stopUndoTimer();
    setMessageButtonsDisabled(true);
    button.textContent = '되돌리는 중…';
    const n = m.undo.result.issue.number;
    let failure = null;
    const done = await runIssueAction(n, async () => {
      let u;
      try {
        u = await unhideDone(S.api, S.issues.get(n) || m.undo.result.issue);
      } catch (e) {
        failure = e;
        return;
      }
      upsert(touchLocal(u));
      showMessage({
        tone: 'info',
        lines: [['되돌렸습니다: ', issueLink(n), ' ', u.title || '', ' — 다시 완료 목록에 표시됩니다.']],
      });
    });
    if (failure) {
      // 되돌리기 실패(서버·권한·네트워크): 오류와 함께 [되돌리기]를 다시 5초 보여 준다 — 한 번의 일시 오류로 되돌릴 방법이 사라지지 않게.
      showMessage({
        tone: 'error',
        lines: [['되돌리지 못했습니다: ', issueLink(n), ' 은(는) 아직 완료 목록에서 숨겨져 있습니다.'], errorText(failure)],
        actions: errorActions(failure),
        undo: { ...m.undo, running: false, expired: false, endsAt: Date.now() + UNDO_MS },
        focus: true,
      });
    } else if (done) {
      restoreFocus(`btn-hide-${n}`);
    } else if (msgState === m) {
      // 같은 항목을 처리 중이라 실행하지 못함 → 되돌리기를 다시 누를 수 있게 되살린다
      m.undo.running = false;
      renderMessage();
    }
  }

  /** 회신 확인 등록. undo: 완료 메시지의 되돌리기 상태 — 아직 유효하면 새 메시지에도 같은 마감 시각으로 유지한다. */
  function onReplyCheck(original, undo = null) {
    return runIssueAction(original.number, async () => {
      const today = todayKST();
      const created = await registerReplyCheck(S.api, original, today, { labelCache: S.labelCache });
      upsert(created);
      const keepUndo = Boolean(undo && !undo.expired && !undo.running && undo.endsAt > Date.now());
      // 완료를 되돌리면 방금 등록한 회신 확인도 함께 닫는다(자동 등록 다음 단계와 같은 처리)
      if (undo && undo.result) undo.result.replyIssue = created;
      const due = parseBody(created.body).due || addDays(today, 3);
      showMessage({
        tone: 'success',
        lines: [
          ['회신 확인을 등록했습니다: ', issueLink(created.number), ' ', created.title || ''],
          `마감 ${formatDue(due, today)} · 대기 중`,
        ],
        undo: keepUndo ? undo : undefined,
      });
    });
  }

  // ── 항목 버튼 ─────────────────────────────────────────
  function onCompleteClick(n) {
    const issue = S.issues.get(n);
    if (!issue || !requireApi()) return;
    return confirmAndComplete(issue);
  }

  function onWaitingClick(n) {
    if (!requireApi()) return;
    return runIssueAction(n, async () => {
      const issue = S.issues.get(n);
      if (!issue) throw new ApiError('할 일을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.', 404);
      const was = labelNames(issue).includes('waiting');
      const updated = await toggleWaiting(S.api, issue, { labelCache: S.labelCache });
      upsert(updated);
      showMessage({
        tone: 'success',
        lines: [[issueLink(n), ' ', issue.title || '', was ? ' — 대기를 해제했습니다.' : ' — 대기 중으로 전환했습니다.']],
      });
    });
  }

  function onSosClick(n) {
    if (!requireApi()) return;
    const now = Date.now();
    if (!canRequestSos(storage, n, now)) {
      const mins = Math.max(1, Math.ceil(sosRemainingMs(storage, n, now) / 60000));
      showMessage({
        tone: 'info',
        lines: [
          [issueLink(n), ` 🆘 요청은 이미 보냈습니다. ${mins}분 후에 다시 요청할 수 있습니다.`],
          '1~3분 후 GitHub에 답글이 달립니다. 답변은 항목의 [💬 답변 보기]에서 볼 수 있습니다.',
        ],
      });
      return;
    }
    return runIssueAction(n, async () => {
      const sosComment = await requestDecompose(S.api, n);
      markSos(storage, n, Date.now());
      afterSosRequested(n, sosComment);
      showMessage({
        tone: 'success',
        lines: [
          [issueLink(n), ' 🆘 막막해요 요청을 보냈습니다.'],
          '1~3분 후 GitHub에 답글이 달립니다.',
          '이 페이지를 열어 두면 30초마다(최대 6분) 확인해 답변이 오면 알려 드립니다. 답변은 항목의 [💬 답변 보기]에서도 볼 수 있습니다.',
        ],
      });
    });
  }

  // ── [✏ 변경] 열기·닫기·저장 ──────────────────────────
  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** 열린 편집 패널의 선택된 우선순위(없으면 첫 칸)로 포커스 */
  function focusEditPanel(n, groupKey) {
    const form = byId(`edit-${groupKey}-${n}`);
    if (!form) return;
    const t = form.querySelector('input[type=radio]:checked:not(:disabled)') || form.querySelector('input:not(:disabled), button:not(:disabled)');
    if (t) t.focus({ preventScroll: true });
  }

  /** 그 행의 [✏ 변경] 으로 포커스(그룹이 바뀌었으면 data-fkey 로 찾는다). reveal: 화면 밖이면 보이게 스크롤. */
  function focusEditButton(n, groupKey, reveal = false) {
    const byGroup = groupKey ? byId(`btn-edit-${groupKey}-${n}`) : null;
    const b =
      byGroup && !byGroup.disabled
        ? byGroup
        : [...els.groups.querySelectorAll('button[data-fkey]')].find((x) => x.dataset.fkey === `btn-edit-${n}` && !x.disabled);
    if (!b) return;
    if (reveal) {
      const r = b.getBoundingClientRect();
      const stack = document.querySelector('.msg-stack');
      const top = stack ? Math.max(0, stack.getBoundingClientRect().bottom) : 0;
      if (r.top < top || r.bottom > window.innerHeight) b.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    b.focus({ preventScroll: true });
  }

  /**
   * 편집 패널의 입력 칸(날짜·완료 기준·메모·하위 작업 글자 칸)에 키보드 포커스가 있으면 true — 입력 중.
   * 배경 작업(🆘 자동 확인·날짜 바뀜)은 이때 화면을 다시 그리지 않고 미룬다(5차 R5UI-2 를 6차 글자 칸까지 넓힘):
   * 다시 그리면 칸이 새로 만들어져 덜 친 날짜·한글 조합 중인 글자가 끊기기 때문.
   */
  function editingField() {
    const a = document.activeElement;
    return Boolean(a && a.matches && a.matches(EDIT_FIELD_SEL) && els.app.contains(a));
  }

  /** 입력 중인 편집 패널의 이슈 번호(없으면 null) */
  function editingIssue() {
    if (!editingField()) return null;
    const f = document.activeElement.closest('form.edit-panel');
    const v = f ? Number(f.dataset.editFor) : NaN;
    return Number.isSafeInteger(v) ? v : null;
  }

  /** 키보드 포커스가 아무 데도 없으면(본문·사라진 요소) true — 처리 뒤 포커스를 옮겨도 사용자가 옮겨 간 자리를 빼앗지 않는다 */
  function focusFree() {
    const a = document.activeElement;
    return !a || a === document.body || !a.isConnected;
  }

  /** 편집 패널 안의 요소로 포커스: id = `${prefix}-${그룹}-${n}`(rowId 가 있으면 `-${rowId}`). 화면 밖이면 가까운 쪽으로 스크롤. */
  function focusEditTarget(n, prefix, rowId = null) {
    const g = editAt.get(n);
    if (!g) return false;
    const t = byId(rowId == null ? `${prefix}-${g}-${n}` : `${prefix}-${g}-${n}-${rowId}`);
    if (!t || t.disabled) return false;
    t.focus({ preventScroll: true });
    const r = t.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      try {
        t.scrollIntoView({ block: 'nearest' });
      } catch {
        /* 무시 */
      }
    }
    return true;
  }

  /** 이슈 → 편집 패널 상태(열 때·[최신 내용 불러오기]). base 는 충돌 확인용 원래 값(parseBody 그대로). */
  function editStateFrom(issue, groupKey) {
    const f = parseBody(issue.body);
    const due = f.due;
    const p = priorityOf(issue);
    // pCount: 열 때의 p 라벨 수. 1개가 아니면(GitHub에서 2개를 붙였거나 하나도 없음) 저장할 때 고른 우선순위를 그대로 보내
    // updateTaskMeta 가 p 라벨을 하나로 정리하게 한다(같은 값을 골라도).
    const pCount = labelNames(issue).filter((x) => PRIORITY_KEYS.includes(x)).length;
    const criteria = f.criteria && f.criteria !== CRITERIA_UNSET ? f.criteria : ''; // '(미정)'은 빈 칸으로 보여 준다
    const { marker, text } = splitMemoMarker(f.memo); // 회차 표지는 읽기 전용, 칸에는 사용자 메모만
    const memo = marker ? text || '' : f.memo || '';
    const subs = f.subtasks.map((s) => ({ id: ++subSeq, text: s.text, done: s.done }));
    return {
      group: groupKey,
      origPriority: p,
      origDue: due,
      pCount,
      priority: p,
      due: due || '',
      noDue: !due,
      lastDue: '',
      base: { criteria: f.criteria, memo: f.memo, subtasks: f.subtasks.map((s) => ({ text: s.text, done: s.done })) },
      origCriteria: criteria,
      criteria,
      marker,
      origMemo: memo,
      memo,
      origSubs: subs.map((s) => ({ text: s.text, done: s.done })),
      origSubText: new Map(subs.map((s) => [s.id, s.text])), // 줄 id → 열 때 글자(고친 줄·새 줄만 글자 수를 검사)
      subs,
      conflict: null,
    };
  }

  /** [✏ 변경]/[✏ 닫기]: 행 아래 편집 패널을 열고 닫는다(다른 그룹에 그려진 같은 항목에서 누르면 패널을 그쪽으로 옮김). */
  function onEditToggle(n, groupKey) {
    const d = S.edits.get(n);
    if (d && editAt.get(n) === groupKey) {
      if (S.busy.has(issueKey(n))) return;
      S.edits.delete(n);
      render({ now: true });
      return;
    }
    if (d) {
      d.group = groupKey;
      render({ now: true });
      focusEditPanel(n, groupKey);
      return;
    }
    if (!requireApi()) return;
    const issue = S.issues.get(n);
    if (!issue) return;
    S.edits.set(n, editStateFrom(issue, groupKey));
    render({ now: true });
    focusEditPanel(n, groupKey);
  }

  /** [취소]·Esc: 요청 없이 패널을 닫고 그 행의 [✏ 변경] 으로 포커스 */
  function onEditCancel(n) {
    if (S.busy.has(issueKey(n))) return;
    const g = editAt.get(n) || (S.edits.get(n) && S.edits.get(n).group) || null;
    S.edits.delete(n);
    render({ now: true });
    focusEditButton(n, g);
  }

  const critKey = (s) => {
    const t = oneLine(s);
    return t === CRITERIA_UNSET ? '' : t;
  };
  /** 편집기 줄 → 저장될 모양(앞뒤 공백 정리, 빈 줄 버림) — 바뀌었는지 비교용 */
  const cleanEditSubs = (list) => list.map((s) => ({ text: oneLine(s.text), done: Boolean(s.done) })).filter((s) => s.text);

  /**
   * [저장]: 패널을 연 뒤 바꾼 값만 보낸다(손대지 않은 칸은 그대로 — 다른 곳의 변경을 덮지 않게).
   * 단 열 때 p 라벨이 1개가 아니었으면 우선순위는 늘 보낸다(라벨 정리 — updateTaskMeta 의 'p 라벨 2개 이상·없음' 규칙).
   * 바꾼 게 없으면 요청 없이 '바뀐 내용이 없습니다'. 성공하면 패널을 닫고 응답 이슈로 그 행을 즉시 옮긴다
   * (목록 다시 받기 없음, upsert → 60초 캐시 동안 로컬 상태 우선). 포커스는 옮겨 간 행의 [✏ 변경].
   * 6차: 완료 기준·메모·하위 작업도 같은 PATCH 한 번. 패널을 열 때 읽은 값(d.base)으로 충돌을 확인하고,
   * 충돌(409 kind 'conflict')이면 패널·입력값을 그대로 두고 [내 내용으로 저장](force)·[최신 내용 불러오기]를 보여 준다.
   */
  async function onEditSave(n, { force = false } = {}) {
    if (!requireApi()) return;
    const d = S.edits.get(n);
    if (!d || S.busy.has(issueKey(n))) return;
    const groupNow = editAt.get(n) || d.group;
    const focusField = (what) => {
      const t = byId(`edit-${what}-${groupNow}-${n}`);
      if (t && !t.disabled) t.focus({ preventScroll: true });
    };
    // 글자 칸에서 Enter 로 저장: 포커스를 [저장]으로 옮긴다(저장 중 표시가 '입력 중 다시 그리기 미룸'에 걸리지 않게).
    if (editingIssue() === n) {
      const sb = byId(`btn-esave-${groupNow}-${n}`);
      if (sb && !sb.disabled) sb.focus({ preventScroll: true });
    }
    if (!d.noDue && !d.due) {
      showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${META_TEXT.needDate}`]] });
      focusField('due');
      return;
    }
    // 형식 + 범위(날짜 칸 min·max): 폼이 novalidate 라 브라우저가 막지 않는다 — 연도를 덜 친 0202-10-30 등
    if (!d.noDue && !isDueInRange(d.due)) {
      showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${META_TEXT.badDate}`]] });
      focusField('due');
      return;
    }
    const want = d.noDue ? null : d.due;
    const change = {};
    if (d.priority !== d.origPriority || d.pCount !== 1) change.priority = d.priority;
    if (want !== d.origDue) change.due = want;
    if (critKey(d.criteria) !== critKey(d.origCriteria)) change.criteria = oneLine(d.criteria);
    if (oneLine(d.memo) !== oneLine(d.origMemo)) change.memo = oneLine(d.memo);
    if (!sameSubtasks(cleanEditSubs(d.subs), cleanEditSubs(d.origSubs))) change.subtasks = d.subs.map((s) => ({ text: s.text, done: Boolean(s.done) }));
    if (!Object.keys(change).length) {
      showMessage({ tone: 'info', lines: [[issueLink(n), ` ${META_TEXT.noChange}`]] });
      return;
    }
    // 글자 수: 이번에 바꾼 칸만 검사한다(입력 칸 maxlength 가 보통 막지만, GitHub 에서 길게 적어 둔 값을 고쳤는데 아직 긴 경우).
    // 손대지 않은 칸은 보내지 않으므로 GitHub 에서 길게 적어 둔 값이 있어도 우선순위·마감 등 다른 칸은 저장된다.
    if ('criteria' in change && detailInputLength(d.criteria) > BODY_FIELD_MAX_CHARS) {
      showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${META_TEXT.criteriaTooLong}`]] });
      focusField('crit');
      return;
    }
    if ('memo' in change && detailInputLength(d.memo) > BODY_FIELD_MAX_CHARS) {
      showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${META_TEXT.memoTooLong}`]] });
      focusField('memo');
      return;
    }
    // 하위 작업은 새로 넣거나 글자를 고친 줄만(열 때 그대로인 긴 줄은 그대로 저장 — updateTaskMeta 가 본문에 있던 줄로 본다)
    const touched = (s) => !d.origSubText.has(s.id) || oneLine(d.origSubText.get(s.id)) !== oneLine(s.text);
    const longAt = 'subtasks' in change ? d.subs.findIndex((s) => touched(s) && detailInputLength(s.text) > SUBTASK_MAX_CHARS) : -1;
    if (longAt >= 0) {
      showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${subtaskTooLongText(longAt + 1)}`]] });
      focusEditTarget(n, 'edit-subtext', d.subs[longAt].id);
      return;
    }
    let target = null;
    let conflicted = false;
    await runIssueAction(n, async () => {
      let res;
      try {
        res = await updateTaskMeta(S.api, S.issues.get(n) || { number: n }, change, { labelCache: S.labelCache, base: d.base, force });
      } catch (e) {
        // 세부 내용 충돌(409 kind 'conflict'): 패널·입력값은 그대로, 행은 GitHub 의 최신 내용으로. 사용자가 고른다.
        if (e instanceof ApiError && e.kind === 'conflict') {
          if (e.issue && Number.isInteger(e.issue.number)) upsert(e.issue);
          const cur = S.edits.get(n);
          if (cur) cur.conflict = { fields: Array.isArray(e.conflicts) ? e.conflicts : [] };
          conflicted = true;
          showMessage({ tone: 'warn', lines: [[issueLink(n), ` ${conflictText(e.conflicts)}`], META_TEXT.conflictChoose] });
          return;
        }
        // 이미 완료(409)·할 일이 아님(400): 서버의 최신 이슈로 목록을 정리하고 패널을 닫는다.
        if (e instanceof ApiError && (e.status === 409 || e.status === 400) && e.issue && Number.isInteger(e.issue.number)) {
          upsert(e.issue);
          S.edits.delete(n);
          if (e.status === 409) stopReplyWatch(n);
          showMessage({
            tone: 'error',
            lines: [[issueLink(n), ` ${e.message}`], META_TEXT.listUpdated],
            actions: [{ label: '목록 새로고침', run: () => loadAll() }],
            focus: true,
          });
          return;
        }
        throw e; // 그 밖의 오류(401 → ⚙ 설정 열기 등): 패널과 입력값은 그대로 두어 다시 저장할 수 있다
      }
      const fresh = res.issue && res.issue.updated_at ? res.issue : touchLocal(res.issue);
      upsert(fresh);
      S.edits.delete(n);
      const today = todayKST();
      const cur = S.issues.get(n) || fresh;
      // 옮겨 갈 그룹(접혀 있으면 펼친다 — 옮긴 행과 [✏ 변경] 포커스가 보이게). 같은 그룹에 남으면 그 그룹.
      const groups = isTask(cur) && cur.state !== 'closed' ? groupsOf(cur, today) : [];
      target = groups.includes(groupNow) ? groupNow : groups[0] || null;
      if (target && S.groupOpen.get(target) === false) S.groupOpen.set(target, true);
      if (!res.changed.length) {
        showMessage({ tone: 'info', lines: [[issueLink(n), ` ${META_TEXT.noChange}`], META_TEXT.alreadySame] });
        return;
      }
      showMessage({
        tone: 'success',
        lines: [[issueLink(n), ` ${metaChangeText(cur, res.changed, today)}`], ...metaChangeNotes(cur, res.changed, today)],
      });
    });
    if (conflicted && S.edits.has(n)) {
      // 고를 버튼으로 포커스(사용자가 그사이 다른 곳으로 옮겼으면 그대로)
      const a = document.activeElement;
      const own = a && a.closest && a.closest('form.edit-panel');
      if (focusFree() || (own && own.dataset.editFor === String(n))) focusEditTarget(n, 'btn-eforce');
      return;
    }
    if (target && !S.edits.has(n) && focusFree()) focusEditButton(n, target, true);
  }

  /** [최신 내용 불러오기]: 내 입력을 버리고 GitHub 의 최신 이슈(새로 GET)로 패널을 다시 채운다(패널은 열린 채). */
  async function onEditReload(n) {
    if (!requireApi()) return;
    const d0 = S.edits.get(n);
    if (!d0 || S.busy.has(issueKey(n))) return;
    const fields = d0.conflict ? d0.conflict.fields : [];
    let reloaded = false;
    await runIssueAction(n, async () => {
      const latest = await S.api.getIssue(n);
      if (!latest || typeof latest !== 'object') throw new ApiError(MSG.badResponse, 0);
      upsert(latest);
      if (latest.state === 'closed' || !isTask(latest)) {
        S.edits.delete(n);
        if (latest.state === 'closed') stopReplyWatch(n);
        showMessage({
          tone: 'error',
          lines: [[issueLink(n), ` ${latest.state === 'closed' ? MSG.metaClosed : MSG.metaNotTask}`], META_TEXT.listUpdated],
          actions: [{ label: '목록 새로고침', run: () => loadAll() }],
          focus: true,
        });
        return;
      }
      const cur = S.edits.get(n) || d0;
      S.edits.set(n, editStateFrom(latest, cur.group));
      reloaded = true;
      showMessage({ tone: 'info', lines: [[issueLink(n), ` ${META_TEXT.reloaded}`]] });
    });
    if (!reloaded || !S.edits.has(n) || !focusFree()) return;
    // 다른 곳에서 바뀌었던 칸으로 포커스(하위 작업이면 첫 줄, 없으면 [+ 하위 작업 추가])
    const d = S.edits.get(n);
    const k = fields[0];
    const ok =
      k === 'criteria'
        ? focusEditTarget(n, 'edit-crit')
        : k === 'memo'
          ? focusEditTarget(n, 'edit-memo')
          : k === 'subtasks'
            ? (d.subs.length && focusEditTarget(n, 'edit-subtext', d.subs[0].id)) || focusEditTarget(n, 'btn-subadd')
            : false;
    if (!ok) focusEditPanel(n, editAt.get(n));
  }

  /**
   * [+ 하위 작업 추가]·Enter: afterId 줄 바로 아래(없으면 맨 끝)에 빈 줄을 넣고 그 칸으로 포커스.
   * 50줄이면 넣지 않는다(안내는 패널에 — 추가 버튼은 꺼져 있으므로 Enter 로 온 경우 메시지 영역에도 짧게 알린다, 포커스는 그대로).
   */
  function onSubAdd(n, afterId) {
    const d = S.edits.get(n);
    if (d && !S.busy.has(issueKey(n)) && d.subs.length >= SUBTASK_LIMIT) {
      showMessage({ tone: 'info', lines: [[issueLink(n), ` ${META_TEXT.subtaskLimit}`]] });
      return;
    }
    if (!d || S.busy.has(issueKey(n)) || d.subs.length >= SUBTASK_LIMIT) return;
    const row = { id: ++subSeq, text: '', done: false };
    const i = afterId == null ? -1 : d.subs.findIndex((s) => s.id === afterId);
    d.subs.splice(i < 0 ? d.subs.length : i + 1, 0, row);
    render({ now: true });
    focusEditTarget(n, 'edit-subtext', row.id);
  }

  /** ▲/▼: 그 줄을 한 칸 옮기고 같은 줄의 같은 버튼에 포커스(끝에 닿아 그 버튼이 꺼지면 반대쪽 버튼). */
  function onSubMove(n, id, delta) {
    const d = S.edits.get(n);
    if (!d || S.busy.has(issueKey(n))) return;
    const i = d.subs.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= d.subs.length) return;
    [d.subs[i], d.subs[j]] = [d.subs[j], d.subs[i]];
    render({ now: true });
    const same = delta < 0 ? 'btn-subup' : 'btn-subdown';
    const other = delta < 0 ? 'btn-subdown' : 'btn-subup';
    if (!focusEditTarget(n, same, id)) focusEditTarget(n, other, id);
  }

  /** [삭제]: 그 줄을 지우고 다음 줄(없으면 앞 줄) 글자 칸으로, 다 지웠으면 [+ 하위 작업 추가] 로 포커스. */
  function onSubDelete(n, id) {
    const d = S.edits.get(n);
    if (!d || S.busy.has(issueKey(n))) return;
    const i = d.subs.findIndex((s) => s.id === id);
    if (i < 0) return;
    d.subs.splice(i, 1);
    render({ now: true });
    const next = d.subs[i] || d.subs[i - 1];
    if (!(next && focusEditTarget(n, 'edit-subtext', next.id))) focusEditTarget(n, 'btn-subadd');
  }

  function onSubtaskToggle(n, item, checked) {
    if (!requireApi() || S.edits.has(n)) {
      // 토큰 없음·편집 패널이 열림(그 패널에서 바꾼다): 체크 표시를 원래대로 되돌린다
      render();
      return;
    }
    return runIssueAction(n, async () => {
      const updated = await toggleSubtask(S.api, n, item, checked);
      upsert(updated);
    });
  }

  // ── 🆘 Claude 답변: 불러오기 / 반영 / 자동 확인 ─────────
  function replyEntry(comments, seq) {
    const list = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c === 'object');
    let latest = null;
    for (const c of list) if (!latest || timeOf(c.created_at) >= timeOf(latest.created_at)) latest = c;
    return { loading: false, error: null, reply: findClaudeReply(list), latest, count: list.length, at: Date.now(), seq };
  }

  /** 댓글 수를 화면 상태에 반영(재조회 없음). 바뀌었으면 true. */
  function setCommentCount(n, count) {
    const i = S.issues.get(n);
    if (!i || !Number.isSafeInteger(count) || count < 0 || i.comments === count) return false;
    S.issues.set(n, { ...i, comments: count });
    const r = S.recent.get(n);
    if (r) S.recent.set(n, { issue: { ...r.issue, comments: count }, at: r.at });
    return true;
  }

  async function loadReply(n) {
    if (!S.api) return;
    const api = S.api;
    const seq = ++S.replySeq;
    const prev = S.replies.get(n);
    S.replies.set(n, { reply: null, latest: null, count: 0, at: 0, ...(prev || {}), loading: true, error: null, seq });
    render();
    try {
      const comments = await api.listComments(n);
      const cur = S.replies.get(n);
      if (api !== S.api || !cur || cur.seq !== seq) return;
      S.replies.set(n, replyEntry(comments, seq));
      setCommentCount(n, comments.length);
    } catch (e) {
      const cur = S.replies.get(n);
      if (api !== S.api || !cur || cur.seq !== seq) return;
      S.replies.set(n, { ...cur, loading: false, error: e });
    } finally {
      render();
    }
  }

  function onReplyToggle(n) {
    if (S.replyOpen.has(n)) {
      S.replyOpen.delete(n);
      render();
      return;
    }
    if (!requireApi()) return;
    S.replyOpen.add(n);
    loadReply(n);
  }

  /** [본문에 반영]: 패널·알림 공용. 답글의 하위 작업을 최신 본문에 추가하고 stuck 을 뗀다. 화면은 반환값으로 즉시 갱신. */
  async function onApplyReply(n) {
    if (!requireApi()) return;
    if (S.edits.has(n)) {
      // 같은 항목의 [✏ 변경] 패널이 열려 있으면 반영하지 않는다(버튼도 꺼져 있다 — 패널의 하위 작업과 서로 덮어쓰지 않게)
      showMessage({ tone: 'info', lines: [[issueLink(n), ` ${META_TEXT.editingApply}`]] });
      return;
    }
    const entry = S.replies.get(n);
    const reply = entry && entry.reply;
    const items = reply && reply.state !== 'working' ? parseReplyChecklist(reply.body) : [];
    if (!items.length) {
      showMessage({ tone: 'info', lines: [[issueLink(n), ' 반영할 하위 작업이 없습니다.']] });
      return;
    }
    // 반영에 성공하면 누른 [본문에 반영]은 '이미 반영됨'(비활성)으로 바뀌므로, 키보드 포커스를 같은 자리의 버튼으로 옮긴다
    // (패널 → [다시 불러오기], 알림 → [답변 보기]).
    const origin = (document.activeElement && document.activeElement.id) || '';
    const focusAfter = origin.startsWith('btn-napply-')
      ? `btn-nview-${n}`
      : origin.startsWith('btn-apply-')
        ? { id: null, fkey: `btn-rreload-${n}` }
        : null;
    const done = await runIssueAction(n, async () => {
      let r;
      try {
        r = await applyReplySubtasks(S.api, n, items);
      } catch (e) {
        // 다른 곳에서 이미 완료된 할 일(409): 목록을 서버 상태로 정리하고 🆘 자동 확인도 멈춘다.
        if (e instanceof ApiError && e.status === 409 && e.issue && Number.isInteger(e.issue.number)) {
          upsert(e.issue);
          stopReplyWatch(n);
        }
        throw e;
      }
      upsert(r.issue);
      if (r.added.length) S.expanded.add(n);
      const k = r.added.length;
      const m = r.skipped.length;
      let text = k
        ? ` 본문에 하위 작업 ${k}개를 반영했습니다${m ? `(이미 있던 ${m}개 제외)` : ''}`
        : ' 본문에 이미 모든 하위 작업이 있습니다(반영할 항목 없음)';
      if (r.stuckRemoved) text += ' · stuck 라벨 제거';
      if (r.stuckError) text += ` · stuck 라벨은 떼지 못했습니다: ${errorText(r.stuckError)}`;
      showMessage({ tone: r.stuckError ? 'warn' : k ? 'success' : 'info', lines: [[issueLink(n), text]] });
    });
    if (done && focusAfter) restoreFocus(focusAfter);
  }

  /** 알림의 [답변 보기]: 패널을 펼치고 그 위치로 이동(방금 확인한 결과가 있으면 다시 불러오지 않음). */
  function onNoticeView(n) {
    if (!requireApi()) return;
    const issue = S.issues.get(n);
    if (S.project && issue && !labelNames(issue).includes(`proj:${S.project}`)) setProject(null);
    S.replyOpen.add(n);
    const entry = S.replies.get(n);
    if (!entry || entry.error || Date.now() - entry.at > REPLY_POLL_MS) loadReply(n);
    else render();
    const panel = [...els.groups.querySelectorAll('.reply-panel')].find((p) => p.dataset.replyFor === String(n));
    if (!panel) {
      showMessage({
        tone: 'info',
        lines: [[issueLink(n), ' 은(는) 지금 목록에 없는 항목입니다(완료됐거나 할 일이 아님). 번호를 눌러 GitHub에서 확인하세요.']],
      });
      return;
    }
    const group = panel.closest('details.group');
    if (group && !group.open) {
      group.open = true;
      const key = group.id.replace(/^group-/, '');
      S.groupOpen.set(key, true);
    }
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduce = false;
    }
    panel.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    panel.focus({ preventScroll: true });
  }

  function stopReplyWatch(n) {
    const w = S.watch.get(n);
    if (!w) return;
    w.stopped = true;
    if (w.timer !== null) clearTimeout(w.timer);
    S.watch.delete(n);
  }

  function stopAllReplyWatches() {
    for (const n of [...S.watch.keys()]) stopReplyWatch(n);
  }

  /** 🆘 요청 시각(ISO). 요청 댓글의 created_at(GitHub 시각)을 쓰고, 없으면 이 기기 시각에서 2분 앞. */
  function sosSince(comment) {
    const c = comment && typeof comment === 'object' ? comment.created_at : null;
    if (typeof c === 'string' && Number.isFinite(Date.parse(c))) return c;
    return new Date(Date.now() - 120000).toISOString();
  }

  /**
   * 🆘 후 자동 확인: REPLY_POLL_MS 간격으로 최대 REPLY_WATCH_MS 동안 댓글을 확인한다.
   * since 이후의 Claude 답글이 'working' 이 아니게 되면 "답변 도착" 알림. 이슈당 타이머 1개(다시 시작하면 이전 것은 멈춤).
   * 페이지를 닫으면 타이머도 사라진다(재개하지 않음).
   */
  function startReplyWatch(n, since) {
    if (!S.api) return;
    stopReplyWatch(n);
    S.notices.delete(n);
    const w = { since, checks: 0, timer: null, stopped: false, api: S.api };
    const maxChecks = Math.max(1, Math.floor(REPLY_WATCH_MS / REPLY_POLL_MS));
    const alive = () => !w.stopped && S.watch.get(n) === w && S.api === w.api;
    const finish = (notice) => {
      S.watch.delete(n);
      if (notice) S.notices.set(n, notice);
      render();
    };
    const tick = async () => {
      w.timer = null;
      if (!alive()) return;
      // 편집 패널 칸(날짜·글자)에 입력 중이면 확인을 미룬다(세지 않음): 그 칸을 벗어나면 곧 확인하고 알린다
      if (editingField()) {
        w.timer = setTimeout(tick, EDIT_DEFER_MS);
        return;
      }
      w.checks += 1;
      let reply = null;
      let changed = false;
      try {
        const comments = await w.api.listComments(n);
        if (!alive()) return;
        if (editingField()) {
          // 응답을 기다리는 사이 편집 패널 칸에 들어갔으면 이번 결과는 버리고 다시 미룬다(다시 그리기 없음)
          w.checks -= 1;
          w.timer = setTimeout(tick, EDIT_DEFER_MS);
          return;
        }
        S.replies.set(n, replyEntry(comments, ++S.replySeq));
        changed = setCommentCount(n, comments.length);
        reply = findClaudeReply(comments, { since: w.since });
      } catch (e) {
        if (!alive()) return;
        if (editingField()) {
          w.checks -= 1;
          w.timer = setTimeout(tick, EDIT_DEFER_MS);
          return;
        }
        if (e instanceof ApiError && [401, 404, 410].includes(e.status)) {
          finish({ kind: 'error', n, message: errorText(e) });
          return;
        }
      }
      if (reply && reply.state !== 'working') {
        finish({ kind: 'arrived', n, state: reply.state });
        return;
      }
      if (w.checks >= maxChecks) {
        finish({ kind: 'timeout', n });
        return;
      }
      w.timer = setTimeout(tick, REPLY_POLL_MS);
      if (changed || S.replyOpen.has(n)) render();
    };
    S.watch.set(n, w);
    w.timer = setTimeout(tick, REPLY_POLL_MS);
  }

  /** 🆘 요청 댓글을 단 직후: 댓글 수 +1(화면), 자동 확인 시작 */
  function afterSosRequested(n, comment) {
    const i = S.issues.get(n);
    if (i) setCommentCount(n, (Number.isSafeInteger(i.comments) && i.comments > 0 ? i.comments : 0) + 1);
    startReplyWatch(n, sosSince(comment));
  }

  function onRecurringDelete(n) {
    if (!requireApi()) return;
    return runIssueAction(n, async () => {
      const prev = S.issues.get(n) || { number: n };
      const closed = await deleteRecurring(S.api, n);
      upsert({ ...prev, ...(closed && typeof closed === 'object' ? closed : {}), state: 'closed', state_reason: 'not_planned' });
      S.confirmDelete = null;
      showMessage({ tone: 'success', lines: [['반복 할 일을 삭제했습니다: ', issueLink(n), ' ', prev.title || '']] });
    });
  }

  function setProject(p) {
    S.project = p || null;
    if (S.project) storage.setItem(PROJECT_KEY, S.project);
    else storage.removeItem(PROJECT_KEY);
    render();
  }

  function jumpToGroup(key) {
    const d = byId(`group-${key}`);
    if (!d) return;
    d.open = true;
    if (!d.classList.contains('is-empty')) S.groupOpen.set(key, true);
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduce = false;
    }
    d.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    const s = d.querySelector('summary');
    if (s) s.focus({ preventScroll: true });
  }

  // ── 목록 불러오기 ─────────────────────────────────────
  async function loadAll() {
    if (!S.api) return;
    const seq = ++S.loadSeq;
    S.loading = true;
    S.loadError = null;
    render();
    try {
      const today = todayKST();
      const since = kstMidnightISO(startOfWeek(today));
      const [open, closed] = await Promise.all([S.api.listOpenIssues(), S.api.listClosedSince(since)]);
      if (seq !== S.loadSeq) return;
      const map = new Map();
      for (const i of [...closed, ...open]) {
        if (!i || !Number.isInteger(i.number)) continue;
        const prev = map.get(i.number);
        if (!prev || timeOf(i.updated_at) >= timeOf(prev.updated_at)) map.set(i.number, i);
      }
      // 목록 응답은 최대 약 60초 늦을 수 있다 → 방금 바꾼 항목은 더 새로운 응답이 오기 전까지 로컬 상태 유지
      const now = Date.now();
      for (const [n, r] of S.recent) {
        if (now - r.at > RECENT_WINDOW_MS) {
          S.recent.delete(n);
          continue;
        }
        const fetched = map.get(n);
        if (!fetched || !(timeOf(fetched.updated_at) > timeOf(r.issue.updated_at))) map.set(n, r.issue);
      }
      S.issues = map;
      S.labelCache = new Set();
      S.loaded = true;
      S.loadedAt = now;
    } catch (e) {
      if (seq !== S.loadSeq) return;
      S.loadError = e;
    } finally {
      if (seq === S.loadSeq) {
        S.loading = false;
        render();
      }
    }
  }

  // ── 설정(토큰) ────────────────────────────────────────
  function setSettingsStatus(text, tone = 'info') {
    els.settingsStatus.textContent = text;
    els.settingsStatus.className = `settings-status tone-${tone}`;
  }

  function openSettings(open) {
    els.settings.hidden = !open;
    els.settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      els.settings.scrollIntoView({ block: 'nearest' });
      els.tokenInput.focus({ preventScroll: true });
    }
  }

  function applyTokenPresence() {
    els.mainContent.hidden = !S.token;
    if (!S.token) els.tokenState.textContent = '저장된 토큰: 없음 — 아래 안내대로 발급해 저장하세요.';
    else if (S.tokenPersisted) els.tokenState.textContent = '저장된 토큰: 있음 (이 브라우저에만 저장됨)';
    else els.tokenState.textContent = '저장된 토큰: 있음 (브라우저 저장소를 쓸 수 없어 이 탭을 닫으면 사라집니다)';
    els.tokenDelete.disabled = !S.token;
    els.tokenTest.disabled = !S.token;
  }

  function setToken(tok, persisted) {
    S.token = tok || null;
    S.tokenPersisted = Boolean(tok) && Boolean(persisted);
    S.api = S.token ? createApi({ token: S.token }) : null;
    S.issues = new Map();
    S.recent = new Map();
    S.labelCache = new Set();
    S.loaded = false;
    S.loading = false;
    S.loadError = null;
    S.loadSeq += 1;
    S.expanded.clear();
    S.confirmDelete = null;
    stopAllReplyWatches();
    S.replies = new Map();
    S.replyOpen = new Set();
    S.notices = new Map();
    S.edits = new Map();
    clearMessage();
    applyTokenPresence();
    render();
  }

  function setSettingsBusy(v) {
    els.tokenSave.disabled = v;
    els.tokenDelete.disabled = v || !S.token;
    els.tokenTest.disabled = v || !S.token;
  }

  async function testConnectionUI() {
    if (!S.api) {
      setSettingsStatus('저장된 토큰이 없습니다.', 'warn');
      return false;
    }
    setSettingsBusy(true);
    setSettingsStatus('연결 확인 중…', 'info');
    try {
      const repo = await S.api.testConnection();
      const name = (repo && repo.full_name) || `${OWNER}/${REPO}`;
      if (repo && repo.has_issues === false) {
        setSettingsStatus(`연결은 됐지만 ${name} 저장소의 Issues 기능이 꺼져 있습니다. 저장소 Settings에서 Issues를 켜 주세요.`, 'warn');
        return false;
      }
      setSettingsStatus(`연결 성공: ${name}${repo && repo.private ? ' (비공개 저장소)' : ''}`, 'success');
      return true;
    } catch (e) {
      setSettingsStatus(`연결 실패: ${errorText(e)}`, 'error');
      return false;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function onTokenSave() {
    const v = els.tokenInput.value.trim();
    if (!v) {
      setSettingsStatus('토큰을 입력하세요.', 'warn');
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(v)) {
      setSettingsStatus('토큰 형식이 올바르지 않습니다. 공백·한글 없이 토큰만 붙여 넣으세요.', 'error');
      return;
    }
    els.tokenInput.value = ''; // 화면(DOM)에 토큰을 남기지 않는다
    const persisted = storage.setItem(TOKEN_KEY, v);
    setToken(v, persisted);
    setSettingsStatus(
      persisted
        ? '토큰을 이 브라우저에 저장했습니다. 연결을 확인하는 중…'
        : '이 브라우저에서는 저장소(localStorage)를 쓸 수 없어 이 탭을 닫으면 다시 입력해야 합니다. 연결을 확인하는 중…',
      'info',
    );
    const ok = await testConnectionUI();
    if (ok) {
      openSettings(false);
      showMessage({ tone: 'success', lines: ['GitHub 연결에 성공했습니다. 할 일 목록을 불러옵니다.'] });
      loadAll();
    }
  }

  function onTokenDelete() {
    storage.removeItem(TOKEN_KEY);
    setToken(null, false);
    openSettings(true);
    setSettingsStatus(
      '이 브라우저에서 토큰을 삭제했습니다. 토큰 자체를 폐기하려면 GitHub → Settings → Developer settings → Personal access tokens에서 삭제하세요.',
      'info',
    );
  }

  // ── 이벤트 연결 & 시작 ────────────────────────────────
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });
  els.refreshBtn.addEventListener('click', () => {
    if (!S.loading) loadAll();
  });
  els.settingsBtn.addEventListener('click', () => openSettings(els.settings.hidden));
  els.tokenSave.addEventListener('click', onTokenSave);
  els.tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      onTokenSave();
    }
  });
  els.tokenDelete.addEventListener('click', onTokenDelete);
  els.tokenTest.addEventListener('click', () => {
    testConnectionUI();
  });
  const checkDayChange = () => {
    // 편집 패널 칸(날짜·글자)에 입력 중이면 다음 확인(1분 뒤·화면 복귀)으로 미룬다(EDIT_DEFER_MS 설명 참고)
    if (todayKST() !== S.today && !editingField()) render();
  };
  setInterval(checkDayChange, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkDayChange();
  });

  S.project = storage.getItem(PROJECT_KEY) || null;
  const saved = storage.getItem(TOKEN_KEY);
  setToken(saved, Boolean(saved) && storage.persistent);
  if (S.token) {
    openSettings(false);
    loadAll();
  } else {
    openSettings(true);
  }
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
