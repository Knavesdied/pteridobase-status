#!/usr/bin/env node
/**
 * Pole tests for .github/workflows/pteridobase-banner.yml
 *
 * WHY THIS EXISTS. That workflow forwards an issue's open and close to
 * pteridobase.org, which renders a site-wide banner from it. Its predicate
 * decides WHICH issues reach the site. The dangerous direction is firing on
 * Exotic Fern Group's incidents: those carry Upptime's `status` label like
 * every other monitor's, and a predicate keyed on `status` would banner
 * Pteridobase for an outage on a different website. The site has its own gate
 * (it reads the title and the monitor label), so an over-wide predicate costs
 * a wasted run rather than a wrong banner; an over-NARROW one costs a missed
 * incident, which is the thing the whole mechanism exists to prevent. Both
 * directions are pinned below.
 *
 * IT READS THE REAL WORKFLOW, as test-discount-predicate.js does, so the
 * expression under test is the committed one. If the predicate is rewritten
 * into a shape this cannot parse, the run FAILS rather than passing over an
 * empty analysis.
 *
 * BLIND SPOT, stated: this implements GitHub's `contains()` over an array of
 * label names, joined by `||`. It is not the GitHub expression evaluator and
 * cannot catch a mistake in how GitHub resolves `labels.*.name`.
 *
 * Run: node scripts/test-banner-predicate.js
 */

const fs = require("fs");
const path = require("path");

const wf = path.join(__dirname, "..", ".github", "workflows", "pteridobase-banner.yml");
const text = fs.readFileSync(wf, "utf8");

// --- extract the real `if:` expression ---------------------------------------
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
if (!expr.includes("||") || expr.includes("&&")) {
	console.error("FATAL: expected the terms joined by || only. Got: " + expr);
	process.exit(1);
}
for (const t of terms) {
	if (t.operand !== "github.event.issue.labels.*.name") {
		console.error(`FATAL: unmapped operand ${t.operand} - extend this test rather than ignoring it`);
		process.exit(1);
	}
}
const stripped = expr.replace(TERM, "").replace(/\|\|/g, "").trim();
if (stripped) {
	console.error("FATAL: the predicate carries text this test does not model: " + JSON.stringify(stripped));
	process.exit(1);
}

function evaluate(issue) {
	return terms.some(({ needle }) => issue.labels.includes(needle));
}

// --- the poles ---------------------------------------------------------------
// Titles are upstream's exact templates (uptime-monitor src/update.ts L648-651)
// where they matter; the predicate reads only labels, so a title is context.
const CASES = [
	{ fire: true,  title: "⚠️ Pteridobase has degraded performance",     labels: ["status", "pteridobase"],       why: "the case it exists for" },
	{ fire: true,  title: "🛑 Pteridobase is down",                      labels: ["status", "pteridobase"],       why: "a real outage of the site" },
	{ fire: true,  title: "🛑 Pteridobase API is down",                  labels: ["status", "pteridobase-api"],   why: "the API monitor" },
	{ fire: true,  title: "⚠️ Pteridobase has degraded performance",     labels: ["pteridobase"],                 why: "after discount-degraded stripped `status` - the close must still reach the site" },
	{ fire: true,  title: "[Scheduled Maintenance] Site down for Maintenance", labels: ["maintenance"],          why: "a maintenance window - one issue silences the monitor and posts the banner" },
	{ fire: true,  title: "Investigate slow pages last week",            labels: ["pteridobase"],                 why: "reaches the site, which IGNORES it on the title - the site's gate, not this one" },

	{ fire: false, title: "🛑 Exotic Fern Group is down",                labels: ["status", "exotic-fern-group"], why: "ANOTHER SITE'S OUTAGE - must never banner Pteridobase" },
	{ fire: false, title: "⚠️ Exotic Fern Group has degraded performance", labels: ["status", "exotic-fern-group"], why: "same, degraded" },
	{ fire: false, title: "WP-Cron never runs on beta",                  labels: ["status"],                      why: "a human issue that happens to carry the ledger label" },
	{ fire: false, title: "Typo on the status page",                     labels: ["bug"],                         why: "an ordinary issue" },
	{ fire: false, title: "Unlabelled report",                           labels: [],                              why: "no labels at all" },
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
