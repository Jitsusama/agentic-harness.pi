// A keyring call that dies as the native module did on 18 November: SIGSEGV, before it answers.
process.kill(process.pid, "SIGSEGV");
