/**
 * Upptime check dispatcher — Pteridobase#869.
 *
 * WHY THIS EXISTS. Upptime's uptime check is driven by a five-minute cron in
 * .github/workflows/uptime.yml. (The cron literal is deliberately not written out in
 * this comment: it begins with the two characters that END a block comment, so writing
 * it here closes the docblock and the rest parses as code. It cost a build to find.)
 *
 * GitHub drops scheduled workflow events under load, and
 * measurement on this repo put actual delivery at 2.0-2.9% of the configured firings,
 * with a longest observed gap of 271.6 min (4h 32m). That is GitHub's base rate rather
 * than our misconfiguration: Upptime's own reference deployment manages 8.7%, and
 * across 299 consecutive intervals there not one was under 7.5 minutes.
 *
 * The consequence is not academic. UptimeRobot covers hard-down at a genuine 5 minutes,
 * but a site serving HTTP 200 at 8-16 seconds is invisible to it — and that is exactly
 * the failure Pteridobase has actually had, twice (1 and 2 September 2026). Catching it
 * is Upptime's `maxResponseTime` alone, so Upptime's cadence IS the detection latency
 * for that whole class.
 *
 * WHY workflow_dispatch RATHER THAN repository_dispatch. uptime.yml accepts both.
 * repository_dispatch is Upptime's documented path and needs no `ref` — but GitHub
 * returns 204 No Content even when the `event_type` matches no workflow at all, so a
 * typo dispatches into the void with nothing to observe. #869 exists because a monitor
 * failed silently for hours; picking the endpoint that cannot report its own
 * misconfiguration would have been an odd way to fix that. workflow_dispatch names the
 * workflow file and the ref, and errors when either is wrong.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not perform the check. It asks GitHub to
 * run Upptime's own workflow, so the status page, history and notifications stay
 * exactly as Upptime defines them. A Worker that curled the sites itself would be a
 * second, divergent implementation of something that already works.
 */

const USER_AGENT = "pteridobase-uptime-dispatcher (+https://github.com/Knavesdied/Pteridobase/issues/869)";

/**
 * A dispatch that SUCCEEDS while producing no runs is the exact shape of the bug that
 * led here — Upptime logged "Sending notification" for weeks while its email channel
 * did not exist, because the log recorded the attempt and never the outcome.
 *
 * So this checks the EFFECT before acting: if the newest run of the target workflow is
 * older than the threshold, something between us and a running check is broken, and
 * that is worth an error even though our own POSTs are returning 204.
 */
async function newestRunAgeMinutes(env, headers) {
	const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}` +
		`/actions/workflows/${env.GH_WORKFLOW}/runs?per_page=1`;
	const res = await fetch(url, { headers });
	if (!res.ok) {
		// Not fatal: the staleness check is corroboration, not the job. Say so and carry
		// on to the dispatch, which is what actually keeps checks flowing.
		console.warn(`staleness check unavailable: HTTP ${res.status} from runs API`);
		return null;
	}
	const body = await res.json();
	const runs = body.workflow_runs || [];
	if (runs.length === 0) {
		return null;
	}
	const created = Date.parse(runs[0].created_at);
	if (Number.isNaN(created)) {
		return null;
	}
	return (Date.now() - created) / 60000;
}

export default {
	async scheduled(event, env, ctx) {
		const missing = ["GH_OWNER", "GH_REPO", "GH_WORKFLOW", "GH_REF", "GH_TOKEN"]
			.filter((k) => !env[k]);
		if (missing.length) {
			// Throwing marks the invocation failed in Cloudflare's observability. A
			// console line alone would be a silent failure wearing a log message, which
			// is the class of defect this Worker exists to avoid.
			throw new Error(`dispatcher misconfigured: missing ${missing.join(", ")}`);
		}

		const headers = {
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": USER_AGENT,
			"Authorization": `Bearer ${env.GH_TOKEN}`,
		};

		const staleAfter = Number(env.STALE_AFTER_MIN || 20);
		const age = await newestRunAgeMinutes(env, headers);
		if (age !== null && age > staleAfter) {
			console.error(
				`no ${env.GH_WORKFLOW} run for ${age.toFixed(1)} min (threshold ${staleAfter}) — ` +
				`dispatches may be succeeding without producing runs`
			);
		}

		const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}` +
			`/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ ref: env.GH_REF }),
		});

		// 204 No Content is the documented success. Anything else is a real failure and
		// must not be swallowed: 401/403 means the token is wrong or expired, 404 means
		// the workflow file or repo path is wrong (which is what #865's org move will
		// cause if the vars are not repointed), 422 means the ref does not exist.
		if (res.status !== 204) {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`dispatch failed: HTTP ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`
			);
		}

		console.log(
			`dispatched ${env.GH_WORKFLOW}@${env.GH_REF} ` +
			`(newest prior run ${age === null ? "unknown" : age.toFixed(1) + " min old"})`
		);
	},

	/**
	 * No HTTP route is configured, so this is unreachable in production. It exists for
	 * `wrangler dev`, where hitting /__scheduled is how the cron handler is exercised
	 * locally — and because a Worker with no fetch handler returns an opaque error if
	 * anything ever does reach it.
	 */
	async fetch() {
		return new Response(
			"Upptime check dispatcher. No HTTP interface; runs on a cron trigger.\n",
			{ status: 200, headers: { "Content-Type": "text/plain" } }
		);
	},
};
