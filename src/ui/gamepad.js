import {BUTTONS} from "../joypad/joypad";

/**
 * Gamepad API -> digital pad mapping (W3C "standard" layout, which is
 * what Xbox controllers report in Chrome/Edge/Firefox).
 */
const STANDARD_MAP = [
	BUTTONS.CROSS,    // 0: A
	BUTTONS.CIRCLE,   // 1: B
	BUTTONS.SQUARE,   // 2: X
	BUTTONS.TRIANGLE, // 3: Y
	BUTTONS.L1,       // 4: LB
	BUTTONS.R1,       // 5: RB
	BUTTONS.L2,       // 6: LT
	BUTTONS.R2,       // 7: RT
	BUTTONS.SELECT,   // 8: Back/View
	BUTTONS.START,    // 9: Start/Menu
	0,                // 10: LS click
	0,                // 11: RS click
	BUTTONS.UP,       // 12: dpad up
	BUTTONS.DOWN,     // 13: dpad down
	BUTTONS.LEFT,     // 14: dpad left
	BUTTONS.RIGHT,    // 15: dpad right
];

const STICK_THRESHOLD = 0.5;

/**
 * @return {number} - pressed-button mask (BUTTONS.* bits, 0 = none)
 */
export function pollGamepads() {
	if (typeof navigator === "undefined" || !navigator.getGamepads) return 0;
	let mask = 0;
	for (const pad of navigator.getGamepads()) {
		if (!pad || !pad.connected) continue;
		for (let i = 0; i < pad.buttons.length && i < STANDARD_MAP.length; i++) {
			const b = pad.buttons[i];
			if (b.pressed || b.value > 0.5) mask |= STANDARD_MAP[i];
		}
		// left stick doubles as the d-pad
		if (pad.axes.length >= 2) {
			if (pad.axes[0] < -STICK_THRESHOLD) mask |= BUTTONS.LEFT;
			if (pad.axes[0] > STICK_THRESHOLD) mask |= BUTTONS.RIGHT;
			if (pad.axes[1] < -STICK_THRESHOLD) mask |= BUTTONS.UP;
			if (pad.axes[1] > STICK_THRESHOLD) mask |= BUTTONS.DOWN;
		}
	}
	return mask;
}

/**
 * @return {string | null} - id of the first connected gamepad
 */
export function connectedGamepadId() {
	if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
	for (const pad of navigator.getGamepads()) {
		if (pad && pad.connected) return pad.id;
	}
	return null;
}
