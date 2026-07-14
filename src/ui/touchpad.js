/**
 * Touch/pointer controller overlay for the player screen. Every control
 * is driven by Pointer Events (unifies touch, pen and mouse), each
 * pointer tracked independently so multiple fingers on different
 * buttons work at once, and released on pointerup/cancel so a finger
 * lifted off-screen never leaves a button stuck down.
 */

import {BUTTONS} from "../joypad/joypad";

/** bits contributed by each currently active pointer, keyed by pointerId */
const activePointers = new Map();
let mask = 0;

/** @return {number} - BUTTONS.* bitmask currently held by touch/pointer input */
export function pollTouch() {
	return mask;
}

/**
 * @param {number} pointerId
 * @param {number} bits
 */
function setBits(pointerId, bits) {
	if (bits === 0) {
		activePointers.delete(pointerId);
	} else {
		activePointers.set(pointerId, bits);
	}
	let m = 0;
	for (const b of activePointers.values()) m |= b;
	mask = m;
}

/**
 * @param {number} pointerId
 */
function release(pointerId) {
	setBits(pointerId, 0);
}

/**
 * Routes subsequent pointer events to el even if the finger drags off
 * it. Not implemented in every environment (older WebViews, jsdom in
 * tests), so this degrades gracefully rather than throwing.
 * @param {Element} el
 * @param {number} pointerId
 */
function capture(el, pointerId) {
	if (typeof el.setPointerCapture !== "function") return;
	try {
		el.setPointerCapture(pointerId);
	} catch (err) {
		// unsupported pointerId or capture target: touch still works,
		// it just won't track drags that leave the element's bounds
	}
}

/**
 * Wires a single-bit button element (face buttons, shoulders, start/select).
 * @param {Element} el
 * @param {number} bits
 */
function attachButton(el, bits) {
	el.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		capture(el, e.pointerId);
		el.classList.add("active");
		setBits(e.pointerId, bits);
	});
	const up = (e) => {
		el.classList.remove("active");
		release(e.pointerId);
	};
	el.addEventListener("pointerup", up);
	el.addEventListener("pointercancel", up);
}

/** 8-way sector -> BUTTONS bitmask (index 0 = east, clockwise) */
const DPAD_SECTORS = [
	BUTTONS.RIGHT,
	BUTTONS.RIGHT | BUTTONS.DOWN,
	BUTTONS.DOWN,
	BUTTONS.DOWN | BUTTONS.LEFT,
	BUTTONS.LEFT,
	BUTTONS.LEFT | BUTTONS.UP,
	BUTTONS.UP,
	BUTTONS.UP | BUTTONS.RIGHT,
];

/**
 * Wires the d-pad: one circular hit area, direction (and diagonals)
 * computed from the touch point's angle from the center, so a finger
 * can slide between directions like a real d-pad.
 * @param {Element} el
 */
function attachDpad(el) {
	// tracked separately from activePointers: a finger resting in the
	// dead zone contributes 0 bits (and is absent from activePointers),
	// but pointermove must keep listening to it until it actually lifts
	const held = new Set();

	const update = (pointerId, clientX, clientY) => {
		const r = el.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		const dx = clientX - cx;
		const dy = clientY - cy;
		const dist = Math.hypot(dx, dy);
		const deadZone = Math.min(r.width, r.height) * 0.15;
		if (dist < deadZone) {
			setBits(pointerId, 0);
			return;
		}
		const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
		const sector = Math.round(deg / 45) % 8;
		setBits(pointerId, DPAD_SECTORS[sector]);
	};
	el.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		capture(el, e.pointerId);
		held.add(e.pointerId);
		el.classList.add("active");
		update(e.pointerId, e.clientX, e.clientY);
	});
	el.addEventListener("pointermove", (e) => {
		if (!held.has(e.pointerId)) return;
		update(e.pointerId, e.clientX, e.clientY);
	});
	const up = (e) => {
		held.delete(e.pointerId);
		if (held.size === 0) el.classList.remove("active");
		release(e.pointerId);
	};
	el.addEventListener("pointerup", up);
	el.addEventListener("pointercancel", up);
}

/**
 * Wires every [data-tp-button]/[data-tp="dpad"] element under root.
 * @param {Element | null} root
 */
export function mountTouchControls(root) {
	if (root === null) return;
	const dpad = root.querySelector("[data-tp=\"dpad\"]");
	if (dpad !== null) attachDpad(dpad);
	for (const el of root.querySelectorAll("[data-tp-button]")) {
		const bits = BUTTONS[el.dataset.tpButton];
		if (bits !== undefined) attachButton(el, bits);
	}
}
