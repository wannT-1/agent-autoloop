// Everything that can change the hub is decided here: given the view and one input, the facts to record and the answer
// to give. Time and secrets come in as arguments, so the same input on the same view always decides the same.
import { credential, digest, type Environment } from "./credentials.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { deadlines, MINUTE, offlineCard, OFFLINE_AFTER, RUN_LEASE, SEEN_EVERY, WORKER_FRESH } from "./due.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { iso, rows, type Change, type Fact, type Row, type Table, type View } from "./evolve.ts";
import {
  agentsOf,
  cardView,
  configuration,
  eventsOf,
  jobOf,
  openInScope,
  pauseOf,
  routingOf,
  sourceOf,
  waitingOn,
  workerOf,
  workers,
} from "./query.ts";
import { cronOf, eventRule, ruleOf, SCHEDULE, typeMatches, type Rule, type Rules } from "./rules.ts";
import {
  addUsage,
  ANSWER_BY,
  ANSWER_REF,
  ANSWER_TEXT,
  DELIVERY_REF,
  parseEvent,
  parseResult,
  type Later,
  type Rejected,
  type Result,
} from "../protocol/validate.ts";

export type Input = { type: string; args: any[] };

/** Minutes after the first try that a card is sent to a channel again. */
const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55];
/** The last resend and the minute it holds the card: after this a channel has given up. */
const RESEND_WINDOW = 57 * MINUTE;
/** How long a chain of events causing events can get before it stops being dispatched. */
const MAX_HOPS = 8;
/** Failures in a row after which a run stops being retried: each try spends the owner's real tokens. */
const MAX_ATTEMPTS = 10;
const NOT_TRYING = { tries: 0, first_try_at: null, not_before: null };
const NOT_DELIVERED: Row = { version: 0, ref: null, ...NOT_TRYING, error: null, given_up: 0 };

const nulls = (...names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
const CARD_BASICS = { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0 };
const DEFAULTS: Partial<Record<Table, Row>> = {
  runs: {
    attempts: 0,
    ...nulls("claim", "issued", "last_issued", "last_result", "last_answer", "cancel_at", "resume", "session", "link"),
    ...nulls("claimed_at", "seen_at", "finished_at", "summary", "error", "usage"),
  },
  cards: {
    ...CARD_BASICS,
    ...nulls("choice", "answer", "by", "result", "rule"),
    lane: "",
    ...nulls("grp", "source", "agent", "session", "run_id", "answer_event"),
    version: 1,
    ...nulls("decided_at", "closed_at"),
  },
  deliveries: NOT_DELIVERED,
};

type Given = { type: string; seq: number; now: number; at: string; env: Environment; rules: Rules };
/** One input being decided: what holds throughout, and the view with its changes so far. */
type Draft = Given & { view: View; changes: Change[] };

export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  const { type, args } = input;
  if (!Object.hasOwn(HANDLERS, type)) throw new InputError(`不认识的输入：${type}`);
  const rules = configuration(view);
  const draft: Draft = { view: view.fork(), seq: view.seq + 1, type, now, at: iso(now), env, rules, changes: [] };
  const value = HANDLERS[type](draft, ...args);
  // With nothing changed nothing new can come due, and what only the clock changes has a deadline of its own to bring a tick.
  if (!draft.changes.length && type !== "tick") return { facts: [], value };
  const due = deadlines(draft.view, now);
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(draft.view.get("due", key)) !== JSON.stringify(row)) put(draft, "due", key, row);
  }
  for (const { kind, key: name } of rows(draft.view, "due")) {
    const key = `${kind}:${name}`;
    if (!due[key]) set(draft, "due", key, null);
  }
  return { facts: draft.changes.length ? [factOf(draft, draft.changes)] : [], value };
}

function factOf({ seq, now, type }: Draft, changes: Change[]): Fact {
  return { version: 1, seq, at: now, type, changes };
}

function set(draft: Draft, table: Table, key: string | number, row: Row | null) {
  const change = { table, key: String(key), row };
  draft.changes.push(change);
  draft.view.set(table, String(key), row);
  return row!;
}

const put = (draft: Draft, table: Table, key: string | number, fields: Row) =>
  set(draft, table, key, { ...DEFAULTS[table], ...draft.view.get(table, key), ...fields });

function add(draft: Draft, table: Table, fields: Row) {
  const id = (draft.view.next[table] ?? 0) + 1;
  return put(draft, table, id, { ...fields, id });
}

const ruleNamed = (draft: Draft, name: string) => ruleOf(draft.rules, name);
function assignQueued(draft: Draft, run: Row) {
  const config = draft.view.get("config", "rules")!;
  const rule = ruleOf(config.value as Rules, run.rule);
  if (!rule) return;
  const session = rule.to === run.agent ? {} : nulls("session", "resume");
  put(draft, "runs", run.id, { agent: rule.to, rules_version: config.version, ...session });
}
const threadOf = (run: Row) => ({ rule: run.rule, lane: run.lane, grp: run.grp });

/** The session a round about to start goes on in. With resume, one that has none takes its thread's last, unless that round was
 * stopped: what stopped it, or the owner's reason, would meet this one too. Rounds on a thread can share a session, so another
 * still going, or one the hub lost track of, may be running in it: a second process mustn't open it, and a new one starts. */
function settleSession(draft: Draft, run: Row) {
  const rule = ruleNamed(draft, run.rule);
  const thread = { rule: run.rule, lane: run.lane };
  const carried = run.session ?? run.resume;
  let session = carried;
  if (!session && rule?.resume) {
    const [last] = rows(draft.view, "runs", { ...thread, state: ["done", "nothing", "cancelled"] }, 1, true);
    if (last?.state !== "cancelled" && last?.agent === rule.to) session = last.session;
  }
  if (!session) return;
  const going = rows(draft.view, "runs", { ...thread, state: ["claimed", "unknown"] });
  if (going.some((other) => (other.session ?? other.resume) === session)) {
    put(draft, "runs", run.id, nulls("session", "resume"));
  } else if (session !== carried) put(draft, "runs", run.id, { resume: session });
}
const hopsOf = (draft: Draft, run: Row) => Math.max(0, ...eventsOf(draft.view, run.id).map((event) => event.hops ?? 0));

function closeCard(draft: Draft, card: Row, result: string, by: string | null = null, note: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 };
  // A note says how a notice was handled, for looking back at later.
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by, ...(note ? { answer: note } : {}) });
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rows(draft.view, "cards", { state: "open" }).filter((card) => matches(card.key));
  for (const card of open) closeCard(draft, card, result);
}

/** Once it's stopped, nothing should still say it will try again, or that it may still be going. */
const closeStopped = (draft: Draft, run: number, result: string) =>
  closeOpen(draft, (key) => key === `run:${run}:failing` || key === `run:${run}:unknown`, result);

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "连上了");

/** Whether a new stamp would tell nothing this one doesn't. One in the future means a clock was set back: it gets redone. */
function justSeen({ now }: Draft, row?: Row) {
  const age = now - Date.parse(row?.seen_at);
  return age >= 0 && age < SEEN_EVERY;
}

function createCard(draft: Draft, spec: Row) {
  const [existing] = rows(draft.view, "cards", { key: spec.key, ...(!spec.once && { state: "open" }) }, 1, true);
  if (existing) return { card: existing.id, duplicate: true };
  const { once, run, options, fyi, quiet, ...fields } = spec;
  const stored = {
    run_id: run ?? null,
    options: JSON.stringify(options ?? []),
    fyi: fyi ? 1 : 0,
    quiet: quiet ? 1 : 0,
  };
  const state = fyi ? { state: "closed", closed_at: draft.at } : { state: "open" };
  const card = add(draft, "cards", { ...fields, ...stored, ...state, created_at: draft.at });
  return { card: card.id, duplicate: false };
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: Row = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra });

/** A queued run of this rule and thread takes the event, so what comes in while it waits is handled together. */
function enqueue(draft: Draft, rule: Rule, event: number, lane: string, resume?: string | null) {
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: rulesVersion };
  const run =
    rows(draft.view, "runs", { rule: rule.name, lane, state: "queued" })[0] ??
    add(draft, "runs", { rule: rule.name, agent: rule.to, grp: rule.group, lane, state: "queued", ...stamps });
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
  if (resume) put(draft, "runs", run.id, { resume });
  return run.id as number;
}

/** Keeps an event under a key of its own: one the hub makes up mustn't collide with one a source sent. */
function recordEvent(
  draft: Draft,
  source: string,
  event: Row,
  routed: string[],
  paused: string[] = [],
  sent = false,
): number {
  let key = event.id;
  for (let suffix = 1; rows(draft.view, "events", { source, key }).length; suffix++) {
    key = `${event.id}:${suffix}`;
  }
  return add(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    routed: JSON.stringify(routed),
    // Only where a pause held it back, so the owner's list of what was skipped reads an index of those alone.
    ...(paused.length && { paused: JSON.stringify(paused) }),
    // Through the source's own door: only these are its to read back (`eventOutcome`), not what the hub made in its name.
    ...(sent && { sent: 1 }),
    received_at: draft.at,
  }).id;
}

function ingest(draft: Draft, source: string, given: unknown, sent = false) {
  const event = parseEvent(given);
  const existing = rows(draft.view, "events", { source, key: event.id })[0];
  if (existing) {
    return { event: existing.id, duplicate: true, ...routingOf(existing) };
  }
  const tooDeep = event.hops > MAX_HOPS;
  const takes = (rule: Rule) =>
    eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type);
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes);
  // A paused rule doesn't take the event, and nothing is kept back for it: the event is recorded as skipped for it.
  const isPaused = (rule: Rule) => !!pauseOf(draft.view, rule, draft.now);
  const paused = matched.filter(isPaused).map((rule) => rule.name);
  const taking = matched.filter((rule) => !isPaused(rule));
  const id = recordEvent(
    draft,
    source,
    event,
    matched.map((rule) => rule.name),
    paused,
    sent,
  );
  if (tooDeep) {
    const words = `同一条处理链已超过 ${MAX_HOPS} 层，后续事件已记录，没有继续派发。`;
    notify(draft, `hops:${source}:${event.id}`, "事件循环已停止", words, { once: true });
  }
  for (const rule of taking) enqueue(draft, rule, id, rule.parallel ? event.subject : "");
  return { event: id, duplicate: false, routed: taking.map((rule) => rule.name), paused };
}

function heldRun(draft: Draft, id: number, token: string, states: string[]) {
  const run = draft.view.get("runs", id);
  const issued = run && states.includes(run.state) && run.issued !== null;
  if (!issued || credential(draft.env, "run", id, run.issued) !== token) throw new AuthError("这件活不归这个令牌");
  return run;
}

function cardFromReceipt(draft: Draft, run: Row, kind: string, card: Row) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32);
  const session = draft.view.get("runs", run.id)!.session;
  const fyi = kind === "notice" && card.fyi === true;
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never";
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id };
  const key = `thread:${run.rule}:${run.lane}:${name}`;
  // Closed as it's made, nothing open stops it coming again: a run trying again says it once.
  if (fyi && rows(draft.view, "cards", { key, run_id: run.id }, 1).length) return;
  createCard(draft, { ...card, hops: hopsOf(draft, run), key, kind, fyi, quiet, ...threadOf(run), ...origin });
}

/** Notices what has gone quiet: a worker that stopped coming, a run its worker stopped mentioning. */
function sweep(draft: Draft) {
  const { now } = draft;
  for (const worker of workers(draft.view)) {
    const seen = draft.view.get("seen", `worker:${worker}`);
    const lastSeen = seen ? Date.parse(seen.seen_at) : undefined;
    if (lastSeen !== undefined && now - lastSeen <= WORKER_FRESH) {
      closeOffline(draft, worker);
      const inDoubt = (run: Row) => workerOf(draft.view, run) === worker && Date.parse(run.seen_at) < now - RUN_LEASE;
      for (const run of rows(draft.view, "runs", { state: "claimed" }).filter(inDoubt)) {
        put(draft, "runs", run.id, { state: "unknown" });
        const agent = configuration(draft.view, run.rules_version).agents[run.agent].name;
        const words = `交给 ${agent} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。`;
        notify(draft, `run:${run.id}:unknown`, run.rule, words, threadOf(run));
      }
    }
    const waiting = waitingOn(draft.view, worker, now);
    if (!waiting.length) continue;
    const since = now - (lastSeen ?? Date.parse(waiting[0].created_at));
    const { key, told } = offlineCard(draft.view, worker, waiting);
    if (since <= OFFLINE_AFTER || told) continue;
    const minutes = Math.floor(since / MINUTE);
    const neverSeen = lastSeen === undefined;
    const situation = neverSeen
      ? `${worker} 一直没连上中台，有 ${waiting.length} 件任务等了 ${minutes} 分钟没人接`
      : `${worker} 已经 ${minutes} 分钟没连上中台，有 ${waiting.length} 件任务在排队或在跑`;
    const check = neverSeen ? "有没有开机联网" : "是不是关机、休眠或断网了";
    notify(draft, key, "接单程序没连上", `${situation}（请看一眼那台电脑${check}）。`);
  }
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft.view, worker);
  const runs = rows(draft.view, "runs", { state: ["queued", "claimed"] });
  const claimed = runs.filter((run) => run.state === "claimed");
  const groupLimit = (group: string) => draft.rules.rules.find((rule) => rule.group === group)?.parallel ?? 1;
  // What was queued before a pause, or an answer that came in during one, waits for the resume.
  const unpaused = (name: string) => {
    const rule = ruleNamed(draft, name);
    return !!rule && !pauseOf(draft.view, rule, draft.now);
  };
  const claimable = (run: Row) =>
    run.state === "queued" &&
    agents.includes(ruleNamed(draft, run.rule)?.to ?? "") &&
    Date.parse(run.not_before) <= draft.now &&
    unpaused(run.rule) &&
    !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
    claimed.filter((other) => other.grp === run.grp).length < groupLimit(run.grp);
  // The same claim again means the answer got lost: it gets back the run it already has.
  const held = claimed.find((run) => run.claim === claim && workerOf(draft.view, run) === worker);
  const run = held ?? runs.find(claimable);
  if (!run) return null;
  if (!held) {
    assignQueued(draft, run);
    settleSession(draft, draft.view.get("runs", run.id)!);
  }
  const since = held ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null };
  const rules_version = held ? run.rules_version : draft.view.get("config", "rules")!.version;
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version, ...since };
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") });
  return jobOf(draft.view, draft.view.get("runs", run.id)!, draft.env);
}

/** Ends a run nothing will pick up again, and says so. */
function stopRun(draft: Draft, run: Row, why: string, summary: string, words: string) {
  put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at, summary });
  closeStopped(draft, run.id, summary);
  notify(draft, `run:${run.id}:${why}`, run.rule, words, threadOf(run));
}

const ruleGone = (run: Row): [string, string] => [
  `规则「${run.rule}」不在了，不再派发`,
  `规则「${run.rule}」不在了（删掉或改名了），排着的这一轮不再派发。规则加回来、没有暂停时可以重试这一轮；也可以重新触发这件事。`,
];

/** A run that didn't get through waits to try again, and takes along whatever came in for the same thing meanwhile. */
function retryLater(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const attempts = run.attempts + 1;
  const notBefore = draft.now + Math.min(5 * MINUTE * 2 ** (attempts - 1), 60 * MINUTE);
  const error = (result.error ?? "").trim().replace(/[。.]+$/, "") || "没说原因";
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at");
  const rejected: Rejected[] = [];
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? []) rejected.push({ what, reason: "没跑成的一轮只能发通知" });
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  const failure = { attempts, error, ...unclaimed };
  if (!ruleNamed(draft, run.rule)) {
    put(draft, "runs", id, failure);
    stopRun(draft, run, "rule-gone", ...ruleGone(run));
    return rejected;
  }
  if (attempts >= MAX_ATTEMPTS) {
    // Runs queued for this thread stay apart: they came in since, and get their own count and their own go.
    const summary = `连续 ${MAX_ATTEMPTS} 次没跑成，不再自动重试`;
    const words = `连续 ${MAX_ATTEMPTS} 次自动处理没跑完（卡在：${error}），不再自动重试。解决后可以重试这一轮，事件和会话都还在；重新触发这件事则从头开始。`;
    put(draft, "runs", id, failure);
    stopRun(draft, run, "stopped", summary, words);
    return rejected;
  }
  put(draft, "runs", id, { state: "queued", not_before: iso(notBefore), ...failure });
  const waiting = rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued" });
  for (const other of waiting.filter((other) => other.id !== id)) {
    for (const link of rows(draft.view, "run_events", { run_id: other.id })) {
      put(draft, "run_events", `${id}:${link.event_id}`, { run_id: id, event_id: link.event_id });
      set(draft, "run_events", `${other.id}:${link.event_id}`, null);
    }
    set(draft, "runs", other.id, null);
    if (other.resume) put(draft, "runs", id, { resume: other.resume });
  }
  if (!result.notice?.some((notice) => !notice.fyi) && attempts === 3) {
    const clock = { timeZone: draft.rules.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Intl.DateTimeFormat("zh-CN", clock).format(notBefore);
    const words = `连续 3 次自动处理没跑完（卡在：${error}），${time} 会自动再试。`;
    notify(draft, `run:${id}:failing`, run.rule, words, threadOf(run));
  }
  assignQueued(draft, draft.view.get("runs", id)!);
  return rejected;
}

function scheduleReview(draft: Draft, run: Row, later: Later) {
  const { rule, lane } = run;
  const [existing] = rows(draft.view, "timers", { rule, lane, key: later.key, event_id: null });
  if (later.cancel) {
    if (existing) set(draft, "timers", existing.id, null);
    return;
  }
  const session = draft.view.get("runs", run.id)!.session;
  const fields = { at: iso(Date.parse(later.at!)), about: later.about, session, hops: hopsOf(draft, run) };
  if (existing) return void put(draft, "timers", existing.id, fields);
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE;
  add(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at });
}

/** A receipt takes effect here, all of it in the one fact. */
function applyReceipt(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const rule = ruleNamed(draft, run.rule);
  const summary = result.summary ?? "";
  const rejected: Rejected[] = [];
  put(draft, "runs", id, { state: result.outcome, finished_at: draft.at, summary, error: null, cancel_at: null });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  const eventIds = eventsOf(draft.view, id).map((event) => event.id);
  for (const card of rows(draft.view, "cards", { answer_event: eventIds, state: "decided" })) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 });
  }
  for (const item of result.resolve ?? []) {
    const card = openInScope(draft.view, run).find((card) => card.id === item.card);
    if (card) closeCard(draft, card, item.reason.trim(), `第 ${id} 轮`);
    else rejected.push({ card: item.card, reason: "不在本轮核对范围" });
  }
  for (const ask of result.ask ?? []) cardFromReceipt(draft, run, "ask", ask);
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (rule?.tell === "always" && result.outcome === "done") {
    const once = { fyi: true, once: true, ...threadOf(run), source: sourceOf(draft.view, id), run: id };
    notify(draft, `run:${id}:done`, run.rule, summary, once);
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later);
  const emitted: number[] = [];
  for (const event of result.events ?? []) {
    if (rule?.emits && typeMatches(rule.emits.types, event.type)) {
      const sent = ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 });
      // A number already taken is an earlier event's, perhaps another source's: what it says isn't what this receipt sent.
      if (!sent.duplicate) emitted.push(sent.event);
    } else rejected.push({ what: "events", reason: `规则「${run.rule}」没有写可以发 ${event.type}` });
  }
  // The source whose event this run took reads them back (`eventOutcome`); nothing else links them to the run.
  if (emitted.length) put(draft, "runs", id, { emitted: JSON.stringify(emitted) });
  return rejected;
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null));
  const prior = draft.view.get("runs", id);
  // The same execution handing in again means the answer got lost: it gets the same answer, and nothing happens twice.
  if (prior && prior.last_issued !== null && credential(draft.env, "run", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new Conflict("这一次执行已经交过不一样的结果");
    return { rejected: JSON.parse(prior.last_answer ?? "[]"), duplicate: true };
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const result = parseResult(given);
  const session = result.session ?? run.session;
  const usage = result.usage
    ? JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, result.usage))
    : run.usage;
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage });
  let rejected: Rejected[] = [];
  // Told to stop, one that failed first has stopped all the same: trying again would start what the owner ended.
  if (result.outcome === "cancelled" || (result.outcome === "failed" && run.cancel_at)) {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    });
    closeStopped(draft, id, "已停止");
  } else if (result.outcome === "failed") rejected = retryLater(draft, run, result);
  else rejected = applyReceipt(draft, run, result);
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) });
  return { rejected };
}

function answer(draft: Draft, id: number, given: Row) {
  const card = draft.view.get("cards", id);
  if (!card) throw new NotFound("没有这张卡片");
  if (given.channel !== undefined) {
    const allowed = draft.rules.channels[given.channel]?.answerers;
    if (allowed && !allowed.includes(given.by ?? "")) throw new AuthError("这个人不能回答这张卡片");
    const delivery = draft.view.get("deliveries", `${id}:${given.channel}`);
    if (!delivery?.ref || delivery.ref !== given.ref) throw new AuthError("不是发出去的那条消息");
  }
  if (card.state !== "open") return { changed: false, state: card.state };
  if (given.by !== undefined && (typeof given.by !== "string" || [...given.by].length > ANSWER_BY)) {
    throw new InputError(`回答人最多 ${ANSWER_BY} 字`);
  }
  if (given.ref !== undefined && (typeof given.ref !== "string" || [...given.ref].length > ANSWER_REF)) {
    throw new InputError(`消息编号最多 ${ANSWER_REF} 字`);
  }
  const words = card.kind === "notice" ? "处理说明" : "回答";
  if (given.text !== undefined && typeof given.text !== "string") throw new InputError(`${words}要是文字`);
  const text = given.text?.trim() || null;
  if (text !== null && [...text].length > ANSWER_TEXT) throw new InputError(`${words}最多 ${ANSWER_TEXT} 字`);
  if (card.kind === "notice") {
    closeCard(draft, card, "已处理", given.by ?? null, text);
    return { changed: true, state: "closed" };
  }
  const optionCount = JSON.parse(card.options).length;
  const inRange = Number.isInteger(given.choice) && given.choice >= 0 && given.choice < optionCount;
  if (given.choice === undefined ? !text : !inRange) throw new InputError("没有这个选项");
  const rule = card.rule ? ruleNamed(draft, card.rule) : undefined;
  const { lane: subject, title: summary, hops = 0 } = card;
  const event = { id: `card:${id}`, type: "card.answered", subject, summary, hops };
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule ? [rule.name] : []);
  const decision = { choice: given.choice ?? null, answer: text, by: given.by ?? null, decided_at: draft.at };
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 });
  if (rule) enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null);
  return { changed: true, state: "decided" };
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft;
  for (const card of draft.view.deliveryCandidates(channel, now)) {
    const reach = card.rule ? ruleNamed(draft, card.rule)?.channels : undefined;
    if (reach && !reach.includes(channel)) continue;
    const key = `${card.id}:${channel}`;
    const delivery = draft.view.get("deliveries", key) ?? NOT_DELIVERED;
    const recentNote = card.fyi && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE;
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote;
    const resting = delivery.not_before && Date.parse(delivery.not_before) > now;
    if (card.quiet || delivery.version >= card.version || delivery.given_up || resting || !worthSending) continue;
    const firstTry = delivery.first_try_at;
    if (delivery.tries >= RESEND_AT.length || (firstTry && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 });
      continue;
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(now + MINUTE) };
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt });
    return cardView(card, draft.env, delivery.ref, draft.rules.channels[channel]?.links === true);
  }
  return null;
}

/** What the clock has brought: schedules come round, reviews come due, and anything gone quiet. */
function tick(draft: Draft) {
  const { now } = draft;
  const { rules, timezone } = draft.rules;
  for (const pause of rows(draft.view, "pauses")) {
    if (pause.until === null || Date.parse(pause.until) > now) continue;
    set(draft, "pauses", pause.name, null);
    reopen(draft, pause.name, Date.parse(pause.until));
  }
  for (const rule of rules) {
    if (eventRule(rule)) continue;
    const text = cronOf(rule);
    const cron = parseCron(text)!;
    const schedule = draft.view.get("schedules", rule.name);
    const nextAt = () => iso(nextRun(cron, now, timezone)!);
    if (!schedule || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: nextAt() });
      continue;
    }
    if (now < Date.parse(schedule.next_at)) continue;
    const slot = iso(latestBefore(cron, Date.parse(schedule.next_at), now, timezone));
    // Paused, the moment passes without a run, and the next one is the next one: a resume owes nothing.
    if (pauseOf(draft.view, rule, now)) {
      put(draft, "schedules", rule.name, { next_at: nextAt(), skipped_at: slot });
      continue;
    }
    const key = `${rule.name}@${slot}`;
    if (!rows(draft.view, "events", { source: SCHEDULE, key }).length) {
      enqueue(draft, rule, recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]), "");
    }
    put(draft, "schedules", rule.name, { next_at: nextAt() });
  }
  const due = rows(draft.view, "timers", { event_id: null }).filter((timer) => Date.parse(timer.at) <= now);
  for (const timer of due.sort((a, b) => a.at.localeCompare(b.at))) {
    const rule = ruleNamed(draft, timer.rule);
    const event = { id: `timer:${timer.id}`, type: "timer.due", subject: timer.lane, hops: timer.hops ?? 0 };
    const eventId = recordEvent(draft, timer.source, event, rule ? [rule.name] : []);
    put(draft, "timers", timer.id, { event_id: eventId });
    if (rule) enqueue(draft, rule, eventId, timer.lane, timer.session);
  }
  sweep(draft);
}

/** A schedule whose next moment passed while paused starts again at the first moment from `from`, not with a backlog. */
function reopen(draft: Draft, name: string, from: number) {
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (!rule || eventRule(rule)) return;
  const schedule = draft.view.get("schedules", rule.name);
  if (!schedule || Date.parse(schedule.next_at) >= from) return;
  const next = nextRun(parseCron(cronOf(rule))!, from - 1, draft.rules.timezone);
  put(draft, "schedules", rule.name, { next_at: iso(next!) });
}

function knownRule(draft: Draft, name: string) {
  // Not ruleNamed: a task elsewhere that can ask goes on like a rule, but the hub neither starts nor holds it.
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  if (draft.rules.elsewhere.some((task) => task.name === name)) {
    throw new InputError(`「${name}」是在别处跑的定时任务，中台不启动它，也就停不了、跑不了`);
  }
  throw new NotFound(`没有这条规则：${name}`);
}

const PAUSE_REASON = 500;
function pauseFields(draft: Draft, given: Row) {
  const { reason = "", until = null } = given ?? {};
  if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
    throw new InputError(`暂停原因要是 ${PAUSE_REASON} 字以内的文字`);
  }
  const ends = typeof until === "string" && /(Z|[+-]\d\d:\d\d)$/.test(until) ? Date.parse(until) : NaN;
  if (until !== null && !(ends > draft.now)) throw new InputError("until 要是带时区、晚于现在的 ISO 时间");
  return { reason: reason.trim(), until: until === null ? null : iso(ends) };
}

const pauseView = ({ by, reason, since, until }: Row) => ({ by, reason, since, until });

/** Owner actions on one rule. They are facts in the log, not edits to rules.json. */
const CONTROL = {
  pauseRule(draft: Draft, name: string, by: string, given: Row) {
    knownRule(draft, name);
    const fields = pauseFields(draft, given);
    const existing = draft.view.get("pauses", name);
    const same = existing && existing.reason === fields.reason && existing.until === fields.until;
    if (!same) put(draft, "pauses", name, { name, by, since: existing?.since ?? draft.at, ...fields });
    return { changed: !same, rule: name, paused: pauseView(draft.view.get("pauses", name)!) };
  },
  resumeRule(draft: Draft, name: string) {
    // A rule taken out of rules.json while paused can still have its pause lifted.
    if (!draft.view.get("pauses", name)) {
      knownRule(draft, name);
      return { changed: false, rule: name };
    }
    set(draft, "pauses", name, null);
    reopen(draft, name, draft.now);
    return { changed: true, rule: name };
  },
  /** One run now, through the usual queue, from an event of its own that says the owner asked for it. */
  runRule(draft: Draft, name: string, by: string, given: Row) {
    const rule = knownRule(draft, name);
    const { subject = "", reason = "" } = given ?? {};
    if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
      throw new InputError(`说明要是 ${PAUSE_REASON} 字以内的文字`);
    }
    if (pauseOf(draft.view, rule, draft.now)) throw new Conflict(`规则「${name}」暂停中，先恢复再手动运行`);
    const source = eventRule(rule) ? rule.when.source : SCHEDULE;
    // The same checks as any event: its subject becomes the lane and goes into the prompt.
    const event = parseEvent({
      id: `manual:${draft.seq}`,
      type: "run.manual",
      subject,
      summary: `${by} 手动运行`,
      detail: reason,
    });
    const eventId = recordEvent(draft, source, event, [name]);
    const run = enqueue(draft, rule, eventId, rule.parallel ? subject : "");
    // Waiting out a retry's backoff wouldn't be now: the owner asking is the go-ahead.
    put(draft, "runs", run, { manual: 1, not_before: draft.at });
    return { event: eventId, run };
  },
};

/** Puts one stopped round back on the queue. It is the same round, so its events and session stay; the old execution's
 * token must not still be accepted, which is why the claim and the last receipt's marks are cleared. A round already
 * waiting is this request again. */
function retry(draft: Draft, id: number) {
  const run = draft.view.get("runs", id);
  if (!run) throw new NotFound("没有这一轮");
  if (run.state === "queued") return { run: id, state: "queued", changed: false };
  if (run.state === "claimed" || run.state === "unknown") throw new InputError("这一轮还在跑，不能重试");
  if (run.state !== "cancelled") throw new InputError("这一轮已经做完了，不能重试");
  const rule = draft.rules.rules.find((rule) => rule.name === run.rule);
  if (!rule) {
    if (draft.rules.elsewhere.some((task) => task.name === run.rule)) {
      throw new InputError(`「${run.rule}」是在别处跑的定时任务，中台不启动它，也就重试不了`);
    }
    throw new Conflict(`规则「${run.rule}」不在了，不能重试`);
  }
  if (pauseOf(draft.view, rule, draft.now)) throw new Conflict(`规则「${run.rule}」暂停中，先恢复再重试`);
  const cleared = nulls(
    "claim",
    "claimed_at",
    "seen_at",
    "cancel_at",
    "issued",
    "last_issued",
    "last_result",
    "last_answer",
    "finished_at",
    "summary",
    "error",
  );
  put(draft, "runs", id, { state: "queued", attempts: 0, not_before: draft.at, manual: 1, ...cleared });
  assignQueued(draft, draft.view.get("runs", id)!);
  closeOpen(
    draft,
    (key) => key === `run:${id}:failing` || key === `run:${id}:stopped` || key === `run:${id}:rule-gone`,
    "重新排队了",
  );
  return { run: id, state: "queued", changed: true };
}

/** Every input there is, each with its arguments named. What one returns is what the caller is told. */
const HANDLERS: Record<string, (draft: Draft, ...args: any[]) => unknown> = {
  rules(draft, rules) {
    put(draft, "config", "rules", { value: rules, version: draft.seq });
    for (const run of rows(draft.view, "runs", { state: "queued" })) {
      if (ruleOf(rules, run.rule)) assignQueued(draft, run);
      else stopRun(draft, run, "rule-gone", ...ruleGone(run));
    }
    closeOpen(draft, (key) => key.startsWith("rules:"), "改好了");
  },
  rulesError: (draft, problem) => notify(draft, `rules:${digest(problem)}`, "rules.json 写错了，还在用旧规则", problem),
  key: (draft, kind, name, hash) =>
    void put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),
  removeKey: (draft, kind, name) => {
    if (!draft.view.get("keys", `${kind}:${name}`)) return false;
    set(draft, "keys", `${kind}:${name}`, null);
    return true;
  },
  ingest: (draft, source, given) => ingest(draft, source, given, true),
  createCard,
  /** A task elsewhere asks you; your answer goes on like a round of a rule, where its cwd says. */
  ask(draft, name, given) {
    const task = draft.rules.elsewhere.find((task) => task.name === name)!;
    if (!task.cwd) throw new InputError(`定时任务「${name}」没写 cwd，回答了没人接着做：只能 tell`);
    const { key, ...question } = given;
    const matter = key ?? digest(`${question.title}\n${question.text}`).slice(0, 32);
    const thread = { rule: name, lane: "", grp: name, source: task.source, agent: task.to };
    // A key of its own: told once for good, a notice under the same key would never get through after a question.
    return createCard(draft, { ...question, key: `elsewhere-ask:${name}:${matter}`, kind: "ask", ...thread });
  },
  tell(draft, key, title, text) {
    const told = createCard(draft, { key, title, text, kind: "notice", fyi: true, once: true });
    if (!told.duplicate) return told;
    // Said again after every channel gave up on it: it gets another go.
    const givenUp = rows(draft.view, "deliveries", { card_id: told.card, given_up: 1 });
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, ...NOT_TRYING });
    }
    if (!givenUp.length) return told;
    put(draft, "cards", told.card, { text, created_at: draft.at });
    return { ...told, duplicate: false };
  },
  heartbeat(draft, worker, running) {
    closeOffline(draft, worker);
    const held = (run?: Row) => run?.state === "claimed" && workerOf(draft.view, run) === worker;
    const inHand = running.map((id: number) => draft.view.get("runs", id)).filter(held);
    // All stamped together, so however many runs a worker has on, it's one fact each time.
    if ([draft.view.get("seen", `worker:${worker}`), ...inHand].every((row) => justSeen(draft, row))) return;
    put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at });
    for (const run of inHand) put(draft, "runs", run.id, { seen_at: draft.at });
  },
  channelSeen(draft, name) {
    if (justSeen(draft, draft.view.get("seen", `channel:${name}`))) return;
    put(draft, "seen", `channel:${name}`, { kind: "channel", name, seen_at: draft.at });
  },
  claimNext,
  started(draft, id, token, given) {
    const { session, link } = given ?? {};
    for (const [field, value] of Object.entries({ session, link })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
        throw new InputError(`${field} 要是 500 字以内的文字`);
      }
    }
    const run = heldRun(draft, id, token, ["claimed"]);
    put(draft, "runs", id, { session: session ?? run.session, link: link ?? run.link, seen_at: draft.at });
  },
  finish,
  cancel(draft, id) {
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("没有这一轮");
    if (run.state === "queued") {
      put(draft, "runs", id, { state: "cancelled", finished_at: draft.at });
      closeStopped(draft, id, "已停止");
    } else if (run.state === "claimed") put(draft, "runs", id, { cancel_at: draft.at });
    else throw new InputError("这一轮已经结束了");
  },
  retry,
  resolve(draft, id, reason, by) {
    const card = draft.view.get("cards", id);
    if (!card) throw new NotFound("没有这张卡片");
    if (card.state !== "open") return false;
    closeCard(draft, card, reason, by);
    return true;
  },
  answer,
  nextCard,
  delivered(draft, channel, id, version, ref) {
    if (!draft.view.get("cards", id)) throw new NotFound("没有这张卡片");
    if (ref !== null && (typeof ref !== "string" || [...ref].length > DELIVERY_REF)) {
      throw new InputError(`消息编号最多 ${DELIVERY_REF} 字`);
    }
    const delivery = draft.view.get("deliveries", `${id}:${channel}`) ?? NOT_DELIVERED;
    const sent = { version: Math.max(delivery.version, version), ref: delivery.ref ?? ref };
    put(draft, "deliveries", `${id}:${channel}`, { card_id: id, channel, ...sent, ...NOT_TRYING, error: null });
  },
  failed(draft, channel, id, version, error) {
    const card = draft.view.get("cards", id);
    const delivery = draft.view.get("deliveries", `${id}:${channel}`);
    if (!card || !delivery) throw new NotFound("这张卡片没有交给这个通道");
    const firstTry = delivery.first_try_at ? Date.parse(delivery.first_try_at) : draft.now;
    const next =
      version < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(firstTry + RESEND_AT[delivery.tries] * MINUTE) };
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) });
  },
  sweep,
  tick,
  ...CONTROL,
};
