/**
 * Used as a bus (connection between BIOS, RAM, GPU ....)
 * Should wrap the memory
 */
export class Interconnect {

	bios = null;
	ram = null;
	gpu = null;

	constructor(bios, ram, gpu) {
		this.bios = bios;
		this.ram = ram;
		this.gpu = gpu;
	}

	/**
     * loads value by address
     * @param {number} addr
     * */
	load(addr) {
		console.log(addr);
	}

	/**
     * stores value by address, should check if memory can be written (not ROM)
     * @param {number} addr
     * @param {number} value
     * */
	store(addr, value) {
		console.log(addr, value);
	}

}
