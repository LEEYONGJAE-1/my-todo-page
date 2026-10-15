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
  };
  let msgState = null;
  let undoTimer = null;
  let noticeSig = '';

  // ── 상태 헬퍼 ─────────────────────────────────────────
  const issueKey = (n) => `issue:${n}`;
  const openIssues = () => [...S.issues.values()].filter((i) => i.state !== 'closed' && !i.pull_request);
  const matchesProject = (i) => !S.project || labelNames(i).includes(`proj:${S.project}`);
  const completedList = (today) =>
    [...S.issues.values()]
      .filter((i) => i.state === 'closed' && !i.pull_request && isTask(i) && isCompletedThisWeek(i, today) && matchesProject(i))
      .sort((a, b) => timeOf(a.closed_at) - timeOf(b.closed_at) || a.number - b.number);
  const recurringList = () =>
    [...S.issues.values()]
      .filter((i) => i.state !== 'closed' && !i.pull_request && labelNames(i).includes('recurring') && matchesProject(i))
      .sort((a, b) => a.number - b.number);

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

  // ── 렌더링 ───────────────────────────────────────────
  function render() {
    const today = todayKST(); // 매번 다시 계산
    S.today = today;
    const focus = activeIdInApp();
    renderTop(today);
    renderStatus();
    renderGroups(today);
    renderDone(today);
    renderRecurring();
    renderNotices();
    els.inputBtn.disabled = S.busy.has('input');
    if (focus && document.activeElement !== byId(focus.id)) restoreFocus(focus);
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
      const tbody = el('tbody', null, items.map((issue) => renderRow(issue, def.key, today)));
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
      f.next ? el('p', { class: 'next-step' }, el('span', { class: 'next-key' }, '다음:'), ' ', f.next) : null,
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
      { class: `task prio-${prio}${busy ? ' is-busy' : ''}`, 'aria-busy': busy ? 'true' : null },
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

  function renderSubtasks(issue, subtasks, busy, groupKey) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
    const n = issue.number;
    const { done, total } = checklistProgress(issue.body);
    if (!total) return null;
    const expanded = S.expanded.has(n);
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
          disabled: busy,
        });
        box.addEventListener('change', () => onSubtaskToggle(n, { index, text: s.text }, box.checked));
        ul.append(el('li', null, el('label', { class: s.done ? 'is-done' : null }, box, el('span', null, s.text))));
      });
      wrap.append(ul);
    }
    return wrap;
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
    const head = el('div', { class: 'reply-head' }, el('strong', { class: 'reply-title' }, 'Claude 답변'));
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
      kids.push(el('div', { class: 'reply-body' }, renderReplyBlocks(replyBlocks(reply.body))));
      const info = applyInfo(issue, reply);
      kids.push(
        el(
          'div',
          { class: 'reply-actions' },
          el(
            'button',
            {
              type: 'button',
              class: info.enabled ? 'primary' : null,
              id: `btn-apply-${groupKey}-${n}`,
              dataset: { fkey: `btn-apply-${n}` },
              disabled: busy || !info.enabled,
              'aria-label': `${info.label}: #${n}`,
              onclick: () => onApplyReply(n),
            },
            info.label,
          ),
          reload,
        ),
      );
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
      { class: 'reply-panel', id: `reply-${groupKey}-${n}`, dataset: { replyFor: n }, tabindex: '-1', 'aria-label': `#${n} Claude 답변` },
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
        return [nt.n, nt.kind, nt.state || '', nt.message || '', info && info.label, info && info.enabled, S.busy.has(issueKey(nt.n))];
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
        lines.push(['🆘 ', issueLink(n), ' 에 Claude 답변이 도착했습니다']);
        if (nt.state === 'error') lines.push('Claude 실행은 오류로 끝났지만 답변 내용은 볼 수 있습니다.');
        const entry = S.replies.get(n);
        const info = applyInfo(S.issues.get(n) || { number: n, body: '' }, entry && entry.reply);
        actions.push(
          el('button', { type: 'button', id: `btn-nview-${n}`, onclick: () => onNoticeView(n) }, '답변 보기'),
          el(
            'button',
            {
              type: 'button',
              class: info.enabled ? 'primary' : null,
              id: `btn-napply-${n}`,
              disabled: S.busy.has(issueKey(n)) || !info.enabled,
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
        el('div', { class: 'msg-text' }, lines.map((ln) => el('p', null, ln))),
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
    const list = S.loaded ? completedList(today) : [];
    els.doneCount.textContent = S.loaded ? `${list.length}건` : '';
    if (!list.length) {
      els.doneList.replaceChildren(
        el('p', { class: 'empty' }, S.loaded ? '이번 주(월요일 0시 이후)에 완료한 일이 없습니다.' : '목록을 불러오면 표시됩니다.'),
      );
      return;
    }
    els.doneList.replaceChildren(
      el(
        'ol',
        { class: 'plain-list done-list' },
        list.map((i) =>
          el(
            'li',
            null,
            el('span', { class: 'when' }, i.closed_at ? shortDate(toKSTDate(i.closed_at)) : ''),
            issueLink(i.number),
            el('span', { class: 'title-text' }, i.title || '(제목 없음)'),
          ),
        ),
      ),
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
        b.remove();
        return;
      }
      b.textContent = `되돌리기 (${left}초)`;
    };
    tick();
    undoTimer = setInterval(tick, 250);
    b.addEventListener('click', () => onUndo(m, b));
    return b;
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

  function showError(e) {
    const actions = [];
    if (e instanceof ApiError && e.status === 401) actions.push({ label: '⚙ 설정 열기', run: () => openSettings(true) });
    showMessage({ tone: 'error', lines: [errorText(e)], actions });
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
      render();
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
      upsert(res.issue);
      if (res.nextIssue) upsert(res.nextIssue);
      clearInputIf(sourceText);
      const lines = [['완료했습니다: ', issueLink(n), ' ', res.issue.title || '']];
      if (res.nextIssue) lines.push(['다음 단계 등록: ', issueLink(res.nextIssue.number), ' ', res.nextIssue.title || '']);
      if (res.nextError) lines.push(res.nextError);
      const actions = [];
      const msg = {
        tone: res.nextError ? 'warn' : 'success',
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

  function onSubtaskToggle(n, item, checked) {
    if (!requireApi()) {
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
      w.checks += 1;
      let reply = null;
      let changed = false;
      try {
        const comments = await w.api.listComments(n);
        if (!alive()) return;
        S.replies.set(n, replyEntry(comments, ++S.replySeq));
        changed = setCommentCount(n, comments.length);
        reply = findClaudeReply(comments, { since: w.since });
      } catch (e) {
        if (!alive()) return;
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
    if (todayKST() !== S.today) render();
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
