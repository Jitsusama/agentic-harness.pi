// A keyring call that panics in its native module and dies by a signal before it answers, as the native module did with SIGSEGV on 18 November; it leaves stderr as a Rust panic does, and SIGKILL stands in so no run leaves a core dump to write.
process.stderr.write(
	"\nthread '<unnamed>' panicked at src/entry.rs:12:5:\nthe entry faulted\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n",
);
process.kill(process.pid, "SIGKILL");
