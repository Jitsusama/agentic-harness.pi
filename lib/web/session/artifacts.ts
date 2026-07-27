/**
 * Everything a session puts on disk, and the bookkeeping that
 * keeps one write from trampling another.
 *
 * The sink is made on first use rather than at open, because
 * most sessions never write anything and a directory per
 * session would be litter. The stamps exist so no picture or
 * archive overwrites another, and the ledger of paths exists so
 * status can recite what was written, in order.
 */

import { type BundleSink, diskSink } from "../envelope/index.js";

/** The disk side of a session: sink, stamps and ledger. */
export class ArtifactLedger {
	/** Where this session's files are written, made on demand. */
	private bundle?: BundleSink;

	/** How many pictures have been taken. */
	private shots = 0;

	/** How many archives have been written. */
	private archives = 0;

	/** Everything this session has put on disk, in order. */
	private readonly paths: string[] = [];

	/** The sink artifacts go to, made on first use. */
	sink(): BundleSink {
		if (!this.bundle) this.bundle = diskSink();
		return this.bundle;
	}

	/** The next picture's stamp, so none overwrites another. */
	nextShot(): string {
		this.shots += 1;
		return String(this.shots).padStart(2, "0");
	}

	/** The next archive's stamp, for the same reason. */
	nextArchive(): string {
		this.archives += 1;
		return String(this.archives).padStart(2, "0");
	}

	/** Note a path in the ledger and hand it back. */
	keep(path: string): string {
		this.paths.push(path);
		return path;
	}

	/** Everything written, in order. */
	get written(): readonly string[] {
		return this.paths;
	}
}
