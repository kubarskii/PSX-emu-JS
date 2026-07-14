import {BUTTONS} from "../../src/joypad/joypad";
import {pollTouch, mountTouchControls} from "../../src/ui/touchpad";

/** jsdom has no PointerEvent/getBoundingClientRect layout - fake both */
function pointerEvent(type, pointerId, extra) {
	const e = new Event(type, {bubbles: true, cancelable: true});
	Object.assign(e, {pointerId, pointerType: "touch"}, extra);
	return e;
}

/** builds the on-screen control DOM the same way public/index.html does */
function buildDom() {
	document.body.innerHTML = `
		<div id="touch-controls">
			<div class="tp-dpad" data-tp="dpad"></div>
			<button data-tp-button="CROSS"></button>
			<button data-tp-button="TRIANGLE"></button>
		</div>
	`;
	const dpad = document.querySelector("[data-tp=dpad]");
	dpad.getBoundingClientRect = () => ({left: 0, top: 0, width: 100, height: 100});
	mountTouchControls(document.getElementById("touch-controls"));
	return {
		dpad,
		cross: document.querySelector("[data-tp-button=\"CROSS\"]"),
		triangle: document.querySelector("[data-tp-button=\"TRIANGLE\"]"),
	};
}

it("presses and releases a face button", () => {
	const {cross} = buildDom();
	expect(pollTouch()).toBe(0);
	cross.dispatchEvent(pointerEvent("pointerdown", 1));
	expect(pollTouch()).toBe(BUTTONS.CROSS);
	expect(cross.classList.contains("active")).toBe(true);
	cross.dispatchEvent(pointerEvent("pointerup", 1));
	expect(pollTouch()).toBe(0);
	expect(cross.classList.contains("active")).toBe(false);
});

it("pointercancel releases a button the same as pointerup", () => {
	const {triangle} = buildDom();
	triangle.dispatchEvent(pointerEvent("pointerdown", 1));
	expect(pollTouch()).toBe(BUTTONS.TRIANGLE);
	triangle.dispatchEvent(pointerEvent("pointercancel", 1));
	expect(pollTouch()).toBe(0);
});

it("tracks independent fingers on different buttons at once", () => {
	const {cross, triangle} = buildDom();
	cross.dispatchEvent(pointerEvent("pointerdown", 1));
	triangle.dispatchEvent(pointerEvent("pointerdown", 2));
	expect(pollTouch()).toBe(BUTTONS.CROSS | BUTTONS.TRIANGLE);
	cross.dispatchEvent(pointerEvent("pointerup", 1));
	expect(pollTouch()).toBe(BUTTONS.TRIANGLE);
	triangle.dispatchEvent(pointerEvent("pointerup", 2));
	expect(pollTouch()).toBe(0);
});

it("d-pad: center is a dead zone, cardinal directions map to single bits", () => {
	const {dpad} = buildDom();
	dpad.dispatchEvent(pointerEvent("pointerdown", 5, {clientX: 50, clientY: 50}));
	expect(pollTouch()).toBe(0); // center: inside the dead zone

	dpad.dispatchEvent(pointerEvent("pointermove", 5, {clientX: 50, clientY: 10}));
	expect(pollTouch()).toBe(BUTTONS.UP);

	dpad.dispatchEvent(pointerEvent("pointermove", 5, {clientX: 90, clientY: 50}));
	expect(pollTouch()).toBe(BUTTONS.RIGHT);

	dpad.dispatchEvent(pointerEvent("pointerup", 5));
	expect(pollTouch()).toBe(0);
});

it("d-pad: diagonals combine two direction bits", () => {
	const {dpad} = buildDom();
	dpad.dispatchEvent(pointerEvent("pointerdown", 7, {clientX: 90, clientY: 90}));
	expect(pollTouch()).toBe(BUTTONS.RIGHT | BUTTONS.DOWN);
	dpad.dispatchEvent(pointerEvent("pointerup", 7));
});

it("d-pad: resumes tracking a finger that passed through the dead zone", () => {
	const {dpad} = buildDom();
	dpad.dispatchEvent(pointerEvent("pointerdown", 3, {clientX: 90, clientY: 50}));
	expect(pollTouch()).toBe(BUTTONS.RIGHT);
	// drag back through the center (0 bits) without lifting the finger
	dpad.dispatchEvent(pointerEvent("pointermove", 3, {clientX: 50, clientY: 50}));
	expect(pollTouch()).toBe(0);
	// then out the other side: must still be tracked, not stuck at 0
	dpad.dispatchEvent(pointerEvent("pointermove", 3, {clientX: 10, clientY: 50}));
	expect(pollTouch()).toBe(BUTTONS.LEFT);
	dpad.dispatchEvent(pointerEvent("pointerup", 3));
	expect(pollTouch()).toBe(0);
});

it("ignores pointermove from a finger that never pressed the d-pad", () => {
	const {dpad} = buildDom();
	dpad.dispatchEvent(pointerEvent("pointermove", 9, {clientX: 90, clientY: 50}));
	expect(pollTouch()).toBe(0);
});
