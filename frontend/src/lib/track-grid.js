// How many tracked radios fit on the screen at once, and how to lay them out.
//
// There is no fixed limit. A tile has to stay big enough to read - the street
// around the radio and its header - so the screen's own size decides how many
// fit. A wall screen in the control room is watched from metres away, which is
// why the minimum tile size is a choice rather than a constant.

export const TILE_SIZES = {
  compact: { label: "Compact", width: 360, height: 260 },
  standard: { label: "Standard", width: 480, height: 340 },
  wall: { label: "Wall", width: 640, height: 460 },
};

// Space between tiles, in CSS pixels.
export const TILE_GAP = 8;

// Wider than this and it is a wall screen, not a desk.
const WALL_SCREEN_WIDTH = 2500;

export function defaultTileSize(screenWidth) {
  return screenWidth >= WALL_SCREEN_WIDTH ? "wall" : "compact";
}

function fitCount(space, size) {
  return Math.max(1, Math.floor((space + TILE_GAP) / (size + TILE_GAP)));
}

/** The most tiles of this size the area holds: columns, rows and the total. */
export function capacity(width, height, sizeKey) {
  const size = TILE_SIZES[sizeKey] || TILE_SIZES.compact;
  const cols = fitCount(width, size.width);
  const rows = fitCount(height, size.height);
  return { cols, rows, max: cols * rows };
}

/**
 * The columns and rows for `count` tiles: whichever arrangement inside the
 * capacity makes each tile biggest. A tile is judged by the largest 4:3 frame
 * it holds, so neither a sliver nor a letterbox wins. Ties go to the layout
 * with fewer empty cells.
 */
export function gridFor(count, width, height, sizeKey) {
  const room = capacity(width, height, sizeKey);
  const shown = Math.min(Math.max(count, 0), room.max);
  if (!shown) return { cols: 1, rows: 1, shown: 0, max: room.max };
  let best = null;
  for (let cols = 1; cols <= Math.min(room.cols, shown); cols += 1) {
    const rows = Math.ceil(shown / cols);
    if (rows > room.rows) continue;
    const tileWidth = (width - TILE_GAP * (cols - 1)) / cols;
    const tileHeight = (height - TILE_GAP * (rows - 1)) / rows;
    const score = Math.min(tileWidth, (tileHeight * 4) / 3);
    const empty = cols * rows - shown;
    if (!best || score > best.score + 0.5 || (Math.abs(score - best.score) <= 0.5 && empty < best.empty)) {
      best = { cols, rows, score, empty };
    }
  }
  return { cols: best.cols, rows: best.rows, shown, max: room.max };
}

// Web Mercator, as Leaflet draws it, at zoom 0 on a 256 px world.
function project(lat, lon) {
  const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * 256, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256 };
}

// Close enough to see which street each radio is on.
export const TOGETHER_MIN_ZOOM = 16;

/**
 * Whether every position fits on one map of this size at street zoom. When it
 * does, one map with every trail on it says more than separate tiles.
 */
export function fitsTogether(positions, width, height, pad = 48) {
  const points = positions.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
  if (points.length < 2) return true;
  const projected = points.map((point) => project(point.lat, point.lon));
  const spanX = Math.max(...projected.map((p) => p.x)) - Math.min(...projected.map((p) => p.x));
  const spanY = Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y));
  const usableWidth = Math.max(1, width - pad * 2);
  const usableHeight = Math.max(1, height - pad * 2);
  if (!spanX && !spanY) return true;
  const zoom = Math.log2(Math.min(spanX ? usableWidth / spanX : Infinity, spanY ? usableHeight / spanY : Infinity));
  return zoom >= TOGETHER_MIN_ZOOM;
}

// One colour per tracked radio, on its tile, pin and trail. Picked to stay
// apart from each other and from the status colours (red SOS, amber stale).
export const TRACK_COLOURS = ["#22d3ee", "#a78bfa", "#f472b6", "#4ade80", "#facc15", "#60a5fa", "#fb923c", "#2dd4bf", "#e879f9", "#a3e635"];

/** The first colour no tracked radio is using, or a repeat once all are. */
export function nextColour(used) {
  const taken = new Set(used);
  return TRACK_COLOURS.find((colour) => !taken.has(colour)) || TRACK_COLOURS[used.length % TRACK_COLOURS.length];
}
