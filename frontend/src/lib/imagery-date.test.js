import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPhotoDate, pickPhotoDate } from "./imagery-date.js";

// Shaped like Esri's answer for a place with a different photo per zoom range.
const results = [
  { layerId: 0, attributes: { "DATE (YYYYMMDD)": "20200405", MinMapLevel: "12", MaxMapLevel: "17" } },
  { layerId: 2, attributes: { "DATE (YYYYMMDD)": "20230115", MinMapLevel: "18", MaxMapLevel: "18" } },
  { layerId: 3, attributes: { "DATE (YYYYMMDD)": "20251220", MinMapLevel: "19", MaxMapLevel: "19" } },
];

test("each zoom gets the date of the photo it actually shows", () => {
  assert.equal(pickPhotoDate(results, 12), "20200405");
  assert.equal(pickPhotoDate(results, 17.4), "20200405");
  assert.equal(pickPhotoDate(results, 18), "20230115");
  assert.equal(pickPhotoDate(results, 19), "20251220");
  // Past 19 the map enlarges the zoom-19 photo.
  assert.equal(pickPhotoDate(results, 21), "20251220");
});

test("no date when zoomed out to the undated world mosaic, or when Esri has none", () => {
  assert.equal(pickPhotoDate(results, 11), null);
  assert.equal(pickPhotoDate([{ attributes: { "DATE (YYYYMMDD)": "Null", MinMapLevel: "12", MaxMapLevel: "19" } }], 15), null);
  assert.equal(pickPhotoDate(undefined, 15), null);
});

test("dates read the way people write them", () => {
  assert.equal(formatPhotoDate("20200405"), "5 Apr 2020");
  assert.equal(formatPhotoDate("20251220"), "20 Dec 2025");
  assert.equal(formatPhotoDate("2020"), "");
});
