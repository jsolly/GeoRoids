# Grokbot prompt for the GeoRoids developer

Add a monthly performance review routine for GeoRoids development.

Run the repeatable browser benchmarks with fixed scenarios, seeds, viewports,
CPU throttling and network constraints. Compare results with the previous month
and agreed reference values. Include frame timing, input latency, network
delivery and deterministic work per frame. Retain raw results, source and browser
provenance, and explain changes in workload or environment before comparing them.

Performance results are report-only. Do not emit CI warnings or fail CI for
numeric performance changes. Invalid measurements and functional failures remain
errors. Review meaningful regressions and improvements monthly, explain deliberate
feature costs, and propose reference-value adjustments for discussion rather than
silently resetting them.

Review documented mobile visual reductions and whether general improvements or
new hardware justify removing them. Update performance documentation and notify
John only when there is a meaningful change, a failed measurement, or a decision
needed. Physical phone testing supplements the browser routine and must not be a
prerequisite. No Android device is currently available; an iPhone 16e is available
for separate real-device validation.
