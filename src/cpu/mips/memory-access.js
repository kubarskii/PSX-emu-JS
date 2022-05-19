import {memory} from "../../memory";
import {getSigned16} from "../../utils";

export const MA = {
	SW(i) {
		if ((this._sr & 0x1000) !== 0x0) {
			console.log("Ignoring write as cache is isolated!");
			return;
		}
		const imm = getSigned16(i.imm());
		const rt = i.rt();
		const rs = i.rs();
		const addr = this.getRegV(rs) + imm >>> 0;
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: sw     r${rt}, $${imm.toString(16).padStart(4, 0)}(r${rs})`);
		memory.memWrite(addr, this.getRegV(rt));
	},

	LW(i) {
		const rs = i.rs();
		const rt = i.rt();
		const offset = i.imm();
		const addr = this.getRegV(rs) + offset;
		const v = memory.memRead(addr) >> 0;
		this.setRegV(rt, v);
	},

	// SB(i) {
	//
	// },

	/**
     * Store HALF WORD - 16 bit instead of 32
     * */
	SH(i) {
		if (this.sr & 0x10000 !== 0) {
			/**
             * Cache is isolated , ignore write
             * */
			console.warn("Ignoring store while cache is isolated");
			return;
		}

		let imm = i.imm();
		let rt = i.rt();
		let rs = i.rs();

		let addr = this.getRegV(rs) + imm;

		if (addr % 2 === 0) {
			let v = this.getRegV(rt);
			memory.memWrite(addr, v);
		} else {
			throw new Error("StoreAddressError");
		}
	}
};

