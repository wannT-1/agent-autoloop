// Putting a stopped round back on the queue. Failure cases: a round that stopped after failing too often is thrown away
// and a new one starts, so its events, session and materials are gone; a deleted, renamed or paused rule is retried
// anyway; a round that finished, is still running, or was never there is queued; retrying twice opens a second round.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rows } from "../kernel/evolve.ts";
import { World } from "../sim/world.ts";
import { at, setup } from "./helpers.ts";

setup("retry");
const { ingest, claimNext, finish, started, cancel, execute, rules, getView } = await import("./hub.ts");
const { AuthError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const note = (n: number, step = "new", detail = "原来的正文") => ({
  id: `feedback:${n}:${step}`,
  type: `feedback.${step}`,
  subject: `#${n}`,
  summary: `第 ${n} 条`,
  detail,
  link: `https://x.test/feedback?id=${n}`,
});
const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "pauses"])
    run(`DELETE FROM ${table}`);
};
const claim = (now: number) => claimNext("w1", `c${now}`, now);
const state = (id: number) => one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [id])!.state;
const round = (id: number) => getView().get("runs", id)!;
const facts = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n;

/** Ten failures, the follow-up joining while it waits, then the round is cancelled. */
function stoppedByFailure() {
  clean();
  ingest("app", note(1), at(0));
  let job = claim(at(0))!;
  const id = job.run;
  started(id, job.token, { session: "s-keep" }, at(0));
  const step = 100;
  for (let failure = 1; failure < 10; failure++) {
    const usage = failure === 1 ? { input: 4 } : undefined;
    finish(id, job.token, { outcome: "failed", error: "没登录", session: "s-keep", usage }, at(failure * step));
    if (failure === 1) ingest("app", note(1, "followup", "后来补的"), at(failure * step + 1));
    assert.equal(state(id), "queued", `still retrying after failure ${failure}`);
    job = claim(at((failure + 1) * step - 1))!;
    assert.equal(job.run, id);
  }
  finish(id, job.token, { outcome: "failed", error: "没登录", session: "s-keep" }, at(10 * step));
  assert.equal(state(id), "cancelled");
  return { id, token: job.token };
}

test("retry after a round stopped for failing queues that same round again", () => {
  const { id, token } = stoppedByFailure();
  const stopped = one<{ state: string }>("SELECT state FROM cards WHERE key = ?", [`run:${id}:stopped`])!;
  assert.equal(stopped.state, "open");
  const before = facts();
  const done = execute("retry", [id], at(2000)) as { run: number; state: string; changed: boolean };
  assert.deepEqual(done, { run: id, state: "queued", changed: true });
  assert.equal(facts(), before + 1);
  const row = round(id);
  assert.equal(row.state, "queued");
  assert.equal(row.attempts, 0);
  assert.equal(row.manual, 1);
  assert.equal(row.session, "s-keep");
  assert.equal(row.not_before, new Date(at(2000)).toISOString());
  assert.equal(row.claim, null);
  assert.equal(row.issued, null);
  assert.equal(row.last_issued, null);
  assert.equal(row.last_result, null);
  assert.equal(row.last_answer, null);
  assert.equal(row.finished_at, null);
  assert.equal(row.error, null);
  assert.equal(row.cancel_at, null);
  assert.equal(JSON.parse(row.usage).input, 4);
  assert.equal(
    one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE key = ?", [`run:${id}:stopped`])!
      .state,
    "closed",
  );
  assert.equal(
    one<{ result: string }>("SELECT result FROM cards WHERE key = ?", [`run:${id}:stopped`])!.result,
    "重新排队了",
  );
  assert.equal(all<{ id: number }>("SELECT id FROM runs").length, 1, "the follow-up stayed on this round");

  const again = execute("retry", [id], at(2001)) as { run: number; state: string; changed: boolean };
  assert.deepEqual(again, { run: id, state: "queued", changed: false });
  assert.equal(facts(), before + 1, "a second retry adds nothing");
  assert.equal(all<{ id: number }>("SELECT id FROM runs").length, 1);
  assert.throws(() => finish(id, token, { outcome: "done", summary: "晚到的" }, at(2002)), AuthError);

  const job = claim(at(2002))!;
  assert.equal(job.run, id);
  assert.equal(job.attempt, 1);
  assert.equal(job.session, "s-keep");
  assert.deepEqual(
    job.context.events.map((event) => [event.type, event.detail]),
    [
      ["feedback.new", "原来的正文"],
      ["feedback.followup", "后来补的"],
    ],
  );
});

test("a round the owner stopped is queued again with the events it already had", () => {
  clean();
  ingest("app", note(4, "new", "停之前的"), at(0));
  const id = one<{ id: number }>("SELECT id FROM runs")!.id;
  cancel(id, at(1));
  assert.equal(state(id), "cancelled");
  const done = execute("retry", [id], at(2)) as { run: number; changed: boolean };
  assert.deepEqual([done.run, done.changed], [id, true]);
  const job = claim(at(2))!;
  assert.equal(job.run, id);
  assert.equal(job.attempt, 1);
  assert.deepEqual(
    job.context.events.map((event) => event.detail),
    ["停之前的"],
  );
});

test("retry refuses a rule that is gone or paused, and says why", () => {
  const { id } = stoppedByFailure();
  const renamed = structuredClone(rules);
  renamed.rules.find((rule) => rule.name === "意见")!.name = "新意见";
  try {
    execute("rules", [renamed], at(2100));
    assert.throws(() => execute("retry", [id], at(2101)), /规则「意见」不在了，不能重试/);
    assert.equal(state(id), "cancelled");
    assert.equal(one<{ state: string }>("SELECT state FROM cards WHERE key = ?", [`run:${id}:stopped`])!.state, "open");
    execute("rules", [structuredClone(rules)], at(2102));
    execute("pauseRule", ["意见", "owner", { reason: "先别跑" }], at(2103));
    assert.throws(() => execute("retry", [id], at(2104)), /规则「意见」暂停中，先恢复再重试/);
    assert.equal(state(id), "cancelled");
  } finally {
    execute("rules", [structuredClone(rules)], at(2105));
    execute("resumeRule", ["意见"], at(2106));
  }
});

test("retry closes the notice that the rule was gone, once that rule is back", () => {
  clean();
  ingest("app", note(5), at(0));
  const job = claim(at(0))!;
  const renamed = structuredClone(rules);
  renamed.rules.find((rule) => rule.name === "意见")!.name = "新意见";
  try {
    execute("rules", [renamed], at(1));
    finish(job.run, job.token, { outcome: "failed", error: "没跑成" }, at(2));
    assert.equal(state(job.run), "cancelled");
    assert.equal(
      one<{ state: string }>("SELECT state FROM cards WHERE key = ?", [`run:${job.run}:rule-gone`])!.state,
      "open",
    );
    assert.throws(() => execute("retry", [job.run], at(3)), /不在了，不能重试/);
    execute("rules", [structuredClone(rules)], at(4));
    execute("retry", [job.run], at(5));
    const card = one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE key = ?", [
      `run:${job.run}:rule-gone`,
    ])!;
    assert.equal(card.state, "closed");
    assert.equal(card.result, "重新排队了");
    assert.equal(state(job.run), "queued");
    assert.equal(round(job.run).attempts, 0);
  } finally {
    execute("rules", [structuredClone(rules)], at(6));
  }
});

test("retry refuses a finished round, a running one, and one that is not there", () => {
  clean();
  ingest("app", note(6), at(0));
  const running = claim(at(0))!;
  assert.throws(() => execute("retry", [running.run], at(1)), /这一轮还在跑，不能重试/);
  assert.equal(state(running.run), "claimed");
  finish(running.run, running.token, { outcome: "done", summary: "好了" }, at(2));
  assert.throws(() => execute("retry", [running.run], at(3)), /这一轮已经做完了，不能重试/);
  assert.equal(state(running.run), "done");

  ingest("app", note(7), at(4));
  const quiet = claim(at(4))!;
  finish(quiet.run, quiet.token, { outcome: "nothing", summary: "没事" }, at(5));
  assert.throws(() => execute("retry", [quiet.run], at(6)), /这一轮已经做完了，不能重试/);
  assert.equal(state(quiet.run), "nothing");
  assert.throws(() => execute("retry", [9999], at(7)), NotFound);
});

test("retrying a cancelled round is allowed by the log check that finished rounds stay finished", () => {
  const world = new World();
  try {
    world.call("ingest", "app", { id: "e", type: "one", subject: "#1" });
    let job = world.call("claimNext", "w1", "c0");
    let id = job.run as number;
    for (let n = 0; n < 10; n++) {
      world.finish(id, { outcome: "failed", error: "x", session: "S" });
      if (world.view.get("runs", id)!.state !== "queued") break;
      world.advance(60 * 60_000);
      job = world.call("claimNext", "w1", `c${n + 1}`);
      assert.equal(job.run, id);
    }
    assert.equal(world.view.get("runs", id)!.state, "cancelled");
    const retried = world.call("retry", id);
    assert.deepEqual(retried, { run: id, state: "queued", changed: true });
    assert.equal(world.view.get("runs", id)!.session, "S");
    assert.equal(world.view.get("runs", id)!.attempts, 0);
    assert.equal(rows(world.view, "run_events", { run_id: id }).length, 1);
    assert.deepEqual(world.call("retry", id), { run: id, state: "queued", changed: false });
  } finally {
    world.view.close();
  }
});
