import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ActResult, BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

/**
 * A page with enough structure that a target below the fold has to
 * be scrolled to, and with other elements at the positions a
 * mis-resolved hit test would land on. A live audit found every
 * such target refused as "covered", naming a paragraph that was
 * nowhere near it.
 */
const STRUCTURED = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Structured</title><style>
  body { font: 16px system-ui; margin: 0; }
  main { padding: 1rem; max-width: 900px; }
  .card { background: #f2f3f7; padding: 1rem; margin: 1rem 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
</style></head><body>
  <header style="padding:1rem">a header</header>
  <div style="padding:2rem 1rem"><h1>A tall hero</h1></div>
  <main>
    <h2>Forms</h2>
    <form><label for="e">Email</label><input id="e"><input id="n"></form>
    <h2>Cards</h2>
    <div class="card"><p>A paragraph inside a card.</p></div>
    <p id="one">Filler one.</p>
    <p id="two">Filler two.</p>
    <div style="height:200px">more filler</div>
    <h2>Interaction</h2>
    <div class="row">
      <button id="deep">Deep button</button>
    </div>
    <div id="out"></div>
    <div id="host"></div>
  </main>
  <script>
    document.getElementById('deep').addEventListener('click', () => {
      document.getElementById('out').textContent = 'clicked';
    });
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="inner">Inside a shadow root</button>';
    root.getElementById('inner').addEventListener('click', () => {
      document.getElementById('out').textContent = 'shadow clicked';
    });
  </script>
</body></html>`;

describe.skipIf(!haveChrome)(
	"acting on a target that must be scrolled to",
	() => {
		let fixture: Fixture;
		let session: BrowserSession;

		beforeAll(async () => {
			fixture = await serve([
				{ path: "/", body: STRUCTURED, type: "text/html" },
			]);
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
	},
);
