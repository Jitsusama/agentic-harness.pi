/**
 * Take up one session's move into a host, asked with /host in its own
 * window (host/cutover/take-up.ts): /host starts it on its own before
 * the move, and it adopts the session's log into the host its note
 * names once its pi has gone. Node runs it as it stands:
 *
 *   node scripts/host-take-up.ts --session ID --to attended|background
 *     [--deadline MINUTES]
 *
 * It ends once the host holds the session, the move is called off, the
 * pi goes without a note, or the deadline passes, 60 minutes unless
 * said, since a move waits for a run and for the window to go quiet.
 * Exits 0 when the host took the session or the move was called off,
 * 1 otherwise.
 */

import { parseArgs } from "node:util";
import { takeUpFacts } from "../host/cutover/machine.ts";
import { takeUp } from "../host/cutover/take-up.ts";
import { hostRealm } from "../host/service/address.ts";

const DEFAULT_DEADLINE_MINUTES = 60;
const MINUTE_MS = 60_000;

const { values } = parseArgs({
	options: {
		session: { type: "string" },
		to: { type: "string" },
		deadline: { type: "string", default: String(DEFAULT_DEADLINE_MINUTES) },
	},
});

const session = values.session;
if (
	session === undefined ||
	!["attended", "background"].includes(values.to ?? "")
)
	throw new Error(
		"Usage: host-take-up.ts --session ID --to attended|background [--deadline MINUTES]",
	);
const minutes = Number(values.deadline);
const deadline =
	Date.now() +
	(Number.isFinite(minutes) && minutes > 0
		? minutes
		: DEFAULT_DEADLINE_MINUTES) *
		MINUTE_MS;
const facts = takeUpFacts({
	realm: hostRealm(process.env),
	claimer: process.pid,
});
facts.say(
	`${new Date().toISOString()} taking up ${session}'s move to the ${values.to} host`,
);
const ended = await takeUp(session, facts, deadline);
facts.say(`${new Date().toISOString()} ${session}: ${ended}`);
process.exitCode = ended === "moved" || ended === "called off" ? 0 : 1;
