/**
 * Whether the checkout a package was loaded from has moved since.
 *
 * pi evaluates an extension once, when it loads, and a pull afterwards
 * changes the files on disk without changing what runs. A session can
 * run for days on code several merges old while every file it reads
 * says otherwise. Comparing the checkout's HEAD with the one it had at
 * load says so, once per new HEAD, so nobody is told the same thing
 * after every run.
 */

/** A move of the checkout's HEAD since the code was loaded. */
export interface HeadMove {
	readonly loaded: string;
	readonly now: string;
}

/** Options for {@link headWatch}. */
export interface HeadWatchOptions {
	/** HEAD as it was when the code loaded, or nothing without git. */
	readonly loaded: Promise<string | undefined>;
	/** Read HEAD now, or nothing when it cannot be read. */
	readonly read: () => Promise<string | undefined>;
	/** The least time between two reads. */
	readonly intervalMs: number;
	/** The clock, in milliseconds. */
	readonly now?: () => number;
}

/** Asks whether HEAD moved, at most once an interval. */
export interface HeadWatch {
	/**
	 * A move not reported before, or nothing: no git, too soon since
	 * the last read, the same HEAD, or one already reported.
	 */
	check(): Promise<HeadMove | undefined>;
}

/** Watch a checkout's HEAD against the one it had at load. */
export function headWatch(options: HeadWatchOptions): HeadWatch {
	const clock = options.now ?? Date.now;
	let lastRead = Number.NEGATIVE_INFINITY;
	let reading = false;
	let reported: string | undefined;
	return {
		async check() {
			if (reading || clock() - lastRead < options.intervalMs) return undefined;
			reading = true;
			lastRead = clock();
			try {
				const loaded = await options.loaded;
				if (!loaded) return undefined;
				const now = await options.read();
				if (!now || now === loaded || now === reported) return undefined;
				reported = now;
				return { loaded, now };
			} finally {
				reading = false;
			}
		},
	};
}
