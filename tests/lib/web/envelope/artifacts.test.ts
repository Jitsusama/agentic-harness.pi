import { describe, expect, it } from "vitest";
import { withArtifact } from "../../../../lib/web/envelope/artifacts.js";
import { paginate } from "../../../../lib/web/envelope/paged.js";
import type { BundleSink } from "../../../../lib/web/reader.js";

interface Entry {
	id: number;
	text: string;
}

function entries(count: number): Entry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		text: `entry ${i + 1}`,
	}));
}

/** A sink that keeps what it was handed, so writes are inspectable. */
function fakeSink(): BundleSink & { written: Map<string, string> } {
	const written = new Map<string, string>();
	return {
		dir: "/tmp/bundle",
		written,
		writeText(name, content) {
			written.set(name, content);
			return `/tmp/bundle/${name}`;
		},
		writeBinary(name, base64) {
			written.set(name, base64);
			return `/tmp/bundle/${name}`;
		},
	};
}

const shape = { idOf: (entry: Entry) => entry.id };

describe("withArtifact", () => {
	it("hands back a path to the diverted answer", () => {
		const sink = fakeSink();
		const all = entries(100);

		const page = withArtifact(paginate(all, {}, shape), all, sink, {
			name: "requests.json",
		});

		expect(page.artifactPath).toBe("/tmp/bundle/requests.json");
	});

	it("writes everything, not just the window the caller saw", () => {
		const sink = fakeSink();
		const all = entries(100);

		const page = paginate(all, { limit: 5 }, shape);
		withArtifact(page, all, sink, { name: "requests.json" });

		const written = [...sink.written.values()][0];
		expect(page.items).toHaveLength(5);
		expect(JSON.parse(written)).toHaveLength(100);
	});

	it("lets the caller decide the artifact's format", () => {
		const sink = fakeSink();
		const all = entries(3);

		withArtifact(paginate(all, {}, shape), all, sink, {
			name: "requests.txt",
			render: (items) => items.map((one) => one.text).join("\n"),
		});

		expect([...sink.written.values()][0]).toBe("entry 1\nentry 2\nentry 3");
	});

	it("keeps the summary and the window alongside the path", () => {
		const sink = fakeSink();
		const all = entries(100);

		const page = withArtifact(paginate(all, { limit: 5 }, shape), all, sink, {
			name: "requests.json",
		});

		expect(page.total).toBe(100);
		expect(page.items).toHaveLength(5);
		expect(page.nextCursor).toBeDefined();
	});

	it("does not let one divert overwrite another", () => {
		const sink = fakeSink();
		const all = entries(3);

		const first = withArtifact(paginate(all, {}, shape), all, sink, {
			name: "requests.json",
		});
		const second = withArtifact(paginate(all, {}, shape), all, sink, {
			name: "requests.json",
		});

		expect(second.artifactPath).not.toBe(first.artifactPath);
		expect(sink.written.size).toBe(2);
	});
});
