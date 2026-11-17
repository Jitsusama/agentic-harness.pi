/**
 * Judging the pre-flight's X check (15d): a fenced command reaches
 * neither of X's sockets, the file under /tmp/.X11-unix nor the abstract
 * one, while outside the fence the same probe shows which there are.
 * xwayland-satellite bridges the clipboard to X, so an X socket reached
 * inside would read a copy the clipboard door refuses (ISXEG8, 120e6f5d).
 */

import { describe, expect, it } from "vitest";
import { xDisplayJudged } from "../../../../lib/internal/fence/fence-preflight-desktop.ts";

const BOTH_REACHED = "connected file\nconnected abstract\n";
const BOTH_REFUSED = "refused file ENOENT\nrefused abstract EPERM\n";

describe("judging whether X's sockets stay out of the fence", () => {
	it("passes when outside reaches both and inside reaches neither", () => {
		const verdict = xDisplayJudged(BOTH_REACHED, BOTH_REFUSED);
		expect(verdict.outcome, verdict.said).toBe("passed");
		expect(verdict.said, "names what was refused").toContain("abstract");
	});

	it("fails naming the socket a fenced command reached", () => {
		const verdict = xDisplayJudged(
			BOTH_REACHED,
			"refused file ENOENT\nconnected abstract\n",
		);
		expect(verdict.outcome, verdict.said).toBe("failed");
		expect(verdict.said, "names the abstract socket").toContain("abstract");
	});

	it("passes, saying so, where no X server runs to reach", () => {
		const verdict = xDisplayJudged(
			"refused file ENOENT\nrefused abstract ECONNREFUSED\n",
			BOTH_REFUSED,
		);
		expect(verdict.outcome, verdict.said).toBe("passed");
		expect(verdict.said, "says nothing listened").toContain("no X server");
	});

	it("fails when the probe said nothing inside, rather than reading silence as refused", () => {
		const verdict = xDisplayJudged(BOTH_REACHED, "");
		expect(verdict.outcome, verdict.said).toBe("failed");
	});
});
