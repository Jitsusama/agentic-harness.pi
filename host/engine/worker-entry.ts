/**
 * Spike (worker per awake engine), never merged: what runs inside one
 * conversation's worker thread. It loads the host's pi, the theme and
 * pi's screens, a SessionHost of its own and the ordinary engine over it,
 * so the conversation's extensions, turns and screen run on this thread's
 * loop, not the host's. The main thread (worker-engine.ts) keeps the
 * roster, the socket and the viewers' connections, and drives this
 * engine over the channel: what it holds and how each stands is told back
 * as it changes, and every viewer's bytes are relayed both ways.
 *
 * The worker's SessionHost writes no registry (the main thread's does)
 * and answers holds for its siblings' conversations from the list the
 * main thread sends, so liveness read here sees the whole host.
 */
import { registerHooks } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parentPort, threadId, workerData } from "node:worker_threads";
import { piFromHost } from "../service/pi-resolution.ts";
import type { WorkerSetup, WorkerWeight } from "./worker-setup.ts";

const setup = workerData as WorkerSetup;
const port = parentPort;
if (!port) throw new Error("worker-entry.ts runs only as a worker");

registerHooks({ resolve: piFromHost(setup.packageDir) });

const { openChannel, flat } = await import("./worker-channel.ts");
const { withSession, ambientSession } = await import(
	"../../lib/core/session/index.ts"
);
const { SessionHost } = await import("./session-host.ts");
const { createEngine } = await import("./engine.ts");
const { loadHostPi } = await import("./host-pi.ts");
const { hostedModeOf, hostScreens } = await import("../screen/screens.ts");
const { hostedAskerOf } = await import("../screen/startup-ask.ts");
const { startupQuestions, themeStarter } = await import(
	"../service/program.ts"
);

/** Nanoseconds in a millisecond, as the loop's delays are read. */
const NS_PER_MS = 1e6;
const BYTES_PER_KB = 1024;
/** How often what each conversation holds in the background is told again. */
const BACKGROUND_EVERY_MS = 1000;

const report = (error: unknown) => channel.tell("report", flat(error));

/** How the main thread says its other workers' conversations stand. */
const mirror = new Map<string, "busy" | "idle" | "parked">(setup.mirror);
/** Each viewer attached through the main thread, by its connection's number. */
const viewers = new Map<
	number,
	{
		readonly sessionId: string;
		readonly connection: {
			input(data: string): void;
			resize(rows: number, columns: number): void;
			edited?(id: string, text?: string): void;
			detach(): void;
		};
	}
>();

const channel = openChannel(
	port,
	{
		prepare: (request) => engine.prepare(request as never),
		start: (prepared, request) =>
			engine.start(prepared as never, request as never),
		discard: (prepared) => engine.discard(prepared as never),
		resume: (entry, woken) => engine.resume(entry as never, woken === true),
		abort: (sessionId) => engine.abort(String(sessionId)),
		parkSettled: (sessionId) => engine.parkSettled?.(String(sessionId)),
		finish: (sessionId, why, how) =>
			how === "signalled"
				? host.stop(String(sessionId), String(why))
				: host.close(String(sessionId), String(why)),
		reload: (sessionId, request) =>
			host.reload(String(sessionId), request as never),
		weigh,
		exit: () => {
			// Ends the thread once this answer is out, so a CPU profile is written.
			setImmediate(() => process.exit(0));
		},
		mirror: (entries) => {
			mirror.clear();
			if (Array.isArray(entries))
				for (const [id, state] of entries) mirror.set(id, state);
		},
		attach: (connection, request) => attach(Number(connection), request),
		input: (connection, data) =>
			viewerOf(connection, (viewer) => viewer.connection.input(String(data))),
		resize: (connection, rows, columns) =>
			viewerOf(connection, (viewer) =>
				viewer.connection.resize(Number(rows), Number(columns)),
			),
		edited: (connection, id, text) =>
			viewerOf(connection, (viewer) =>
				viewer.connection.edited?.(
					String(id),
					text === undefined ? undefined : String(text),
				),
			),
		detach: (connection) => {
			const viewer = viewers.get(Number(connection));
			viewers.delete(Number(connection));
			if (viewer)
				withSession(viewer.sessionId, () => viewer.connection.detach());
		},
	},
	(error) => process.stderr.write(`worker ${threadId}: ${String(error)}\n`),
);

const pi = await loadHostPi(setup.packageDir);
themeStarter(pi.modules.codingAgent, setup.home)();
const questions = startupQuestions(pi.modules);
const screens = hostScreens({
	create: hostedModeOf(pi.modules.codingAgent.InteractiveMode),
	ask: hostedAskerOf(questions.selector, questions.mainScreen),
	report,
});
if (setup.setup) await import(setup.setup);

const host = new SessionHost({
	key: setup.key,
	owner: setup.owner,
	writesRegistry: false,
	published: (list) => channel.tell("list", list, backgrounds(list)),
	elsewhere: (id) => mirror.get(id),
});
const engine = await createEngine({
	packageDir: setup.packageDir,
	stateDir: setup.stateDir,
	host,
	env: setup.env,
	...(setup.keyInherited === undefined
		? {}
		: {
				key: {
					inherited: setup.keyInherited,
					current: async () => String(await channel.call("key")),
					refused: () => channel.tell("refused"),
				},
			}),
	...(setup.launchFromRequest
		? {
				conversationEnv: (
					_conversation: unknown,
					request: { readonly env?: Readonly<Record<string, string>> },
				) => request.env ?? {},
			}
		: {}),
	screens: screens.screens,
	...(setup.collectWhenQuiet === undefined
		? {}
		: { collectWhenQuiet: setup.collectWhenQuiet }),
	reapAtStart: false,
	parkedOut: (sessionId) => channel.tell("parked", sessionId),
	report,
});
engine.watch({
	ended: async (sessionId, why) => {
		channel.tell("ended", sessionId, why);
	},
	became: async (previousId, next) => {
		await channel.call("became", previousId, next);
	},
	wake: async (sessionId) => {
		await channel.call("wake", sessionId);
	},
});

// One conversation's throw stays its own, as the host's faults do.
process.on("uncaughtException", (error) => {
	const sessionId = ambientSession() ?? host.list()[0]?.id;
	if (!(sessionId && screens.faulted(sessionId, error))) report(error);
});
process.on("unhandledRejection", report);

/** What each conversation holds in the background, as the main thread lists it. */
function backgrounds(
	list: readonly { readonly id: string }[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const { id } of list) counts[id] = engine.backgroundOf(id);
	return counts;
}
let lastBackground = "";
setInterval(() => {
	const counts = JSON.stringify(backgrounds(host.list()));
	if (counts === lastBackground) return;
	lastBackground = counts;
	channel.tell("background", JSON.parse(counts));
}, BACKGROUND_EVERY_MS).unref();

/** Attach a viewer the main thread holds to this conversation's screen, its output batched a frame a tick. */
function attach(connection: number, request: unknown): void {
	const sessionId = String(Reflect.get(Object(request), "sessionId"));
	let drawn = "";
	const flush = () => {
		if (drawn === "") return;
		const data = drawn;
		drawn = "";
		channel.tell("write", connection, data);
	};
	try {
		const attached = withSession(sessionId, () =>
			screens.viewer.attach(request as never, {
				write: (data) => {
					if (data === "") return;
					if (drawn === "") setImmediate(flush);
					drawn += data;
				},
				disconnect: (reason) => {
					flush();
					channel.tell("disconnect", connection, reason);
				},
				edit: (id, text) => {
					flush();
					channel.tell("edit", connection, id, text);
				},
				suspend: () => {
					flush();
					channel.tell("suspend", connection);
				},
			}),
		);
		viewers.set(connection, { sessionId, connection: attached });
	} catch (error) {
		channel.tell(
			"disconnect",
			connection,
			error instanceof Error ? error.message : String(error),
		);
	}
}

function viewerOf(
	connection: unknown,
	act: (viewer: NonNullable<ReturnType<typeof viewers.get>>) => void,
): void {
	const viewer = viewers.get(Number(connection));
	if (viewer) withSession(viewer.sessionId, () => act(viewer));
}

/** How late this thread's loop ran between weighings, sampled every 10 ms. */
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let utilised = performance.eventLoopUtilization();

/** Collect this thread's garbage and say what it weighs and how its loop ran. */
function weigh(): WorkerWeight {
	const loopP99Ms = loop.percentile(99) / NS_PER_MS;
	const loopMaxMs = loop.max / NS_PER_MS;
	const loopBusy = performance.eventLoopUtilization(utilised).utilization;
	loop.disable();
	loop.reset();
	const collect = Reflect.get(globalThis, "gc");
	if (typeof collect === "function") {
		collect();
		collect();
	}
	const seen = Reflect.get(globalThis, Symbol.for("screen-host.sessions"));
	const sessions: string[] = [];
	if (Array.isArray(seen))
		for (const [id, ref] of seen)
			if (ref instanceof WeakRef && ref.deref() !== undefined)
				sessions.push(String(id));
	const used = process.memoryUsage();
	const inKb = (bytes: number) => Math.round(bytes / BYTES_PER_KB);
	loop.enable();
	utilised = performance.eventLoopUtilization();
	return {
		threadId,
		ids: host.list().map(({ id }) => id),
		heapKb: inKb(used.heapUsed),
		heapTotalKb: inKb(used.heapTotal),
		externalKb: inKb(used.external),
		arrayBuffersKb: inKb(used.arrayBuffers),
		loopP99Ms,
		loopMaxMs,
		loopBusy,
		sessions,
	};
}

channel.tell("ready");
