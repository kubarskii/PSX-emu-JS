/**
 * Web Worker entry: runs the emulator host off the main thread. The page
 * transfers its <canvas> as an OffscreenCanvas, so frames are rendered
 * and presented from here without a round trip through the page.
 */

import {EmuHost} from "./host";

const host = new EmuHost((msg, transfer) => self.postMessage(msg, transfer || []));

self.onmessage = (e) => {
	try {
		host.handle(e.data);
	} catch (err) {
		self.postMessage({type: "error", message: String(err && err.stack || err)});
	}
};
