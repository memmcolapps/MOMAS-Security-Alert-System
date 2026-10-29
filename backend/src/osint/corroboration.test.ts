import { describe, expect, test } from "bun:test";
import { describeSameEvent, onlyStateLevel, stateOf } from "./corroboration";

// Real reports from the queue, 18-29 Oct 2026, trimmed to the fields matching
// reads. Coordinates are what the geocoder stored: note that unresolved places
// fall back to the state's centre, so equal coordinates prove little.
const report = (r: any) => ({ ...r, date: r.event_date, state: r.event_state, lat: r.event_lat, lon: r.event_lon, claimed_location: r.event_location, type: r.event_type });

const tarabaDailyTrust = report({
  source_url: "https://dailytrust.com/tarabas-bloody-market-day/",
  event_type: "massacre", event_date: "2026-10-21", event_state: "Taraba",
  event_location: "Binnari town, Karim-Lamdo LGA, Taraba State", event_lat: 8.892, event_lon: 11.373,
  title: "Taraba’s bloody market day",
  description: "An attack launched by gunmen suspected to be bandits on Binnari town in Karim-Lamdo Local Government Area of Taraba State has reportedly claimed the lives of over 50 persons, including women and children.",
});
const tarabaGazette = report({
  source_url: "https://t.me/peoplesgazette/337412",
  event_type: "massacre", event_date: "2026-10-26", event_state: "Taraba",
  event_location: "Binnari community, Karim-Lamido LGA, Taraba State", event_lat: 8.892, event_lon: 11.373,
  title: "At least 48 people were killed and several others missing as bandits struck Binnari community",
  description: "At least 48 people were killed and several others missing as bandits struck Binnari community located in the Karim-Lamido local government area of Taraba State. The state police spokesperson said the incident happened on Friday. “It was a bandit attack actually on the village which happened to be on the market day,” Mr Mshelizah stated.",
});
const tarabaTimesOfIndia = report({
  source_url: "https://timesofindia.indiatimes.com/world/x",
  event_type: "banditry", event_date: "2026-10-25", event_state: null,
  event_location: "Taraba state, Nigeria", event_lat: null, event_lon: null,
  title: "At least 62 killed as 'bandit' gunmen attack civilians in Nigeria",
  description: "At least 62 people were killed in a gun attack allegedly carried out by armed criminals locally known as bandits in northeastern Nigeria.",
});
const clericGazette = report({
  source_url: "https://t.me/peoplesgazette/337266",
  event_type: "banditry", event_date: "2026-10-24", event_state: "Katsina",
  event_location: "Katsina", event_lat: 12.988, event_lon: 7.606,
  title: "Police confirm death of Islamic cleric killed by bandits in Katsina",
  description: "Police confirm death of Islamic cleric killed by bandits in Katsina",
});
const clericPunch = report({
  source_url: "https://punchng.com/katsina-cleric-killing-wife-recounts-attack-tinubu-orders-manhunt/",
  event_type: "armed_attack", event_date: "2026-10-27", event_state: "Katsina",
  event_location: "Katsina", event_lat: 12.988, event_lon: 7.606,
  title: "Katsina cleric killing: Wife recounts attack, Tinubu orders manhunt",
  description: "The wife of a slain Katsina Islamic cleric, Sheikh Yahaya Masussuka, has recounted how gunmen killed him. Read More: https://punchng.com/katsina-cleric-killing/",
});
const hunters = report({
  source_url: "https://t.me/peoplesgazette/336605",
  event_type: "banditry", event_date: "2026-10-23", event_state: "Katsina",
  event_location: "Gidan Wawo village, Kakumi Ward, Bakori LGA, Katsina State", event_lat: 12.988, event_lon: 7.606,
  title: "At least 14 bandits have reportedly been killed after local hunters repelled an attempt to abduct residents of Gidan Wawo village",
  description: "Nasir Mu’azu, the state commissioner for internal security and home affairs, disclosed this in a statement.",
});
const butcher = report({
  source_url: "https://t.me/peoplesgazette/336536",
  event_type: "armed_attack", event_date: "2026-10-18", event_state: "Ogun",
  event_location: "Alagbo, Ogun State", event_lat: 7.153, event_lon: 3.345,
  title: "A butcher, Selim Ayodele, has been arrested for allegedly stabbing his colleague to death in Alagbole",
  description: "The state police spokesperson, Oluseyi Babaseyi, said on Friday that the incident happened.",
});
const footballFans = report({
  source_url: "https://punchng.com/algerian-fans-attack-coach-vandalise-stadium-after-rangers-defeat/",
  event_type: "armed_attack", event_date: "2026-10-19", event_state: "Ogun",
  event_location: "Abeokuta", event_lat: 7.153, event_lon: 3.345,
  title: "Algerian fans attack coach, vandalise stadium after Rangers defeat",
  description: "Angry MC Alger supporters allegedly attacked their assistant coach and vandalised the stadium in Abeokuta.",
});

describe("describeSameEvent", () => {
  test("two outlets naming the same village are one event, even five days apart and typed differently", () => {
    expect(describeSameEvent(tarabaDailyTrust, tarabaGazette)).toBe(true);
    expect(describeSameEvent(tarabaGazette, { ...tarabaDailyTrust, type: "banditry" })).toBe(true);
  });

  test("a killing named by two outlets matches despite different types and a three-day gap", () => {
    expect(describeSameEvent(clericGazette, clericPunch)).toBe(true);
  });

  test("a report with no details in common is not counted, even in the same state and week", () => {
    expect(describeSameEvent(tarabaTimesOfIndia, tarabaGazette)).toBe(false);
  });

  test("different incidents in one state do not vouch for each other", () => {
    expect(describeSameEvent(hunters, clericGazette)).toBe(false);
    expect(describeSameEvent(butcher, footballFans)).toBe(false);
  });

  test("different states never match", () => {
    expect(describeSameEvent(clericGazette, { ...clericPunch, state: "Kano", claimed_location: "Kano" })).toBe(false);
  });

  test("displacement is a different kind of event from an attack", () => {
    expect(describeSameEvent(tarabaGazette, { ...tarabaDailyTrust, type: "displacement" })).toBe(false);
  });

  test("named places far apart are different events", () => {
    const elsewhere = { ...tarabaDailyTrust, claimed_location: "Jalingo town, Taraba State", lat: 8.89 + 1, lon: 11.37 + 1 };
    expect(describeSameEvent(tarabaGazette, elsewhere)).toBe(false);
  });

  test("more than a week apart is not the same event, even in the same village", () => {
    expect(describeSameEvent(tarabaGazette, { ...tarabaDailyTrust, date: "2026-10-12" })).toBe(false);
  });
});

describe("places", () => {
  const attack = (location: string, extra: any = {}) => ({
    type: "armed_attack", date: "2026-09-23", state: "Plateau", claimed_location: location,
    title: "Gunmen attacked a mining site, killing two women and injuring miners",
    description: "Rwang Tengwong, spokesman for the Berom Youth Moulders Association, said the miners were shot.",
    ...extra,
  });

  test("attacks in neighbouring villages are separate incidents, however alike the reports", () => {
    expect(describeSameEvent(attack("Marit village, Barkin Ladi LGA, Plateau State"), attack("Rakum community, Barkin Ladi LGA, Plateau State"))).toBe(false);
  });

  test("a less precise report of the same place still matches", () => {
    const clash = (location: string) => ({
      type: "armed_attack", date: "2026-09-23", state: "Plateau", claimed_location: location,
      title: "One shot as NSCDC operatives, traders clash in Jos market",
      description: "NSCDC operatives clashed with traders during a sanitation exercise, smashing vehicles.",
    });
    expect(describeSameEvent(clash("Chorbe market, Jos North LGA, Plateau State"), clash("Jos North, Plateau"))).toBe(true);
    expect(describeSameEvent(clash("Jos North, Plateau"), clash("Bukuru, Jos South LGA, Plateau State"))).toBe(false);
  });

  test("a place spelled two ways is one place", () => {
    const killing = (location: string) => ({
      type: "armed_attack", date: "2026-09-27", state: "Adamawa", claimed_location: location,
      title: "Tea seller beaten to death in Adamawa", description: "A tea seller was beaten to death; police hunt suspects.",
    });
    expect(describeSameEvent(killing("Nassarawa Quarters, Yola North LGA, Adamawa"), killing("Banga, Nassarawo Borehole, Jimeta, Adamawa State"))).toBe(true);
  });

  test("a location that opens with the state names no village", () => {
    const strike = { type: "terrorism", date: "2026-10-02", state: "Borno", claimed_location: "Borno, Badu village south of Gulumba", title: "Air strike kills 40 ISWAP fighters", description: "Operation Hadin Kai air component" };
    const farmers = { type: "terrorism", date: "2026-09-30", state: "Borno", claimed_location: "Marte Local Government Area, Borno", title: "Terrorists kill 15 farmers in Borno", description: "Operation Hadin Kai" };
    expect(describeSameEvent(strike, farmers)).toBe(false);
  });
});

describe("state and place", () => {
  test("a report with no state takes it from the place it names", () => {
    expect(stateOf(tarabaTimesOfIndia)).toBe("taraba");
    expect(stateOf({ state: "Taraba State" })).toBe("taraba");
  });

  test("a place that is only the state is not a pinned-down location", () => {
    expect(onlyStateLevel(tarabaTimesOfIndia)).toBe(true);
    expect(onlyStateLevel(clericPunch)).toBe(true);
    expect(onlyStateLevel(tarabaGazette)).toBe(false);
  });
});
