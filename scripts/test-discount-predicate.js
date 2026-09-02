#!/usr/bin/env node
/**
 * Pole tests for .github/workflows/discount-degraded.yml
 *
 * WHY THIS EXISTS. That workflow strips the `status` label, and in Upptime the
 * `status` label IS the downtime ledger - `calculate-uptime.ts` derives every
 * uptime figure from issues carrying it. So a predicate that fires one case too
 * wide does not mis-tag anything: it DELETES a real outage from the day, week,
 * month and year figures at once, with no second ledger to restore it from and
 * nothing on the page to show it ever happened.
 *
 * The dangerous direction is therefore firing on a `is down` incident. That is
 * the pole this file exists to pin, and a test that only checked "does it fire
 * on a degraded issue?" would pass against a predicate that fires on both.
 *
 * IT READS THE REAL WORKFLOW. The expression is extracted from the committed
 * YAML and evaluated, rather than restated here - two copies of one rule is how
 * they drift. If the predicate is ever rewritten into a shape this cannot parse,
 * the run FAILS rather than passing over an empty analysis.
 *
 * BLIND SPOT, stated rather than discovered later: this implements GitHub's
 * `contains()` for exactly the two operand types the workflow uses - an array of
 * label names, and the title string - joined by `&&`. It is not the GitHub
 * expression evaluator. It cannot catch a mistake in how GitHub resolves
 * `labels.*.name`, only a mistake in the predicate written against it.
 *
 * Run: node scripts/test-discount-predicate.js
 */

const fs = require("fs");
const path = require("path");

const wf = path.join(__dirname, "..", ".github", "workflows", "discount-degraded.yml");
const text = fs.readFileSync(wf, "utf8");

// --- extract the real `if:` expression ---------------------------------------
// Line-based, not one regex: a `(?:\s+\S.*\n)+` continuation swallows the whole
// rest of the file, because every later line in a workflow is indented too. The
// block ends at the first line back at or below the `if:` key's own indentation.
const lines = text.split("\n");
const startIdx = lines.findIndex((l) => /^\s*if:\s*>-\s*$/.test(l));
if (startIdx === -1) {
	console.error("FATAL: could not find an `if: >-` block in " + wf);
	console.error("The predicate may have been rewritten. This test analysed NOTHING;");
	console.error("failing rather than reporting a pass over an empty expression.");
	process.exit(1);
}
const keyIndent = lines[startIdx].match(/^(\s*)/)[1].length;
const body = [];
for (let i = startIdx + 1; i < lines.length; i++) {
	const l = lines[i];
	if (!l.trim()) break;
	if (l.match(/^(\s*)/)[1].length <= keyIndent) break;
	body.push(l.trim());
}
const expr = body.join(" ");
if (!expr) {
	console.error("FATAL: the `if:` block is empty.");
	process.exit(1);
}
console.log("  predicate under test:\n    " + expr + "\n");

// --- parse it into contains() terms ------------------------------------------
const TERM = /contains\(\s*([A-Za-z0-9_.*]+)\s*,\s*'([^']*)'\s*\)/g;
const terms = [...expr.matchAll(TERM)].map((t) => ({ operand: t[1], needle: t[2] }));
if (terms.length < 2) {
	console.error(`FATAL: expected at least 2 contains() terms, parsed ${terms.length}.`);
	process.exit(1);
}
if (!expr.includes("&&") || expr.includes("||")) {
	console.error("FATAL: expected the terms joined by && only. Got: " + expr);
	process.exit(1);
}

function evaluate(issue) {
	return terms.every(({ operand, needle }) => {
		if (operand === "github.event.issue.labels.*.name") return issue.labels.includes(needle);
		if (operand === "github.event.issue.title") return issue.title.includes(needle);
		throw new Error(`unmapped operand ${operand} - extend this test rather than ignoring it`);
	});
}

// --- the poles ---------------------------------------------------------------
// Titles are upstream's exact templates (uptime-monitor src/update.ts L648-651):
//   down     -> `🛑 ${site.name} is down`
//   degraded -> `⚠️ ${site.name} has degraded performance`
const CASES = [
	{ fire: true,  title: "⚠️ Pteridobase has degraded performance",     labels: ["status", "pteridobase"],     why: "the case it exists for" },
	{ fire: true,  title: "⚠️ Pteridobase API has degraded performance", labels: ["status", "pteridobase-api"], why: "same, second monitor" },

	{ fire: false, title: "🛑 Pteridobase is down",                      labels: ["status", "pteridobase"],     why: "REAL OUTAGE - must keep its label and keep counting" },
	{ fire: false, title: "🛑 Exotic Fern Group is down",                labels: ["status", "exotic-fern-group"], why: "REAL OUTAGE, second monitor" },

	{ fire: false, title: "⚠️ Pteridobase has degraded performance",     labels: ["pteridobase"],               why: "label already stripped - a re-fired close event is a no-op" },
	{ fire: false, title: "Scheduled maintenance: DB upgrade",           labels: ["maintenance"],               why: "maintenance issues are a different mechanism" },
	{ fire: false, title: "WP-Cron never runs on beta",                  labels: ["status"],                    why: "a human issue that happens to carry the label" },
	{ fire: false, title: "Investigate degraded performance last week",  labels: ["status"],                    why: "prose mentioning degradation is not an incident" },

	// A site NAMED so that the naive inverse gate ("not a down issue") breaks.
	{ fire: false, title: "🛑 Downdetector Mirror is down",              labels: ["status", "downdetector-mirror"], why: "outage whose name contains 'down'" },
	{ fire: true,  title: "⚠️ Downdetector Mirror has degraded performance", labels: ["status", "downdetector-mirror"], why: "degraded, name contains 'down' - positive gate still right" },
];

let fail = 0;
for (const c of CASES) {
	const got = evaluate({ title: c.title, labels: c.labels });
	const ok = got === c.fire;
	if (!ok) fail++;
	console.log(
		`  ${ok ? "PASS" : "FAIL"}  ${c.fire ? "fires    " : "does not "} ${JSON.stringify(c.title).slice(0, 46).padEnd(48)} ${c.why}`
	);
}

console.log(fail ? `\n  ${fail} case(s) FAILED` : `\n  all ${CASES.length} cases passed`);
process.exit(fail ? 1 : 0);
