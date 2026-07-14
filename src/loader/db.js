/**
 * Minimal IndexedDB wrapper for persisting binaries (BIOS image) and the
 * game-library directory handle. Unlike localStorage it stores
 * ArrayBuffers and FileSystemHandles natively.
 */

const DB_NAME = "psx-emu";
const DB_VERSION = 3;
const STORE = "binaries";
const HANDLES = "handles";
const COVERS = "covers";

const STORES = [STORE, HANDLES, COVERS];

/**
 * @param {number} version - 0 opens at the current version
 * @return {Promise<IDBDatabase>}
 */
function openAt(version) {
	return new Promise((resolve, reject) => {
		const req = version === 0 ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const s of STORES) {
				if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Opens the database, healing half-migrated states: when a store is
 * missing at the current version (an upgrade ran with older code), one
 * more version bump forces onupgradeneeded to create it.
 * @return {Promise<IDBDatabase>}
 */
async function openDb() {
	let db = await openAt(DB_VERSION).catch(() => openAt(0));
	if (!STORES.every((s) => db.objectStoreNames.contains(s))) {
		const next = db.version + 1;
		db.close();
		db = await openAt(next);
	}
	return db;
}

/**
 * @param {string} store
 * @param {string} key
 * @param {*} value
 * @return {Promise<void>}
 */
async function put(store, key, value) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readwrite");
		tx.objectStore(store).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * @param {string} store
 * @param {string} key
 * @return {Promise<*>}
 */
async function get(store, key) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readonly");
		const req = tx.objectStore(store).get(key);
		req.onsuccess = () => resolve(req.result || null);
		req.onerror = () => reject(req.error);
	});
}

/**
 * @param {string} key
 * @param {ArrayBuffer} buffer
 * @return {Promise<void>}
 */
export function saveBinary(key, buffer) {
	return put(STORE, key, buffer);
}

/**
 * @param {string} key
 * @return {Promise<ArrayBuffer | null>}
 */
export function loadBinary(key) {
	return get(STORE, key);
}

/**
 * @param {string} key - normalized thumbnail name
 * @param {Blob} blob - cover image
 * @return {Promise<void>}
 */
export function saveCover(key, blob) {
	return put(COVERS, key, blob);
}

/**
 * @param {string} key
 * @return {Promise<Blob | null>}
 */
export function loadCover(key) {
	return get(COVERS, key);
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @return {Promise<void>}
 */
export function saveLibraryHandle(handle) {
	return put(HANDLES, "library", handle);
}

/**
 * @return {Promise<FileSystemDirectoryHandle | null>}
 */
export function loadLibraryHandle() {
	return get(HANDLES, "library");
}
