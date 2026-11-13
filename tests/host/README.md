# Host Tests

Observable ownership, lifecycle and pi parity of the shared runtime under
host/.

- `cutover/`: mirrors host/cutover/, on fakes of the machine.
- `engine/`: mirrors host/engine/.
- `screen/`: mirrors host/screen/.
- `service/`: socket contract tests.
- `end-to-end/`: runs a whole host as its own process under a sealed HOME.
- `parity/`: records six scenarios on plain pi and on the host, from one
  install with this package's extensions, and fails on any difference beyond
  the host's durable journal. It needs a pi built with the host's patches, and
  skips without one, saying how to get one. Run it before merging a change to
  host/, with `pnpm test:host` or on one build:

```sh
PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
  tests/host/parity/parity.test.ts
```

- `soak/`: a week's turns through one host, then through plain pi, reporting
  the host's memory over the run, each side's turn latency and how their
  records differ. Its smoke test runs in `pnpm test:host`; a week's run goes
  on a lent builder by hand, as its README says.
