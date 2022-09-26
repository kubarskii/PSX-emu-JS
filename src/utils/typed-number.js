export default class N {

	static typedInt8 = new Int8Array(1);
	static typedUInt8 = new Uint8Array(1);
	static typedInt16 = new Int16Array(1);
	static typedUInt16 = new Uint16Array(1);
	static typedInt32 = new Int32Array(1);
	static typedUInt32 = new Uint32Array(1);
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static int8(n){
		N.typedInt8[0] = n;
		return N.typedInt8[0];
	}
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static uint8(n){
		N.typedUInt8[0] = n;
		return N.typedUInt8[0];
	}
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static int16(n){
		N.typedInt16[0] = n;
		return N.typedInt16[0];
	}
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static uint16(n){
		N.typedUInt16[0] = n;
		return N.typedUInt16[0];
	}
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static int32(n){
		N.typedInt32[0] = n;
		return N.typedInt32[0];
	}
	/**
	 * @param {number} n
	 * @return {number}
	 * */
	static uint32(n){
		N.typedUInt32[0] = n;
		return N.typedUInt32[0];
	}
}
