import {UnsupportedDataTypeError} from "../errors/unsupported-data-type";

export class Range {
	data;
	initialAddress;
	size;

	/**
     * @param {number} initialAddress - initial address
     * @param {number} size - of range in bytes
     * */
	constructor(initialAddress, size) {
		this.data = new Uint32Array(new Uint8Array(size).buffer);
		this.initialAddress = initialAddress;
		this.size = size;
	}

	/**
     * @param {number} index
     * @param {number} data
     * */
	write(index, data) {
		if (typeof data !== "number")
			throw new UnsupportedDataTypeError("Memory can store only numbers");
		this.data[index] = data;
	}

}

export class Mapping {
	/**
     * @type Array<Range>
     * */
	data = [];

	constructor() {
	}

	/**
     * Adds Range to the Mapping
     * */
	add(range) {
		this.data.push(range);
	}

	/**
     * @param {number} index
     * @param {number} data
     * @return {void}
     * */
	memWrite(index, data) {
		console.log(index);
		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if (r.initialAddress <= index && (index - r.initialAddress) <= r.size) {
				const actualIndex = r.initialAddress ^ index >>> 0;
				r.write(actualIndex, data);
			}
		}
	}

	/**
     * @return {number}
     * */
	memRead(index) {
		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if ((r.initialAddress <= index) && ((index - r.initialAddress) <= r.size)) {
				const actualIndex = r.initialAddress ^ index >>> 0;
				return r.data[actualIndex];
			}
		}
		throw new Error("Mapping is not implemented");
	}
}
