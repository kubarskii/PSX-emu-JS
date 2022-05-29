import {loadFile, loadFileData} from "./loader/load";
import {readAndExecute, stubFn} from "./utils";
import {BINARY_TYPES} from "./utils/constants";
import {BIOS} from "./bios/bios";
import {CPU} from "./cpu/cpu";
import {initMemory, memory} from "./memory";

const test_form = document.getElementById("test_form");

const loadFileErrorCb = (e) => {
	console.warn(e);
};
const initialLog = console.log;
window.useLog = false;
console.log = (...params) => (window.useLog) ? initialLog(...params) : stubFn;

initMemory();

/**
 * Loading file from form on submit
 * */
test_form.addEventListener("submit", function (e) {
	e.preventDefault();
	const file_input = this.file_loader;
	const fileList = file_input.files;
	Array.from(fileList).forEach(file => {
		loadFile(file, loadFileData, loadFileErrorCb);
	});
});

/**
 * Attempting to load binary from localStorage
 * @see BINARY_TYPES
 * */
readAndExecute(BINARY_TYPES.BIOS, (buffer) => {
	if (!buffer) return;
	loadFileData(buffer);
	const bios = new BIOS(new CPU(), memory);
	bios.run();
});


