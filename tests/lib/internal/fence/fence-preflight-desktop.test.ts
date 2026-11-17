/**
 * Which niri the window check (1b) takes to be the person's session's,
 * read from what `pgrep -xa niri` lists: the one started `--session`,
 * never a client of it such as the launcher's event stream, and never
 * the shell running the check, whose own command line names the session.
 */

import { describe, expect, it } from "vitest";
import { sessionNiri } from "../../../../lib/internal/fence/fence-preflight-desktop.ts";

const STORE = "/nix/store/gx1bliq1fckl940akz1kqjl0bvcynvkm-niri-26.04/bin/niri";

describe("naming the niri running the person's session", () => {
	it("takes the one started --session over a newer client of it", () => {
		const listing = [
			`2839 ${STORE} --session`,
			`7840 ${STORE} msg --json event-stream`,
		].join("\n");
		expect(sessionNiri(listing)).toBe(STORE);
	});

	it("never takes a command that only names the session in its words", () => {
		const listing = [
			`7840 ${STORE} msg --json event-stream`,
			`9001 /bin/bash -c pgrep -f -n "niri --session"`,
		].join("\n");
		expect(sessionNiri(listing)).toBeUndefined();
	});

	it("names none when no niri runs", () => {
		expect(sessionNiri("")).toBeUndefined();
	});
});
