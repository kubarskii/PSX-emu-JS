import {BIOS_LEN} from "../utils/constants";
import {UnsupportedDataTypeError} from "../errors/unsupported-data-type";

export class Memory extends Uint32Array{

	static instance = undefined;

	/**
     * The Memory will be used for storing bios and games
     * There are several types of data that can be stored in memory, these are:
     * uit8_t, int16_t, int_32t
     * To support all operations this 32bits types array will store the data.
     * @param {number} size this size of the memory to be allocated
     * */
	constructor(size = BIOS_LEN << 4) {
		if (Memory.instance)
			return Memory.instance;
		super(size);
		Memory.instance = this;
	}

	/**
	 * Used to set quaternion of 32 bits value
	 * @param {number} index - index to be updated
	 * @param {number} data - data to be set
	 * */
	setInt8(index, data) {
		if ((data & 0xffffff00) > 0 )
			throw new UnsupportedDataTypeError("Data provided does not fit 8 bits size");

		switch (index & 0x3) {
		case 0: return;
		case 1: return;
		case 2: return;
		case 3: return;
		}
	}

	setInt16(index, data) {

	}

	setInt32(index, data){

	}

}
