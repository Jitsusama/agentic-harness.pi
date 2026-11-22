/**
 * A records folder lies closed only where no other account could put
 * its own in its place: not below pi's state, where unclosedIn walks,
 * nor above it, where a folder another may write lets them rename pi's
 * state away. Joel's own homes pass (/, /home and the home are root's
 * or his, written by no other); a sticky folder such as /tmp passes
 * too, since there no other may rename what isn't theirs.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	throughHome,
	unclosedIn,
} from "../../../host/engine/closed-folders.ts";

let made: string | undefined;
afterEach(() => {
	if (made) rmSync(made, { recursive: true, force: true });
	made = undefined;
});

/** A home under a fresh folder, holding pi's state and a records folder in it. */
function laid(): { home: string; closed: string; records: string } {
	made = realpathSync(mkdtempSync(join(tmpdir(), "closed-folders-")));
	chmodSync(made, 0o755);
	const home = join(made, "home");
	const closed = join(home, ".local", "state", "pi");
	const records = join(closed, "hosts");
	mkdirSync(records, { recursive: true, mode: 0o755 });
	return { home, closed, records };
}

it("names a folder closed where each folder above and below pi's state is closed to others", () => {
	const { records, closed } = laid();
	expect(unclosedIn(records, closed)).toBeUndefined();
});

it("names a folder unclosed where another account may write a folder above pi's state", () => {
	const { home, records, closed } = laid();
	chmodSync(join(home, ".local"), 0o775);
	expect(unclosedIn(records, closed)).toBe(
		`${join(home, ".local")} may be written by another account`,
	);
});

it("spells pi's state through a home's link only where no other may swap the link", () => {
	const { home, closed } = laid();
	const shared = join(home, "..", "shared");
	mkdirSync(shared, { mode: 0o755 });
	symlinkSync(home, join(shared, "joel"));
	const linked = join(shared, "joel");
	const state = join(linked, ".local", "state", "pi");
	expect(throughHome(state, linked), "held").toBe(closed);
	chmodSync(shared, 0o775);
	expect(throughHome(state, linked), "open to the group").toBe(state);
	expect(unclosedIn(join(state, "hosts"), throughHome(state, linked))).toBe(
		`${state} lies past a link`,
	);
	chmodSync(shared, 0o1775);
	expect(throughHome(state, linked), "sticky").toBe(closed);
});

it("names a folder closed where a folder above is sticky, as /tmp is", () => {
	const { home, records, closed } = laid();
	chmodSync(home, 0o1777);
	expect(unclosedIn(records, closed)).toBeUndefined();
});
