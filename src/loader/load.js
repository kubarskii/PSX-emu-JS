import {isBios, writeBinaryToLocalStorage} from "../utils";
import {UnsupportedDataTypeError} from "../errors/unsupported-data-type";
import {BINARY_TYPES, BIOS_LEN, DEFAULT_MASK, DEFAULT_BIOS_PC} from "../utils/constants";
import {memory} from "../memory";

/**
 * Loads the file provided
 * @param file
 * @param {(e: ProgressEvent<FileReader>) => void} onErr - onerror callback
 * @param {(e: string | ArrayBuffer) => void} onLoad - onload callback
 * @return {void}
 * */
export const loadFile = (file, onLoad, onErr) => {
	const reader = new FileReader();

	reader.onerror = (event) => {
		console.warn("Error occurred");
		onErr(event);
	};

	reader.onload = (event) => {
		onLoad(event.target.result);
	};

	reader.readAsArrayBuffer(file);
};

/**
 * @param {ArrayBuffer} buffer - buffer of bytes of the binary provided
 * @return {never}
 * */
export const loadFileData = (buffer) => {
	if (isBios(buffer)) {
		writeBinaryToLocalStorage(BINARY_TYPES.BIOS, buffer);
		const data = new Int32Array(buffer);
		// const INITIAL_ADDRESS = DEFAULT_BIOS_PC & DEFAULT_MASK
		for (let i = 0; i < BIOS_LEN; i += 4) {
			memory[i >> 2] = data[i >> 2];
		}

		console.log(memory, data);
		return void 0;
	}
	throw new UnsupportedDataTypeError(`file MUST be one of: ${Object.values(BINARY_TYPES).join(", ")}`);
};
