import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ActResult,
	BrowserSession,
} from "../../../lib/core/web/session.ts";
import { type Fixture, pageFile, serve } from "./_harness.ts";

/**
 * A page with enough structure that a target below the fold has to
 * be scrolled to, and with other elements at the positions a
 * mis-resolved hit test would land on. A live audit found every
 * such target refused as "covered", naming a paragraph that was
 * nowhere near it.
 */
const STRUCTURED = pageFile("structured.html");

describe("acting on a target that must be scrolled to", () => {
	let fixture: Fixture;
	let session: BrowserSession;

	beforeAll(async () => {
		fixture = await serve([{ path: "/", body: STRUCTURED, type: "text/html" }]);
		session = await BrowserSession.open("occlusion");
	});

	afterAll(async () => {
		await session.close();
		await fixture.close();
	});

	/**
	 * The blocker, or undefined when the act went through. Asserting
	 * on this rather than on `ok` puts the refusal's own words in the
	 * failure, which is the whole evidence: the claim is a coverage
	 * one, naming an element that is not there.
	 */
	const refusal = (result: ActResult): string | undefined =>
		"blocked" in result ? result.blocked.blocker : undefined;

	const outcome = async (): Promise<unknown> => {
		const answer = await session.evaluate(
			"document.getElementById('out').textContent",
		);
		return answer.ok ? answer.result.value : answer;
	};

	it("clicks a button below the fold on a page with structure", async () => {
		await session.navigate(fixture.url("/"));
		// The default 800 by 600 viewport, with the filler above
		// putting the target past the fold: the shape the live audit
		// reproduced. Emulating a shorter viewport instead makes the
		// target so far off screen that a different branch handles it
		// and the bug hides.

		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Deep button" },
		});

		expect(refusal(result)).toBeUndefined();
		expect(await outcome()).toBe("clicked");
	});

	it("does not call a shadow host an occluder of its own content", async () => {
		// No emulation: the host sits within the default viewport, so
		// nothing scrolls and the hit test runs on its own centre,
		// which is where the host masks its own content.
		await session.navigate(fixture.url("/"));

		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Inside a shadow root" },
		});

		expect(refusal(result)).toBeUndefined();
		expect(await outcome()).toBe("shadow clicked");
	});
});
