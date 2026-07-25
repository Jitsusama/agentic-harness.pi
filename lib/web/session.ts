/**
 * A browser session: one tab, driven by observe-then-act.
 *
 * observe renders the page's accessibility tree as a
 * role-and-name outline (plus optional screenshot and
 * readable text); act targets an element the way the model
 * named it, role plus accessible name, disambiguated by
 * container or ordinal, using the browser's own accessibility
 * matching. Opaque node handles never reach the model.
 *
 * web_read is a one-shot over a session; the browser drive
 * tool holds one open across tool calls. Same code path,
 * different lifetime.
 */

import type {
	BrowserContext,
	CDPSession,
	ElementHandle,
	Page,
} from "puppeteer-core";
import { type AxNode, renderAxOutline } from "./a11y.js";
import { newContextPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
	type TargetRefusal,
} from "./target/index.js";

/** A raw CDP accessibility node (the fields we read). */
interface RawAxNode {
	nodeId: string;
	parentId?: string;
	backendDOMNodeId?: number;
	childIds?: string[];
	role?: { value?: string };
	name?: { value?: string };
	ignored?: boolean;
}

/** The result of observing a page. */
export interface Observation {
	readonly url: string;
	readonly title: string;
	readonly outline: string;
}

/** An action that operates on a named element. */
export type TargetedAction =
	| { kind: "click"; target: Target }
	| { kind: "type"; target: Target; text: string };

/** An action to perform against the page. */
export type PageAction = { kind: "navigate"; url: string } | TargetedAction;

/** Why an act could not target an element, and what would work. */
export type ActFailure = { ok: false; refusal: TargetRefusal };

/** The outcome of an act call. */
export type ActResult = { ok: true } | ActFailure;

/** How a session should behave for its whole life. */
export interface SessionOptions {
	/**
	 * Carry the user's own Chrome cookies into this session, so
	 * internal apps that expect a signed-in browser are drivable.
	 * Off by default: a session is a clean user unless asked.
	 */
	readonly cookies?: boolean;
}

/** Chrome cookie injection was asked for but is not set up. */
export class CookieSetupNeeded extends Error {
	constructor() {
		super(
			"Chrome cookie injection is not set up. Run the " +
				"/setup-chrome-cookies command, or open the session " +
				"without cookies.",
		);
		this.name = "CookieSetupNeeded";
	}
}

/** A driveable browser session over a single tab. */
export class BrowserSession {
	private constructor(
		readonly name: string,
		private readonly page: Page,
		private readonly cdp: CDPSession,
		private readonly context: BrowserContext,
		private readonly options: SessionOptions,
	) {}

	/**
	 * Open a fresh session in a browser context of its own, so
	 * its cookies, storage and cache belong to it alone.
	 */
	static async open(
		name: string,
		options: SessionOptions = {},
	): Promise<BrowserSession> {
		if (options.cookies && !isSetUp()) throw new CookieSetupNeeded();
		const { page, context } = await newContextPage();
		try {
			const cdp = await page.createCDPSession();
			await cdp.send("Accessibility.enable");
			return new BrowserSession(name, page, cdp, context, options);
		} catch (err) {
			// Do not leak the context if the CDP channel could not be
			// set up; close it before surfacing the failure.
			await context.close().catch(() => {});
			throw err;
		}
	}

	/** Navigate the tab to a URL and wait for the network to settle. */
	async navigate(url: string): Promise<void> {
		// Cookies are per-domain, so they are injected against the
		// URL we are about to visit rather than once at open.
		if (this.options.cookies) await injectCookies(this.page, url);
		await this.page.goto(url, { waitUntil: "networkidle2" });
	}

	/** Render the page's accessibility outline, plus url and title. */
	async observe(): Promise<Observation> {
		const tree = await this.axTree();
		return {
			url: this.page.url(),
			title: await this.page.title(),
			outline: renderAxOutline(tree),
		};
	}

	/** Perform an action, resolving semantic targets against the a11y tree. */
	async act(action: PageAction): Promise<ActResult> {
		if (action.kind === "navigate") {
			await this.navigate(action.url);
			return { ok: true };
		}
		const handle = await this.resolve(action.target);
		if (!handle.ok) return handle;
		if (action.kind === "click") {
			await handle.element.click();
		} else {
			await handle.element.type(action.text);
		}
		await handle.element.dispose();
		return { ok: true };
	}

	/** Close the tab and the context holding its state. */
	async close(): Promise<void> {
		try {
			await this.cdp.detach();
		} catch {
			// The session may already be gone; closing the context is enough.
		}
		// Closing the context disposes its pages along with the
		// cookies, storage and cache they accumulated.
		await this.context.close();
	}

	private async resolve(
		target: Target,
	): Promise<{ ok: true; element: ElementHandle } | ActFailure> {
		// Confirm uniqueness against our own outline so an ambiguous
		// target becomes a prompt to narrow it rather than a wrong click.
		const tree = await this.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}
		// Drive the real element through the browser's own accessibility
		// matching (puppeteer's aria selector), honouring an ordinal.
		const selector = `aria/${target.name}[role="${target.role}"]`;
		const handles = await this.page.$$(selector);
		const index = target.ordinal ? target.ordinal - 1 : 0;
		const element = handles[index];
		for (let i = 0; i < handles.length; i++) {
			if (i !== index) await handles[i].dispose();
		}
		if (!element) return { ok: false, refusal: notFoundRefusal(tree, target) };
		return { ok: true, element };
	}

	private async axTree(): Promise<AxNode> {
		const { nodes } = (await this.cdp.send("Accessibility.getFullAXTree")) as {
			nodes: RawAxNode[];
		};
		const byId = new Map(nodes.map((node) => [node.nodeId, node]));
		const build = (id: string): AxNode => {
			const raw = byId.get(id);
			if (!raw) return { role: "", name: "", children: [] };
			const children = (raw.childIds ?? [])
				.filter((childId) => byId.has(childId))
				.map(build);
			const backend = raw.backendDOMNodeId;
			return {
				role: raw.role?.value ?? "",
				name: raw.name?.value ?? "",
				...(backend !== undefined ? { backendDomId: backend } : {}),
				children,
			};
		};
		const root = nodes.find((node) => !node.parentId) ?? nodes[0];
		return root ? build(root.nodeId) : { role: "", name: "", children: [] };
	}
}
