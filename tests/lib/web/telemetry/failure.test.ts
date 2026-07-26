/**
 * What a caller is told when the page never arrived.
 */

import { describe, expect, it } from "vitest";
import { failureText } from "../../../../lib/web/telemetry/failure.js";

describe("saying what the network said", () => {
	it("keeps Chrome's code and drops the rest", () => {
		// The code is the searchable, recognisable part; the url and
		// the wait condition push it off the end of the line.
		const said = failureText(
			new Error(
				"net::ERR_INTERNET_DISCONNECTED at http://localhost:8731/, " +
					"waiting until networkidle2",
			),
		);
		expect(said).toBe("net::ERR_INTERNET_DISCONNECTED");
	});

	it("finds the code wherever it sits in the message", () => {
		expect(failureText(new Error("Navigation failed: net::ERR_ABORTED"))).toBe(
			"net::ERR_ABORTED",
		);
	});

	it("tidies a message that carries no code", () => {
		expect(
			failureText(new Error("Navigation timeout of 30000 ms exceeded")),
		).toBe("Navigation timeout of 30000 ms exceeded");
	});

	it("strips the driver's framing from a bare message", () => {
		expect(
			failureText("Navigation failed because the frame was detached"),
		).toBe("the frame was detached");
	});

	it("keeps only the first line, so a stack cannot follow", () => {
		expect(failureText(new Error("it broke\n  at somewhere:1:1"))).toBe(
			"it broke",
		);
	});

	it("says something even when the error says nothing", () => {
		// A failure reported with a blank reason reads like a bug in
		// the reporter rather than a fact about the network.
		expect(failureText(new Error(""))).toBe("the navigation failed");
	});

	it("copes with something thrown that is not an error", () => {
		expect(failureText({ nope: true })).toContain("object");
	});
});
