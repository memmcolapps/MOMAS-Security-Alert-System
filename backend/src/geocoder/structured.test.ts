import { describe, expect, test } from "bun:test";
import { geocodeStructured, locateReport } from "./index";

describe("structured locations", () => {
  test("an LGA named in the location is found, not just the state", () => {
    const found = geocodeStructured("Marte Local Government Area, Borno");
    expect(found?.state).toBe("Borno");
    expect(found?.matched).toBe("Marte");
  });

  test("a misspelt LGA is still found, within the named state", () => {
    // News copy wrote Karim-Lamdo; the gazetteer has Karim Lamido.
    const found = geocodeStructured("Binnari town, Karim-Lamdo LGA, Taraba State");
    expect(found?.state).toBe("Taraba");
    expect(found?.matched).toBe("Karim Lamido");
  });

  test("the most specific part that exists wins", () => {
    expect(geocodeStructured("Gidan Wawo village, Kakumi Ward, Bakori LGA, Katsina State")?.matched).toBe("Kakumi");
    expect(geocodeStructured("Chorbe market, Jos North LGA, Plateau State")?.level).toBe("lga");
  });

  test("a place in another state is never used", () => {
    // Yola exists in Plateau's gazetteer too; Adamawa's Yola is the one meant.
    expect(geocodeStructured("Yola North LGA, Adamawa")?.state).toBe("Adamawa");
  });

  test("a location that only names the state has no coordinates, but still gives the state", () => {
    expect(geocodeStructured("Taraba state, Nigeria")).toBeNull();
    expect(locateReport({ locationText: "Taraba state, Nigeria", fullText: "At least 62 killed in Nigeria" }).state).toBe("Taraba");
  });

  test("article text naming another state does not override the location", () => {
    const { state } = locateReport({ locationText: "Marte Local Government Area, Borno", fullText: "Troops from Kaduna deployed" });
    expect(state).toBe("Borno");
  });
});
