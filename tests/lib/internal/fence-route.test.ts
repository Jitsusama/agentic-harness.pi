/**
 * A fenced command refused something that isn't git's, a pass kept or a
 * write outside what the session holds, is told why and where to go,
 * and the refusal is counted (ISXEG8 [2fc080c2], [6e4de1de]).
 */

import { describe, expect, it, vi } from "vitest";
import {
	KEEP_ROUTE,
	READ_ONLY_ROUTE,
	routedKeep,
	routedReadOnly,
} from "../../../lib/internal/fence-route.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

// ISXEG8 [2fc080c2], 15 November: a build run inside through direnv
// passed, and its pass couldn't be kept, naming no call that keeps one.
describe("a fenced build whose pass couldn't be kept", () => {
	it("is told the plain call that keeps it, and counted once", () => {
		const record = vi.fn();
		const said =
			"nix-offload: couldn't keep what passed at 9fd9b340df9e: couldn't reach /run/nix-offload-keep.sock: Permission denied (os error 13)";
		expect(routedKeep(text(said), record)).toEqual(
			text(`${said}\n\n${KEEP_ROUTE}`),
		);
		expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		expect(KEEP_ROUTE, "the route doesn't name the call").toContain(
			"nix-offload there --changed",
		);
	});

	it("leaves a build that kept its pass as it is", () => {
		const record = vi.fn();
		expect(
			routedKeep(text("there 0\nkept what passed at 9fd9b340df9e"), record),
		).toBeUndefined();
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});

// ISXEG8 [6e4de1de], 15 November: a write outside the held trees said
// only "Read-only file system", naming no way through.
describe("a fenced write outside what the session holds", () => {
	it("is told where it may write, and counted once", () => {
		const record = vi.fn();
		for (const said of [
			"touch: cannot touch '/h/src/core.nix/.fence-probe': Read-only file system",
			"bash: /h/notes/x: Read-only file system",
		]) {
			record.mockClear();
			expect(routedReadOnly(text(said), record), said).toEqual(
				text(`${said}\n\n${READ_ONLY_ROUTE}`),
			);
			expect(record, "it wasn't counted").toHaveBeenCalledTimes(1);
		}
		for (const route of ["work tree", "$TMPDIR"])
			expect(READ_ONLY_ROUTE, `the route doesn't name ${route}`).toContain(
				route,
			);
	});

	it("leaves a write that worked as it is", () => {
		const record = vi.fn();
		expect(routedReadOnly(text("wrote 12 bytes"), record)).toBeUndefined();
		expect(record, "other output was counted").not.toHaveBeenCalled();
	});
});
