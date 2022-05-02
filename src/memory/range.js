// TODO: Separate Range and Mapping into separate files (should be easier to mock in tests later)

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
		this.data = new Uint32Array(size >>> 2);
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

	/**
     * @param {number} index
     * @return {boolean}
     */
	has(index) {
		const i = (this.initialAddress | ((index ^ this.initialAddress) >> 2)) >>> 0;
		return i >= this.initialAddress && i - this.initialAddress <= this.size;

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
     * TODO: ADD INTERSECTION CHECK (NOT SUPPOSED TO BE FAST AS CALLED RARELY)
     *
     * Adds Range to the Mapping
     *
     * !!!! It will NOT override old ranges if intersect BE CAREFUL !!!
     * @param {Range} range
     * */
	add(range) {
		this.data.push(range);
	}

	/**
     * @param {(a: number, b: number, c: Mapping) => void} cb
     * @return {void}
     */
	forEach(cb) {
		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			for (let j = 0; j < r.data.length; j++) {
				cb(r[j], j, this);
			}
		}
	}

	/**
     * @param {number} index address where to store data
     * @param {number} data data to be stored
     * @param {boolean} force use force property to allow unaligned memory access by force
     * @return {void}
     * */
	memWrite(index, data, force = false) {
		if (!force && (index >>> 0) % 4 !== 0) {
			throw new Error(`Unaligned memWrite address: 0x${index.toString(16)}`);
		}
		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if (r.has(index)) {
				const actualIndex = (r.initialAddress ^ index) >>> 2;
				r.write(actualIndex, data >>> 0);
				return;
			}
		}
		throw new Error(`Memory address not found: 0x${index.toString(16)}`);
	}

	/**
     * @return {number}
     * */
	memRead(index) {
		if ((index >>> 0) % 4 !== 0) {
			throw new Error(`Unaligned memRead address: 0x${index.toString(16)}`);
		}
		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if (r.has(index)) {
				const actualIndex = (r.initialAddress ^ index) >>> 2;
				return r.data[actualIndex];
			}
		}
		throw new Error("Mapping is not implemented");
	}
}
