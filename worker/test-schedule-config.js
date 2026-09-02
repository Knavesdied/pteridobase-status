#!/usr/bin/env node
/**
 * Config invariants for the dispatcher (Pteridobase#869).
 *
 * WHY THIS EXISTS. The Worker's triggers live in `triggers.crons` and its targets in
 * `vars`, and the handler joins them by the cron STRING Cloudflare hands it. Nothing
 * but exact string equality connects the two halves, so a trigger with no matching
 * schedule entry fires forever and dispatches nothing - and a schedule entry with no
 * trigger never runs at all.
 *
 * Both failures are SILENT. The first would report success on every invocation while
 * doing nothing; the second leaves a workflow quietly unscheduled. That is the exact
 * shape #869 exists to end: a monitor that logged "Sending notification" for weeks
 * while its email channel did not exist. The handler throws on an unmapped cron at
 * runtime, which is the backstop; this is the check you can run before deploying.
 *
 * It reads the REAL wrangler.jsonc rather than a copy of the values, so it cannot
 * pass against a config that is not shipping.
 *
 * Run: node worker/test-schedule-config.js
 * Exit 0 all passed, 1 otherwise. Run it after ANY change to crons or the var maps.
 */

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "wrangler.jsonc");
// Comments only ever occupy whole lines in this file; a full JSONC parser would be a
// dependency for one read. If that ever stops being true, this throws rather than
// silently parsing the wrong thing.
const cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""));

const crons = cfg.triggers.crons;
const sched = cfg.vars.GH_SCHEDULE;
const hourlyCron = cfg.vars.GH_HOURLY_CRON;
const byMinute = cfg.vars.GH_HOURLY_BY_MINUTE || {};
let fail = 0;
const chk = (label, cond) => {
	console.log((cond ? "  PASS  " : "  FAIL  ") + label);
	if (!cond) fail++;
};

// --- the account limit that caused a half-applied deploy ---------------------
// Workers Free allows FIVE cron triggers PER ACCOUNT, shared with every other Worker
// on it. A four-trigger deploy was REFUSED with the code already live and the triggers
// only partially updated - the code and its schedule out of step, which is worse than
// either failing cleanly. Two leaves headroom for the account's other Workers.
chk(`uses ${crons.length} cron trigger(s), within the 5-per-ACCOUNT free-plan limit`,
	crons.length <= 2);

// --- the two silent failures -------------------------------------------------
const resolves = (c) => !!sched[c] || (c === hourlyCron && Object.keys(byMinute).length > 0);
for (const c of crons) {
	chk(`cron ${JSON.stringify(c)} resolves to a workflow`, resolves(c));
}
for (const k of Object.keys(sched)) {
	chk(`schedule key ${JSON.stringify(k)} has a trigger (else it never runs)`, crons.includes(k));
}
chk(`the hourly cron ${JSON.stringify(hourlyCron)} is an actual trigger`,
	crons.includes(hourlyCron));

// --- the shared hourly cron: its minutes ARE its routing table ---------------
// The handler selects the workflow by the tick's minute, so the minute list in the
// cron and the keys of the map are two spellings of one fact. A minute in one and not
// the other is either a tick that throws or a workflow that never runs.
const cronMinutes = new Set(String(hourlyCron).split(" ")[0].split(","));
const mapMinutes = new Set(Object.keys(byMinute));
chk(`hourly cron minutes [${[...cronMinutes].join(",")}] match the map keys exactly`,
	cronMinutes.size === mapMinutes.size && [...cronMinutes].every((m) => mapMinutes.has(m)));

// All eight Upptime workflows share ONE concurrency group holding a single PENDING
// run, so simultaneous dispatches DISCARD each other. Minutes on the five-minute grid
// would fire in the same minute as an uptime tick; off-grid minutes cannot.
chk("hourly minutes sit OFF the five-minute grid (no collision with an uptime tick)",
	[...mapMinutes].every((m) => Number(m) % 5 !== 0));

// --- the design decisions, pinned so a later edit has to argue with them -----
const allTargets = [...Object.values(sched), ...Object.values(byMinute)];
chk("staleness target is a workflow we actually dispatch",
	allTargets.includes(cfg.vars.GH_STALENESS_WORKFLOW));

chk("uptime.yml stays on the five-minute trigger",
	sched["*/5 * * * *"] === "uptime.yml");

// The status page fetches history/summary.json and the graphs PNGs from
// raw.githubusercontent at RUNTIME, so site.yml only rebuilds the Svelte shell and
// does not need an hourly dispatch. Verified against the live DOM, 2026-09-02.
chk("site.yml is NOT dispatched (its output is not what goes stale)",
	!allTargets.includes("site.yml"));

// summary.yml writes the file the page reads, so it must run AFTER the two that
// refresh the data it summarises.
const hourly = Object.entries(byMinute)
	.sort((a, b) => Number(a[0]) - Number(b[0]))
	.map((x) => x[1]);
chk(`hourly order is ${hourly.join(" -> ")} (summary last, it reads the others' output)`,
	hourly[hourly.length - 1] === "summary.yml");

console.log(fail ? `\n  ${fail} check(s) FAILED` : "\n  all passed");
process.exit(fail ? 1 : 0);
