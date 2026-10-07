# Server integration tests

These cases exercise server modules and owned loopback WebSocket interactions:
protocol admission, authoritative state, current-client recovery and lifecycle.
Use fixed participants and controlled clocks when the assertion depends on a
rule deadline. Follow [test conventions](../../AGENTS.md).

From the absolute checkout path:

```sh
npm run test:integration:server
./scripts/test-runner.sh tests/integration/server/server-pause.test.ts
```

The repository runner owns fresh local services, automatically selected unused
ports and process cleanup. It requires Node and no browser. Never attach to a
developer server or invoke raw Vitest on these paths. The complete literal
[server/entity inventory](../README.md#complete-inventory) runs in the local gate
and the CI integration lane.
