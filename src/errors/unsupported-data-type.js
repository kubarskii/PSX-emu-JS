export class UnsupportedDataTypeError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "Unsupported dataType";
	}
}
