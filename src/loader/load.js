/**
 * Reads a File (from an <input type="file">) as an ArrayBuffer.
 * @param {File} file
 * @return {Promise<ArrayBuffer>}
 */
export function readFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => resolve(reader.result);
		reader.readAsArrayBuffer(file);
	});
}
