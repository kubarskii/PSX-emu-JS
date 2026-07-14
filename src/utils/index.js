import {BIOS_LEN} from "./constants";

/**
 * @param {number} value - dec number to be converted to hex
 * @param {number} len - max string length returned, 8 is default
 * @return {string} - hex representation of {value}
 * */
export const toHex = (value, len = 8) => {
	return (value >>> 0).toString(16).padStart(len, "0");
};

/**
 * Checks that the buffer looks like a PSX BIOS image
 * @param {ArrayBuffer} buffer
 * @return {boolean}
 * */
export const isBios = (buffer) => {
	return buffer.byteLength === BIOS_LEN;
};
