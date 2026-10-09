# Maintaining the field manual

The manual is a second Vite entry at `/wiki/`, deployed with the client on the same domain. It never boots the game or opens a gameplay WebSocket. Articles use fragment links such as `/wiki/#hauler`; Vite emits `dist/wiki/index.html`. The existing Vercel middleware rewrites both `/wiki` and `/wiki/` to that entry while preserving query parameters; a Vite plugin applies the same mapping in development and build previews. Search covers titles, summaries, headings, and rule text. No separate service or database is required. Vite commands use its `runner` config loader so the build-time content compiler can import the existing TypeScript game definitions without requiring native Node import syntax across gameplay modules.

## Content and coverage

Pages CMS reads the root `.pages.yml` on the selected branch. Open
<https://app.pagescms.org/jsolly/GeoRoids/main> to find the Field manual collection.
For edits, select a working branch containing that configuration, then save and
ship through a PR. Saving uses GitHub's branch permissions; the CMS does not bypass
the required PR and CI on `main`. Article filenames are stable URLs, so renaming
and deletion are disabled in the editor. New articles still need developer review
of coverage and source references. Upload PNG, JPEG, or WebP images through the
media library; the editor writes `/wiki/uploads/` URLs. Generated demonstrations
and exact gameplay values remain maintained in their owning source files.

Edit `content/wiki/*.md` directly and ship the change through a PR. Each Markdown file contains title, category, summary, navigation order, related article paths, demonstration placements, and a rich-text body. Each placement selects a demonstration and its matching Heading 2, so the illustration stays beside the relevant text. Update the placement heading when renaming a section. Body images go in `public/wiki/uploads/` as PNG, JPEG, or WebP and are referenced as `/wiki/uploads/<name>` with alternative text. Filenames are stable article IDs; title edits do not change URLs. Avoid renaming published articles because their filename is their URL. When a published topic is replaced, migrate every related link and source-reference key to the replacement article and remove the obsolete page; do not leave an alias that keeps the old ID alive. Validation prevents breaking internal links.

`src/wiki/articleSources.json` keeps developer source references separate from editorial content. `src/wiki/gameReference.ts` generates exact values from game definitions in a collapsed reference below the editable body. Keep each feature to two or three short sentences; explain its action, result, and essential limitation. Link to the owning topic instead of repeating its instructions. Use the existing demonstrations where motion explains the rule. Keep imported tuning values out of the narrative so balance changes do not leave stale copies. Some mechanics use private implementation literals, such as the touch flick threshold; those details remain in the editable prose and are checked during gameplay-source review. Do not create duplicate wiki constants for them. New articles need no TypeScript edits; gameplay changes still require developers to maintain coverage and source references. Explain player-visible behavior, including failure conditions and exceptions. Keep strategy separate from confirmed rules and avoid declaring a best tactic without gameplay evidence.

Use `docs/wiki-coverage.md` as the inventory. A new ship or player-facing mechanic needs an entry or a documented section within an existing entry, plus cross-links. New important interactions need the same treatment. Do not interpret a passing hash check as proof that editorial coverage is complete.

Back and Forward return to the scroll position of that visit, including after a reload. A new visit opens at the top.

## Ship profiles

Each ship page pairs an Apache ECharts SVG radar with seven base-stat ratings and exact values. `src/wiki/shipScorecard.ts` derives both displays from the current ship definitions. Each stat maps linearly from the fleet minimum to maximum onto 1–5 bubbles, rounded to a whole bubble. Size, shot interval, and ability cooldown reverse the scale so smaller or shorter scores higher. Equal fleet-wide values score 3. These compare base stats, not ability effectiveness or an overall ship ranking.

The Wiki imports only the radar chart and SVG renderer; gameplay does not load ECharts. Navigation disposes the chart and its resize observer. The HTML values and accessible bubble labels remain the readable counterpart to the visual radar.

## Demonstrations

`src/wiki/media.ts` describes each GIF and its static poster. Each demonstration has a title, descriptive alternative text, a caption explaining the controlled setup, and source files. Assets live in `public/wiki/media/`. Use actual simulation helpers and game geometry in the generator, with scripted inputs and a fixed clock. `scripts/wiki-satellite-demo.ts` records all six Earth-observation pickup hulls from the real `SatellitePickupManager`; keep that simulation separate from panel layout. A section with a demonstration renders its copy and animation in one card, without a repeated caption. Keep the Hauler demonstration on the real tow cable and furnace delivery path, show Scout scan sharing with a teammate radar, and show one environmental asteroid impact reducing health while the ship survives and continues flying. The HUD documentation must describe the local minimap separately from the full-screen universe map opened by M or the Map button, including the shared exploration state and discovered important assets. Keep reflective asteroid behavior in the reflection demonstration. Never invent a visual rule that the game does not implement.

Article demonstrations autoplay their GIF when an article opens; there are no playback controls to operate. When `prefers-reduced-motion: reduce` is active, articles use their static posters. Hiding the browser tab swaps active GIFs to posters, and returning to the tab resumes them when motion is allowed. Posters and descriptive text remain available without animation.

## Generate or verify GIFs

The generator uses the repository's Node `canvas` package and Python with Pillow pinned in `scripts/wiki-media-requirements.txt`. Set `WIKI_MEDIA_PYTHON` to that Python executable when it is not `python3`. Run from the checkout root:

```sh
npm run wiki:media
npm run wiki:media:check
```

Generation renders each controlled scene twice and compares frame and GIF hashes before writing GIFs, PNG posters, and `public/wiki/media/manifest.json`. Verification checks reproducibility and compares regenerated output with the committed assets. The manifest records the fixed seed, dimensions, timing, encoder, and hashes. A generation or comparison failure exits unsuccessfully.

Use the pinned Node dependency installation and the same Pillow version for regeneration. Fonts and native rendering libraries can differ across operating systems; a cross-platform hash difference needs inspection, not automatic baseline acceptance.

## Source review gate

Run commands from `/Users/johnsolly/code/GeoRoids` or the root of its checkout.

`npm run check:wiki` validates frontmatter, stable article IDs, related and body links, image alternative text and local upload paths, source paths, demonstrations, and the accepted source digest. Markdown renders with HTML disabled; executable HTML is never inserted into the page. Gameplay source additions, removals, and changes invalidate the review, including files not cited in an existing article. Changes to rendering, generated demonstrations, and generation scripts also invalidate it. Editorial Markdown and uploaded screenshots are validated on every build but do not invalidate the gameplay review. They cannot change the generated facts or accepted source digest. The build runs this check so stale documentation cannot quietly pass the normal release path.

When a check fails:

1. Inspect changed source files and identify affected rules and illustrations.
2. Update relevant articles and source references; regenerate affected demonstrations.
3. Inspect the resulting images and verify their behavior against the implementation. Run the media reproducibility check when the generator changes.
4. Run lint, types, relevant gameplay tests, and desktop/mobile wiki checks.
5. Record only the completed scope with `npm run wiki:review`: repeat `--source` for each reviewed changed path, `--topic` for every affected article, and `--media` for every affected demonstration, with a nonempty `--note`. Unmapped or deleted sources also need an explicit `--owner source/path=topic-id` using a selected real topic. Then run `npm run test` and `npm run build`, including the review-invalidation contract test. Commit the resulting `docs/wiki-source-review.json` with the change.

Do not regenerate the baseline automatically in CI or as part of a build. The digest detects review work; it cannot write or validate the explanation for you. Review notes should describe actual completed checks. Explicit acceptance formats the ledger with the pinned Biome installation before replacing it atomically; a formatter failure leaves the previous review intact.

Acceptance updates only the selected source hashes, adding or removing those keys as needed. It preserves unrelated pending hashes, the legacy review note and earlier review batches. A scoped acceptance can succeed while reporting other pending sources; the ordinary check still fails until those sources are reviewed. Unknown, duplicate or incomplete selectors fail before writing. Build and CI never accept a review automatically.

For a change confined to the Wiki checker, a review command from `/Users/johnsolly/code/GeoRoids` or its absolute worktree root is:

```sh
npm run wiki:review -- --source scripts/wiki-check.ts --topic field-manual --owner scripts/wiki-check.ts=field-manual --note "Reviewed scoped maintenance checks; player rules and demonstrations are unchanged."
```
