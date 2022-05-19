export const BRANCH = {
	J(i) {
		const target = i.address();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: j      ${(((this.pc & 0xf0000000) | (target << 2)) >>> 0).toString(16)}`);
		this._nextPc = (((this.pc & 0xf0000000) | (target << 2)) >>> 0);
	},

	BNE(i) {
		const imm = i.imm() & 0x0000ffff;
		const rs = i.rs();
		const rt = i.rt();

		if (this.getRegV(rs) !== this.getRegV(rt)) {
			this._nextPc = this._currentPc + 4 + 4 * ((i.value << 16) >> 16);
		}
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: bne      r${rs}, r${rt}, ${(imm).toString(16)}`);
	},

	JAL(i){
		this.branch.J(i);
		this.setRegV(31, this._nextPc);
	},

	BEQ() {},
	BGEZ() {},
	BGEZAL() {},
	BGTZ() {},
	BLEZ(){},
	BLTZ(){},
	BLTZAL(){},
	BREAK(){},
	JALR(){},
	JR(){},
	SYSCALL(){},
};
