/** Bounded LF framing preserves split UTF-8 and refuses truncated records. */
const MAX_FRAME_BYTES = 1024 * 1024;

/** Decode complete JSON lines without treating Unicode separators as LF. */
export function jsonLines(limit = MAX_FRAME_BYTES) {
	let pending: Buffer | undefined;
	let bytes = 0;
	let failed = false;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	function fail(message: string): never {
		failed = true;
		pending = undefined;
		bytes = 0;
		throw new Error(message);
	}
	return {
		push(chunk: Buffer): unknown[] {
			if (failed) throw new Error("Host frame decoder is closed");
			const frames: unknown[] = [];
			let start = 0;
			while (start < chunk.length) {
				const lf = chunk.indexOf(10, start);
				const end = lf === -1 ? chunk.length : lf;
				const part = chunk.subarray(start, end);
				if (bytes + part.length > limit) fail("Host frame exceeds byte limit");
				if (part.length) {
					pending ??= Buffer.allocUnsafe(limit);
					part.copy(pending, bytes);
				}
				bytes += part.length;
				if (lf === -1) break;
				const line = pending?.subarray(0, bytes) ?? Buffer.alloc(0);
				bytes = 0;
				try {
					frames.push(JSON.parse(decoder.decode(line)));
				} catch {
					fail("Host frame is not valid UTF-8 JSON");
				}
				start = lf + 1;
			}
			return frames;
		},
		end(): void {
			if (bytes) fail("Host frame ended before LF");
			failed = true;
		},
	};
}
