// The wake bench: parked conversations holding real logs woken by a window one at a time while others stay busy.
/**
 * Run on a lent builder, as the soak is (README.md). It opens one
 * conversation for each log in --logs and --busy more, in one sealed
 * host. Each log conversation takes a turn, parks, and then has its log
 * replaced by the given one under its own header, so every wake loads a
 * real log's entries. The busy ones take paced turns throughout. Each
 * round, the log conversations park, and each is woken by a window one
 * at a time: from the attach to the host's answer, which waits for the
 * whole wake, then to its first drawing, with the host weighed after
 * each so its loop figures cover that wake alone.
 *
 *   node tests/host/soak/wake-bench.mts --logs a.jsonl,b.jsonl [--busy 2]
 *     [--rounds 8] [--answer-ms P50,P90] [--tool-ms P50,P90]
 *     [--turn-rounds P50,P90]
 *
 * It prints the report as one JSON line after `wake bench report:`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { folders } from "../end-to-end/support/folders.ts";
import { hostPackageDir } from "../end-to-end/support/host-pi.ts";
import {
	type ScreenHost,
	startScreenHost,
	type Weight,
} from "../end-to-end/support/screen-host.ts";
import { seal } from "../end-to-end/support/seal.ts";
import { attach, type Viewer } from "../end-to-end/support/viewer.ts";
import { paceOf } from "./pace.ts";
import { soakProvider } from "./soak-provider.ts";
import { acknowledged, type Turn, turnsOf } from "./turns.ts";

const TURN_MS = 10 * 60_000;
const PARK_MS = 6 * 60_000;
const DRAWN_MS = 60_000;
const LOOK_EVERY_MS = 100;
const ROWS = 30;
const COLUMNS = 100;
const ENTER = "\r";
const BUSY_TURNS = 10_000;
const FIXTURE_LOADS = new Set([
	"panel-lifecycle-workflow",
	"panel-zoom-widget",
	"park-workflow",
]);
const HARNESS = resolve(import.meta.dirname, "../../..");

const { values } = parseArgs({
	options: {
		logs: { type: "string" },
		busy: { type: "string", default: "2" },
		rounds: { type: "string", default: "8" },
		"answer-ms": { type: "string", default: "3000,8000" },
		"tool-ms": { type: "string", default: "500,3000" },
		"turn-rounds": { type: "string", default: "3,8" },
	},
});
const logs = (values.logs ?? "").split(",").filter(Boolean);
if (logs.length === 0) throw new Error("usage: wake-bench.mts --logs a,b,...");
const busyCount = Number(values.busy);
const rounds = Number(values.rounds);

const say = (line: string) =>
	process.stderr.write(`wake ${new Date().toISOString()} ${line}\n`);
const faults: string[] = [];
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Conversation {
	readonly index: number;
	readonly sessionId: string;
	readonly file: string;
}

interface Wake {
	readonly round: number;
	readonly conversation: number;
	readonly recordBytes: number;
	readonly answeredMs: number;
	readonly drawnMs: number;
	readonly loopMaxMs: number;
	readonly loopP99Ms: number;
	readonly loopBusy: number;
	/** Busy turns under way as the wake began. */
	readonly busyRunning: number;
}

const provider = await soakProvider({
	answer: paceOf(values["answer-ms"]),
	tool: paceOf(values["tool-ms"]),
	rounds: paceOf(values["turn-rounds"]),
});
const agent = {
	providers: {
		soak: {
			baseUrl: provider.endpoint,
			api: "anthropic-messages",
			apiKey: "local-soak-no-secret",
			models: [
				{
					id: "mock",
					name: "Soak Mock",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8192,
				},
			],
		},
	},
	settings: {
		defaultProvider: "soak",
		defaultModel: "mock",
		quietStartup: true,
		compaction: { enabled: false },
		retry: { enabled: false },
		extensions: ["-builtin:codemode"],
	},
};
const also = readdirSync(join(HARNESS, "extensions"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !FIXTURE_LOADS.has(entry.name))
	.map((entry) => entry.name)
	.sort();

const sealed = await seal();
const agentFile = join(sealed.root, "soak-agent.json");
writeFileSync(agentFile, JSON.stringify(agent));
const host = await startScreenHost(
	sealed,
	hostPackageDir() ?? "",
	also,
	agentFile,
);
const work = folders(sealed);
const parkFolder = join(
	sealed.env.XDG_STATE_HOME ?? "",
	"pi",
	"agentic-harness.pi",
	"park-workflow",
);
const switchFile = join(parkFolder, "switch");

const tail = (file: string) => {
	try {
		const text = readFileSync(file, "utf8");
		return text.slice(-65536);
	} catch {
		// Not written until its first answer.
		return "";
	}
};
const sizeOf = (file: string) => {
	try {
		return statSync(file).size;
	} catch {
		// Not written until its first answer.
		return 0;
	}
};

/** Type one turn into `viewer` and wait for its answer and idle. */
async function turn(
	one: Conversation,
	viewer: Viewer,
	what: Turn,
): Promise<void> {
	const ack = acknowledged(what.tag);
	viewer.type(`${what.prompt}${ENTER}`);
	const until = Date.now() + TURN_MS;
	while (!tail(one.file).includes(ack)) {
		if (Date.now() > until) throw new Error(`${what.tag} never answered`);
		await wait(LOOK_EVERY_MS);
	}
	await host.idle(one.sessionId, TURN_MS);
}

async function open(index: number): Promise<Conversation> {
	const cwd = work.trusted();
	writeFileSync(join(cwd, "notes.txt"), "soak notes\n");
	const { sessionId, file } = await host.open(cwd);
	return { index, sessionId, file };
}

async function parkAll(
	conversations: readonly Conversation[],
	of: ScreenHost,
): Promise<void> {
	const { mkdirSync } = await import("node:fs");
	mkdirSync(parkFolder, { recursive: true });
	writeFileSync(
		switchFile,
		`${conversations.map((one) => one.sessionId).join("\n")}\n`,
	);
	for (const one of conversations) await of.parked(one.sessionId, PARK_MS);
	writeFileSync(switchFile, "");
}

const opening = Date.now();
const real: Conversation[] = [];
for (const [index] of logs.entries()) real.push(await open(index));
const busy: Conversation[] = [];
for (let n = 0; n < busyCount; n += 1) busy.push(await open(logs.length + n));
say(`opened ${real.length + busy.length} in ${Date.now() - opening} ms`);

// Each log conversation takes one turn so its log exists, then parks.
for (const one of real) {
	const viewer = await attach(host.path, one.sessionId, ROWS, COLUMNS);
	await viewer.sent(/\S/, DRAWN_MS);
	const first = turnsOf(one.index, 1)[0];
	if (first) await turn(one, viewer, first);
	await viewer.leave();
}
await parkAll(real, host);
for (const [at, one] of real.entries()) {
	const header = readFileSync(one.file, "utf8").split("\n")[0] ?? "";
	const entries = readFileSync(logs[at] ?? "", "utf8");
	writeFileSync(
		one.file,
		`${header}\n${entries.endsWith("\n") ? entries : `${entries}\n`}`,
	);
	say(`conversation ${one.index} now holds ${sizeOf(one.file)} bytes`);
}

// The busy ones take paced turns until the rounds are done.
let stopping = false;
let running = 0;
let busyTurns = 0;
const busyLoops = busy.map(async (one) => {
	const viewer = await attach(host.path, one.sessionId, ROWS, COLUMNS);
	await viewer.sent(/\S/, DRAWN_MS);
	for (const what of turnsOf(one.index, BUSY_TURNS)) {
		if (stopping) break;
		running += 1;
		try {
			await turn(one, viewer, what);
			busyTurns += 1;
		} catch (error) {
			faults.push(`busy ${one.index}: ${String(error)}`);
		} finally {
			running -= 1;
		}
	}
	await viewer.leave();
});

const wakes: Wake[] = [];
const weighings: Weight[] = [];
for (let round = 1; round <= rounds; round += 1) {
	if (round > 1) await parkAll(real, host);
	weighings.push(await host.weigh());
	for (const one of real) {
		const recordBytes = sizeOf(one.file);
		const busyRunning = running;
		const started = Date.now();
		const window = await attach(host.path, one.sessionId, ROWS, COLUMNS);
		const answered = Date.now();
		await window.sent(/\S/, DRAWN_MS).catch((error: unknown) => {
			faults.push(
				`round ${round} c${one.index} drew nothing: ${String(error)}`,
			);
		});
		const drawn = Date.now();
		await host.idle(one.sessionId, TURN_MS).catch((error: unknown) => {
			faults.push(`round ${round} c${one.index} never idle: ${String(error)}`);
		});
		const weight = await host.weigh();
		await window.leave();
		const wake: Wake = {
			round,
			conversation: one.index,
			recordBytes,
			answeredMs: answered - started,
			drawnMs: drawn - answered,
			loopMaxMs: Math.round(weight.loopMaxMs),
			loopP99Ms: Math.round(weight.loopP99Ms),
			loopBusy: weight.loopBusy,
			busyRunning,
		};
		wakes.push(wake);
		say(`wake ${JSON.stringify(wake)}`);
	}
}
stopping = true;
await Promise.all(busyLoops);
await host.stop();

const sorted = (pick: (one: Wake) => number) =>
	wakes.map(pick).sort((a, b) => a - b);
const pct = (list: number[], p: number) =>
	list[Math.max(0, Math.ceil(list.length * p) - 1)] ?? null;
const spread = (list: number[]) => ({
	count: list.length,
	p50: pct(list, 0.5),
	p99: pct(list, 0.99),
	max: list.at(-1) ?? null,
	min: list[0] ?? null,
});
const report = {
	logs: real.map((one, at) => ({
		conversation: one.index,
		bytes: sizeOf(logs[at] ?? ""),
	})),
	busy: busy.length,
	busyTurns,
	answeredMs: spread(sorted((one) => one.answeredMs)),
	drawnMs: spread(sorted((one) => one.drawnMs)),
	toDrawnMs: spread(sorted((one) => one.answeredMs + one.drawnMs)),
	loopMaxMs: spread(sorted((one) => one.loopMaxMs)),
	wakes,
	weighings,
	faults,
};
process.stdout.write(`wake bench report: ${JSON.stringify(report)}\n`);
await sealed.dispose();
await provider.close?.();
process.exit(0);
