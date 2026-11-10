/**
 * Release hosted conversations back to plain pi (host/cutover/release.ts):
 * each closes itself once nothing holds it, its host drops it, and the
 * launcher's Sessions to Reopen offers it, so Reopen Them All opens each
 * in plain pi from the same file. What only the host held goes in each
 * one's quest journal. Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-release.ts (ADDR|SESSION ...|--all) [--deadline MINUTES]
 *
 * Names are addresses or session ids; --all releases every conversation
 * the realm's two hosts hold. --deadline is how long to wait for busy
 * ones, 45 minutes unless said; run it again for those still held.
 * Exits 0 when every one named was released and offered, 1 otherwise.
 */

import { parseArgs } from "node:util";
import { releaseFacts } from "../host/cutover/machine.ts";
import { releaseBack } from "../host/cutover/release.ts";
import { hostRealm } from "../host/service/address.ts";

const DEFAULT_DEADLINE_MINUTES = 45;
const MINUTE_MS = 60_000;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		all: { type: "boolean", default: false },
		deadline: { type: "string", default: String(DEFAULT_DEADLINE_MINUTES) },
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
const report = await releaseBack(
	values.all ? "all" : positionals,
	facts,
	deadline,
);
facts.say(
	[
		`${report.released.length} released; Sessions to Reopen offers them.`,
		...report.released
			.filter((one) => !one.journaled)
			.map(
				(one) =>
					`not journaled: ${one.address}, ${one.quest ? `no README for ${one.quest}` : "no quest"}`,
			),
		...report.waiting.map(
			(one) => `still held: ${one.address}${one.holds ? `, ${one.holds}` : ""}`,
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
