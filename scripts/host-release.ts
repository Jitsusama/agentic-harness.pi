/**
 * Release hosted conversations back to plain pi (host/cutover/release.ts):
 * each closes itself once nothing holds it and its host drops it, and
 * the launcher opens it in plain pi from the same file the moment it
 * has gone, as Reopen Them All does, unless a window viewing it carried
 * it on first. One the launcher won't take waits in its Sessions to
 * Reopen. What only the host held goes in each one's quest journal.
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-release.ts (ADDR|SESSION ...|--all) [--deadline MINUTES] [--offer]
 *
 * Names are addresses or session ids; --all releases every conversation
 * the realm's two hosts hold. --deadline is how long to wait for busy
 * ones, 45 minutes unless said. At the deadline, or on Ctrl-C or
 * SIGTERM, the move of each still held is called off, so it stays in its
 * host rather than leave later with nothing to open it; run it again for
 * those. --offer only offers each in Sessions to Reopen, opening none.
 * Exits 0 when every one named was released, 1 otherwise.
 */

import { parseArgs } from "node:util";
import { releaseFacts } from "../host/cutover/machine.ts";
import { type Opened, releaseBack } from "../host/cutover/release.ts";
import { hostRealm } from "../host/service/address.ts";

const DEFAULT_DEADLINE_MINUTES = 45;
const MINUTE_MS = 60_000;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		all: { type: "boolean", default: false },
		deadline: { type: "string", default: String(DEFAULT_DEADLINE_MINUTES) },
		offer: { type: "boolean", default: false },
	},
});

if (!values.all && positionals.length === 0) {
	throw new Error(
		"Name the conversations to release, by address or session id, or pass --all.",
	);
}

const facts = releaseFacts({ realm: hostRealm(process.env) });
const minutes = Number(values.deadline);
const deadline =
	Date.now() +
	(Number.isFinite(minutes) && minutes > 0
		? minutes
		: DEFAULT_DEADLINE_MINUTES) *
		MINUTE_MS;
// A stop ends the wait as the deadline does, calling off what is left.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		facts.say(`${signal}: calling off the moves still waiting`);
		stop.abort();
	});
}
const report = await releaseBack(
	values.all ? "all" : positionals,
	facts,
	deadline,
	{ reopen: !values.offer, stop: stop.signal },
);
const count = (opened: Opened) =>
	report.released.filter((one) => one.opened === opened).length;
facts.say(
	[
		`${report.released.length} released: ${count("launcher")} reopened by the launcher, ${count("window")} carried on in their windows, ${count("offered")} offered in Sessions to Reopen.`,
		...report.released
			.filter((one) => !one.journaled)
			.map(
				(one) =>
					`not journaled: ${one.address}, ${one.quest ? `no README for ${one.quest}` : "no quest"}`,
			),
		...report.waiting.map(
			(one) =>
				`called off, still hosted: ${one.address}${one.holds ? `, ${one.holds}` : ""}`,
		),
		...report.lost.map(
			(one) => `closed without a note, so not offered: ${one}`,
		),
		...report.unknown.map((one) => `no host holds ${one}`),
	].join("\n"),
);
process.exitCode =
	report.waiting.length + report.lost.length + report.unknown.length === 0
		? 0
		: 1;
