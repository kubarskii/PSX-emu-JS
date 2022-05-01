import {BIOS_LEN} from "./constants";

/**
 * Simple check that fn is a function
 * @param {unknown} fn
 * @return {boolean}
 * */
export const isFunction = (fn) => typeof fn === "function";

/**
 * @param {number} value - dec number to be converted to hex
 * @param {number} len - max string length returned, 8 is default
 * @return {string} - hex representation of {value}
 * */
export const toHex = (value, len = 8) => {
	return value.toString(16).padStart(len, "0");
};

/**
 * Saves binary to localStorage, so we can read it later if needed,
 * generally is intended for bios, but can save any type of binary
 * @param {string} name - localStorage binary type name
 * @param {ArrayBuffer} buffer - ArrayBuffer with
 * @return {void}
 * */
export const writeBinaryToLocalStorage = (name, buffer) => {
	localStorage.setItem(name, JSON.stringify(Array.from(new Uint32Array(buffer))));
};

/**
 * Used to get data from localStorage
 * @see BINARY_TYPES
 * @param {string} name - localStorage binary type name
 * @return {ArrayBuffer | null}
 * */
export const readBinaryFromLocalStorage = (name) => {
	const binaryString = localStorage.getItem(name);
	if (binaryString === null)
		return null;

	const arr = JSON.parse(binaryString);
	const uint_8_arr = new Uint32Array(arr);
	return uint_8_arr.buffer;
};

/**
 * Reads binary and call callback passed
 * @type <T = BINARY_TYPES, K extends keyof T>(name: K, cb: (c: ArrayBuffer) => void) => void
 * @return {void}
 * */
export const readAndExecute = (name, cb) => {
	const buffer = readBinaryFromLocalStorage(name);
	if (isFunction(cb))
		cb(buffer);
};

/**
 * checks that the bugger contains bios
 * @param {ArrayBuffer} buffer
 * @return {boolean}
 * */
export const isBios = (buffer) => {
	return buffer.byteLength === BIOS_LEN;
};

/**
 * Function stub that can be used if no callback provided
 * @return {undefined}
 * */
export const stubFn = () => void 0;
