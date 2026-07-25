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
import {
	ANNOUNCE_BINDING,
	ANNOUNCEMENT_OBSERVER,
	type Announcement,
	type AnnouncementCandidate,
	type AxNode,
	CANDIDATE_REGISTRY,
	normalizeAxTree,
	type RawAxNode,
	renderAxOutline,
	renderReading,
	scopeTree,
	subtreeAt,
	type TreeScope,
} from "./a11y/index.js";
import { newContextPage } from "./browser.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import {
	ANIMATIONS_PROBE,
	type Animation,
	type BoxModel,
	centreOf,
	cornersOf,
	diffStyles,
	judgeVisibility,
	type Listener,
	normalizeAnimations,
	normalizeBoxModel,
	normalizeListeners,
	OCCLUDER_PROBE,
	type PseudoState,
	type PseudoVariant,
	type RawAnimation,
	type RawBoxModel,
	type RawListener,
	SETTLE_PROBE,
	type VisibilityVerdict,
} from "./element/index.js";
import {
	asCall,
	COMPUTED_STYLE_PROBE,
	type ComputedStyles,
	curateStyles,
	INITIALS_PROBE,
	normalizeCascade,
	type PropertyTrace,
	type RawMatchedStyles,
	SHORTHAND_PROPERTIES,
	type StyleGroup,
	traceProperty,
} from "./styles/index.js";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
	type TargetRefusal,
} from "./target/index.js";
import {
	createRingBuffer,
	type Recorded,
	type RingBuffer,
} from "./telemetry/index.js";

/** How a page should be laid out for reading. */
export type PageForm = "outline" | "reading";

/** What else to gather while inspecting an element. */
export interface InspectOptions {
	/** Exactly these properties instead of the curated set. */
	readonly styles?: readonly string[];
	/** Trace why this one property has the value it has. */
	readonly why?: string;
	/** Also report what is listening and what is moving. */
	readonly behaviour?: boolean;
	/** Hold each of these states and report what changes. */
	readonly states?: readonly PseudoState[];
}

/** Everything the browser will say about one element. */
export interface Inspection {
	readonly node: AxNode;
	readonly visibility: VisibilityVerdict;
	readonly box?: BoxModel;
	readonly styles?: readonly StyleGroup[];
	readonly trace?: PropertyTrace;
	readonly listeners?: readonly Listener[];
	readonly animations?: readonly Animation[];
	readonly variants?: readonly PseudoVariant[];
}

/**
 * How long to let a state settle before reading it.
 *
 * Forcing a state starts whatever transition the page declared,
 * so a reading taken at once catches the resting values and
 * reports that nothing changed. The wait is on the browser's
 * own promise that its animations have finished; this only caps
 * a page that keeps starting new ones.
 */
const SETTLE_CAP_MS = 2000;

/** An inspection, or the refusal that stopped it. */
export type InspectResult =
	| { readonly ok: true; readonly inspection: Inspection }
	| { readonly ok: false; readonly refusal: TargetRefusal };

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

/** The outcome of reading one named branch of a page. */
export type ObserveResult =
	| { ok: true; observation: Observation }
	| { ok: false; refusal: TargetRefusal };

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
	/** What the page announced, oldest first, within its budget. */
	private readonly announcements: RingBuffer<Announcement> =
		createRingBuffer<Announcement>();

	/**
	 * What the browser said about each nominated region, keyed by
	 * document epoch and registry index. Null means the browser
	 * ruled it not live.
	 */
	private readonly livenessByRegion = new Map<
		string,
		Announcement["politeness"] | null
	>();

	/** What every property computes to untouched, read once. */
	private initialStyles?: ComputedStyles;

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
			// The element domain reads boxes and the cascade, which
			// need the DOM and CSS agents running.
			await cdp.send("DOM.enable");
			await cdp.send("CSS.enable");
			const session = new BrowserSession(name, page, cdp, context, options);
			await session.listenForAnnouncements();
			return session;
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

	/**
	 * Render the page's accessibility outline, plus url and
	 * title. A scope narrows the tree before it is rendered; with
	 * none, the whole page is read.
	 */
	async observe(
		scope: TreeScope = {},
		form: PageForm = "outline",
	): Promise<Observation> {
		const tree = await this.axTree();
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
		const tree = await this.axTree();
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
			url: this.page.url(),
			title: await this.page.title(),
			outline: form === "reading" ? renderReading(tree) : renderAxOutline(tree),
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

	/**
	 * Start hearing what the page says. The binding is installed
	 * once and survives navigation; the observer is registered
	 * for every document, so announcements made during load are
	 * caught too.
	 *
	 * Candidates arrive faster than they can be ruled on, so they
	 * are resolved one at a time along a chain. Resolving them
	 * concurrently would let a slow lookup overtake a fast one and
	 * record two announcements out of the order they were said.
	 */
	private async listenForAnnouncements(): Promise<void> {
		let queue: Promise<void> = Promise.resolve();
		await this.page.exposeFunction(
			ANNOUNCE_BINDING,
			(candidate: AnnouncementCandidate) => {
				queue = queue.then(() => this.recordIfLive(candidate));
			},
		);
		await this.page.evaluateOnNewDocument(ANNOUNCEMENT_OBSERVER);
	}

	/**
	 * Record a nominated change only if the browser calls its
	 * region live, at the politeness the browser computed.
	 */
	private async recordIfLive(candidate: AnnouncementCandidate): Promise<void> {
		const politeness = await this.politenessOf(candidate);
		if (!politeness) return;
		this.announcements.push({
			politeness,
			text: candidate.text,
			at: candidate.at,
		});
	}

	/**
	 * Ask the browser what it computed for a nominated region.
	 *
	 * The answer is cached per document: liveness is a property of
	 * the markup, and a navigation starts a new registry with a
	 * new epoch, so a stale entry can never be read back.
	 */
	private async politenessOf(
		candidate: AnnouncementCandidate,
	): Promise<Announcement["politeness"] | undefined> {
		const key = `${candidate.epoch}:${candidate.index}`;
		const known = this.livenessByRegion.get(key);
		if (known !== undefined) return known ?? undefined;

		const computed = await this.readLiveness(candidate.index);
		this.livenessByRegion.set(key, computed ?? null);
		return computed;
	}

	/** Read a region's computed live politeness from the AX tree. */
	private async readLiveness(
		index: number,
	): Promise<Announcement["politeness"] | undefined> {
		let objectId: string | undefined;
		try {
			const { result } = await this.cdp.send("Runtime.evaluate", {
				expression: `globalThis[${JSON.stringify(CANDIDATE_REGISTRY)}][${index}]`,
			});
			objectId = result.objectId;
			if (!objectId) return undefined;

			const { node } = await this.cdp.send("DOM.describeNode", { objectId });
			const { nodes } = await this.cdp.send("Accessibility.getPartialAXTree", {
				backendNodeId: node.backendNodeId,
				fetchRelatives: false,
			});
			// The nominated node is last; anything before it is the
			// ancestry the protocol threw in.
			const target = nodes.at(-1);
			const live = target?.properties?.find((p) => p.name === "live")?.value
				.value;
			if (live === "polite" || live === "assertive") return live;
			return undefined;
		} catch {
			// The page can navigate or drop the node between the
			// nomination and the lookup. A change nobody can point at
			// any more is not worth reporting as an announcement.
			return undefined;
		} finally {
			if (objectId) {
				await this.cdp
					.send("Runtime.releaseObject", { objectId })
					// Releasing a handle the page already discarded is
					// not a failure worth surfacing.
					.catch(() => {});
			}
		}
	}

	/**
	 * What the page has announced since a cursor, with the cursor
	 * to read from next time and how many were dropped.
	 */
	heard(since = 0): {
		entries: readonly Recorded<Announcement>[];
		cursor: number;
		dropped: number;
	} {
		return {
			entries: this.announcements.since(since),
			cursor: this.announcements.cursor,
			dropped: this.announcements.dropped,
		};
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

	/**
	 * Everything worth knowing about one element.
	 *
	 * Each fact is asked of the browser rather than worked out
	 * here: the box from the layout engine, the occluder from a
	 * hit test, the styles from the cascade, the announcement from
	 * the accessibility tree.
	 */
	async inspect(
		target: Target,
		options: InspectOptions = {},
	): Promise<InspectResult> {
		const tree = await this.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}

		const node = subtreeAt(tree, resolution.backendDomId) ?? tree;
		const objectId = await this.objectFor(resolution.backendDomId);
		try {
			return {
				ok: true,
				inspection: await this.inspectNode(
					resolution.backendDomId,
					objectId,
					node,
					options,
				),
			};
		} finally {
			await this.release(objectId);
		}
	}

	/**
	 * A handle on the element inside this session.
	 *
	 * Object identifiers belong to the protocol session that
	 * minted them, so puppeteer's own handles are unusable here.
	 * A backend node id is the identity both sides agree on.
	 */
	private async objectFor(backendNodeId: number): Promise<string | undefined> {
		try {
			const { object } = await this.cdp.send("DOM.resolveNode", {
				backendNodeId,
			});
			return object.objectId;
		} catch {
			// The node can go out of the document between being named
			// and being looked at; the inspection reports what it can.
			return undefined;
		}
	}

	/** Let go of a handle, whether or not the page still has it. */
	private async release(objectId: string | undefined): Promise<void> {
		if (!objectId) return;
		await this.cdp
			.send("Runtime.releaseObject", { objectId })
			// Releasing a handle the page already dropped is not a
			// failure worth surfacing.
			.catch(() => {});
	}

	/** Gather every fact about an element the browser will give. */
	private async inspectNode(
		backendNodeId: number,
		objectId: string | undefined,
		node: AxNode,
		options: InspectOptions,
	): Promise<Inspection> {
		const box = await this.boxOf(backendNodeId);
		const styles = objectId ? await this.stylesOf(objectId) : undefined;
		const viewport = await this.viewport();
		const coveredBy =
			box && objectId ? await this.occluderOf(objectId, box) : undefined;

		const visibility = judgeVisibility({
			rendered: box !== undefined,
			...(box === undefined ? {} : { border: box.border }),
			...(viewport === undefined ? {} : { viewport }),
			...(coveredBy === undefined ? {} : { coveredBy }),
			...(styles?.opacity === undefined
				? {}
				: { opacity: Number(styles.opacity) }),
			...(styles?.visibility === undefined
				? {}
				: { visibility: styles.visibility }),
		});

		const initials = await this.initials();
		const curated =
			styles === undefined
				? undefined
				: curateStyles(styles, {
						...(initials === undefined ? {} : { initials }),
						...(options.styles === undefined ? {} : { only: options.styles }),
					});

		const wantsBehaviour = options.behaviour === true && objectId !== undefined;
		const variants =
			options.states && objectId && curated
				? await this.variantsOf(
						backendNodeId,
						objectId,
						curated,
						options.states,
						initials,
						options,
					)
				: undefined;

		return {
			node,
			visibility,
			...(box === undefined ? {} : { box }),
			...(curated === undefined ? {} : { styles: curated }),
			...(wantsBehaviour && objectId
				? {
						listeners: await this.listenersOf(objectId),
						animations: await this.animationsOf(objectId),
					}
				: {}),
			...(variants === undefined ? {} : { variants }),
			...(options.why === undefined
				? {}
				: {
						trace: await this.traceOf(backendNodeId, options.why, styles),
					}),
		};
	}

	/** What is listening on the element. */
	private async listenersOf(objectId: string): Promise<readonly Listener[]> {
		try {
			const { listeners } = (await this.cdp.send(
				"DOMDebugger.getEventListeners",
				{ objectId },
			)) as { listeners: RawListener[] };
			return normalizeListeners(listeners);
		} catch {
			// Without the debugger agent this one section is missing;
			// the rest of the inspection still stands.
			return [];
		}
	}

	/** What is moving on the element. */
	private async animationsOf(objectId: string): Promise<readonly Animation[]> {
		try {
			const { result } = await this.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: ANIMATIONS_PROBE,
				returnByValue: true,
			});
			return normalizeAnimations((result.value ?? []) as RawAnimation[]);
		} catch {
			// A page that navigated mid-inspection has nothing left to
			// report here.
			return [];
		}
	}

	/**
	 * How the element looks in each state, against how it looks at
	 * rest.
	 *
	 * The forced state is always released afterwards, including
	 * when a reading throws part way through. Leaving a page stuck
	 * in a forced hover would quietly corrupt every later
	 * observation of it.
	 */
	private async variantsOf(
		backendNodeId: number,
		objectId: string,
		atRest: readonly StyleGroup[],
		states: readonly PseudoState[],
		initials: ComputedStyles | undefined,
		options: InspectOptions,
	): Promise<readonly PseudoVariant[]> {
		const nodeId = await this.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return [];

		const variants: PseudoVariant[] = [];
		try {
			for (const state of states) {
				await this.cdp.send("CSS.forcePseudoState", {
					nodeId,
					forcedPseudoClasses: [state],
				});
				await this.settle(objectId);
				const held = await this.stylesOf(objectId);
				if (!held) continue;
				variants.push({
					state,
					changes: diffStyles(
						atRest,
						curateStyles(held, {
							...(initials === undefined ? {} : { initials }),
							...(options.styles === undefined ? {} : { only: options.styles }),
						}),
					),
				});
			}
		} finally {
			await this.cdp
				.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })
				// A page that navigated took the forced state with it.
				.catch(() => {});
			// Releasing the state starts the transition back, so the
			// element is only truly as it was found once that has
			// finished. Without this the next reading catches it part
			// way home and reports a colour nobody chose.
			await this.settle(objectId);
		}
		return variants;
	}

	/**
	 * Let whatever the forced state started finish before reading.
	 *
	 * Without this the reading catches a transition at its resting
	 * values and reports that the state changes nothing, which is
	 * exactly backwards.
	 */
	private async settle(objectId: string): Promise<void> {
		try {
			await this.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: SETTLE_PROBE,
				arguments: [{ value: SETTLE_CAP_MS }],
				awaitPromise: true,
				returnByValue: true,
			});
		} catch {
			// A reading taken early is worse than one taken late, but
			// neither is worth abandoning the inspection over.
		}
	}

	/** The front-end node id, which the CSS agent works in. */
	private async frontendNodeFor(
		backendNodeId: number,
	): Promise<number | undefined> {
		try {
			// A front-end id only exists once the document has been
			// walked at least once.
			await this.cdp.send("DOM.getDocument", { depth: 0 });
			const { nodeIds } = await this.cdp.send(
				"DOM.pushNodesByBackendIdsToFrontend",
				{ backendNodeIds: [backendNodeId] },
			);
			return nodeIds[0];
		} catch {
			// Without a front-end id the CSS agent cannot be addressed.
			return undefined;
		}
	}

	/** The element's four boxes, or nothing when it has none. */
	private async boxOf(backendNodeId: number): Promise<BoxModel | undefined> {
		try {
			const { model } = (await this.cdp.send("DOM.getBoxModel", {
				backendNodeId,
			})) as { model: RawBoxModel };
			return normalizeBoxModel(model);
		} catch {
			// An element with display none has no box at all, and the
			// protocol says so by refusing. That is an answer, not a
			// failure: the visibility verdict reports it as unrendered.
			return undefined;
		}
	}

	/** Every computed property of the element, as the browser has it. */
	private async stylesOf(
		objectId: string,
	): Promise<ComputedStyles | undefined> {
		try {
			const { result } = await this.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: COMPUTED_STYLE_PROBE,
				arguments: [{ value: SHORTHAND_PROPERTIES }],
				returnByValue: true,
			});
			return result.value as ComputedStyles;
		} catch {
			// A page that navigated mid-inspection leaves nothing to
			// read; the rest of the inspection still stands.
			return undefined;
		}
	}

	/**
	 * What every property computes to untouched, read once per
	 * session. These decide which values were actually chosen.
	 */
	private async initials(): Promise<ComputedStyles | undefined> {
		if (this.initialStyles) return this.initialStyles;
		try {
			const { result } = await this.cdp.send("Runtime.evaluate", {
				expression: asCall(INITIALS_PROBE, SHORTHAND_PROPERTIES),
				returnByValue: true,
			});
			this.initialStyles = result.value as ComputedStyles;
			return this.initialStyles;
		} catch {
			// Without these nothing is suppressed as a default, which
			// is verbose but never wrong.
			return undefined;
		}
	}

	/** Why one property has the value it has. */
	private async traceOf(
		backendNodeId: number,
		property: string,
		styles: ComputedStyles | undefined,
	): Promise<PropertyTrace | undefined> {
		try {
			const nodeId = await this.frontendNodeFor(backendNodeId);
			if (nodeId === undefined) return undefined;
			const raw = (await this.cdp.send("CSS.getMatchedStylesForNode", {
				nodeId,
			})) as RawMatchedStyles;
			return traceProperty(normalizeCascade(raw), property, styles?.[property]);
		} catch {
			// The cascade domain needs the CSS agent; without it the
			// rest of the inspection is still worth returning.
			return undefined;
		}
	}

	/** The area a person can currently see. */
	private async viewport(): Promise<
		{ width: number; height: number } | undefined
	> {
		try {
			const metrics = (await this.cdp.send("Page.getLayoutMetrics")) as {
				cssVisualViewport?: { clientWidth: number; clientHeight: number };
			};
			const seen = metrics.cssVisualViewport;
			if (!seen) return undefined;
			return { width: seen.clientWidth, height: seen.clientHeight };
		} catch {
			// Without the viewport an element is judged on everything
			// else known about it rather than not at all.
			return undefined;
		}
	}

	/**
	 * What is painted over the element, if anything.
	 *
	 * The browser is asked what it would hit at the element's own
	 * centre and corners. Anything the element contains counts as
	 * itself, since a click there still reaches it.
	 */
	private async occluderOf(
		objectId: string,
		box: BoxModel,
	): Promise<string | undefined> {
		const points = [centreOf(box.border), ...cornersOf(box.border, 2)];
		for (const point of points) {
			const hit = await this.hitTest(objectId, point);
			if (hit) return hit;
		}
		return undefined;
	}

	/** Who receives a click at one point, when it is not us. */
	private async hitTest(
		objectId: string,
		point: { x: number; y: number },
	): Promise<string | undefined> {
		let hitObjectId: string | undefined;
		try {
			const { backendNodeId } = await this.cdp.send("DOM.getNodeForLocation", {
				x: Math.round(point.x),
				y: Math.round(point.y),
			});
			hitObjectId = await this.objectFor(backendNodeId);
			if (!hitObjectId) return undefined;

			const { result } = await this.cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: OCCLUDER_PROBE,
				arguments: [{ objectId: hitObjectId }],
				returnByValue: true,
			});
			return (result.value as string | null) ?? undefined;
		} catch {
			// A point outside the viewport cannot be hit tested. The
			// verdict already reports that as being off screen, so
			// there is nothing further to say here.
			return undefined;
		} finally {
			await this.release(hitObjectId);
		}
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
		return normalizeAxTree(nodes);
	}
}
