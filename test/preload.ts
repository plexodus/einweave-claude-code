/**
 * Every test that spawns the plugin passes `...process.env` through. A developer's shell
 * may still carry pre-0.30 BRIDGE_* variables (BRIDGE_AUTOCONNECT, BRIDGE_PROFILE, …), and the
 * plugin now REFUSES to start a session with any of them (legacy-env.ts) — which would
 * fail the whole suite on that machine for a reason that has nothing to do with the test.
 * test/legacy-env.test.ts sets its own explicitly.
 */
for (const k of Object.keys(process.env)) if (k.startsWith("BRIDGE_")) delete process.env[k];

/**
 * Two fixed waits every spawned plugin paid (measured 2026-10-25: 3.0 s for the session-map
 * hook this suite never runs, 1.0 s shutdown grace — ~4 s per test, ~75% of a 20-min suite).
 * Set here so every spawn that passes `...process.env` inherits them; honoured only under
 * EINWEAVE_TEST=1 (server.ts testKnob). A test OF either wait sets the production value back.
 */
process.env.EINWEAVE_TEST = "1";
process.env.EINWEAVE_TEST_SESSION_MAP_WAIT_MS = "0";
process.env.EINWEAVE_TEST_SHUTDOWN_GRACE_MS = "50";
