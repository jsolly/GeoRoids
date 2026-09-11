# Maintaining the field manual

The manual is a second Vite entry at `/wiki/`, deployed with the client on the same domain. It never boots the game or opens a gameplay WebSocket. Articles use fragment links such as `/wiki/#hauler`; Vite emits `dist/wiki/index.html`. The existing Vercel middleware rewrites both `/wiki` and `/wiki/` to that entry while preserving the release header; a Vite plugin applies the same mapping in development and build previews. Search covers titles, summaries, headings, and rule text. No separate service or database is required.

## Content and coverage

Edit `src/wiki/content.ts`. Every article declares its authoritative source files and related entry IDs; sections own the demonstration that illustrates that section, and `mediaForArticle` derives the article media inventory for checks. Exact values should come from game definitions where possible. Explain player-visible behavior, including failure conditions and exceptions. Keep strategy separate from confirmed rules and avoid declaring a best tactic without gameplay evidence.

Use `docs/wiki-coverage.md` as the inventory. A new ship or player-facing mechanic needs an entry or a documented section within an existing entry, plus cross-links. New important interactions need the same treatment. Do not interpret a passing hash check as proof that editorial coverage is complete.

## Ship profiles

Each ship page pairs an Apache ECharts SVG radar with seven base-stat ratings and exact values. `src/wiki/shipScorecard.ts` derives both displays from the current ship definitions. Each stat maps linearly from the fleet minimum to maximum onto 1–5 bubbles, rounded to a whole bubble. Size, shot interval, and ability cooldown reverse the scale so smaller or shorter scores higher. Equal fleet-wide values score 3. These compare base stats, not ability effectiveness or an overall ship ranking.

The Wiki imports only the radar chart and SVG renderer; gameplay does not load ECharts. Navigation disposes the chart and its resize observer. The HTML values and accessible bubble labels remain the readable counterpart to the visual radar.

## Demonstrations

`src/wiki/media.ts` describes each GIF and its static poster. Each demonstration has a title, descriptive alternative text, a caption explaining the controlled setup, and source files. Assets live in `public/wiki/media/`. Use actual simulation helpers and game geometry in the generator, with scripted inputs and a fixed clock. `scripts/wiki-satellite-demo.ts` records all six firing profiles from the real `SatelliteManager`, including burst gaps and projectile lifetimes; keep that simulation separate from panel layout. A section with a demonstration renders its copy and animation in one card, without a repeated caption. Keep the Hauler demonstration on its combat harpoon and keep reflective asteroid behavior in the reflection demonstration. Never invent a visual rule that the game does not implement.

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

`npm run check:wiki` checks article IDs, related links, source paths, media files, and the accepted source digest. Gameplay source additions, removals, and changes invalidate the review, including files not cited in an existing article. Changes to prose, media, and generation scripts also invalidate it. The build runs this check so stale documentation cannot quietly pass the normal release path.

When a check fails:

1. Inspect changed source files and identify affected rules and illustrations.
2. Update relevant articles and source references; regenerate affected demonstrations.
3. Inspect the resulting images and verify their behavior against the implementation. Run the media reproducibility check when the generator changes.
4. Run lint, types, relevant gameplay tests, and desktop/mobile wiki checks.
5. Record the completed review with `npm run wiki:review -- --note "Describe the rules and demonstrations reviewed"`. Then run `npm run test` and `npm run build`, including the review-invalidation contract test. Commit the resulting `docs/wiki-source-review.json` with the change.

Do not regenerate the baseline automatically in CI or as part of a build. The digest detects review work; it cannot write or validate the explanation for you. Review notes should describe actual completed checks.
