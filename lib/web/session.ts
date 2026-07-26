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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type {
	BrowserContext,
	CDPSession,
	ElementHandle,
	KeyInput,
	Page,
	Protocol,
} from "puppeteer-core";
// The key table is reached through the driver's declared
// internal subpath rather than its barrel, which marks the
// table private and strips it from the public types. Copying
// the 255 entries instead would mean maintaining a second
// opinion about which keys exist, and being wrong separately.
import { _keyDefinitions } from "puppeteer-core/internal/common/USKeyboardLayout.js";
import { dataDir } from "../internal/paths.js";
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
	type Unreachable,
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
	type WalkCandidate,
	type WalkCapture,
	type WalkStop,
} from "./a11y/index.js";
import { newContextPage } from "./browser.js";
import { compareImages, readPng } from "./compare/images.js";
import type { Comparison } from "./compare/index.js";
import {
	type BaselineProvenance,
	describeDrift,
	parse as parseProvenance,
	sidecarFor,
	stringify,
} from "./compare/provenance.js";
import { injectCookies, isSetUp } from "./cookies/index.js";
import {
	type Actionability,
	type ActionabilityFacts,
	ANIMATIONS_PROBE,
	type Animation,
	type BoxModel,
	centreOf,
	cornersOf,
	diffStyles,
	judgeActionability,
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
	type Rect,
	SELECT_TEXT_PROBE,
	SETTLE_PROBE,
	sameBox,
	type VisibilityVerdict,
} from "./element/index.js";
import {
	type BundleSink,
	DIR_MODE,
	diskSink,
	FILE_MODE,
} from "./envelope/index.js";
import {
	type CookieRecord,
	type Divergence,
	divergences,
	type EmulationState,
	ENVIRONMENT_PROBE,
	matchesPattern,
	mediaFeaturesOf,
	mergeEmulation,
	type NetworkRule,
	type ObservedEnvironment,
	ruleFor,
	type SessionStatus,
	type StorageSnapshot,
	type ThrottleConditions,
} from "./environment/index.js";
import {
	type ChordRefusal,
	type Point,
	type PointerEventStep,
	parseChords,
	type TouchStep,
} from "./input/index.js";
import {
	inFlight,
	isIdle,
	type WaitCondition,
	type WaitOutcome,
} from "./wait/index.js";

/**
 * The styles a snapshot carries by default.
 *
 * Enough to answer why something is not where it should be,
 * without dragging the whole computed style of every node into
 * the answer.
 */
const SNAPSHOT_STYLES: readonly string[] = [
	"display",
	"visibility",
	"opacity",
	"position",
	"color",
	"background-color",
	"font-size",
];

/** Extra stops beyond two full passes, to show a cycle clearly. */
const WALK_SLACK = 4;

/** The hard ceiling on a walk, however large the page. */
const MAX_WALK_STOPS = 400;

/** How many trailing stops to inspect for being stuck. */
const WALK_STUCK_SAMPLE = 4;

/** What a stop outside the candidates has for a style. */
const BLANK_STYLE = {
	outlineStyle: "none",
	outlineWidth: "0px",
	outlineColor: "",
	boxShadow: "none",
	backgroundColor: "",
	borderColor: "",
	color: "",
} as const;

/** How long a wait runs before it gives up and says so. */
const DEFAULT_WAIT_MS = 10_000;

/** How often a wait looks again. */
const WAIT_POLL_MS = 100;

/** Milliseconds in a second, where two clocks have to meet. */
const MS_PER_SECOND = 1000;

/**
 * Every key the driver knows how to send.
 *
 * The chord parser is given this rather than keeping its own
 * copy, so there is one table and it is the one that will
 * actually be used to dispatch.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(_keyDefinitions));

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	type A11yFinding,
	type AxFacts,
	buildStructure,
	type CapturedTarget,
	type PageBox,
	type RawAxeRun,
	readAxeRun,
	type StructureNode,
	TARGET_CAPTURE,
	type VisualNode,
	visualCaptureSource,
} from "./audit/index.js";
import { inventorySource, type StyleSample } from "./design/index.js";
import {
	describeThrow,
	type EvalFrame,
	type EvalOutcome,
	type EvalValue,
	evaluationSource,
} from "./evaluate/index.js";
import {
	observerBootstrap,
	readVitalsSource,
	type Vitals,
} from "./perf/index.js";
import { captureTiles } from "./screenshot.js";
import {
	flattenSnapshot,
	type IndexedNode,
	type RawSnapshot,
} from "./snapshot/index.js";
import {
	authoredPosition,
	parseSourceMap,
	resolveMapUrl,
	type SourceMap,
} from "./sourcemap/index.js";
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
	answerFor,
	type BrowserLogged,
	browserEntry,
	type ConsoleCalled,
	consoleEntry,
	createDownloadRecorder,
	createLifecycleRecorder,
	createNetworkRecorder,
	createRingBuffer,
	DEFAULT_DIALOG_POLICY,
	type DialogEvent,
	type DialogKind,
	type DialogPolicy,
	type DownloadRecord,
	type DownloadState,
	exceptionEntry,
	type LifecycleEvent,
	type LifecycleRecorder,
	type LogEntry,
	type NetworkRequest,
	type Recorded,
	type RingBuffer,
	toHar,
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

/** What to photograph. */
export interface ShotOptions {
	/** One element rather than the page. */
	readonly target?: Target;
	/** The whole scrollable page rather than what is on screen. */
	readonly fullPage?: boolean;
	/** Hold this state while capturing. */
	readonly state?: PseudoState;
}

/** Where the images landed, and what had to be left out. */
export interface Shot {
	readonly paths: readonly string[];
	readonly truncated: boolean;
	readonly width: number;
	readonly height: number;
}

/** A capture, or the refusal that stopped it. */
export type ShotResult =
	| { readonly ok: true; readonly shot: Shot }
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
	| { kind: "type"; target: Target; text: string }
	| { kind: "hover"; target: Target }
	| { kind: "focus"; target: Target }
	| { kind: "clear"; target: Target }
	| { kind: "select"; target: Target; text: string }
	| { kind: "scrollTo"; target: Target };

/**
 * How long to wait for an element to become ready, and how
 * often to look. A page that animates a dialog in takes a few
 * hundred milliseconds, and waiting is far cheaper than a click
 * that silently misses.
 */
const READY_BUDGET_MS = 2000;
const READY_POLL_MS = 100;

/** Touch points a touch device is given, matching a common phone. */
const TOUCH_POINTS = 5;

/** Metres of accuracy claimed for an overridden position. */
const GEOLOCATION_ACCURACY = 10;

/**
 * Whether an action arrives by pointer.
 *
 * A pointer has to reach the element's centre unobstructed and
 * on screen. Everything else addresses the element directly and
 * would succeed where a click could not.
 */
function usesPointer(action: TargetedAction): boolean {
	return action.kind === "click" || action.kind === "hover";
}

/** An action to perform against the page. */
export type PageAction = { kind: "navigate"; url: string } | TargetedAction;

/** Why an act could not target an element, and what would work. */
export type ActFailure = { ok: false; refusal: TargetRefusal };

/** An element that never became ready, and what held it up. */
export interface Blocked {
	readonly ready: false;
	readonly waitedMs: number;
	readonly blocker: string;
}

/** The outcome of an act call. */
export type ActResult =
	| { ok: true; waitedMs?: number }
	| ActFailure
	| { ok: false; blocked: Blocked };

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
/**
 * Where axe-core's bundle sits on disk.
 *
 * Resolved through node rather than assembled from a relative
 * path, so it keeps working wherever the package is installed
 * and however the dependency is hoisted.
 */
function axeSource(): string {
	return createRequire(import.meta.url).resolve("axe-core/axe.min.js");
}

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

	/** Where this session's images are written, made on demand. */
	private bundle?: BundleSink;

	/** Everything the page has said since it opened. */
	private readonly logBuffer = createRingBuffer<LogEntry>();

	/** Every request the page has made since it opened. */
	private readonly requestLog = createNetworkRecorder();

	/** Every dialog the page has raised, and how it was answered. */
	private readonly dialogLog: DialogEvent[] = [];

	/** Where the page has been, and whether it survived. */
	private lifecycleLog?: LifecycleRecorder;

	/** The recovery in flight, so nothing reads a tab mid-replacement. */
	private recovery?: Promise<void>;

	/** What this session is pretending to be. */
	private emulation: EmulationState = {};

	/** Requests being mocked or blocked, first match winning. */
	private rules: readonly NetworkRule[] = [];

	/** How slow the network is being made, if at all. */
	private throttle?: ThrottleConditions;

	/** Whether the interceptor is currently attached. */
	private intercepting = false;

	/**
	 * Wall seconds minus the protocol's monotonic seconds.
	 *
	 * The protocol's clock counts from when the browser started,
	 * so it reads around 586,000 while ours reads 1.78 billion.
	 * Comparing a recorded request against our own clock without
	 * this correction does not merely give a wrong answer, it
	 * gives a confidently idle one, because every request looks
	 * like it finished aeons ago.
	 */
	private clockOffset?: number;

	/** How dialogs get answered while nobody is watching. */
	private dialogPolicy: DialogPolicy = DEFAULT_DIALOG_POLICY;

	/** How many pictures have been taken, so none overwrites another. */
	private shots = 0;

	/** How many archives have been written, for the same reason. */
	private archives = 0;

	/** Everything this session has put on disk, in order. */
	private readonly written: string[] = [];

	/** Which map each script and stylesheet named, unresolved. */
	private readonly mapUrls = new Map<string, string>();

	/** Maps already fetched. A null records one that will not come. */
	private readonly maps = new Map<string, SourceMap | null>();

	/** Which URL each stylesheet id belongs to. */
	private readonly sheetUrls = new Map<string, string>();

	/** Files the page has handed back. */
	private readonly downloadLog = createDownloadRecorder();

	/**
	 * Announcements still being ruled on. Candidates resolve one
	 * at a time along this chain, so a slow lookup cannot overtake
	 * a fast one and record two out of the order they were said.
	 */
	private pending: Promise<void> = Promise.resolve();

	private constructor(
		readonly name: string,
		// The page and its protocol channel are replaced wholesale
		// when the tab crashes, so neither can be readonly.
		private page: Page,
		private cdp: CDPSession,
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
			await session.listenForLogs();
			await session.listenForRequests();
			await session.listenForDialogs();
			await session.listenForLifecycle();
			await session.listenForDownloads();
			await session.listenForSourceMaps();
			await session.watchVitals();
			return session;
		} catch (err) {
			// Do not leak the context if the CDP channel could not be
			// set up; close it before surfacing the failure.
			await context.close().catch(() => {});
			throw err;
		}
	}

	/**
	 * Listen for everything the page says, from the moment it
	 * opens.
	 *
	 * Three sources, because no one of them is complete. The
	 * console is what the page chose to say; exceptions are what
	 * it did not choose; and the browser's own log carries what
	 * the page never hears at all, a resource that failed to load
	 * or a request the browser refused.
	 */
	private async listenForLogs(): Promise<void> {
		this.cdp.on("Runtime.consoleAPICalled", (event) => {
			this.logBuffer.push(consoleEntry(event as ConsoleCalled));
		});
		this.cdp.on("Runtime.exceptionThrown", (event) => {
			this.logBuffer.push(
				exceptionEntry(event.exceptionDetails, event.timestamp),
			);
		});
		this.cdp.on("Log.entryAdded", (event) => {
			const logged = event as { entry: BrowserLogged };
			this.logBuffer.push(browserEntry(logged.entry));
		});
		await this.cdp.send("Runtime.enable");
		await this.cdp.send("Log.enable");
	}

	/**
	 * Watch every request the page makes.
	 *
	 * The protocol reports one request as four separate events
	 * over its life, so the recorder does the reassembly and this
	 * only relabels the CDP names it consumes.
	 */
	private async listenForRequests(): Promise<void> {
		this.cdp.on("Network.requestWillBeSent", (event) => {
			// This is the one event carrying both clocks at once, which
			// makes it the only place the offset between them can be
			// learned rather than assumed.
			if (event.wallTime !== undefined) {
				this.clockOffset = event.wallTime - event.timestamp;
			}
			this.requestLog.apply({ kind: "sent", event });
		});
		this.cdp.on("Network.responseReceived", (event) => {
			this.requestLog.apply({ kind: "received", event });
		});
		this.cdp.on("Network.loadingFinished", (event) => {
			this.requestLog.apply({ kind: "finished", event });
		});
		this.cdp.on("Network.loadingFailed", (event) => {
			this.requestLog.apply({ kind: "failed", event });
		});
		await this.cdp.send("Network.enable");
	}

	/**
	 * Answer dialogs, because an unanswered one stops the page.
	 *
	 * Until something replies, no script runs and no action lands,
	 * so there is no such thing as declining to have a policy.
	 * Every answer given is recorded, since a dismissed confirm
	 * changes what the page did next and the reader has to be able
	 * to see that it happened.
	 */
	private async listenForDialogs(): Promise<void> {
		this.cdp.on("Page.javascriptDialogOpening", (event) => {
			const kind = event.type as DialogKind;
			const reply = answerFor(kind, this.dialogPolicy);
			this.dialogLog.push({
				kind,
				message: event.message,
				accepted: reply.accept,
				...(event.defaultPrompt === undefined || event.defaultPrompt === ""
					? {}
					: { defaultPrompt: event.defaultPrompt }),
				...(reply.promptText === undefined ? {} : { reply: reply.promptText }),
				...(event.url === undefined ? {} : { url: event.url }),
			});
			this.cdp
				.send("Page.handleJavaScriptDialog", reply)
				// A dialog the page closed itself is already gone, and
				// failing to answer it is not news.
				.catch(() => {});
		});
		await this.cdp.send("Page.enable");
	}

	/** Decide how dialogs will be answered from here on. */
	setDialogPolicy(policy: DialogPolicy): void {
		this.dialogPolicy = policy;
	}

	/** How dialogs are currently answered. */
	get dialogs(): {
		readonly policy: DialogPolicy;
		readonly seen: readonly DialogEvent[];
	} {
		return { policy: this.dialogPolicy, seen: this.dialogLog };
	}

	/** Every request the page has made. */
	requests(): readonly NetworkRequest[] {
		return this.requestLog.all();
	}

	/**
	 * Write a capture out as an HTTP Archive.
	 *
	 * Bodies are fetched for the requests being exported, since an
	 * archive without them answers far fewer questions than one
	 * with them, and an export is already an explicit ask.
	 */
	async exportHar(requests: readonly NetworkRequest[]): Promise<string> {
		const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
		for (const request of requests) {
			const fetched = await this.bodyOf(request.id);
			if (fetched && fetched.body.length > 0) bodies.set(request.id, fetched);
		}

		if (!this.bundle) this.bundle = diskSink();
		this.archives += 1;
		const path = this.bundle.writeText(
			`capture-${String(this.archives).padStart(2, "0")}.har`,
			JSON.stringify(toHar(requests, { bodies }), null, 2),
		);
		this.written.push(path);
		return path;
	}

	/**
	 * The body of one recorded reply, fetched on demand.
	 *
	 * Bodies are not captured as they stream past: most are never
	 * asked for, and holding every one would cost far more memory
	 * than the rest of the session put together. Chrome keeps them
	 * for the current document, so this asks only when asked.
	 */
	async bodyOf(
		requestId: string,
	): Promise<{ body: string; base64Encoded: boolean } | undefined> {
		try {
			return await this.cdp.send("Network.getResponseBody", { requestId });
		} catch {
			// Chrome discards bodies on navigation, and never had one
			// for a request that failed. Neither is an error here.
			return undefined;
		}
	}

	/**
	 * What the page has said, from a cursor onward.
	 *
	 * The buffer survives navigation on purpose: a message logged
	 * just before a redirect is often the one that explains it.
	 */
	logs(since?: number): {
		readonly entries: readonly Recorded<LogEntry>[];
		readonly dropped: number;
		readonly cursor: number;
	} {
		return {
			entries:
				since === undefined
					? this.logBuffer.all()
					: this.logBuffer.since(since),
			dropped: this.logBuffer.dropped,
			cursor: this.logBuffer.cursor,
		};
	}

	/** Navigate the tab to a URL and wait for the network to settle. */
	async navigate(url: string): Promise<void> {
		await this.ready();
		// Cookies are per-domain, so they are injected against the
		// URL we are about to visit rather than once at open.
		if (this.options.cookies) await injectCookies(this.page, url);
		await this.page.goto(url, { waitUntil: "networkidle2" });
	}

	/** Where the session currently is. */
	get url(): string {
		return this.page.url();
	}

	/**
	 * Fetch the page again.
	 *
	 * ignoreCache is the useful default for a developer, who
	 * reloads to see a change they just made. A reload that served
	 * the old file back would be the one thing it must not do.
	 */
	async reload(): Promise<void> {
		await this.ready();
		await this.page.reload({ waitUntil: "networkidle2" });
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
		await this.ready();
		try {
			if (direction === "back") {
				await this.page.goBack({ waitUntil: "networkidle2" });
			} else {
				await this.page.goForward({ waitUntil: "networkidle2" });
			}
		} catch {
			return {
				ok: false,
				refusal:
					direction === "back"
						? "There is nothing behind this page in the session's " +
							"history. It is where the session started."
						: "There is nothing ahead of this page. Going forward " +
							"only works after going back.",
			};
		}
		return { ok: true, url: this.page.url() };
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
		// Readiness is established before targeting, because an
		// element that has not appeared yet is the commonest reason
		// an action is early rather than wrong.
		const ready = await this.awaitReady(action.target, usesPointer(action));
		if (!ready.ready) {
			// Never showing up and never existing look the same from
			// here, and only one of them has a spelling suggestion
			// worth making, so ask the targeting to explain itself.
			const missing = await this.resolve(action.target);
			if (!missing.ok) return missing;
			await missing.element.dispose();
			return { ok: false, blocked: ready };
		}

		const handle = await this.resolve(action.target);
		if (!handle.ok) return handle;

		await this.perform(action, handle.element, ready.backendDomId);
		await handle.element.dispose();
		if (ready.waitedMs > 0) return { ok: true, waitedMs: ready.waitedMs };
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
	/**
	 * Watch where the page goes, and notice if it dies.
	 *
	 * The crash half is not optional. After the tab crashes every
	 * call against it hangs rather than failing, measured against
	 * a deliberately crashed tab, so a session that waited to find
	 * out lazily would simply stop responding. Recovery therefore
	 * happens the moment the crash is announced.
	 */
	/**
	 * Note which map belongs to which script and stylesheet.
	 *
	 * Chrome reports the map's URL and stops there. It does no
	 * resolving of its own, because in a browser that is the
	 * devtools front end's job, so a session that wants authored
	 * positions has to keep the note itself.
	 *
	 * The map is not fetched here. Most sessions never throw, and
	 * fetching every map a page mentions would cost a request per
	 * bundle to answer a question nobody asked.
	 */
	private async listenForSourceMaps(): Promise<void> {
		this.cdp.on("Debugger.scriptParsed", (event) => {
			if (!event.sourceMapURL || !event.url) return;
			this.mapUrls.set(event.url, event.sourceMapURL);
		});
		this.cdp.on("CSS.styleSheetAdded", (event) => {
			const { sourceURL, sourceMapURL, styleSheetId } = event.header;
			if (!sourceMapURL || !sourceURL) return;
			this.mapUrls.set(sourceURL, sourceMapURL);
			// The cascade names a stylesheet by id, not by URL, so the
			// two have to be joined here while both are in hand.
			this.sheetUrls.set(styleSheetId, sourceURL);
		});
		await this.cdp.send("Debugger.enable");
	}

	/**
	 * Fetch and decode the map for a file, once.
	 *
	 * The fetch goes through the page rather than through node,
	 * because the page is already on the right origin with the
	 * right cookies. A map behind a login is unreachable any
	 * other way.
	 *
	 * A failure is cached as firmly as a success. A map that 404s
	 * will still 404 on the next frame of the same stack, and
	 * asking again once per frame is how one bad path turns into
	 * a dozen requests.
	 */
	private async mapFor(fileUrl: string): Promise<SourceMap | undefined> {
		const cached = this.maps.get(fileUrl);
		if (cached !== undefined) return cached ?? undefined;

		const declared = this.mapUrls.get(fileUrl);
		if (!declared) return undefined;
		const located = resolveMapUrl(fileUrl, declared);
		if (!located) {
			this.maps.set(fileUrl, null);
			return undefined;
		}

		let json: string | undefined;
		if (located.kind === "inline") {
			json = located.json;
		} else {
			try {
				const response = await this.cdp.send("Runtime.evaluate", {
					expression: `fetch(${JSON.stringify(located.url)})
						.then((r) => (r.ok ? r.text() : null))
						.catch(() => null)`,
					awaitPromise: true,
					returnByValue: true,
				});
				const body = response.result.value;
				if (typeof body === "string") json = body;
			} catch {
				// A page that navigated away mid-fetch is not a reason
				// to lose the stack we were annotating.
			}
		}

		const parsed = json === undefined ? undefined : parseSourceMap(json);
		this.maps.set(fileUrl, parsed ?? null);
		return parsed;
	}

	/**
	 * Tell each frame of a stack where it was written.
	 *
	 * A frame with no map keeps its generated position rather than
	 * being dropped: half a stack is worse than a raw one.
	 */
	async resolveFrames(
		frames: readonly EvalFrame[],
	): Promise<readonly EvalFrame[]> {
		return Promise.all(
			frames.map(async (frame) => {
				if (!frame.url) return frame;
				const map = await this.mapFor(frame.url);
				if (!map) return frame;
				const authored = authoredPosition(map, {
					line: frame.lineNumber,
					column: frame.columnNumber,
				});
				return authored === undefined ? frame : { ...frame, authored };
			}),
		);
	}

	private async listenForLifecycle(): Promise<void> {
		const { frameTree } = await this.cdp.send("Page.getFrameTree");
		const log = createLifecycleRecorder(frameTree.frame.id);
		this.lifecycleLog = log;
		this.attachLifecycle(log);
	}

	/** Point the lifecycle handlers at the current protocol channel. */
	private attachLifecycle(log: LifecycleRecorder): void {
		this.cdp.on("Page.frameRequestedNavigation", (event) => {
			log.apply({
				kind: "requested",
				frameId: event.frameId,
				reason: event.reason,
			});
		});
		this.cdp.on("Page.frameNavigated", (event) => {
			log.apply({
				kind: "navigated",
				frameId: event.frame.id,
				url: event.frame.url,
			});
		});
		this.cdp.on("Page.navigatedWithinDocument", (event) => {
			log.apply({
				kind: "within",
				frameId: event.frameId,
				url: event.url,
				...(event.navigationType === undefined
					? {}
					: { navigationType: event.navigationType }),
			});
		});
		this.cdp.on("Inspector.targetCrashed", () => {
			log.apply({ kind: "crashed" });
			this.recovery = this.recover();
		});
	}

	/**
	 * Replace the dead tab with a live one.
	 *
	 * The context survives a tab crash and can still make pages,
	 * so the session keeps its identity, its cookies and every
	 * buffer it has filled; only the tab is new. Watchers have to
	 * be reinstalled because they were bound to a protocol channel
	 * that no longer answers.
	 */
	private async recover(): Promise<void> {
		// The dead page will not answer, but closing it does work,
		// and leaving it would leak a renderer for the session's life.
		await this.page.close().catch(() => {});

		const page = await this.context.newPage();
		const cdp = await page.createCDPSession();
		this.page = page;
		this.cdp = cdp;

		await cdp.send("Accessibility.enable");
		await cdp.send("DOM.enable");
		await cdp.send("CSS.enable");
		await this.listenForAnnouncements();
		await this.listenForLogs();
		await this.listenForRequests();
		await this.listenForDialogs();

		// A fresh tab knows nothing of what the old one was
		// pretending, so the standing intent is put back before
		// anything reads from it.
		await this.applyEmulation();

		const { frameTree } = await cdp.send("Page.getFrameTree");
		const log = this.lifecycleLog;
		if (log) {
			// A new tab is a new main frame, and a recorder still
			// watching the old id would ignore every navigation from
			// here on while looking perfectly healthy.
			log.adoptFrame(frameTree.frame.id);
			this.attachLifecycle(log);
			log.apply({ kind: "recovered" });
		}
	}

	/**
	 * Wait for any recovery to finish.
	 *
	 * Called before anything that touches the tab, so a read that
	 * arrives during a crash waits for the replacement instead of
	 * hanging on a renderer that is never coming back.
	 */
	private async ready(): Promise<void> {
		if (this.recovery) await this.recovery;
	}

	/**
	 * Catch files the page hands back.
	 *
	 * The behaviour has to be set against this session's browser
	 * context, not merely the connection. Set without the context
	 * id, Chrome cancels every download in a non-default context
	 * and writes nothing, which looks exactly like a page that
	 * never offered a file.
	 */
	private async listenForDownloads(): Promise<void> {
		if (!this.bundle) this.bundle = diskSink();
		this.cdp.on("Browser.downloadWillBegin", (event) => {
			this.downloadLog.apply({
				kind: "begin",
				guid: event.guid,
				url: event.url,
				suggestedFilename: event.suggestedFilename,
			});
		});
		this.cdp.on("Browser.downloadProgress", (event) => {
			this.downloadLog.apply({
				kind: "progress",
				guid: event.guid,
				state: event.state as DownloadState,
				...(event.totalBytes === undefined
					? {}
					: { totalBytes: event.totalBytes }),
				...(event.receivedBytes === undefined
					? {}
					: { receivedBytes: event.receivedBytes }),
				...("filePath" in event && typeof event.filePath === "string"
					? { filePath: event.filePath }
					: {}),
			});
			if (event.state === "completed") {
				const landed = this.downloadLog
					.all()
					.find((record) => record.guid === event.guid);
				if (landed?.filePath) this.written.push(landed.filePath);
			}
		});
		await this.cdp.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: this.bundle.dir,
			eventsEnabled: true,
			browserContextId: this.context.id,
		});
	}

	/** Files the page has handed back. */
	downloads(): readonly DownloadRecord[] {
		return this.downloadLog.all();
	}

	/** Where the page has been. */
	get history(): readonly LifecycleEvent[] {
		return this.lifecycleLog?.all() ?? [];
	}

	/**
	 * Pretend to be a different visitor, then report what the page
	 * actually experiences.
	 *
	 * The intent is kept whole and re-applied in full, because
	 * Chrome's media emulation forgets anything a call omits, so
	 * asking for reduced motion after asking for dark mode would
	 * otherwise turn the dark mode back off.
	 */
	/**
	 * Put the emulation back exactly as it was.
	 *
	 * emulate merges, which is right for a caller adding one
	 * condition and wrong for anything that has to undo itself: a
	 * merge cannot clear a field, so a sweep that widened the
	 * viewport could never restore a session that had none. This
	 * replaces the state wholesale.
	 */
	async restoreEmulation(state: EmulationState): Promise<void> {
		await this.ready();
		this.emulation = state;
		await this.applyEmulation();
	}

	async emulate(change: EmulationState = {}): Promise<{
		asked: EmulationState;
		observed: ObservedEnvironment;
		gaps: readonly Divergence[];
	}> {
		await this.ready();
		this.emulation = mergeEmulation(this.emulation, change);
		await this.applyEmulation();
		const observed = await this.observeEnvironment();
		return {
			asked: this.emulation,
			observed,
			gaps: divergences(this.emulation, observed),
		};
	}

	/** Put the whole standing intent to the browser. */
	private async applyEmulation(): Promise<void> {
		const state = this.emulation;

		await this.cdp.send("Emulation.setEmulatedMedia", {
			media: state.media ?? "",
			features: [...mediaFeaturesOf(state)],
		});
		await this.cdp.send("Emulation.setEmulatedVisionDeficiency", {
			type: state.vision ?? "none",
		});

		if (state.viewport) {
			await this.cdp.send("Emulation.setDeviceMetricsOverride", {
				width: state.viewport.width,
				height: state.viewport.height,
				deviceScaleFactor: state.viewport.deviceScaleFactor ?? 1,
				mobile: state.viewport.mobile ?? false,
			});
		} else {
			await this.cdp.send("Emulation.clearDeviceMetricsOverride");
		}

		await this.cdp.send("Emulation.setTouchEmulationEnabled", {
			enabled: state.touch ?? false,
			...(state.touch ? { maxTouchPoints: TOUCH_POINTS } : {}),
		});
		await this.cdp.send("Emulation.setCPUThrottlingRate", {
			rate: state.cpuThrottle ?? 1,
		});

		if (state.timezone !== undefined) {
			await this.cdp.send("Emulation.setTimezoneOverride", {
				timezoneId: state.timezone,
			});
		}
		if (state.locale !== undefined) {
			await this.cdp.send("Emulation.setLocaleOverride", {
				locale: state.locale,
			});
		}
		if (state.geolocation !== undefined) {
			await this.cdp.send("Emulation.setGeolocationOverride", {
				latitude: state.geolocation.latitude,
				longitude: state.geolocation.longitude,
				accuracy: state.geolocation.accuracy ?? GEOLOCATION_ACCURACY,
			});
		}
	}

	/** What the page says it is experiencing. */
	private async observeEnvironment(): Promise<ObservedEnvironment> {
		const { result } = await this.cdp.send("Runtime.evaluate", {
			expression: ENVIRONMENT_PROBE,
			returnByValue: true,
		});
		return result.value as ObservedEnvironment;
	}

	/** What this session has asked the browser to pretend. */
	get emulated(): EmulationState {
		return this.emulation;
	}

	/**
	 * Read what the page has kept.
	 *
	 * A store that cannot be read says why rather than coming
	 * back empty, since an empty store and an unreadable one lead
	 * to opposite conclusions.
	 */
	async storage(wanted: {
		local?: boolean;
		session?: boolean;
		cookies?: boolean;
		clipboard?: boolean;
	}): Promise<StorageSnapshot> {
		await this.ready();
		const snapshot: {
			local?: readonly (readonly [string, string])[];
			session?: readonly (readonly [string, string])[];
			cookies?: readonly CookieRecord[];
			clipboard?: string;
			unavailable: Record<string, string>;
		} = { unavailable: {} };

		if (wanted.local) {
			snapshot.local = await this.domStorage(true, snapshot.unavailable);
		}
		if (wanted.session) {
			snapshot.session = await this.domStorage(false, snapshot.unavailable);
		}
		if (wanted.cookies) {
			try {
				const { cookies } = await this.cdp.send("Network.getCookies");
				snapshot.cookies = cookies as CookieRecord[];
			} catch (err) {
				snapshot.unavailable.cookies = String(err);
			}
		}
		if (wanted.clipboard) {
			const read = await this.clipboard();
			if (read.ok) snapshot.clipboard = read.text;
			else snapshot.unavailable.clipboard = read.why;
		}

		const { unavailable, ...rest } = snapshot;
		return Object.keys(unavailable).length > 0
			? { ...rest, unavailable }
			: rest;
	}

	/** One of the two DOM stores, keyed by this frame's origin. */
	private async domStorage(
		isLocalStorage: boolean,
		unavailable: Record<string, string>,
	): Promise<readonly (readonly [string, string])[] | undefined> {
		const label = isLocalStorage ? "local storage" : "session storage";
		try {
			await this.cdp.send("DOMStorage.enable");
			const { entries } = await this.cdp.send("DOMStorage.getDOMStorageItems", {
				storageId: { securityOrigin: await this.origin(), isLocalStorage },
			});
			// The protocol types an entry as a loose string array; it
			// is always a key and a value, which is what the pair type
			// says and what the renderer reads.
			return entries.map((entry) => [entry[0] ?? "", entry[1] ?? ""] as const);
		} catch (err) {
			// A page on about:blank or a file url has no security
			// origin to key a store by, which is a fact about where we
			// are rather than a failure to report.
			unavailable[label] = String(err);
			return undefined;
		}
	}

	/** Put a value into one of the DOM stores. */
	async setStored(
		isLocalStorage: boolean,
		key: string,
		value: string,
	): Promise<void> {
		await this.ready();
		await this.cdp.send("DOMStorage.enable");
		await this.cdp.send("DOMStorage.setDOMStorageItem", {
			storageId: { securityOrigin: await this.origin(), isLocalStorage },
			key,
			value,
		});
	}

	/** Empty the stores named, and only those. */
	async clearStorage(wanted: {
		local?: boolean;
		session?: boolean;
		cookies?: boolean;
	}): Promise<void> {
		await this.ready();
		if (wanted.local || wanted.session) {
			await this.cdp.send("DOMStorage.enable");
			const securityOrigin = await this.origin();
			if (wanted.local) {
				await this.cdp.send("DOMStorage.clear", {
					storageId: { securityOrigin, isLocalStorage: true },
				});
			}
			if (wanted.session) {
				await this.cdp.send("DOMStorage.clear", {
					storageId: { securityOrigin, isLocalStorage: false },
				});
			}
		}
		if (wanted.cookies) await this.cdp.send("Network.clearBrowserCookies");
	}

	/**
	 * Read the clipboard.
	 *
	 * Chrome refuses this unless the permission is granted against
	 * the browser context, not merely the origin, and unless the
	 * read is attributed to a user gesture. Both were measured;
	 * either alone still gets a refusal.
	 */
	private async clipboard(): Promise<
		{ ok: true; text: string } | { ok: false; why: string }
	> {
		try {
			await this.grantClipboard();
			const { result } = await this.cdp.send("Runtime.evaluate", {
				expression: "navigator.clipboard.readText()",
				awaitPromise: true,
				userGesture: true,
				returnByValue: true,
			});
			return { ok: true, text: String(result.value ?? "") };
		} catch (err) {
			return { ok: false, why: String(err) };
		}
	}

	/** Put text on the clipboard. */
	async writeClipboard(text: string): Promise<void> {
		await this.ready();
		await this.grantClipboard();
		await this.cdp.send("Runtime.evaluate", {
			expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
			awaitPromise: true,
			userGesture: true,
		});
	}

	/** Ask for clipboard access against this context. */
	private async grantClipboard(): Promise<void> {
		await this.cdp.send("Browser.grantPermissions", {
			origin: await this.origin(),
			browserContextId: this.context.id,
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
		});
	}

	/** The origin the current page's stores are keyed by. */
	private async origin(): Promise<string> {
		return new URL(this.page.url()).origin;
	}

	/**
	 * Bend the network: mock a reply, block a request, slow it all
	 * down, or stop pretending.
	 *
	 * Interception is only attached while there is a rule to
	 * apply. Every paused request has to be answered or the page
	 * waits on it forever, so an interceptor with nothing to say
	 * is a liability rather than a neutral bystander.
	 */
	async shape(change: {
		rules?: readonly NetworkRule[];
		throttle?: ThrottleConditions;
		clear?: boolean;
	}): Promise<{
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	}> {
		await this.ready();

		if (change.clear) {
			this.rules = [];
			this.throttle = undefined;
		} else {
			if (change.rules) this.rules = [...this.rules, ...change.rules];
			if (change.throttle) this.throttle = change.throttle;
		}

		await this.cdp.send("Network.emulateNetworkConditions", {
			offline: this.throttle?.offline ?? false,
			latency: this.throttle?.latency ?? 0,
			// The protocol reads -1 as no limit, which is not the same
			// as zero, and zero would mean nothing may pass at all.
			downloadThroughput: this.throttle?.download || -1,
			uploadThroughput: this.throttle?.upload || -1,
		});

		if (this.rules.length === 0) {
			if (this.intercepting) {
				await this.cdp.send("Fetch.disable");
				this.intercepting = false;
			}
		} else if (!this.intercepting) {
			this.cdp.on("Fetch.requestPaused", (event) => {
				void this.answerPaused(event);
			});
			await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
			this.intercepting = true;
		}

		return { rules: this.rules, throttle: this.throttle };
	}

	/**
	 * Decide what a paused request gets.
	 *
	 * Whatever happens, it is answered. A handler that throws and
	 * says nothing leaves the page waiting forever on a request
	 * the browser has already stopped for us.
	 */
	private async answerPaused(event: {
		requestId: string;
		request: { url: string };
	}): Promise<void> {
		const rule = ruleFor(this.rules, event.request.url);
		try {
			if (rule?.action === "block") {
				await this.cdp.send("Fetch.failRequest", {
					requestId: event.requestId,
					errorReason: (rule.reason ??
						"BlockedByClient") as Protocol.Network.ErrorReason,
				});
				return;
			}
			if (rule?.action === "mock") {
				await this.cdp.send("Fetch.fulfillRequest", {
					requestId: event.requestId,
					responseCode: rule.status ?? 200,
					responseHeaders: [
						{
							name: "content-type",
							value: rule.contentType ?? "text/plain",
						},
					],
					body: Buffer.from(rule.body ?? "").toString("base64"),
				});
				return;
			}
			await this.cdp.send("Fetch.continueRequest", {
				requestId: event.requestId,
			});
		} catch {
			// The request may already be resolved, or the page may have
			// navigated out from under it. Either way there is nothing
			// left to answer and nothing worth reporting.
		}
	}

	/**
	 * Press a chord, or a sequence of them.
	 *
	 * Dispatch goes through the driver's keyboard rather than the
	 * protocol directly, because the driver owns the layout table
	 * that turns a key name into a code, a virtual key number and
	 * the text it produces. Keeping a second opinion about that
	 * would be a second thing to be wrong about.
	 */
	async press(
		keys: string,
	): Promise<{ pressed: readonly string[] } | { refusal: ChordRefusal }> {
		await this.ready();
		const parsed = parseChords(keys, KNOWN_KEYS);
		if ("refusal" in parsed) return parsed;

		const pressed: string[] = [];
		for (const chord of parsed.chords) {
			for (const modifier of chord.modifiers) {
				await this.page.keyboard.down(modifier);
			}
			await this.page.keyboard.press(chord.key as KeyInput);
			for (const modifier of [...chord.modifiers].reverse()) {
				await this.page.keyboard.up(modifier);
			}
			pressed.push([...chord.modifiers, chord.key].join("+"));
		}
		return { pressed };
	}

	/** Send raw text as keystrokes, wherever focus happens to be. */
	async typeRaw(text: string): Promise<void> {
		await this.ready();
		await this.page.keyboard.type(text);
	}

	/** Dispatch a composed mouse gesture. */
	async pointerGesture(steps: readonly PointerEventStep[]): Promise<void> {
		await this.ready();
		for (const step of steps) {
			await this.cdp.send("Input.dispatchMouseEvent", {
				type: step.type,
				x: step.x,
				y: step.y,
				button: step.button,
				clickCount: step.clickCount,
			});
		}
	}

	/** Scroll by wheel, which is not the same as scrolling by script. */
	async wheel(at: Point, byX: number, byY: number): Promise<void> {
		await this.ready();
		await this.cdp.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: at.x,
			y: at.y,
			deltaX: byX,
			deltaY: byY,
			button: "none",
			clickCount: 0,
		});
	}

	/**
	 * Dispatch a composed touch gesture.
	 *
	 * Touch events reach the page whether or not touch emulation
	 * is on, so this never refuses. What emulation changes is what
	 * the page believes about itself: maxTouchPoints and the
	 * coarse-pointer media query. A page that decides at load time
	 * whether to attach touch handlers will not have attached any,
	 * and the gesture lands on nothing, so the caller is told
	 * rather than stopped.
	 */
	async touchGesture(steps: readonly TouchStep[]): Promise<void> {
		await this.ready();
		for (const step of steps) {
			await this.cdp.send("Input.dispatchTouchEvent", {
				type: step.type,
				touchPoints: step.points.map((point) => ({
					x: point.x,
					y: point.y,
					id: point.id,
				})),
			});
			if (step.pauseMs) {
				await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
			}
		}
	}

	/**
	 * Walk the page with the Tab key and report what happened.
	 *
	 * This is one of the two reads that deliberately change the
	 * page, since there is no way to learn where focus goes
	 * without moving it. Focus is put back afterwards and the
	 * result says so.
	 *
	 * The walk runs to twice the number of focusable things plus a
	 * little, which is enough for a healthy page to come round
	 * twice and for a trap to show its cycle. Stopping sooner
	 * would report a trap as a short page.
	 */
	async keyboardWalk(maxStops?: number): Promise<WalkCapture> {
		await this.ready();

		// Remember where the caller's focus and viewport were before
		// disturbing either, so the page can be handed back as found.
		await this.evaluateJson(WALK_REMEMBER);

		// Start from the top of the document so the first Tab lands
		// where a reader arriving at the page would land, not
		// wherever something happened to leave focus.
		//
		// This has to happen before the resting styles are collected,
		// not after. A dialog opened with showModal focuses its first
		// control, so collecting first recorded that control's focused
		// appearance as its resting one, and comparing the two later
		// found no difference and reported a perfectly visible focus
		// ring as missing.
		await this.page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		});

		const collected = await this.evaluateJson<{
			candidates: WalkCandidate[];
			unreachable: Unreachable[];
		}>(WALK_COLLECT);

		const cap = Math.min(
			maxStops ?? collected.candidates.length * 2 + WALK_SLACK,
			MAX_WALK_STOPS,
		);

		const stops: WalkStop[] = [];
		for (let step = 0; step < cap; step += 1) {
			await this.page.keyboard.press("Tab");
			const stop = await this.evaluateJson<WalkStop & { focused: unknown }>(
				WALK_READ,
			);
			if (stop.focused === null) {
				stops.push({ ...stop, focused: BLANK_STYLE });
				continue;
			}
			stops.push(stop as WalkStop);
		}

		// If the walk ended stuck somewhere smaller than the page,
		// find out whether a keyboard user has any way back. That is
		// the difference between a modal and a dead end.
		//
		// The test used to be "any index repeats in the last four
		// stops", which every page whose tab cycle is three stops or
		// shorter satisfies on a healthy run, so Escape was pressed on
		// ordinary login forms. A page is only worth probing when the
		// loop it settled into is smaller than the set of things it
		// could have reached.
		let escapeFreed: boolean | undefined;
		const tail = stops.slice(-WALK_STUCK_SAMPLE).map((stop) => stop.index);
		const reached = new Set(
			stops.map((stop) => stop.index).filter((index) => index >= 0),
		);
		const loopedSmall =
			tail.length > 0 &&
			new Set(tail).size < tail.length &&
			reached.size < collected.candidates.length;
		if (loopedSmall) {
			const before = tail.at(-1);
			await this.page.keyboard.press("Escape");
			await this.page.keyboard.press("Tab");
			const after = await this.evaluateJson<WalkStop>(WALK_READ);
			escapeFreed = after.index !== before && !tail.includes(after.index);
		}

		await this.evaluateJson(WALK_RESTORE);

		// A walk that used its whole budget has not necessarily seen
		// the page. Saying so is what stops everything it did not
		// reach being reported as unreachable.
		const exhausted =
			stops.length >= cap && reached.size < collected.candidates.length;

		return {
			candidates: collected.candidates,
			stops,
			unreachable: collected.unreachable,
			...(escapeFreed === undefined ? {} : { escapeFreed }),
			...(exhausted ? { cappedAt: cap } : {}),
		};
	}

	/**
	 * The whole page flattened, frames and shadow content
	 * included.
	 *
	 * The style properties have to be named up front because the
	 * protocol returns their values as a bare array positioned
	 * against the request. Asking for a handful keeps the snapshot
	 * small; asking for none still gives geometry and structure.
	 */
	async snapshot(
		styleProperties: readonly string[] = SNAPSHOT_STYLES,
	): Promise<readonly IndexedNode[]> {
		await this.ready();
		const raw = await this.cdp.send("DOMSnapshot.captureSnapshot", {
			computedStyles: [...styleProperties],
			includeDOMRects: true,
		});
		return flattenSnapshot(raw as unknown as RawSnapshot, styleProperties);
	}

	/**
	 * Run an expression in the page and describe what came back.
	 *
	 * The value is serialized inside the page rather than by the
	 * protocol, because the protocol does not decline politely: a
	 * circular object rejects the whole call with "object
	 * reference chain is too long", losing the evaluation and any
	 * account of it together.
	 *
	 * The protocol can still fail for its own reasons, so that is
	 * caught too and returned as a refusal rather than thrown. An
	 * expression that kills the session is not a useful tool.
	 */
	async evaluate(expression: string): Promise<EvalOutcome> {
		await this.ready();
		try {
			const response = await this.cdp.send("Runtime.evaluate", {
				expression: evaluationSource(expression),
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			});
			if (response.exceptionDetails) {
				const threw = describeThrow(response.exceptionDetails);
				return {
					ok: false,
					threw: {
						...threw,
						frames: await this.resolveFrames(threw.frames),
					},
				};
			}
			const value = response.result.value as EvalValue | undefined;
			if (!value) {
				return {
					ok: false,
					refused: "The page returned nothing the serializer could read.",
				};
			}
			return { ok: true, result: value };
		} catch (error) {
			return {
				ok: false,
				refused:
					`The browser refused to run that: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Run axe-core against the page and read back its findings.
	 *
	 * axe is injected fresh on every call rather than kept across
	 * navigations. It is half a megabyte, but a navigation clears
	 * the world, and an audit that silently reported nothing
	 * because the library went away with the last page would be
	 * worse than a slow one.
	 *
	 * Only violations and incomplete results are asked for. Passes
	 * and inapplicable rules together outweigh them by an order of
	 * magnitude and answer a question nobody asks.
	 */
	async audit(): Promise<readonly A11yFinding[]> {
		await this.ready();
		const source = await readFile(axeSource(), "utf8");
		await this.cdp.send("Runtime.evaluate", { expression: source });
		const response = await this.cdp.send("Runtime.evaluate", {
			expression:
				'axe.run(document, { resultTypes: ["violations", "incomplete"] })',
			awaitPromise: true,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`axe could not run: ${threw.message}`);
		}
		return readAxeRun((response.result.value ?? {}) as RawAxeRun);
	}

	/**
	 * The page as the structural rules need to see it.
	 *
	 * Two accounts from the browser, joined on the backend node id
	 * they share: the snapshot for attributes and layout, the
	 * accessibility tree for roles and names. Neither carries
	 * both, and every structural rule needs both.
	 */
	async structure(): Promise<readonly StructureNode[]> {
		const [nodes, tree] = await Promise.all([
			this.snapshot(),
			this.cdp.send("Accessibility.getFullAXTree") as Promise<{
				nodes: RawAxNode[];
			}>,
		]);
		const facts: AxFacts[] = [];
		for (const axNode of tree.nodes) {
			if (axNode.backendDOMNodeId === undefined) continue;
			const focusable = axNode.properties?.find(
				(property) => property.name === "focusable",
			);
			facts.push({
				backendNodeId: axNode.backendDOMNodeId,
				...(axNode.role?.value === undefined
					? {}
					: { role: axNode.role.value }),
				...(axNode.name?.value === undefined
					? {}
					: { name: axNode.name.value }),
				focusable: focusable?.value?.value === true,
			});
		}
		return buildStructure(nodes, facts);
	}

	/**
	 * What the layout actually did, as the browser measured it.
	 *
	 * Read in one page-side pass rather than a protocol call per
	 * element: a page of any size would otherwise cost thousands
	 * of round trips to answer one question.
	 */
	/**
	 * Every pointer target on the page, with the facts WCAG 2.5.8
	 * needs to judge its size.
	 *
	 * Separate from layout() because the two ask different
	 * questions: layout wants everything drawn, this wants only
	 * what a finger has to hit, plus the two exceptions the
	 * criterion turns on.
	 */
	async targets(): Promise<readonly CapturedTarget[]> {
		await this.ready();
		const response = await this.cdp.send("Runtime.evaluate", {
			expression: TARGET_CAPTURE,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not measure the targets: ${threw.message}`);
		}
		return response.result.value as readonly CapturedTarget[];
	}

	async layout(): Promise<{
		readonly nodes: readonly VisualNode[];
		readonly viewport: PageBox;
	}> {
		await this.ready();
		const response = await this.cdp.send("Runtime.evaluate", {
			expression: visualCaptureSource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not read the layout: ${threw.message}`);
		}
		return response.result.value as {
			nodes: readonly VisualNode[];
			viewport: PageBox;
		};
	}

	/**
	 * What the page is built from, sampled element by element.
	 *
	 * Read in one page-side pass, and filtered there rather than
	 * here: an inherited value is not a decision, and carrying
	 * every element's inherited colour back only to discard it
	 * would be most of the payload.
	 */
	async styleSamples(): Promise<readonly StyleSample[]> {
		await this.ready();
		const response = await this.cdp.send("Runtime.evaluate", {
			expression: inventorySource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not sample the styles: ${threw.message}`);
		}
		return (response.result.value ?? []) as readonly StyleSample[];
	}

	/**
	 * Install the performance observers ahead of every page.
	 *
	 * Largest contentful paint and layout shift are events rather
	 * than state, so an observer registered after a page loads has
	 * missed them. The buffered flag recovers the timings but not
	 * the element that painted or the nodes that moved, which is
	 * the half worth having, so this goes in through the hook that
	 * runs before the document does.
	 */
	private async watchVitals(): Promise<void> {
		await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
			source: observerBootstrap(),
		});
	}

	/** What the current page cost to show. */
	async vitals(): Promise<Vitals> {
		await this.ready();
		const response = await this.cdp.send("Runtime.evaluate", {
			expression: readVitalsSource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			return { shifts: [], longTasks: [], paints: {}, error: threw.message };
		}
		return response.result.value as Vitals;
	}

	/** Run a page-side source string and read back its value. */
	private async evaluateJson<T>(source: string): Promise<T> {
		const { result } = await this.cdp.send("Runtime.evaluate", {
			expression: source,
			returnByValue: true,
		});
		return result.value as T;
	}

	/** Whether the page believes it is being touched. */
	get touchEmulated(): boolean {
		return this.emulation.touch === true;
	}

	/**
	 * Wait for the page to reach a state, and say what happened.
	 *
	 * The timeout is a real answer rather than an error. A page
	 * that never reaches the state is the finding, so the outcome
	 * carries what was true instead.
	 */
	async waitFor(
		condition: WaitCondition,
		timeoutMs: number = DEFAULT_WAIT_MS,
	): Promise<WaitOutcome> {
		await this.ready();
		const startedAt = Date.now();
		const waited = () => Date.now() - startedAt;

		if (condition.kind === "duration") {
			await new Promise((resolve) => setTimeout(resolve, condition.ms));
			return { met: true, waitedMs: waited(), condition };
		}

		while (waited() < timeoutMs) {
			const reached = await this.check(condition);
			if (reached.met) {
				return {
					met: true,
					waitedMs: waited(),
					condition,
					...(reached.detail === undefined ? {} : { detail: reached.detail }),
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
		}

		const missed = await this.check(condition);
		return {
			met: false,
			waitedMs: waited(),
			condition,
			...(missed.saw === undefined ? {} : { saw: missed.saw }),
		};
	}

	/**
	 * Now, on the protocol's clock, so it can be compared with
	 * what requests carry.
	 *
	 * Before any request has been seen there is no offset to
	 * apply, but there are also no requests to compare against,
	 * so the figure cannot mislead anyone.
	 */
	private protocolNow(): number {
		return Date.now() / MS_PER_SECOND - (this.clockOffset ?? 0);
	}

	/** Look once: is the condition true right now? */
	private async check(
		condition: WaitCondition,
	): Promise<{ met: boolean; detail?: string; saw?: string }> {
		switch (condition.kind) {
			case "selector":
			case "gone": {
				const found = await this.page.$(condition.selector).catch(() => null);
				const present = found !== null;
				if (found) await found.dispose();
				const met = condition.kind === "selector" ? present : !present;
				return {
					met,
					...(met
						? {}
						: {
								saw: present
									? "It is still there."
									: "Nothing matches that selector.",
							}),
				};
			}
			case "text": {
				const has = await this.page
					.evaluate(
						(needle: string) =>
							(document.body?.innerText ?? "").includes(needle),
						condition.text,
					)
					.catch(() => false);
				return {
					met: has,
					...(has ? {} : { saw: "The page does not contain it." }),
				};
			}
			case "idle": {
				const requests = this.requests();
				const met = isIdle(requests, condition.quietMs, this.protocolNow());
				const busy = inFlight(requests);
				return {
					met,
					...(met
						? {}
						: {
								saw:
									busy.length > 0
										? `${busy.length} still in flight, including ` +
											`${busy[0]?.url}.`
										: "The page keeps starting new requests.",
							}),
				};
			}
			case "request": {
				const matched = this.requests().filter(
					(request) =>
						matchesPattern({
							pattern: condition.pattern,
							url: request.url,
						}) && request.state !== "pending",
				);
				const last = matched.at(-1);
				if (!last) {
					const pending = this.requests().filter((request) =>
						matchesPattern({
							pattern: condition.pattern,
							url: request.url,
						}),
					);
					return {
						met: false,
						saw:
							pending.length > 0
								? `${pending.length} matching, none finished yet.`
								: "Nothing has requested it.",
					};
				}
				return {
					met: true,
					detail:
						last.state === "complete"
							? `${last.method} ${last.url} answered ${last.status}.`
							: `${last.method} ${last.url} ${last.state}: ${last.failure}.`,
				};
			}
			case "animations": {
				const running = await this.page
					.evaluate(
						() =>
							document
								.getAnimations()
								.filter((animation) => animation.playState === "running")
								.length,
					)
					.catch(() => 0);
				return {
					met: running === 0,
					...(running === 0
						? {}
						: { saw: `${running} animations are still running.` }),
				};
			}
			case "duration":
				return { met: true };
		}
	}

	/**
	 * Everything this session has accumulated, in one reading.
	 *
	 * Emulation, interception and dialog policy all change what
	 * every other reading means, and none of them is visible in
	 * those readings, so they are gathered here.
	 */
	async status(): Promise<SessionStatus> {
		await this.ready();
		const logs = this.logs();
		const heard = await this.heard(0);
		const requests = this.requests();
		return {
			name: this.name,
			url: this.page.url(),
			title: await this.page.title().catch(() => ""),
			emulation: this.emulation,
			rules: this.rules,
			...(this.throttle === undefined ? {} : { throttle: this.throttle }),
			dialogPolicy: this.dialogPolicy,
			dialogsSeen: this.dialogLog.length,
			logs: { count: logs.entries.length, cursor: logs.cursor },
			announcements: { count: heard.entries.length, cursor: heard.cursor },
			requests: {
				count: requests.length,
				failed: requests.filter((request) => request.state === "failed").length,
			},
			history: this.history,
			artifacts: this.written,
		};
	}

	/** How the network is currently being bent. */
	get shaping(): {
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	} {
		return { rules: this.rules, throttle: this.throttle };
	}

	private async listenForAnnouncements(): Promise<void> {
		await this.page.exposeFunction(
			ANNOUNCE_BINDING,
			(candidate: AnnouncementCandidate) => {
				this.pending = this.pending.then(() => this.recordIfLive(candidate));
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
	async heard(since = 0): Promise<{
		entries: readonly Recorded<Announcement>[];
		cursor: number;
		dropped: number;
	}> {
		// A candidate raised a moment ago is still being ruled on.
		// Answering before the browser has spoken would report
		// silence for something the page just said.
		await this.pending;
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

	/**
	 * Photograph the page, or one element of it.
	 *
	 * Images never come back inline: a screenshot is far larger
	 * than any response budget and would crowd out the reading it
	 * was meant to illustrate. They go to the session's bundle
	 * directory and the answer carries the paths.
	 *
	 * A full-page capture is tiled, because a long page makes an
	 * image taller than a model will accept. The tiling and its
	 * ceiling are the ones web_read already uses, so a page reads
	 * the same either way.
	 */
	async shoot(options: ShotOptions = {}): Promise<ShotResult> {
		const target = options.target;
		let held: number | undefined;
		try {
			if (target) {
				const tree = await this.axTree();
				const resolution = resolveTarget(tree, target);
				if (resolution.kind === "notFound") {
					return { ok: false, refusal: notFoundRefusal(tree, target) };
				}
				if (resolution.kind === "ambiguous") {
					return { ok: false, refusal: ambiguityRefusal(tree, target) };
				}
				held = resolution.backendDomId;
			}

			if (options.state !== undefined) {
				await this.holdState(held, options.state);
			}
			return { ok: true, shot: await this.capture(held, options) };
		} finally {
			if (options.state !== undefined) await this.holdState(held, undefined);
		}
	}

	/** Force or release a state for the duration of a capture. */
	private async holdState(
		backendNodeId: number | undefined,
		state: PseudoState | undefined,
	): Promise<void> {
		if (backendNodeId === undefined) return;
		const nodeId = await this.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return;
		await this.cdp
			.send("CSS.forcePseudoState", {
				nodeId,
				forcedPseudoClasses: state ? [state] : [],
			})
			// A page that navigated took the forced state with it.
			.catch(() => {});
		const objectId = await this.objectFor(backendNodeId);
		try {
			// Photographing mid-transition catches a state part way
			// there, which is the one thing a picture must not do.
			if (objectId) await this.settle(objectId);
		} finally {
			await this.release(objectId);
		}
	}

	/** Take the picture and write it out. */
	private async capture(
		backendNodeId: number | undefined,
		options: ShotOptions,
	): Promise<Shot> {
		if (!this.bundle) this.bundle = diskSink();
		const sink = this.bundle;
		this.shots += 1;
		const stamp = String(this.shots).padStart(2, "0");

		const keep = (path: string): string => {
			this.written.push(path);
			return path;
		};

		if (backendNodeId !== undefined) {
			const box = await this.boxOf(backendNodeId);
			const clip = box?.border;
			const data = await this.page.screenshot({
				type: "png",
				encoding: "base64",
				...(clip
					? {
							clip: {
								x: clip.x,
								y: clip.y,
								width: clip.width,
								height: clip.height,
							},
						}
					: {}),
			});
			return {
				paths: [keep(sink.writeBinary(`element-${stamp}.png`, String(data)))],
				truncated: false,
				width: Math.round(clip?.width ?? 0),
				height: Math.round(clip?.height ?? 0),
			};
		}

		if (options.fullPage) {
			const captured = await captureTiles(this.page);
			return {
				paths: captured.tiles.map((tile, index) =>
					keep(
						sink.writeBinary(
							`page-${stamp}-${String(index + 1).padStart(2, "0")}.png`,
							tile,
						),
					),
				),
				truncated: captured.truncated,
				width: 0,
				height: 0,
			};
		}

		const data = await this.page.screenshot({
			type: "png",
			encoding: "base64",
		});
		const seen = await this.viewport();
		return {
			paths: [keep(sink.writeBinary(`viewport-${stamp}.png`, String(data)))],
			truncated: false,
			width: seen?.width ?? 0,
			height: seen?.height ?? 0,
		};
	}

	/**
	 * Compare the page now against a baseline of it, or record
	 * one when there is none.
	 *
	 * A missing baseline is not a failure. The first run of any
	 * comparison has nothing to compare against, and refusing
	 * would make the tool need a setup step it can perform itself.
	 *
	 * The elements are read after the shot rather than before, so
	 * a region is attributed against the layout that was actually
	 * photographed.
	 */
	async compareToBaseline(
		label: string,
		options: { readonly update?: boolean; readonly threshold?: number } = {},
	): Promise<{
		readonly comparison: Comparison | undefined;
		readonly recorded?: string;
		readonly artifacts: readonly string[];
	}> {
		await this.ready();
		const safe = label.replace(/[^a-zA-Z0-9._-]+/g, "-");
		const baselinePath = path.join(this.baselineDir(), `${safe}.png`);

		const shot = Buffer.from(
			String(await this.page.screenshot({ type: "png", encoding: "base64" })),
			"base64",
		);

		const takenUnder = this.provenance();
		if (options.update || !existsSync(baselinePath)) {
			mkdirSync(path.dirname(baselinePath), {
				recursive: true,
				mode: DIR_MODE,
			});
			writeFileSync(baselinePath, shot, { mode: FILE_MODE });
			writeFileSync(sidecarFor(baselinePath), stringify(takenUnder), {
				mode: FILE_MODE,
			});
			this.written.push(baselinePath);
			return { comparison: undefined, recorded: baselinePath, artifacts: [] };
		}

		// Refuse rather than diff two different subjects. A baseline
		// recorded before this library stored provenance has none, and
		// is compared as before rather than being thrown away.
		const sidecar = sidecarFor(baselinePath);
		const was = existsSync(sidecar)
			? parseProvenance(readFileSync(sidecar, "utf8"))
			: undefined;
		const differs = was && describeDrift(was, takenUnder);
		if (differs) {
			return {
				comparison: { kind: "incomparable", because: differs },
				artifacts: [],
			};
		}

		const { nodes } = await this.layout();
		const placed = nodes.map((node) => ({
			selector: node.selector,
			rect: node.rect,
		}));

		const { comparison, image } = compareImages(
			readPng(readFileSync(baselinePath)),
			readPng(shot),
			placed,
			{
				...(options.threshold === undefined
					? {}
					: { threshold: options.threshold }),
				scale: this.emulation.viewport?.deviceScaleFactor ?? 1,
			},
		);

		if (image === undefined) return { comparison, artifacts: [] };

		// The three together, because a diff on its own shows where
		// something changed and never what it changed from.
		if (!this.bundle) this.bundle = diskSink();
		const sink = this.bundle;
		const stamp = String(++this.shots).padStart(2, "0");
		const artifacts = [
			sink.writeBinary(
				`${safe}-${stamp}-baseline.png`,
				readFileSync(baselinePath).toString("base64"),
			),
			sink.writeBinary(`${safe}-${stamp}-current.png`, shot.toString("base64")),
			sink.writeBinary(`${safe}-${stamp}-diff.png`, image.toString("base64")),
		];
		this.written.push(...artifacts);
		return { comparison, artifacts };
	}

	/**
	 * Where this session's baselines live.
	 *
	 * Under the data directory, not the bundle root. This used to
	 * sit at BUNDLE_ROOT/baselines, which the bundle reaper treats
	 * as an ownerless directory (the name is not a pid) and deletes
	 * once it is six hours old. Writing a baseline touches the
	 * session subdirectory rather than its parent, so the parent's
	 * age kept climbing and a stable set of baselines was reaped on
	 * a timer. The next comparison then found nothing, recorded the
	 * current page as truth and reported a warning, which is data
	 * loss wearing a first run's clothes.
	 *
	 * A baseline is a durable artifact the user asked for and may
	 * want to look at, which is what dataDir is for.
	 */
	private baselineDir(): string {
		return path.join(dataDir("browser-integration"), "baselines", this.name);
	}

	/**
	 * What a baseline was taken under, stored beside the image.
	 *
	 * Without this a comparison cannot tell a regression from a
	 * change of subject: record on one page, navigate to another,
	 * and the diff reports confident failures attributed to the
	 * second page's elements. The size check alone cannot see it,
	 * because two pages at one viewport are the same size.
	 */
	private provenance(): BaselineProvenance {
		const viewport = this.emulation.viewport;
		return {
			url: this.url,
			...(viewport?.width === undefined ? {} : { width: viewport.width }),
			...(viewport?.height === undefined ? {} : { height: viewport.height }),
			deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
		};
	}

	/** Carry out an action against an element judged ready. */
	private async perform(
		action: TargetedAction,
		element: ElementHandle,
		backendNodeId: number,
	): Promise<void> {
		switch (action.kind) {
			case "click":
				await element.click();
				return;
			case "type":
				await element.type(action.text);
				return;
			case "hover":
				await element.hover();
				return;
			case "focus":
				await element.focus();
				return;
			case "select":
				await element.select(action.text);
				return;
			case "scrollTo":
				await element.scrollIntoView();
				return;
			case "clear": {
				// Select what is there and delete it, so the page sees
				// the same input and change events it would from a
				// person at a keyboard. The field is asked to select
				// itself rather than triple clicked, so clearing works
				// under an overlay, and rather than sending a select-all
				// shortcut, so there is no platform to guess at.
				await element.focus();
				// Resolved through our own session: an identifier minted
				// by puppeteer's connection means nothing on this one.
				const objectId = await this.objectFor(backendNodeId);
				try {
					if (objectId) {
						await this.cdp.send("Runtime.callFunctionOn", {
							objectId,
							functionDeclaration: SELECT_TEXT_PROBE,
							returnByValue: true,
						});
					}
				} finally {
					await this.release(objectId);
				}
				await this.page.keyboard.press("Backspace");
				return;
			}
		}
	}

	/**
	 * Wait until an element can actually be acted on.
	 *
	 * A click on an element that is not ready does nothing and
	 * says nothing, leaving a caller believing the page was acted
	 * on. So readiness is established first, and when the budget
	 * runs out the condition still in the way is reported rather
	 * than the action being attempted regardless.
	 */
	private async awaitReady(
		target: Target,
		pointer: boolean,
	): Promise<
		{ ready: true; waitedMs: number; backendDomId: number } | Blocked
	> {
		const started = Date.now();
		let previous: Rect | undefined;
		let last: Actionability = {
			ready: false,
			blocker: "it is not in the page",
		};

		while (Date.now() - started < READY_BUDGET_MS) {
			const look = await this.readinessOf(target, previous, pointer);
			previous = look.box;
			last = judgeActionability(look.facts);
			if (last.ready && look.backendDomId !== undefined) {
				return {
					ready: true,
					waitedMs: Date.now() - started,
					backendDomId: look.backendDomId,
				};
			}
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
		}
		return {
			ready: false,
			waitedMs: Date.now() - started,
			blocker: last.blocker ?? "it never became ready",
		};
	}

	/** One look at whether an element is ready. */
	private async readinessOf(
		target: Target,
		previous: Rect | undefined,
		pointer: boolean,
	): Promise<{
		facts: ActionabilityFacts;
		box: Rect | undefined;
		backendDomId?: number;
	}> {
		const tree = await this.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind !== "resolved") {
			return {
				facts: { present: false, enabled: false, settled: false },
				box: undefined,
			};
		}

		const node = subtreeAt(tree, resolution.backendDomId);
		const box = await this.boxOf(resolution.backendDomId);

		// Where the click lands only matters when there is a click.
		// Focusing, typing, choosing an option and scrolling all
		// reach an element the pointer could not, so holding them to
		// a pointer's standard refuses work that would have
		// succeeded. Being rendered at a real size still matters to
		// every action, so that part of the verdict always applies.
		const viewport = pointer ? await this.viewport() : undefined;
		const coveredBy =
			pointer && box
				? await this.coveredAtCentre(resolution.backendDomId, box)
				: undefined;
		const visibility = judgeVisibility({
			rendered: box !== undefined,
			...(box === undefined ? {} : { border: box.border }),
			...(viewport === undefined ? {} : { viewport }),
			...(coveredBy === undefined ? {} : { coveredBy }),
		});
		return {
			facts: {
				present: true,
				visibility,
				// The tree reports what the browser exposes to assistive
				// technology, which is the same disabled a person meets.
				enabled: node?.properties.disabled !== true,
				settled: sameBox(previous, box?.border),
			},
			box: box?.border,
			backendDomId: resolution.backendDomId,
		};
	}

	/**
	 * Whether something is painted over the element's centre.
	 *
	 * Only the centre, unlike a full inspection: this runs on
	 * every poll, and the centre is where a click is aimed.
	 */
	private async coveredAtCentre(
		backendNodeId: number,
		box: BoxModel,
	): Promise<string | undefined> {
		const objectId = await this.objectFor(backendNodeId);
		if (!objectId) return undefined;
		try {
			return await this.hitTest(objectId, centreOf(box.border));
		} finally {
			await this.release(objectId);
		}
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
			const trace = traceProperty(
				normalizeCascade(raw),
				property,
				styles?.[property],
			);
			return trace === undefined ? undefined : await this.authorTrace(trace);
		} catch {
			// The cascade domain needs the CSS agent; without it the
			// rest of the inspection is still worth returning.
			return undefined;
		}
	}

	/**
	 * Tell each declaration in a trace where it was written.
	 *
	 * A build step that rewrote the CSS makes the reported line
	 * useless in the same way a minified stack frame is: it names
	 * a file nobody edits. The winner is usually the declaration
	 * somebody wants to go and change, so it is the one that most
	 * needs an address that exists.
	 */
	private async authorTrace(trace: PropertyTrace): Promise<PropertyTrace> {
		const declarations = await Promise.all(
			trace.declarations.map(async (declaration) => {
				const { source } = declaration;
				if (source?.styleSheet === undefined || source.line === undefined) {
					return declaration;
				}
				const url = this.sheetUrls.get(source.styleSheet);
				if (url === undefined) return declaration;
				const map = await this.mapFor(url);
				if (!map) return declaration;
				const authored = authoredPosition(map, {
					line: source.line,
					column: source.column ?? 0,
				});
				if (authored === undefined) return declaration;
				return { ...declaration, source: { ...source, authored } };
			}),
		);
		// The winner is compared by identity, so it has to be
		// re-found among the rebuilt declarations rather than kept.
		const winnerAt = trace.winner
			? trace.declarations.indexOf(trace.winner)
			: -1;
		return {
			...trace,
			declarations,
			...(winnerAt < 0 ? {} : { winner: declarations[winnerAt] }),
		};
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

		// Drive the real element through puppeteer's aria selector, which
		// brings the scrolling, visibility and hit testing that a raw
		// protocol click does not. But the selector is page-wide and knows
		// nothing of a container, and its ordering is its own, so the
		// candidate that matches is chosen by the identity the resolution
		// already settled rather than by position in a second list.
		// Choosing by index here is how a click lands on the wrong row.
		const handles = await this.page.$$(
			`aria/${target.name}[role="${target.role}"]`,
		);
		let element: ElementHandle | undefined;
		for (const handle of handles) {
			if (
				element === undefined &&
				(await this.backendIdOf(handle)) === resolution.backendDomId
			) {
				element = handle;
				continue;
			}
			await handle.dispose();
		}
		// The outline named a node the aria selector does not offer: the
		// page moved, or the two matchers disagree. Refusing is the only
		// honest answer, because any handle we still hold is a guess.
		if (!element) return { ok: false, refusal: notFoundRefusal(tree, target) };
		return { ok: true, element };
	}

	/**
	 * The backend node id behind a handle, or undefined if it has gone.
	 *
	 * This asks puppeteer rather than sending DOM.describeNode ourselves
	 * because a remote object id is scoped to the session that minted it,
	 * and these handles were minted by puppeteer's session, not ours.
	 * Resolving them through this.cdp fails for every handle, which reads
	 * as "no candidate matched" and refuses every act.
	 */
	private async backendIdOf(
		handle: ElementHandle,
	): Promise<number | undefined> {
		try {
			return await handle.backendNodeId();
		} catch {
			// The node left the document between the outline and this
			// lookup. It cannot be the one we resolved, so say so.
			return undefined;
		}
	}

	private async axTree(): Promise<AxNode> {
		// Nearly every reading starts here, which makes it the right
		// place to wait out a crash recovery rather than issuing a
		// call to a renderer that will never answer.
		await this.ready();
		const { nodes } = (await this.cdp.send("Accessibility.getFullAXTree")) as {
			nodes: RawAxNode[];
		};
		return normalizeAxTree(nodes);
	}
}
