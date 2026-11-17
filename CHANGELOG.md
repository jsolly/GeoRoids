# Changelog

## 2026-11-17

- Retired the thirteen-asset `_astro` migration inventory, bootstrap downloads,
  aliases and their exclusive seed, registry-response and corrupt-migration tests.
  Migration commit `3a475f8d2d92cbe024c669b93bf48732cd78484a` reached production
  on 2026-10-15 at 15:11:20 UTC, recorded by
  [deployment 7096452167](https://api.github.com/repos/jsolly/GeoRoids/deployments/7096452167/statuses).
  Its minimum 30-day window ended on 2026-11-14 at 15:11:20 UTC. On November 17,
  all thirteen original aliases, immutable migration entries and pinned source
  URLs returned HTTP 410. Production builds no longer depend on those expired URLs.
  Current salted immutable assets, complete SHA-256 inventories and retained-URL
  size/checksum verification keep their existing 30-day retention contract.
