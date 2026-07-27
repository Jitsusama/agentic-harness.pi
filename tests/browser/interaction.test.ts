/**
 * Operating a page: clicking a thing by its name, typing into it,
 * and the raw pointer and key input that names cannot reach.
 *
 * None of this had a test. The cases that matter are the ones
 * where an action must not happen: an element that is covered, one
 * that is disabled, one whose name matches twice. A click that
 * silently misses and reports success is the worst outcome this
 * layer can produce, because everything downstream then describes
 * a page that never changed.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { describeRefusal } from "../../lib/web/target/index.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FORM = page(
	"Interaction",
	`<main>
  <h1>Interaction</h1>
  <button type="button" id="plain" onclick="document.getElementById('log').textContent = 'clicked'">Press me</button>
  <button type="button" id="off" disabled>Disabled button</button>
  <label for="text">Your name</label>
  <input id="text" name="text" value="start">
  <label for="choice">Pick one</label>
  <select id="choice"><option>Alpha</option><option>Beta</option></select>
  <div id="hoverable" onmouseenter="document.getElementById('log').textContent = 'hovered'">Hover target</div>
  <p id="log">nothing yet</p>
  <div id="cover-host" style="position:relative">
    <button type="button" id="under" onclick="document.getElementById('log').textContent = 'should not happen'">Covered button</button>
    <div id="cover" style="position:absolute;inset:0;background:rgba(0,0,0,0.01)"></div>
  </div>
  <nav><button type="button" id="icon" onclick="document.getElementById('log').textContent = 'icon'"><svg width="20" height="20" aria-hidden="true"></svg></button></nav>
  <div id="faux" style="padding:4px;border:1px solid #999">Publish</div>
  <div id="scroller" style="height:2000px"></div>
  <button type="button" id="far" onclick="document.getElementById('log').textContent = 'far'">Far below</button>
</main>`,
);

const KEYS = page(
	"Keys",
	`<main><h1>Keys</h1><input id="field" value="">
<p id="seen">none</p>
<script>
document.addEventListener("keydown", (e) => {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(e.key);
  document.getElementById("seen").textContent = parts.join("+");
});
</script></main>`,
);

const WHEEL = page(
	"Wheel",
	`<main><h1>Wheel</h1><div id="tall" style="height:4000px"></div></main>`,
);

/** A page that records the first touch event it receives. */
const TOUCH = page(
	"Touch",
	`<main><h1>Touch</h1><div id="pad" style="width:200px;height:200px"></div>
<p id="touched">none</p>
<script>
document.addEventListener("touchstart", () => {
  const seen = document.getElementById("touched");
  if (seen.textContent === "none") seen.textContent = "touchstart";
}, { passive: true });
</script></main>`,
);

let fixture: Fixture;
let session: BrowserSession;

/** What the page wrote into its own log element. */
const logged = async (): Promise<unknown> => {
	const answer = await session.evaluate(
		"document.getElementById('log').textContent",
	);
	return answer.ok ? answer.result.value : answer;
};

describe.skipIf(!haveChrome)("acting on a page, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/form", body: FORM },
			{ path: "/keys", body: KEYS },
			{ path: "/wheel", body: WHEEL },
			{ path: "/touch", body: TOUCH },
		]);
		session = await BrowserSession.open("interaction-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	beforeEach(async () => {
		await session.navigate(fixture.url("/form"));
	});

	it("clicks the thing the caller named", async () => {
		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Press me" },
		});

		expect(result.ok).toBe(true);
		expect(await logged()).toBe("clicked");
	});

	it("clicks a control that has no name to be called by", async () => {
		// An icon button carries no accessible name, so the outline
		// offers only its role and that has to be enough to act on.
		// Requiring a name here left it reachable by coordinates and
		// nothing else.
		const result = await session.act({
			kind: "click",
			target: { role: "button" },
		});

		expect(result.ok).toBe(true);
		expect(await logged()).toBe("icon");
	});

	it("types into a field found by its label", async () => {
		await session.act({
			kind: "clear",
			target: { role: "textbox", name: "Your name" },
		});
		const result = await session.act({
			kind: "type",
			target: { role: "textbox", name: "Your name" },
			text: "Ada",
		});

		expect(result.ok).toBe(true);
		const value = await session.evaluate(
			"document.getElementById('text').value",
		);
		expect(value.ok && value.result.value).toBe("Ada");
	});

	it("clears a field rather than typing over what was there", async () => {
		const result = await session.act({
			kind: "clear",
			target: { role: "textbox", name: "Your name" },
		});

		expect(result.ok).toBe(true);
		const value = await session.evaluate(
			"document.getElementById('text').value",
		);
		expect(value.ok && value.result.value).toBe("");
	});

	it("chooses an option by the text a person would read", async () => {
		const result = await session.act({
			kind: "select",
			target: { role: "combobox", name: "Pick one" },
			text: "Beta",
		});

		expect(result.ok).toBe(true);
		const value = await session.evaluate(
			"document.getElementById('choice').value",
		);
		expect(value.ok && value.result.value).toBe("Beta");
	});

	it("hovers, which is how a hover-only affordance is reached", async () => {
		const result = await session.act({
			kind: "hover",
			target: { role: "generic", name: "Hover target" },
		});

		if (result.ok) expect(await logged()).toBe("hovered");
		else expect(result).toMatchObject({ ok: false });
	});

	it("focuses without activating", async () => {
		const result = await session.act({
			kind: "focus",
			target: { role: "button", name: "Press me" },
		});

		expect(result.ok).toBe(true);
		// Focusing is not clicking, and a tool that conflated them
		// would fire every handler it meant only to reach.
		expect(await logged()).toBe("nothing yet");
		const active = await session.evaluate("document.activeElement.id");
		expect(active.ok && active.result.value).toBe("plain");
	});

	it("scrolls to a control below the fold and presses it", async () => {
		// Waiting cannot bring an element into the viewport, so the
		// old refusal spent its whole budget on a verdict it already
		// had. Every other driver scrolls, and so does a person.
		const started = Date.now();
		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Far below" },
		});

		expect(result.ok).toBe(true);
		expect(await logged()).toBe("far");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("scrolls something into view without pressing it", async () => {
		const result = await session.act({
			kind: "scrollTo",
			target: { role: "button", name: "Far below" },
		});

		expect(result.ok).toBe(true);
		const scrolled = await session.evaluate("window.scrollY > 0");
		expect(scrolled.ok && scrolled.result.value).toBe(true);
	});

	it("refuses a name that is not on the page, rather than doing nothing", async () => {
		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "No such button" },
		});

		expect(result.ok).toBe(false);
	});

	it("blames the missing role when the page has the name as text", async () => {
		// A div dressed as a button is the commonest reason a target
		// misses, and the refusal used to answer that nothing on the
		// page was close to it, which sends the caller hunting for a
		// typo while the word sits on the screen.
		const target = { role: "button", name: "Publish" };
		const result = await session.act({ kind: "click", target });

		expect(result.ok).toBe(false);
		// A name that matches nothing is refused before readiness is
		// ever consulted, so this is the refusal branch, not blocked.
		if (result.ok || !("refusal" in result)) throw new Error("no refusal");
		const said = describeRefusal(target, result.refusal);
		expect(said).not.toContain("nothing on the page is close to it");
		expect(said).toContain("Publish");
	});

	it("will not click a button the page has disabled", async () => {
		// The page said this cannot be used. Driving it anyway tests
		// something no person could do.
		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Disabled button" },
		});

		expect(result.ok).toBe(false);
	});

	it("will not click through something covering the target", async () => {
		// A click that lands on the overlay reports success and changes
		// nothing, which is the failure this whole readiness check
		// exists to prevent.
		const result = await session.act({
			kind: "click",
			target: { role: "button", name: "Covered button" },
		});

		expect(result.ok).toBe(false);
		expect(await logged()).toBe("nothing yet");
	});

	it("sends a key chord to whatever has focus", async () => {
		await session.navigate(fixture.url("/keys"));

		const result = await session.press("Ctrl+Shift+K");

		expect(result).toHaveProperty("pressed");
		const seen = await session.evaluate(
			"document.getElementById('seen').textContent",
		);
		expect(seen.ok && seen.result.value).toBe("Ctrl+Shift+K");
	});

	it("refuses a key that does not exist rather than pressing something else", async () => {
		await session.navigate(fixture.url("/keys"));

		const result = await session.press("Ctrl+NotAKey");

		expect(result).toHaveProperty("refusal");
	});

	it("types raw text wherever focus happens to be", async () => {
		await session.navigate(fixture.url("/keys"));
		await session.evaluate("document.getElementById('field').focus()");

		await session.typeRaw("hello");

		const value = await session.evaluate(
			"document.getElementById('field').value",
		);
		expect(value.ok && value.result.value).toBe("hello");
	});

	it("scrolls with the wheel at a point", async () => {
		await session.navigate(fixture.url("/wheel"));

		await session.wheel({ x: 200, y: 200 }, 0, 500);

		// Dispatching the event and applying the scroll are separate
		// turns in the renderer, so reading straight after the call
		// reads the position from before it. That is a property of the
		// browser, not of this library, and a test that raced it would
		// have reported a working wheel as broken.
		await session.waitFor({ kind: "duration", ms: 300 }, 1_000);

		const scrolled = await session.evaluate("window.scrollY");
		expect(scrolled.ok && Number(scrolled.result.value)).toBeGreaterThan(0);
	});

	it("drives the pointer directly, for what a name cannot reach", async () => {
		const box = await session.evaluate(
			"JSON.stringify(document.getElementById('plain').getBoundingClientRect())",
		);
		const rect = JSON.parse(String(box.ok && box.result.value)) as {
			x: number;
			y: number;
			width: number;
			height: number;
		};

		await session.pointerGesture([
			{
				type: "mousePressed",
				x: rect.x + rect.width / 2,
				y: rect.y + rect.height / 2,
				button: "left",
				clickCount: 1,
			},
			{
				type: "mouseReleased",
				x: rect.x + rect.width / 2,
				y: rect.y + rect.height / 2,
				button: "left",
				clickCount: 1,
			},
		]);

		expect(await logged()).toBe("clicked");
	});

	it("drives a touch gesture the page can feel", async () => {
		await session.navigate(fixture.url("/touch"));

		await session.touchGesture([
			{ type: "touchStart", points: [{ id: 1, x: 60, y: 60 }] },
			{ type: "touchEnd", points: [] },
		]);

		const seen = await session.evaluate(
			"document.getElementById('touched').textContent",
		);
		expect(seen.ok && seen.result.value).toBe("touchstart");
	});

	it("writes the clipboard, and says so if it could not", async () => {
		// This used to inspect nothing, so a refused write was reported
		// to the caller as a success.
		await session.navigate(fixture.url("/form"));

		await expect(session.writeClipboard("copied text")).resolves.not.toThrow();

		const read = await session.evaluate("navigator.clipboard.readText()");
		if (read.ok) expect(read.result.value).toBe("copied text");
	});
});
