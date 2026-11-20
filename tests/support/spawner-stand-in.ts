/**
 * A stand-in pi-spawner: two streams and an end. It reads the requests pi
 * writes and sends the frames a test tells it to, so what pi's bash sees
 * through pi-spawner is checked without starting anything.
 */

import { PassThrough } from "node:stream";

/** A stand-in pi-spawner, as one test drives it. */
export type SpawnerStandIn = ReturnType<typeof spawnerStandIn>;

/** A stand-in pi-spawner: what it was asked, and frames to answer with. */
export function spawnerStandIn() {
	const input = new PassThrough();
	const output = new PassThrough();
	let stopped: (() => void) | undefined;
	let running = true;
	const asked: string[][] = [];
	let held = Buffer.alloc(0);
	input.on("data", (chunk: Buffer) => {
		held = Buffer.concat([held, chunk]);
		while (held.length >= 4 && held.length >= 4 + held.readUInt32LE(0)) {
			const length = held.readUInt32LE(0);
			const fields = held
				.subarray(4, 4 + length)
				.toString("utf8")
				.split("\0");
			asked.push(fields.slice(0, -1));
			held = held.subarray(4 + length);
		}
	});
	const frame = (kind: string, id: number, payload: Buffer) => {
		const head = Buffer.alloc(9);
		head[0] = kind.charCodeAt(0);
		head.writeUInt32LE(id, 1);
		head.writeUInt32LE(payload.length, 5);
		output.write(Buffer.concat([head, payload]));
	};
	const int32s = (...values: number[]) => {
		const bytes = Buffer.alloc(values.length * 4);
		for (const [at, value] of values.entries()) {
			bytes.writeInt32LE(value, at * 4);
		}
		return bytes;
	};
	const started = (id: number, pid: number) => frame("p", id, int32s(pid));
	const closed = (id: number, stream: 1 | 2) =>
		frame("c", id, Buffer.from([stream]));
	const exited = (id: number, code: number, signal = 0) =>
		frame("x", id, int32s(code, signal));
	return {
		asked,
		start: () => ({
			input,
			output,
			running: () => running,
			ended: (listener: () => void) => {
				stopped = listener;
			},
		}),
		started,
		said: (id: number, stream: 1 | 2, text: string) =>
			frame("o", id, Buffer.concat([Buffer.from([stream]), Buffer.from(text)])),
		closed,
		exited,
		failed: (id: number, why: string) => frame("e", id, Buffer.from(why)),
		/** End command `id` as pi-spawner would: started, closed, exited 0. */
		ends: (id: number, pid: number) => {
			started(id, pid);
			closed(id, 1);
			closed(id, 2);
			exited(id, 0);
		},
		stop: () => {
			running = false;
			stopped?.();
		},
		/** Its process exits and is reaped, its output not yet read to the end. */
		exits: () => {
			running = false;
		},
		/** Whether pi ended its input, which tells the program to stop. */
		hungUp: () => input.writableEnded,
	};
}
