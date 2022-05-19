import {memory} from "../../memory";
import {getSigned16} from "../../utils";

export const MA = {
	SW(i) {
		if ((this.sr & 0x1000) !== 0x0) {
			console.warn("Ignoring write as cache is isolated!");
			return;
		}
		const imm = getSigned16(i.imm());
		const rt = i.rt();
		const rs = i.rs();
		const addr = this.getRegV(rs) + imm >>> 0;

		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: sw     r${rt}, $${imm.toString(16).padStart(4, 0)}(r${rs})`);

		if (addr % 4 === 0) {
			memory.memWrite(addr, this.getRegV(rt));
		} else {
			console.log("Unaligned memory access");
		}
	},

	LW(i) {
		const rs = i.rs();
		const rt = i.rt();
		const imm = i.imm();
		const addr = (this.getRegV(rs) + imm) >>> 0;
		const v = memory.memRead(addr) >> 0;
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: lw    r${rt}, $${imm.toString(16).padStart(4, 0)}(r${rs})`);
		this.setRegV(rt, v);
	},

	/**
	 * Store byte - 8 bit
	 * */
	SB(i) {
		if (this.sr & 0x10000 !== 0) {
			/** Cache is isolated , ignore write*/
			console.warn("ignoring store while cache is isolated");
			return;
		}

		const imm = i.imm();
		const rt = i.rt();
		const rs = i.rs();
		const addr = (this.getRegV(rs) + imm) >>> 0;
		const v = this.getRegV(rt);

		memory.memWrite(addr, v);

	},

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

		const imm = i.imm();
		const rt = i.rt();
		const rs = i.rs();

		const addr = this.getRegV(rs) + imm >>> 0;

		if (addr % 2 === 0) {
			const v = this.getRegV(rt);
			memory.memWrite(addr, v);
		} else {
			throw new Error("StoreAddressError");
		}
	}
};

