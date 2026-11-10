# Host Tests

Observable ownership, lifecycle and pi parity of the shared runtime under
host/. engine/ mirrors host/engine/; screen/ mirrors host/screen/; service/ holds
socket contract tests; end-to-end/ runs a whole host as its own process under
a sealed HOME; parity/ records six scenarios on plain pi and on the host, from
one install with this package's extensions, and fails on any difference beyond
the host's durable journal. It needs a pi built with the host's patches, and
is skipped without one. Run it before merging a change to host/:

```sh
PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
  tests/host/parity/parity.test.ts
```
