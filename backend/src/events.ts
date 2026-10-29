import { EventEmitter } from "node:events";

// Shared bus for cross-module signalling (DB inserts → SSE broadcasters etc.)
const bus = new EventEmitter();
// Every open map holds a listener for radio points, on top of the broadcasters.
bus.setMaxListeners(200);

export { bus };
