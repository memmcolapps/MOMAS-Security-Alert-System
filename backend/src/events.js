"use strict";

const { EventEmitter } = require("events");

// Shared bus for cross-module signalling (DB inserts → SSE broadcasters etc.)
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = { bus };
