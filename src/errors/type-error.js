export class CPUTypeError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "CPU TypeError";
	}
}
