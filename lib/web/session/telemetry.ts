/**
 * Everything a session overhears: console lines, exceptions,
 * requests, dialogs, navigations, downloads and live-region
 * announcements, each kept from the moment the tab opens.
 *
 * One keeper for all of it because the buffers share a life:
 * they are installed together at open, reinstalled together
 * after a crash, and recited together by status. The session
 * decides when to listen; this decides what is heard and how it
 * is kept.
 */

import {
	ANNOUNCE_BINDING,
	ANNOUNCEMENT_OBSERVER,
	type Announcement,
	type AnnouncementCandidate,
	CANDIDATE_REGISTRY,
} from "../a11y/index.js";
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
} from "../telemetry/index.js";
import type { SessionWires } from "./wires.js";

/** Milliseconds in a second, where two clocks have to meet. */
const MS_PER_SECOND = 1000;

/** What the listeners need from the session beyond the browser. */
interface TelemetryHooks {
	/** Start replacing a crashed tab the moment it is announced. */
	readonly onCrash: () => void;
	/** Where downloads should land. */
	readonly downloadDir: () => string;
	/** Note a landed download in the session's ledger. */
	readonly keep: (path: string) => void;
}

/** The buffers a session fills by listening, and their readers. */
export class SessionTelemetry {
	/** What the page announced, oldest first, within its budget. */
	private readonly announcements = createRingBuffer<Announcement>();

	/**
	 * What the browser said about each nominated region, keyed by
	 * document epoch and registry index. Null means the browser
	 * ruled it not live.
	 */
	private readonly livenessByRegion = new Map<
		string,
		Announcement["politeness"] | null
	>();

	/** Everything the page has said since it opened. */
	private readonly logBuffer = createRingBuffer<LogEntry>();

	/** Every request the page has made since it opened. */
	private readonly requestLog = createNetworkRecorder();

	/** Every dialog the page has raised, and how it was answered. */
	private readonly dialogLog: DialogEvent[] = [];

	/** Where the page has been, and whether it survived. */
	private lifecycleLog?: LifecycleRecorder;

	/** How dialogs get answered while nobody is watching. */
	private dialogPolicy: DialogPolicy = DEFAULT_DIALOG_POLICY;

	/** Files the page has handed back. */
	private readonly downloadLog = createDownloadRecorder();

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

	/**
	 * Announcements still being ruled on. Candidates resolve one
	 * at a time along this chain, so a slow lookup cannot overtake
	 * a fast one and record two out of the order they were said.
	 */
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly wires: SessionWires,
		private readonly hooks: TelemetryHooks,
	) {}

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
	async listenForLogs(): Promise<void> {
		const cdp = this.wires.cdp();
		cdp.on("Runtime.consoleAPICalled", (event) => {
			this.logBuffer.push(consoleEntry(event as ConsoleCalled));
		});
		cdp.on("Runtime.exceptionThrown", (event) => {
			this.logBuffer.push(
				exceptionEntry(event.exceptionDetails, event.timestamp),
			);
		});
		cdp.on("Log.entryAdded", (event) => {
			const logged = event as { entry: BrowserLogged };
			this.logBuffer.push(browserEntry(logged.entry));
		});
		await cdp.send("Runtime.enable");
		await cdp.send("Log.enable");
	}

	/**
	 * Watch every request the page makes.
	 *
	 * The protocol reports one request as four separate events
	 * over its life, so the recorder does the reassembly and this
	 * only relabels the CDP names it consumes.
	 */
	async listenForRequests(): Promise<void> {
		const cdp = this.wires.cdp();
		cdp.on("Network.requestWillBeSent", (event) => {
			// This is the one event carrying both clocks at once, which
			// makes it the only place the offset between them can be
			// learned rather than assumed.
			if (event.wallTime !== undefined) {
				this.clockOffset = event.wallTime - event.timestamp;
			}
			this.requestLog.apply({ kind: "sent", event });
		});
		cdp.on("Network.responseReceived", (event) => {
			this.requestLog.apply({ kind: "received", event });
		});
		cdp.on("Network.loadingFinished", (event) => {
			this.requestLog.apply({ kind: "finished", event });
		});
		cdp.on("Network.loadingFailed", (event) => {
			this.requestLog.apply({ kind: "failed", event });
		});
		await cdp.send("Network.enable");
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
	async listenForDialogs(): Promise<void> {
		const cdp = this.wires.cdp();
		cdp.on("Page.javascriptDialogOpening", (event) => {
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
			cdp
				.send("Page.handleJavaScriptDialog", reply)
				// A dialog the page closed itself is already gone, and
				// failing to answer it is not news.
				.catch(() => {});
		});
		await cdp.send("Page.enable");
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
			return await this.wires
				.cdp()
				.send("Network.getResponseBody", { requestId });
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

	/**
	 * Watch where the page goes, and notice if it dies.
	 *
	 * The crash half is not optional. After the tab crashes every
	 * call against it hangs rather than failing, measured against
	 * a deliberately crashed tab, so a session that waited to find
	 * out lazily would simply stop responding. Recovery therefore
	 * happens the moment the crash is announced.
	 */
	async listenForLifecycle(): Promise<void> {
		const { frameTree } = await this.wires.cdp().send("Page.getFrameTree");
		const log = createLifecycleRecorder(frameTree.frame.id);
		this.lifecycleLog = log;
		this.attachLifecycle(log);
	}

	/**
	 * Point the lifecycle handlers at a replacement tab.
	 *
	 * A new tab is a new main frame, and a recorder still watching
	 * the old id would ignore every navigation from here on while
	 * looking perfectly healthy.
	 */
	readoptLifecycle(frameId: string): void {
		const log = this.lifecycleLog;
		if (!log) return;
		log.adoptFrame(frameId);
		this.attachLifecycle(log);
		log.apply({ kind: "recovered" });
	}

	/** Point the lifecycle handlers at the current protocol channel. */
	private attachLifecycle(log: LifecycleRecorder): void {
		const cdp = this.wires.cdp();
		cdp.on("Page.frameRequestedNavigation", (event) => {
			log.apply({
				kind: "requested",
				frameId: event.frameId,
				reason: event.reason,
			});
		});
		cdp.on("Page.frameNavigated", (event) => {
			log.apply({
				kind: "navigated",
				frameId: event.frame.id,
				url: event.frame.url,
			});
		});
		cdp.on("Page.navigatedWithinDocument", (event) => {
			log.apply({
				kind: "within",
				frameId: event.frameId,
				url: event.url,
				...(event.navigationType === undefined
					? {}
					: { navigationType: event.navigationType }),
			});
		});
		cdp.on("Inspector.targetCrashed", () => {
			log.apply({ kind: "crashed" });
			this.hooks.onCrash();
		});
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
	async listenForDownloads(): Promise<void> {
		const cdp = this.wires.cdp();
		cdp.on("Browser.downloadWillBegin", (event) => {
			this.downloadLog.apply({
				kind: "begin",
				guid: event.guid,
				url: event.url,
				suggestedFilename: event.suggestedFilename,
			});
		});
		cdp.on("Browser.downloadProgress", (event) => {
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
				if (landed?.filePath) this.hooks.keep(landed.filePath);
			}
		});
		await cdp.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: this.hooks.downloadDir(),
			eventsEnabled: true,
			browserContextId: this.wires.context().id,
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
	 * Now, on the protocol's clock, so it can be compared with
	 * what requests carry.
	 *
	 * Before any request has been seen there is no offset to
	 * apply, but there are also no requests to compare against,
	 * so the figure cannot mislead anyone.
	 */
	protocolNow(): number {
		return Date.now() / MS_PER_SECOND - (this.clockOffset ?? 0);
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
	async listenForAnnouncements(): Promise<void> {
		await this.wires
			.page()
			.exposeFunction(ANNOUNCE_BINDING, (candidate: AnnouncementCandidate) => {
				this.pending = this.pending.then(() => this.recordIfLive(candidate));
			});
		await this.wires.page().evaluateOnNewDocument(ANNOUNCEMENT_OBSERVER);
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
		const cdp = this.wires.cdp();
		let objectId: string | undefined;
		try {
			const { result } = await cdp.send("Runtime.evaluate", {
				expression: `globalThis[${JSON.stringify(CANDIDATE_REGISTRY)}][${index}]`,
			});
			objectId = result.objectId;
			if (!objectId) return undefined;

			const { node } = await cdp.send("DOM.describeNode", { objectId });
			const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
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
				await cdp
					.send("Runtime.releaseObject", { objectId })
					// Releasing a handle the page already discarded is
					// not a failure worth surfacing.
					.catch(() => {});
			}
		}
	}
}
