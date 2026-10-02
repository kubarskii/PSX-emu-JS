/**
 * Detects a JavaScript engine running without its optimizing JIT.
 *
 * Security modes do exactly that: Edge's "enhanced security" (default
 * "balanced" level, on for sites you rarely visit), Chrome's per-site
 * "JavaScript optimization" setting, lockdown modes. The emulator then
 * runs 20-40x slower (the dynarec's compiled blocks only pay off once
 * V8 optimizes them), which no amount of tuning can make up for — the
 * page tells the user how to lift it instead.
 */

/** below this the optimizing tier is clearly off (phones with it: 300+) */
export const JIT_MIN_MOPS = 100;

/** @return {number} - integer loop throughput, million iterations/s */
export function measureJit() {
	const a = new Int32Array(1024);
	let x = 1;
	let best = 0;
	const start = performance.now();
	// a few short rounds: the first ones run in the interpreter until V8
	// tiers the loop up; capped at ~60ms even when it never does
	for (let r = 0; r < 40 && performance.now() - start < 60; r++) {
		const t0 = performance.now();
		x = kernel(a, x, 200000);
		const dt = performance.now() - t0;
		if (dt > 0) best = Math.max(best, 200000 / dt / 1000);
	}
	if (x === 0x7fffffff) a[0] = 1; // keep the result observable
	return best;
}

function kernel(a, x, n) {
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) | 0;
		a[i & 1023] ^= x;
	}
	return x;
}
