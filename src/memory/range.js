// TODO: Separate Range and Mapping into separate files (should be easier to mock in tests later)

import {UnsupportedDataTypeError} from "../errors/unsupported-data-type";

export const REGION_MASK = [
	0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, // KUSEG: 2048MB
	0x7fffffff,                                     // KSEG0:  512MB
	0x1fffffff,                                     // KSEG1:  512MB
	0xffffffff, 0xffffffff,                         // KSEG2: 1024MB
];

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

	/**
	 * @param {number} addr
	 * @return {null | number}
	 * */
	contains(addr) {
		if (addr >= this.initialAddress && addr < this.initialAddress + this.size) {
			return addr - this.initialAddress;
		}
		return null;
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
	 * Masked access to memory is used to match memory mirrors and physical
	 * */
	maskRegion(addr) {
		// Index address space in 512MB chunks
		let index = (addr >>> 29) >> 0 ;
		return addr & REGION_MASK[index];
	}


	/**
	 * WARNING!!! Unaligned memory access should be checked before fn call
     * @param {number} index address where to store data
     * @param {number} data data to be stored
     * @return {void}
     * */
	memWrite(index, data) {
		const addr = this.maskRegion(index) >>> 0;
		/**
		 * Unaligned memory access moved to instructions
		 * */

		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if (r.has(addr)) {
				const actualIndex = (r.initialAddress ^ addr) >>> 2;
				r.write(actualIndex, data >>> 0);
				return;
			}
		}
		throw new Error(`Memory address not found: 0x${addr.toString(16)}`);
	}

	/**
     * @return {number}
     * */
	memRead(index) {
		const addr = this.maskRegion(index);

		for (let i = 0; i < this.data.length; i++) {
			const r = this.data[i];
			if (r.has(addr)) {
				const actualIndex = (r.initialAddress ^ addr) >>> 2;
				return r.data[actualIndex];
			}
		}
		throw new Error("Mapping is not implemented");
	}
}
