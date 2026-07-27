import { describe, expect, test } from "bun:test";
import {
  evaluateFence,
  haversineMetres,
  pointInPolygon,
  validatePolygonGeometry,
} from "./geometry";

const square = {
  type: "Polygon",
  coordinates: [[
    [3.0, 6.0],
    [4.0, 6.0],
    [4.0, 7.0],
    [3.0, 7.0],
    [3.0, 6.0],
  ]],
};

describe("geofence geometry", () => {
  test("detects points inside and outside a polygon", () => {
    expect(pointInPolygon(6.5, 3.5, square)).toBe(true);
    expect(pointInPolygon(7.5, 3.5, square)).toBe(false);
  });

  test("validates GeoJSON polygon coordinates", () => {
    expect(validatePolygonGeometry(square)).toBe(true);
    expect(validatePolygonGeometry({ type: "LineString", coordinates: [] })).toBe(false);
  });

  test("applies a GPS buffer outside a polygon", () => {
    const nearEdge = evaluateFence(
      { shape_type: "polygon", geometry: square, buffer_m: 30 },
      6.5,
      4.0001,
    );
    const farOutside = evaluateFence(
      { shape_type: "polygon", geometry: square, buffer_m: 30 },
      6.5,
      4.01,
    );
    expect(nearEdge.outside).toBe(false);
    expect(farOutside.outside).toBe(true);
  });

  test("applies radius and buffer to circles", () => {
    const roughlyOneKmNorth = 6.009;
    const result = evaluateFence(
      {
        shape_type: "circle",
        center_lat: 6,
        center_lon: 3,
        radius_m: 900,
        buffer_m: 50,
      },
      roughlyOneKmNorth,
      3,
    );
    expect(haversineMetres(6, 3, roughlyOneKmNorth, 3)).toBeGreaterThan(950);
    expect(result.outside).toBe(true);
  });
});

