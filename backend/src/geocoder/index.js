'use strict';

/**
 * Nigerian place name geocoder.
 * Resolves a location string to { lat, lon, state } using
 * a static reference database of ~200 Nigerian places.
 */

// Reference database: state capitals, LGAs, major cities, and security hotspots
const PLACES = [
  // ── Abia ──────────────────────────────────────────────────────────────────
  { name: 'umuahia',    state: 'Abia',      lat: 5.532,  lon: 7.485 },
  { name: 'aba',        state: 'Abia',      lat: 5.106,  lon: 7.366 },

  // ── Adamawa ───────────────────────────────────────────────────────────────
  { name: 'yola',       state: 'Adamawa',   lat: 9.204,  lon: 12.496 },
  { name: 'mubi',       state: 'Adamawa',   lat: 10.265, lon: 13.267 },
  { name: 'numan',      state: 'Adamawa',   lat: 9.467,  lon: 12.033 },

  // ── Akwa Ibom ─────────────────────────────────────────────────────────────
  { name: 'uyo',        state: 'Akwa Ibom', lat: 5.033,  lon: 7.933 },
  { name: 'eket',       state: 'Akwa Ibom', lat: 4.648,  lon: 7.924 },

  // ── Anambra ───────────────────────────────────────────────────────────────
  { name: 'awka',       state: 'Anambra',   lat: 6.211,  lon: 7.074 },
  { name: 'onitsha',    state: 'Anambra',   lat: 6.148,  lon: 6.789 },
  { name: 'nnewi',      state: 'Anambra',   lat: 6.017,  lon: 6.917 },

  // ── Bauchi ────────────────────────────────────────────────────────────────
  { name: 'bauchi',     state: 'Bauchi',    lat: 10.307, lon: 9.845 },
  { name: 'azare',      state: 'Bauchi',    lat: 11.679, lon: 10.193 },
  { name: 'misau',      state: 'Bauchi',    lat: 11.326, lon: 10.045 },

  // ── Bayelsa ───────────────────────────────────────────────────────────────
  { name: 'yenagoa',    state: 'Bayelsa',   lat: 4.926,  lon: 6.269 },

  // ── Benue ─────────────────────────────────────────────────────────────────
  { name: 'makurdi',    state: 'Benue',     lat: 7.730,  lon: 8.522 },
  { name: 'gboko',      state: 'Benue',     lat: 7.323,  lon: 9.001 },
  { name: 'otukpo',     state: 'Benue',     lat: 7.190,  lon: 8.134 },
  { name: 'ukum',       state: 'Benue',     lat: 7.082,  lon: 9.244 },
  { name: 'logo',       state: 'Benue',     lat: 7.182,  lon: 9.100 },
  { name: 'gwer',       state: 'Benue',     lat: 7.622,  lon: 8.375 },
  { name: 'guma',       state: 'Benue',     lat: 8.003,  lon: 8.712 },
  { name: 'agatu',      state: 'Benue',     lat: 7.432,  lon: 7.955 },
  { name: 'apa',        state: 'Benue',     lat: 7.289,  lon: 8.048 },
  { name: 'katsina-ala',state: 'Benue',     lat: 6.994,  lon: 9.284 },
  { name: 'yelwata',    state: 'Benue',     lat: 7.730,  lon: 8.530 },
  { name: 'anwase',     state: 'Benue',     lat: 7.220,  lon: 8.950 },
  { name: 'akpanta',    state: 'Benue',     lat: 7.250,  lon: 8.350 },
  { name: 'kwande',     state: 'Benue',     lat: 7.250,  lon: 9.250 },

  // ── Borno ─────────────────────────────────────────────────────────────────
  { name: 'maiduguri',  state: 'Borno',     lat: 11.833, lon: 13.150 },
  { name: 'bama',       state: 'Borno',     lat: 11.524, lon: 13.686 },
  { name: 'gwoza',      state: 'Borno',     lat: 11.090, lon: 13.690 },
  { name: 'chibok',     state: 'Borno',     lat: 10.857, lon: 12.851 },
  { name: 'konduga',    state: 'Borno',     lat: 11.980, lon: 13.590 },
  { name: 'damboa',     state: 'Borno',     lat: 11.170, lon: 12.693 },
  { name: 'dikwa',      state: 'Borno',     lat: 12.033, lon: 13.917 },
  { name: 'kukawa',     state: 'Borno',     lat: 12.916, lon: 13.569 },
  { name: 'mobbar',     state: 'Borno',     lat: 13.467, lon: 13.167 },
  { name: 'nganzai',    state: 'Borno',     lat: 12.400, lon: 13.283 },
  { name: 'abadam',     state: 'Borno',     lat: 13.883, lon: 13.433 },
  { name: 'zabarmari',  state: 'Borno',     lat: 11.900, lon: 13.250 },
  { name: 'koshobe',    state: 'Borno',     lat: 11.900, lon: 13.250 },
  { name: 'darul jamal',state: 'Borno',     lat: 11.850, lon: 13.160 },

  // ── Cross River ───────────────────────────────────────────────────────────
  { name: 'calabar',    state: 'Cross River', lat: 4.958, lon: 8.339 },
  { name: 'ogoja',      state: 'Cross River', lat: 6.657, lon: 8.794 },

  // ── Delta ─────────────────────────────────────────────────────────────────
  { name: 'asaba',      state: 'Delta',     lat: 6.199,  lon: 6.745 },
  { name: 'warri',      state: 'Delta',     lat: 5.516,  lon: 5.751 },
  { name: 'sapele',     state: 'Delta',     lat: 5.894,  lon: 5.678 },

  // ── Ebonyi ────────────────────────────────────────────────────────────────
  { name: 'abakaliki',  state: 'Ebonyi',    lat: 6.326,  lon: 8.112 },

  // ── Edo ───────────────────────────────────────────────────────────────────
  { name: 'benin city', state: 'Edo',       lat: 6.338,  lon: 5.627 },
  { name: 'auchi',      state: 'Edo',       lat: 7.067,  lon: 6.267 },

  // ── Ekiti ─────────────────────────────────────────────────────────────────
  { name: 'ado-ekiti',  state: 'Ekiti',     lat: 7.624,  lon: 5.226 },
  { name: 'ado ekiti',  state: 'Ekiti',     lat: 7.624,  lon: 5.226 },

  // ── Enugu ─────────────────────────────────────────────────────────────────
  { name: 'enugu',      state: 'Enugu',     lat: 6.441,  lon: 7.493 },
  { name: 'nsukka',     state: 'Enugu',     lat: 6.858,  lon: 7.396 },

  // ── FCT ───────────────────────────────────────────────────────────────────
  { name: 'abuja',      state: 'FCT',       lat: 9.072,  lon: 7.393 },
  { name: 'kuje',       state: 'FCT',       lat: 8.880,  lon: 7.230 },
  { name: 'bwari',      state: 'FCT',       lat: 9.280,  lon: 7.370 },

  // ── Gombe ─────────────────────────────────────────────────────────────────
  { name: 'gombe',      state: 'Gombe',     lat: 10.289, lon: 11.167 },
  { name: 'kaltungo',   state: 'Gombe',     lat: 9.820,  lon: 11.320 },

  // ── Imo ───────────────────────────────────────────────────────────────────
  { name: 'owerri',     state: 'Imo',       lat: 5.483,  lon: 7.035 },
  { name: 'okigwe',     state: 'Imo',       lat: 5.883,  lon: 7.350 },
  { name: 'orlu',       state: 'Imo',       lat: 5.783,  lon: 7.033 },

  // ── Jigawa ────────────────────────────────────────────────────────────────
  { name: 'dutse',      state: 'Jigawa',    lat: 11.758, lon: 9.348 },
  { name: 'hadejia',    state: 'Jigawa',    lat: 12.453, lon: 10.044 },

  // ── Kaduna ────────────────────────────────────────────────────────────────
  { name: 'kaduna',     state: 'Kaduna',    lat: 10.513, lon: 7.439 },
  { name: 'zaria',      state: 'Kaduna',    lat: 11.080, lon: 7.720 },
  { name: 'birnin gwari',state:'Kaduna',    lat: 10.778, lon: 6.757 },
  { name: 'chikun',     state: 'Kaduna',    lat: 10.450, lon: 7.367 },
  { name: 'igabi',      state: 'Kaduna',    lat: 10.767, lon: 7.483 },
  { name: 'kajuru',     state: 'Kaduna',    lat: 10.348, lon: 7.688 },
  { name: 'kaura',      state: 'Kaduna',    lat: 10.300, lon: 8.133 },
  { name: 'kuriga',     state: 'Kaduna',    lat: 10.520, lon: 7.350 },
  { name: 'kagara',     state: 'Niger',     lat: 10.350, lon: 6.150 },

  // ── Kano ──────────────────────────────────────────────────────────────────
  { name: 'kano',       state: 'Kano',      lat: 12.000, lon: 8.517 },
  { name: 'wudil',      state: 'Kano',      lat: 11.800, lon: 8.853 },

  // ── Katsina ───────────────────────────────────────────────────────────────
  { name: 'katsina',    state: 'Katsina',   lat: 12.988, lon: 7.606 },
  { name: 'kankara',    state: 'Katsina',   lat: 11.920, lon: 7.400 },
  { name: 'faskari',    state: 'Katsina',   lat: 12.317, lon: 7.300 },
  { name: 'dandume',    state: 'Katsina',   lat: 12.533, lon: 7.267 },
  { name: 'jibia',      state: 'Katsina',   lat: 13.083, lon: 7.200 },

  // ── Kebbi ─────────────────────────────────────────────────────────────────
  { name: 'birnin kebbi',state:'Kebbi',     lat: 12.454, lon: 4.197 },
  { name: 'argungu',    state: 'Kebbi',     lat: 12.740, lon: 4.520 },
  { name: 'zuru',       state: 'Kebbi',     lat: 11.433, lon: 5.233 },
  { name: 'yauri',      state: 'Kebbi',     lat: 11.483, lon: 4.783 },

  // ── Kogi ──────────────────────────────────────────────────────────────────
  { name: 'lokoja',     state: 'Kogi',      lat: 7.801,  lon: 6.741 },
  { name: 'okene',      state: 'Kogi',      lat: 7.550,  lon: 6.233 },
  { name: 'kogi',       state: 'Kogi',      lat: 7.500,  lon: 6.750 },
  { name: 'oke-ode',    state: 'Kwara',     lat: 8.050,  lon: 5.050 },
  { name: 'ayetoro-kiri',state:'Kogi',      lat: 7.730,  lon: 7.110 },

  // ── Kwara ─────────────────────────────────────────────────────────────────
  { name: 'ilorin',     state: 'Kwara',     lat: 8.492,  lon: 4.541 },
  { name: 'offa',       state: 'Kwara',     lat: 8.148,  lon: 4.722 },
  { name: 'kaiama',     state: 'Kwara',     lat: 9.580,  lon: 4.367 },
  { name: 'woro',       state: 'Kwara',     lat: 9.450,  lon: 4.850 },
  { name: 'nuku',       state: 'Kwara',     lat: 9.450,  lon: 4.850 },
  { name: 'eruku',      state: 'Kwara',     lat: 8.600,  lon: 5.200 },
  { name: 'babanla',    state: 'Kwara',     lat: 9.050,  lon: 4.950 },
  { name: 'kwara',      state: 'Kwara',     lat: 8.492,  lon: 4.541 },
  { name: 'pategi',     state: 'Kwara',     lat: 8.720,  lon: 5.750 },
  { name: 'edu',        state: 'Kwara',     lat: 9.150,  lon: 4.833 },

  // ── Lagos ─────────────────────────────────────────────────────────────────
  { name: 'lagos',      state: 'Lagos',     lat: 6.524,  lon: 3.379 },
  { name: 'ikeja',      state: 'Lagos',     lat: 6.600,  lon: 3.347 },

  // ── Nasarawa ──────────────────────────────────────────────────────────────
  { name: 'lafia',      state: 'Nasarawa',  lat: 8.491,  lon: 8.521 },
  { name: 'keffi',      state: 'Nasarawa',  lat: 8.848,  lon: 7.874 },
  { name: 'nasarawa',   state: 'Nasarawa',  lat: 8.491,  lon: 8.521 },

  // ── Niger ─────────────────────────────────────────────────────────────────
  { name: 'minna',      state: 'Niger',     lat: 9.613,  lon: 6.556 },
  { name: 'bida',       state: 'Niger',     lat: 9.075,  lon: 6.010 },
  { name: 'suleja',     state: 'Niger',     lat: 9.183,  lon: 7.183 },
  { name: 'shiroro',    state: 'Niger',     lat: 9.950,  lon: 6.750 },
  { name: 'papiri',     state: 'Niger',     lat: 10.580, lon: 5.230 },
  { name: 'kasuwan daji',state:'Niger',     lat: 10.230, lon: 5.350 },
  { name: 'rafi',       state: 'Niger',     lat: 10.000, lon: 6.100 },
  { name: 'mariga',     state: 'Niger',     lat: 10.600, lon: 5.817 },
  { name: 'niger',      state: 'Niger',     lat: 9.613,  lon: 6.556 },

  // ── Ogun ──────────────────────────────────────────────────────────────────
  { name: 'abeokuta',   state: 'Ogun',      lat: 7.153,  lon: 3.345 },
  { name: 'sagamu',     state: 'Ogun',      lat: 6.833,  lon: 3.633 },

  // ── Ondo ──────────────────────────────────────────────────────────────────
  { name: 'akure',      state: 'Ondo',      lat: 7.252,  lon: 5.195 },
  { name: 'owo',        state: 'Ondo',      lat: 7.200,  lon: 5.590 },
  { name: 'ondo',       state: 'Ondo',      lat: 7.100,  lon: 4.833 },

  // ── Osun ──────────────────────────────────────────────────────────────────
  { name: 'osogbo',     state: 'Osun',      lat: 7.768,  lon: 4.556 },
  { name: 'ile-ife',    state: 'Osun',      lat: 7.467,  lon: 4.567 },

  // ── Oyo ───────────────────────────────────────────────────────────────────
  { name: 'ibadan',     state: 'Oyo',       lat: 7.388,  lon: 3.898 },
  { name: 'ogbomosho',  state: 'Oyo',       lat: 8.133,  lon: 4.250 },
  { name: 'igangan',    state: 'Oyo',       lat: 7.950,  lon: 3.600 },
  { name: 'kishi',      state: 'Oyo',       lat: 8.950,  lon: 3.850 },
  { name: 'igbeti',     state: 'Oyo',       lat: 9.050,  lon: 4.130 },

  // ── Plateau ───────────────────────────────────────────────────────────────
  { name: 'jos',        state: 'Plateau',   lat: 9.921,  lon: 8.889 },
  { name: 'pankshin',   state: 'Plateau',   lat: 9.343,  lon: 9.443 },
  { name: 'bokkos',     state: 'Plateau',   lat: 9.280,  lon: 8.950 },
  { name: 'mangu',      state: 'Plateau',   lat: 9.717,  lon: 9.250 },
  { name: 'barkin ladi',state: 'Plateau',   lat: 9.528,  lon: 8.897 },
  { name: 'riyom',      state: 'Plateau',   lat: 9.300,  lon: 8.800 },
  { name: 'zike',       state: 'Plateau',   lat: 9.250,  lon: 8.880 },
  { name: 'plateau',    state: 'Plateau',   lat: 9.921,  lon: 8.889 },

  // ── Rivers ────────────────────────────────────────────────────────────────
  { name: 'port harcourt',state:'Rivers',   lat: 4.815,  lon: 7.049 },
  { name: 'bonny',      state: 'Rivers',    lat: 4.440,  lon: 7.153 },

  // ── Sokoto ────────────────────────────────────────────────────────────────
  { name: 'sokoto',     state: 'Sokoto',    lat: 13.062, lon: 5.237 },
  { name: 'tambuwal',   state: 'Sokoto',    lat: 12.400, lon: 4.633 },

  // ── Taraba ────────────────────────────────────────────────────────────────
  { name: 'jalingo',    state: 'Taraba',    lat: 8.892,  lon: 11.373 },
  { name: 'wukari',     state: 'Taraba',    lat: 7.867,  lon: 9.783 },
  { name: 'taraba',     state: 'Taraba',    lat: 8.892,  lon: 11.373 },

  // ── Yobe ──────────────────────────────────────────────────────────────────
  { name: 'damaturu',   state: 'Yobe',      lat: 11.752, lon: 11.960 },
  { name: 'potiskum',   state: 'Yobe',      lat: 11.711, lon: 11.085 },
  { name: 'nguru',      state: 'Yobe',      lat: 12.879, lon: 10.458 },
  { name: 'gashua',     state: 'Yobe',      lat: 12.867, lon: 11.050 },

  // ── Zamfara ───────────────────────────────────────────────────────────────
  { name: 'gusau',      state: 'Zamfara',   lat: 12.170, lon: 6.663 },
  { name: 'zamfara',    state: 'Zamfara',   lat: 12.170, lon: 6.663 },
  { name: 'anka',       state: 'Zamfara',   lat: 12.120, lon: 5.930 },
  { name: 'maru',       state: 'Zamfara',   lat: 12.380, lon: 6.317 },
  { name: 'bungudu',    state: 'Zamfara',   lat: 12.270, lon: 6.320 },
  { name: 'bakura',     state: 'Zamfara',   lat: 12.833, lon: 6.400 },
  { name: 'shinkafi',   state: 'Zamfara',   lat: 13.067, lon: 6.517 },
  { name: 'jangebe',    state: 'Zamfara',   lat: 12.450, lon: 6.050 },
  { name: 'bukkuyum',   state: 'Zamfara',   lat: 12.080, lon: 5.850 },
  { name: 'gobirawa chali',state:'Zamfara', lat: 11.980, lon: 6.350 },

  // ── State-level fallbacks (used when HAPI/ACLED returns state name only) ────
  { name: 'abia',         state: 'Abia',       lat: 5.532,  lon: 7.485 },
  { name: 'adamawa',      state: 'Adamawa',    lat: 9.204,  lon: 12.496 },
  { name: 'akwa ibom',    state: 'Akwa Ibom',  lat: 5.033,  lon: 7.933 },
  { name: 'anambra',      state: 'Anambra',    lat: 6.211,  lon: 7.074 },
  { name: 'bayelsa',      state: 'Bayelsa',    lat: 4.926,  lon: 6.269 },
  { name: 'benue',        state: 'Benue',      lat: 7.730,  lon: 8.522 },
  { name: 'borno',        state: 'Borno',      lat: 11.833, lon: 13.150 },
  { name: 'cross river',  state: 'Cross River',lat: 4.958,  lon: 8.339 },
  { name: 'delta',        state: 'Delta',      lat: 6.199,  lon: 6.745 },
  { name: 'ebonyi',       state: 'Ebonyi',     lat: 6.326,  lon: 8.112 },
  { name: 'edo',          state: 'Edo',        lat: 6.338,  lon: 5.627 },
  { name: 'ekiti',        state: 'Ekiti',      lat: 7.624,  lon: 5.226 },
  { name: 'fct',          state: 'FCT',        lat: 9.072,  lon: 7.393 },
  { name: 'imo',          state: 'Imo',        lat: 5.483,  lon: 7.035 },
  { name: 'jigawa',       state: 'Jigawa',     lat: 11.758, lon: 9.348 },
  { name: 'kebbi',        state: 'Kebbi',      lat: 12.454, lon: 4.197 },
  { name: 'ogun',         state: 'Ogun',       lat: 7.153,  lon: 3.345 },
  { name: 'osun',         state: 'Osun',       lat: 7.768,  lon: 4.556 },
  { name: 'oyo',          state: 'Oyo',        lat: 7.388,  lon: 3.898 },
  { name: 'rivers',       state: 'Rivers',     lat: 4.815,  lon: 7.049 },
  { name: 'yobe',         state: 'Yobe',       lat: 11.752, lon: 11.960 },
];

// Build a sorted list (longest names first so they match before substrings)
const SORTED_PLACES = [...PLACES].sort((a, b) => b.name.length - a.name.length);

function toTitleCase(name) {
  return String(name)
    .split(" ")
    .map((part) =>
      part
        .split("-")
        .map((piece) =>
          piece ? piece.charAt(0).toUpperCase() + piece.slice(1) : piece,
        )
        .join("-"),
    )
    .join(" ");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Attempt to resolve a location string to coordinates.
 * Returns { lat, lon, state, matched } or null.
 */
function geocode(locationText) {
  if (!locationText) return null;
  const lower = locationText.toLowerCase();

  for (const place of SORTED_PLACES) {
    if (lower.includes(place.name)) {
      return { lat: place.lat, lon: place.lon, state: place.state, matched: place.name };
    }
  }
  return null;
}

/**
 * Extract a Nigerian state name directly from text.
 * Returns state string or null.
 */
const STATE_NAMES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue',
  'Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT',
  'Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi',
  'Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo',
  'Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara',
];

function extractState(text) {
  const lower = text.toLowerCase();
  for (const state of STATE_NAMES) {
    if (lower.includes(state.toLowerCase())) return state;
  }
  return null;
}

function reverseGeocode(lat, lon) {
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) return null;

  let best = null;
  for (const place of PLACES) {
    const distanceKm = haversineKm(numLat, numLon, place.lat, place.lon);
    if (!best || distanceKm < best.distance_km) {
      best = {
        name: toTitleCase(place.name),
        state: place.state,
        lat: place.lat,
        lon: place.lon,
        distance_km: distanceKm,
      };
    }
  }
  if (!best) return null;
  return {
    ...best,
    distance_km: Number(best.distance_km.toFixed(1)),
    label:
      best.distance_km <= 5
        ? `${best.name}, ${best.state}`
        : `Near ${best.name}, ${best.state}`,
  };
}

module.exports = { geocode, extractState, reverseGeocode, STATE_NAMES };
