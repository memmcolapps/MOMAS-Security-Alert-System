import { describe, expect, test } from "bun:test";
import { addYears, cardServiceWindow, day, manualServiceWindow, parseDay } from "./licences";

const at = (value: string) => new Date(`${value}T00:00:00`);
const now = new Date("2026-11-04T14:20:00");

describe("cardServiceWindow", () => {
  test("extends a live account from its expiry and keeps its start", () => {
    const window = cardServiceWindow({ begin: at("2025-12-08"), end: at("2026-12-08"), years: 1, now });
    expect(day(window.begin)).toBe("2025-12-08");
    expect(day(window.end)).toBe("2027-12-08");
  });

  test("restarts an expired account from today", () => {
    const window = cardServiceWindow({ begin: at("2023-01-01"), end: at("2023-11-15"), years: 2, now });
    expect(day(window.begin)).toBe("2026-11-04");
    expect(day(window.end)).toBe("2028-11-04");
    expect(window.end.getHours()).toBe(0);
  });

  test("treats a never-activated account as expired", () => {
    const window = cardServiceWindow({ begin: null, end: null, years: 1, now });
    expect(day(window.begin)).toBe("2026-11-04");
    expect(day(window.end)).toBe("2027-11-04");
  });
});

describe("manualServiceWindow", () => {
  test("revives an expired account with today as its start", () => {
    const window = manualServiceWindow({ begin: at("2023-01-01"), end: at("2023-11-15"), until: at("2027-03-01"), now });
    expect(day(window.begin)).toBe("2026-11-04");
    expect(day(window.end)).toBe("2027-03-01");
  });

  test("can cut an account off by picking a past date", () => {
    const window = manualServiceWindow({ begin: at("2025-01-01"), end: at("2027-01-01"), until: at("2026-01-01"), now });
    expect(day(window.begin)).toBe("2025-01-01");
    expect(day(window.end)).toBe("2026-01-01");
  });
});

test("29 February moves to 28 February in a common year", () => {
  expect(day(addYears(at("2028-02-29"), 1))).toBe("2029-02-28");
  expect(day(addYears(at("2028-02-29"), 4))).toBe("2032-02-29");
});

test("parseDay accepts real calendar dates only", () => {
  expect(day(parseDay("2027-06-30")!)).toBe("2027-06-30");
  expect(parseDay("2027-02-30")).toBeNull();
  expect(parseDay("30/06/2027")).toBeNull();
  expect(parseDay(undefined)).toBeNull();
});
