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

import type { BrowserContext, CDPSession, Page } from "puppeteer-core";
import type {
	Announcement,
	FocusHolder,
	TreeScope,
	WalkCapture,
} from "./a11y/index.ts";
import type {
	A11yFinding,
	BehindReport,
	CapturedTarget,
	ConformanceBar,
	ContrastLevel,
	MotionCapture,
	PageBox,
	PairReport,
	StructureNode,
	VisualNode,
} from "./audit/index.ts";
import { holdWhile, newContextPage } from "./browser.ts";
import type { Comparison } from "./compare/index.ts";
import { isSetUp } from "./cookies/index.ts";
import type { HoverReport } from "./element/index.ts";
import type {
	Divergence,
	EmulationState,
	NetworkRule,
	ObservedEnvironment,
	SavedState,
	SessionStatus,
	StorageSnapshot,
	TabRecord,
	ThrottleConditions,
} from "./environment/index.ts";
import type { EvalFrame, EvalOutcome } from "./evaluate/index.ts";
import type { HydrationCapture } from "./hydration/index.ts";
import type {
	ChordRefusal,
	Point,
	PointerEventStep,
	TouchStep,
} from "./input/index.ts";
import type {
	HeapComparison,
	Hotspots,
	LayerReport,
	TraceCapture,
	TraceProfile,
	Vitals,
} from "./perf/index.ts";
import type { StyleSample, TextBlock } from "./design/index.ts";
import { assembleSession, type SessionParts } from "./session/assembly.ts";
import {
	describeRecording,
	recordingInProgress,
} from "./session/recording.ts";
import type { StateLoaded } from "./session/storage.ts";
import {
	type ActResult,
	CookieSetupNeeded,
	type InspectOptions,
	type InspectResult,
	type MeasureResult,
	type Observation,
	type ObserveResult,
	type PageAction,
	type PageForm,
	type SessionOptions,
	type ShotOptions,
	type ShotResult,
} from "./session/types.ts";
import type { SessionWires } from "./session/wires.ts";
import type { IndexedNode } from "./snapshot/index.ts";
import type { Target, TargetRefusal } from "./target/index.ts";
import {
	type DialogEvent,
	type DialogPolicy,
	type DownloadRecord,
	type LifecycleEvent,
	type LogEntry,
	type NetworkRequest,
	type Recorded,
	type SocketRecord,
	toHar,
} from "./telemetry/index.ts";
import type {
	Settled,
	WaitCondition,
	WaitOutcome,
} from "./wait/index.ts";

export type {
	ActResult,
	InspectOptions,
	InspectResult,
	Inspection,
	MeasureResult,
	Observation,
	ObserveResult,
	PageAction,
	PageForm,
	SessionOptions,
	Shot,
	ShotOptions,
	ShotResult,
	TargetedAction,
} from "./session/types.ts";
export { CookieSetupNeeded } from "./session/types.ts";

/**
 * A driveable browser session over a single tab.
 *
 * The session owns the tab, its protocol channel and its context,
 * and hands the work to collaborators in session/, each driving the
 * browser through the live wires below. Its methods are the one
 * surface callers see, and the full account of each lives on the
 * collaborator that answers it.
 */
export class BrowserSession {
	/** The live view collaborators drive the browser through. */
	private readonly wires: SessionWires = {
		page: () => this.page,
		cdp: () => this.cdp,
		context: () => this.context,
		ready: () => this.parts.tab.ready(),
	};

	/** The collaborators this session hands its work to. */
	private readonly parts: SessionParts;

	readonly name: string;
	// The page and its protocol channel are replaced wholesale when the
	// tab crashes, so neither can be readonly.
	private page: Page;
	private cdp: CDPSession;
	private readonly context: BrowserContext;

	private constructor(
		name: string,
		page: Page,
		cdp: CDPSession,
		context: BrowserContext,
		options: SessionOptions,
	) {
		this.name = name;
		this.page = page;
		this.cdp = cdp;
		this.context = context;
		this.parts = assembleSession(this.wires, {
			name,
			options,
			adopt: (adopted, channel) => {
				this.page = adopted;
				this.cdp = channel;
			},
		});
	}

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
			await session.parts.telemetry.listenForAnnouncements();
			await session.parts.telemetry.listenForLogs();
			await session.parts.telemetry.listenForRequests();
			await session.parts.telemetry.listenForDialogs();
			await session.parts.telemetry.listenForLifecycle();
			await session.parts.telemetry.listenForDownloads();
			await session.parts.sourceMaps.listen();
			await session.parts.probes.watchVitals();
			return session;
		} catch (err) {
			// Do not leak the context if the CDP channel could not be
			// set up; close it before surfacing the failure.
			await holdWhile(() => context.close()).catch(() => {});
			throw err;
		}
	}

	/** Decide how dialogs will be answered from here on. */
	setDialogPolicy(policy: DialogPolicy): void {
		this.parts.telemetry.setDialogPolicy(policy);
	}

	/** How dialogs are currently answered. */
	get dialogs(): {
		readonly policy: DialogPolicy;
		readonly seen: readonly DialogEvent[];
	} {
		return this.parts.telemetry.dialogs;
	}

	/** Every request the page has made. */
	requests(): readonly NetworkRequest[] {
		return this.parts.telemetry.requests();
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

		const path = this.parts.artifacts
			.sink()
			.writeText(
				`capture-${this.parts.artifacts.nextArchive()}.har`,
				JSON.stringify(toHar(requests, { bodies }), null, 2),
			);
		return this.parts.artifacts.keep(path);
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
		return this.parts.telemetry.bodyOf(requestId);
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
		return this.parts.telemetry.logs(since);
	}

	/** Navigate the tab to a url (session/navigation.ts). */
	navigate(url: string): Promise<{ status?: number; failure?: string }> {
		return this.parts.navigation.navigate(url);
	}

	/** Where the session currently is. */
	get url(): string {
		return this.page.url();
	}

	/** Fetch the page again, past its cache. */
	reload(): Promise<{ failure?: string }> {
		return this.parts.navigation.reload();
	}

	/**
	 * Wait for the page to stop changing, so a read that follows
	 * describes where the page ended up rather than where it was.
	 *
	 * Returns what it found instead of throwing on a page that never
	 * settles: something that animates or polls for ever is still
	 * worth reading, as long as the answer does not pretend it was
	 * final.
	 */
	async settlePage(budgetMs?: number): Promise<Settled> {
		return this.parts.settler.settle(budgetMs);
	}

	/** What the last settle saw, for a reader that wants to say so. */
	get settledLast(): Settled | undefined {
		return this.parts.settler.lastSeen;
	}

	/** Step through the history the session accumulated. */
	step(direction: "back" | "forward"): Promise<
		| { readonly ok: true; readonly url: string }
		| { readonly ok: false; readonly refusal: string }
	> {
		return this.parts.navigation.step(direction);
	}

	/** Render the page's accessibility outline, plus url and title. */
	observe(
		scope: TreeScope = {},
		form: PageForm = "outline",
	): Promise<Observation> {
		return this.parts.navigation.observe(scope, form);
	}

	/** Read one named branch of the page, or say what would work. */
	observeWithin(
		target: Target,
		scope: TreeScope = {},
		form: PageForm = "outline",
	): Promise<ObserveResult> {
		return this.parts.navigation.observeWithin(target, scope, form);
	}

	/** Perform an action on a named element (session/acting.ts). */
	act(action: PageAction): Promise<ActResult> {
		return this.parts.acting.act(action);
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
		return this.parts.sourceMaps.resolveFrames(frames);
	}

	/** When this session last did anything, for the idle reaper. */
	get lastUsedAt(): number {
		return this.parts.tab.lastUsedAt;
	}

	/** Files the page has handed back. */
	downloads(): readonly DownloadRecord[] {
		return this.parts.telemetry.downloads();
	}

	/** Profile the page's JavaScript (session/profiling.ts). */
	profile(forMs: number): Promise<Hotspots> {
		return this.parts.profiler.profile(forMs);
	}

	/** Record a trace around some work, and say what it cost. */
	recordWhile<T>(
		profiles: readonly TraceProfile[],
		work: () => Promise<T>,
	): Promise<{
		readonly result: T;
		readonly trace?: TraceCapture;
		readonly refusal?: string;
	}> {
		return this.parts.profiler.recordWhile(profiles, work);
	}

	/** Every websocket conversation the page has held. */
	sockets(): readonly SocketRecord[] {
		return this.parts.telemetry.sockets();
	}

	/** Measure what the page holds, against the last measurement. */
	heap(collect = true): Promise<HeapComparison> {
		return this.parts.profiler.heap(collect);
	}

	/** Judge text against the background behind it (session/contrast.ts). */
	contrastBehind(
		target: Target,
		bar: ContrastLevel = "AA",
	): Promise<
		{ ok: true; report: BehindReport } | { ok: false; refusal: TargetRefusal }
	> {
		return this.parts.contrast.behind(target, bar);
	}

	/** Judge the contrast between two elements the caller named. */
	contrastPair(
		one: Target,
		other: Target,
		bar: ContrastLevel = "AA",
	): Promise<
		| { ok: true; report: PairReport }
		| { ok: false; target: Target; refusal: TargetRefusal }
	> {
		return this.parts.contrast.pair(one, other, bar);
	}

	/** The layers the compositor made (session/painting.ts). */
	layers(): Promise<LayerReport> {
		return this.parts.painting.layers();
	}

	/** What the page does on hover, and whether focus does it too. */
	hovers(limit?: number): Promise<HoverReport> {
		return this.parts.painting.hovers(limit);
	}

	/** Socket events dropped to stay within the buffer's budget. */
	get socketFramesDropped(): number {
		return this.parts.telemetry.socketFramesDropped;
	}

	/** Where the page has been. */
	get history(): readonly LifecycleEvent[] {
		return this.parts.telemetry.history;
	}

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
		await this.parts.emulation.restore(state);
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
	async emulate(
		change: EmulationState = {},
		/** Overrides to take off, which an absent key cannot express. */
		clear: readonly (keyof EmulationState)[] = [],
	): Promise<{
		asked: EmulationState;
		observed: ObservedEnvironment;
		gaps: readonly Divergence[];
	}> {
		return this.parts.emulation.change(change, clear);
	}

	/** What this session has asked the browser to pretend. */
	get emulated(): EmulationState {
		return this.parts.emulation.asked;
	}

	/** Read what the page has kept (session/storage.ts). */
	storage(wanted: {
		local?: boolean;
		session?: boolean;
		cookies?: boolean;
		clipboard?: boolean;
	}): Promise<StorageSnapshot> {
		return this.parts.stores.storage(wanted);
	}

	/** Put a value into one of the DOM stores. */
	setStored(
		isLocalStorage: boolean,
		key: string,
		value: string,
	): Promise<void> {
		return this.parts.stores.setStored(isLocalStorage, key, value);
	}

	/** Measure the space between two elements (session/inspecting.ts). */
	measure(a: Target, b: Target): Promise<MeasureResult> {
		return this.parts.inspector.measure(a, b);
	}

	/** Every tab this session's context holds open (session/tab.ts). */
	tabs(): Promise<readonly TabRecord[]> {
		return this.parts.tab.tabs();
	}

	/** Drive a different tab from now on. */
	switchTab(index: number): Promise<TabRecord | { refusal: string }> {
		return this.parts.tab.switchTab(index);
	}

	/** Keep everything that makes this session signed in. */
	saveState(): Promise<SavedState> {
		return this.parts.stores.saveState();
	}

	/** Wear a state saved earlier, and report exactly what landed. */
	loadState(state: SavedState): Promise<StateLoaded> {
		return this.parts.stores.loadState(state);
	}

	/** Empty the stores named, and only those. */
	clearStorage(wanted: {
		local?: boolean;
		session?: boolean;
		cookies?: boolean;
	}): Promise<void> {
		return this.parts.stores.clearStorage(wanted);
	}

	/** Put text on the clipboard. */
	writeClipboard(text: string): Promise<void> {
		return this.parts.stores.writeClipboard(text);
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
		/** Conditions, or the name of a profile such as slow-3g. */
		throttle?: ThrottleConditions | string;
		clear?: boolean;
	}): Promise<{
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	}> {
		return this.parts.shaper.shape(change);
	}

	/** Press a chord, or a sequence of them (session/acting.ts). */
	press(
		keys: string,
	): Promise<{ pressed: readonly string[] } | { refusal: ChordRefusal }> {
		return this.parts.acting.press(keys);
	}

	/** Send raw text as keystrokes, wherever focus happens to be. */
	typeRaw(text: string): Promise<void> {
		return this.parts.acting.typeRaw(text);
	}

	/** Dispatch a composed mouse gesture. */
	pointerGesture(steps: readonly PointerEventStep[]): Promise<void> {
		return this.parts.acting.pointerGesture(steps);
	}

	/** Scroll by wheel, which is not the same as scrolling by script. */
	wheel(at: Point, byX: number, byY: number): Promise<void> {
		return this.parts.acting.wheel(at, byX, byY);
	}

	/** Dispatch a composed touch gesture. */
	touchGesture(steps: readonly TouchStep[]): Promise<void> {
		return this.parts.acting.touchGesture(steps);
	}

	/** Walk the page with the Tab key (session/focus.ts). */
	keyboardWalk(maxStops?: number): Promise<WalkCapture> {
		return this.parts.focus.keyboardWalk(maxStops);
	}

	/** What holds focus at this moment, moving nothing. */
	focusHolder(): Promise<FocusHolder | undefined> {
		return this.parts.focus.focusHolder();
	}

	/** The whole page flattened (session/probes.ts). */
	snapshot(styleProperties?: readonly string[]): Promise<readonly IndexedNode[]> {
		return this.parts.probes.snapshot(styleProperties);
	}

	/** Run an expression in the page and describe what came back. */
	evaluate(expression: string): Promise<EvalOutcome> {
		return this.parts.probes.evaluate(expression);
	}

	/** Run axe-core against the page and read back its findings. */
	audit(bar: ConformanceBar = "AAA"): Promise<readonly A11yFinding[]> {
		return this.parts.probes.audit(bar);
	}

	/** What the page keeps doing when asked to hold still. */
	motionUnderReduce(): Promise<MotionCapture> {
		return this.parts.probes.motionUnderReduce();
	}

	/** The page as the structural rules need to see it. */
	structure(): Promise<readonly StructureNode[]> {
		return this.parts.probes.structure();
	}

	/** Every pointer target on the page, sized for WCAG 2.5.8. */
	targets(): Promise<readonly CapturedTarget[]> {
		return this.parts.probes.targets();
	}

	/** Both renders of the page: the server's and hydration's. */
	hydration(): Promise<HydrationCapture> {
		return this.parts.probes.hydration();
	}

	/** How the page's text blocks wrap, from real line boxes. */
	typography(): Promise<readonly TextBlock[]> {
		return this.parts.probes.typography();
	}

	/** What the layout actually did, as the browser measured it. */
	layout(): Promise<{
		readonly nodes: readonly VisualNode[];
		readonly viewport: PageBox;
	}> {
		return this.parts.probes.layout();
	}

	/** What the page is built from, sampled element by element. */
	styleSamples(): Promise<readonly StyleSample[]> {
		return this.parts.probes.styleSamples();
	}

	/** What the current page cost to show. */
	vitals(): Promise<Vitals> {
		return this.parts.probes.vitals();
	}

	/** Whether the page believes it is being touched. */
	get touchEmulated(): boolean {
		return this.parts.emulation.touch;
	}

	/** Wait for the page to reach a state (session/waiting.ts). */
	waitFor(condition: WaitCondition, timeoutMs?: number): Promise<WaitOutcome> {
		return this.parts.waiting.waitFor(condition, timeoutMs);
	}

	/**
	 * Everything this session has accumulated, in one reading.
	 *
	 * Emulation, interception and dialog policy all change what
	 * every other reading means, and none of them is visible in
	 * those readings, so they are gathered here.
	 */
	async status(): Promise<SessionStatus> {
		await this.parts.tab.ready();
		const logs = this.logs();
		const heard = await this.heard(0);
		const requests = this.requests();
		const gaps = await this.parts.emulation.currentGaps();
		return {
			name: this.name,
			url: this.page.url(),
			title: await this.page.title().catch(() => ""),
			emulation: this.parts.emulation.asked,
			...(gaps.length === 0 ? {} : { gaps }),
			rules: this.parts.shaper.current.rules,
			...(this.parts.shaper.current.throttle === undefined
				? {}
				: { throttle: this.parts.shaper.current.throttle }),
			dialogPolicy: this.parts.telemetry.dialogs.policy,
			dialogsSeen: this.parts.telemetry.dialogs.seen.length,
			logs: { count: logs.entries.length, cursor: logs.cursor },
			announcements: { count: heard.entries.length, cursor: heard.cursor },
			requests: {
				count: requests.length,
				failed: requests.filter((request) => request.state === "failed").length,
			},
			history: this.history,
			artifacts: this.parts.artifacts.written,
			recording: describeRecording(recordingInProgress(), this.name),
		};
	}

	/** How the network is currently being bent. */
	get shaping(): {
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	} {
		return this.parts.shaper.current;
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
		return this.parts.telemetry.heard(since);
	}

	/** Close the tab and the context holding its state. */
	async close(): Promise<void> {
		try {
			await this.cdp.detach();
		} catch {
			// The session may already be gone; closing the context is enough.
		}
		// Closing the context disposes its pages along with the
		// cookies, storage and cache they accumulated. Chrome
		// answers that only after the tabs are gone, so the wait is
		// claimed, or nothing would be holding the event loop for it.
		await holdWhile(() => this.context.close());
	}

	/** Everything worth knowing about one element. */
	inspect(
		target: Target,
		options: InspectOptions = {},
	): Promise<InspectResult> {
		return this.parts.inspector.inspect(target, options);
	}

	/** Photograph the page, or one element (session/camera.ts). */
	shoot(options: ShotOptions = {}): Promise<ShotResult> {
		return this.parts.camera.shoot(options);
	}

	/** Compare the page against a baseline, or record one. */
	compareToBaseline(
		label: string,
		options: { readonly update?: boolean; readonly threshold?: number } = {},
	): Promise<{
		readonly comparison: Comparison | undefined;
		readonly recorded?: string;
		readonly artifacts: readonly string[];
	}> {
		return this.parts.camera.compareToBaseline(label, options);
	}
}
