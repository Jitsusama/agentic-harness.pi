# Rules lib/core Keeps

Tests that read every library in `lib/core` at once, for promises no
single library's tests can hold: each git command names its repo, importing
the package loads none of its heaviest dependencies, and a remote's URL
reaches a person without its credential.
