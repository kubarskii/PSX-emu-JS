export const SHIFTER = {

	SLL(i){
		const rd = i.rd();
		const rt = i.rt();
		const sa = i.shamt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: nop`);
		this.setRegV(rd, this.getRegV(rt) << sa);
	}

};
