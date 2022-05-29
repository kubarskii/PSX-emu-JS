import {getSigned16} from "../../utils";

export const BRANCH = {
	J(i) {
		const target = i.address();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: j      ${(((this.pc & 0xf0000000) | (target << 2)) >>> 0).toString(16)}`);
		this._nextPc = (this.pc & 0xf0000000) | (target << 2) >>> 0;
	},

	BNE(i) {
		const imm = i.imm();
		const rs = i.rs();
		const rt = i.rt();

		if (this.getRegV(rs) !== this.getRegV(rt)) {
			this._nextPc = (this.pc + imm * 4) >>> 0;
		}

		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: bne      r${rs}, r${rt}, ${(getSigned16(imm)).toString(16)}`);
	},

	JAL(i) {
		const target = i.address();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: jal    ${(((this.pc & 0xf0000000) | (target << 2)) >>> 0).toString(16)}`);
		this._nextPc = (this.pc & 0xf0000000) | (target << 2) >>> 0;
		this.setRegV(31, (this.pc + 4) >>> 0);
	},

	JR(i) {
		let rs = i.rs();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: jr       r${rs}`);
		this._nextPc = this.getRegV(rs);
	},

	BEQ(i) {
		const imm = i.imm();
		const rs = i.rs();
		const rt = i.rt();

		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: beq      r${rs}, r${rt}, ${(imm).toString(16)}`);

		if (this.getRegV(rs) === this.getRegV(rt)) {
			this._nextPc = this.pc + imm * 4;
		}
	},

	BGEZ() {
	},
	BGEZAL() {
	},

	BGTZ(i) {
		const imm = getSigned16(i.imm());
		const rs = i.rs();
		const v = this.getRegV(rs);

		if (v > 0) {
			this._nextPc = this.pc + imm * 4;
		}
	},

	BLEZ() {
	},
	BLTZ() {
	},
	BLTZAL() {
	},
	BREAK() {
	},
	JALR() {
		// debugger;
	},
	SYSCALL() {
	},
};
