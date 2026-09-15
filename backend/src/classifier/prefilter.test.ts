import { describe, expect, test } from "bun:test";
import { looksLikeSecurityIncident } from "./prefilter";

describe("OSINT security prefilter", () => {
  test("rejects ordinary business, politics, sport, and public-safety stories", () => {
    const noise = [
      "FSL launches Commodity Fund to boost agric investment in Nigeria",
      "TAJBank PBT rises 74%, pays higher dividend in Lagos",
      "NSDC mobilises $1bn investment pipeline for sugar self-sufficiency",
      "Arsenal thrash Man City in Community Shield",
      "Truck kills pedestrian in Lagos-Ibadan Expressway crash",
      "Four workers killed in Kano building collapse",
      "Police arrest two suspects with tramadol in Delta State",
    ];
    for (const title of noise) expect(looksLikeSecurityIncident(title)).toBe(false);
  });

  test("keeps concrete Nigerian violence and abduction reports", () => {
    const incidents = [
      "Gunmen attack Kajuru village and kill two residents in Kaduna",
      "Bandits kidnap 12 passengers on the Abuja-Kaduna road",
      "Bomb explosion kills three in Borno market",
      "Armed herders raid Benue community",
    ];
    for (const title of incidents) expect(looksLikeSecurityIncident(title)).toBe(true);
  });

  test("does not match security fragments embedded inside unrelated words", () => {
    expect(looksLikeSecurityIncident("Nigeria launches digital skills mobilisation fund")).toBe(false);
  });
});
