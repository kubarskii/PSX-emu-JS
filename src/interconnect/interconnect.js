/**
 * TODO: replace memory with Interconnect???
 * Used as a bus (connection between BIOS, RAM ....)
 * Should wrap the memory
 */
export class Interconnect {

	bios = null;

	constructor(bios) {
		this.bios = bios;
	}

	/**
     * loads value by address
     * @param {number} addr
     * */
	load() {
	}

	/**
     * stores value by address, should check if memory can be written (not ROM)
     * @param {number} addr
     * @param {number} value
     * */
	store() {

	}

}
