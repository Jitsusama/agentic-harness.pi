/**
 * Where the tab is: going to a url, reloading, stepping through
 * history, and reading the outline of wherever it arrived.
 *
 * Kept apart from the session because arriving honestly is its own
 * policy: cookies carried to the url, a crash under the navigation
 * waited out and retried, the emulation put back and the page let
 * settle before anything reads it. That changes with what a page
 * does on arrival, not with what is read once it has.
 */

import type { Page } from "puppeteer-core";
import {
	type AxNode,
	renderAxOutline,
	renderReading,
	scopeTree,
	subtreeAt,
	type TreeScope,
} from "../a11y/index.ts";
import { injectCookies } from "../cookies/index.ts";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
} from "../target/index.ts";
import { failureText } from "../telemetry/index.ts";
import type { EmulationController } from "./emulation.ts";
import type { PageSettler } from "./settling.ts";
import type { SessionTab } from "./tab.ts";
import type { SessionTargeting } from "./targeting.ts";
import type { Observation, ObserveResult, PageForm } from "./types.ts";
import type { SessionWires } from "./wires.ts";

/** What navigating needs of the session it moves. */
export interface NavigationParts {
	/** Whether the user's own cookies go to each url visited. */
	readonly cookies: boolean;
	/** What the session pretends, put back after each arrival. */
	readonly emulation: EmulationController;
	/** The wait between arriving and an honest reading. */
	readonly settler: PageSettler;
	/** The tab, and its recovery when it dies under a navigation. */
	readonly tab: SessionTab;
	/** The page's tree, which an observation renders. */
	readonly targeting: SessionTargeting;
}

/** One session's movement through pages, and its outline of each. */
export class SessionNavigation {
	/** The live view of the browser the tab is moved through. */
	private readonly wires: SessionWires;

	/** Whether the user's own cookies go to each url visited. */
	private readonly cookies: boolean;

	/** What the session pretends, put back after each arrival. */
	private readonly emulation: EmulationController;

	/** The wait between arriving and an honest reading. */
	private readonly settler: PageSettler;

	/** The tab, and its recovery when it dies under a navigation. */
	private readonly tab: SessionTab;

	/** The page's tree, which an observation renders. */
	private readonly targeting: SessionTargeting;

	constructor(wires: SessionWires, parts: NavigationParts) {
		this.wires = wires;
		this.cookies = parts.cookies;
		this.emulation = parts.emulation;
		this.settler = parts.settler;
		this.tab = parts.tab;
		this.targeting = parts.targeting;
	}

	/** Navigate the tab to a URL and wait for the network to settle. */
	async navigate(url: string): Promise<{ status?: number; failure?: string }> {
		await this.wires.ready();
		// Cookies are per-domain, so they are injected against the
		// URL we are about to visit rather than once at open.
		if (this.cookies) await injectCookies(this.wires.page(), url);
		// A navigation that never arrives is an answer, not an
		// exception. Offline, or against a host that does not resolve,
		// this threw a raw driver error straight past a doc that
		// promises the opposite two lines below, and the caller got a
		// stack trace where it had asked a question. What the network
		// said is the useful part, so it is returned.
		let response: Awaited<ReturnType<Page["goto"]>> = null;
		try {
			response = await this.wires.page().goto(url, { waitUntil: "networkidle2" });
		} catch (error) {
			const failure = failureText(error);
			// The tab can die under this very call, and Chrome tells the
			// driver the frame is detached before it announces the crash
			// that detached it. Returning here would hand the caller a
			// driver error for a session that is about to be perfectly
			// healthy, and leave it parked on the replacement's blank
			// page: measured, a crash made a session permanently
			// unnavigable while every later call reported success.
			if (
				!(await this.tab.tabDiedUnder(failure)) ||
				!(await this.tab.awaitReplacement())
			) {
				return { failure };
			}
			try {
				response = await this.wires.page().goto(url, { waitUntil: "networkidle2" });
			} catch (afterRecovery) {
				return { failure: failureText(afterRecovery) };
			}
		}
		await this.emulation.reassert();
		// Chrome's idle heuristics fire before a client-rendered app
		// has anything on screen, so this waits for the DOM as well.
		// Without it, navigating to a real application answered with an
		// outline whose only content was "Loading page".
		await this.settler.settle();
		// The status was thrown away, so a 404 or a 500 read as a
		// successful arrival and every later check judged the error
		// page. Returned rather than thrown: an error page is
		// sometimes exactly what a caller means to look at, and the
		// answer should say which one they got.
		const status = response?.status();
		return status === undefined ? {} : { status };
	}

	/**
	 * Fetch the page again.
	 *
	 * ignoreCache is the useful default for a developer, who
	 * reloads to see a change they just made. A reload that served
	 * the old file back would be the one thing it must not do.
	 */
	async reload(): Promise<{ failure?: string }> {
		await this.wires.ready();
		try {
			await this.wires.page().reload({ waitUntil: "networkidle2" });
		} catch (error) {
			// Same reasoning as navigate: reloading with no network is a
			// thing a tester does deliberately.
			return { failure: failureText(error) };
		}
		await this.emulation.reassert();
		await this.settler.settle();
		return {};
	}

	/**
	 * Step through the history the session accumulated.
	 *
	 * Refuses rather than doing nothing at either end. Silently
	 * staying put looks identical to a page that ignored the
	 * request, and the caller then has no way to tell whether
	 * going back was possible at all.
	 *
	 * The refusal is driven by the thrown error, not by a null
	 * return. Puppeteer returns null whenever a navigation has no
	 * HTTP response, which includes about:blank and same-document
	 * moves, so reading null as failure reported a successful step
	 * back to about:blank as an impossible one. An absent entry is
	 * what throws.
	 */
	async step(direction: "back" | "forward"): Promise<
		| { readonly ok: true; readonly url: string }
		| {
				readonly ok: false;
				readonly refusal: string;
		  }
	> {
		await this.wires.ready();
		try {
			if (direction === "back") {
				await this.wires.page().goBack({ waitUntil: "networkidle2" });
			} else {
				await this.wires.page().goForward({ waitUntil: "networkidle2" });
			}
			await this.emulation.reassert();
			await this.settler.settle();
		} catch (error) {
			// Not every failure here is an empty history. Stepping back
			// with the network off fails too, and this used to answer
			// that there was nothing behind the page: a confident, wrong
			// account of the session's own history, which is the kind of
			// lie that sends someone looking in the wrong place.
			const said = failureText(error);
			if (!/History entry/i.test(said)) {
				return {
					ok: false,
					refusal:
						`Going ${direction} did not arrive: ${said}. The page ` +
						"is where it was. Read requests to see what the network " +
						"did.",
				};
			}
			return {
				ok: false,
				refusal:
					direction === "back"
						? "There is nothing behind this page in the browser's " +
							"history. It is where the browser started."
						: "There is nothing ahead of this page. Going forward " +
							"only works after going back.",
			};
		}
		return { ok: true, url: this.wires.page().url() };
	}

	/**
	 * Render the page's accessibility outline, plus url and
	 * title. A scope narrows the tree before it is rendered; with
	 * none, the whole page is read.
	 */
	async observe(
		scope: TreeScope = {},
		form: PageForm = "outline",
	): Promise<Observation> {
		const tree = await this.targeting.axTree();
		return await this.describe(scopeTree(tree, scope), form);
	}

	/**
	 * Read one branch of the page, named the way the caller names
	 * anything else. Unlike a whole-page read this can fail, so
	 * it reports what would have worked instead.
	 */
	async observeWithin(
		target: Target,
		scope: TreeScope = {},
		form: PageForm = "outline",
	): Promise<ObserveResult> {
		const tree = await this.targeting.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		const branch = subtreeAt(tree, resolution.backendDomId);
		if (!branch) {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		return {
			ok: true,
			observation: await this.describe(scopeTree(branch, scope), form),
		};
	}

	/** Wrap a tree as an observation of where the session is. */
	private async describe(tree: AxNode, form: PageForm): Promise<Observation> {
		return {
			url: this.wires.page().url(),
			title: await this.wires.page().title(),
			outline: form === "reading" ? renderReading(tree) : renderAxOutline(tree),
			tree,
		};
	}
}
