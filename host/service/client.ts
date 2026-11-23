/** One-shot control client; never retries a possibly committed mutation. */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { jsonLines } from "./framing.ts";
import {
	type ControlRequest,
	parseControl,
	parseDrainResult,
	parseListResult,
	parseReply,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether a control request's failure says nothing listens at the
 * socket: no socket file, one nothing serves, or a file there that is
 * no socket, which Linux refuses as ECONNREFUSED and macOS as ENOTSOCK.
 * Any other failure, a timeout or a close before the reply, leaves what
 * the host would have said unknown.
 */
export function nothingListens(error: unknown): boolean {
	const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK";
}

/**
 * Send one control request and verify reply correlation; attach needs V's
 * streaming client. A connection carries one request, so an error a host
 * gave before it could read the request's id (`id: null`, as dispatch
 * answers what it can't parse) is this request's answer; any other id is
 * refused.
 */
export async function controlRequest(
	path: string,
	value: ControlRequest,
	timeoutMs = REQUEST_TIMEOUT_MS,
) {
	const request = parseControl(value);
	if (
		["close", "release", "abort", "drain"].includes(request.op) &&
		!request.expectedHost
	)
		throw new Error(
			"Session-ending requests require expectedHost discovery identity",
		);
	if (request.op === "attach")
		throw new Error("Attach requires a streaming viewer client");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error("Control timeout must be a positive integer");
	return new Promise<ReturnType<typeof parseReply>>((resolve, reject) => {
		const socket = createConnection(path);
		const frames = jsonLines();
		let settled = false;
		const deadline = setTimeout(
			() => fail(new Error("Host control request timed out; outcome unknown")),
			timeoutMs,
		);
		function fail(error: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			socket.destroy();
			reject(error);
		}

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			try {
				const values = frames.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				);
				if (!values.length) return;
				if (values.length !== 1)
					throw new Error("Host sent multiple control replies");
				const reply = parseReply(values[0]);
				const unread = !reply.ok && reply.id === null;
				if (reply.id !== request.id && !unread)
					throw new Error("Host reply id does not match request");
				settled = true;
				clearTimeout(deadline);
				socket.destroy();
				resolve(reply);
			} catch (error) {
				fail(error);
			}
		});
		socket.on("error", fail);
		socket.on("close", () =>
			fail(new Error("Host closed before reply; outcome unknown")),
		);
	});
}

/**
 * Start or lift the drain of the host listening at `path`, naming the host
 * a list just found, so a host restarted between the two refuses it.
 * Answers what the host said: the counts, and the heavy runs going.
 */
export async function drainHost(path: string, on: boolean, by: string) {
	const listed = await controlRequest(path, {
		v: 1,
		id: randomUUID(),
		op: "list",
	});
	if (!listed.ok) throw new Error(listed.error.message);
	const { host } = parseListResult(listed.result);
	const reply = await controlRequest(path, {
		v: 1,
		id: randomUUID(),
		op: "drain",
		on,
		by,
		expectedHost: host,
	});
	if (!reply.ok) throw new Error(reply.error.message);
	return parseDrainResult(reply.result);
}
