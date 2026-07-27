import { describe, expect, test } from "bun:test";
import {
  evaluateFence,
  fenceCentre,
  fenceMetrics,
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

  test("locates the centre of both fence shapes", () => {
    expect(fenceCentre({ shape_type: "polygon", geometry: square })).toEqual({ lat: 6.5, lon: 3.5 });
    expect(fenceCentre({ shape_type: "circle", center_lat: 6, center_lon: 3, radius_m: 500 })).toEqual({
      lat: 6,
      lon: 3,
    });
    expect(fenceCentre({ shape_type: "circle", center_lat: null, center_lon: null })).toBeNull();
  });

  test("measures a circle in metres and square metres", () => {
    const metrics = fenceMetrics({ shape_type: "circle", center_lat: 6, center_lon: 3, radius_m: 500 });
    expect(metrics?.width_m).toBe(1000);
    expect(metrics?.area_sq_m).toBeCloseTo(Math.PI * 500 * 500, 0);
  });

  test("measures a polygon at roughly its true ground size", () => {
    // One degree of latitude is ~111 km; the square spans a degree each way,
    // narrowing east-west with the cosine of the latitude.
    const metrics = fenceMetrics({ shape_type: "polygon", geometry: square });
    expect(metrics?.height_m).toBeGreaterThan(110_000);
    expect(metrics?.height_m).toBeLessThan(112_000);
    expect(metrics?.width_m).toBeGreaterThan(108_000);
    expect(metrics?.area_sq_m).toBeGreaterThan(1.1e10);
  });

  test("reports no metrics for a polygon that is not a shape yet", () => {
    expect(fenceMetrics({ shape_type: "polygon", geometry: { type: "Polygon", coordinates: [[[3, 6]]] } })).toBeNull();
  });
});

