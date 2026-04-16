'use strict';

/**
 * Incident classifier for Nigeria security events.
 * Uses keyword scoring + regex extraction to tag type, severity,
 * fatalities, and victims from raw article text.
 */

const INCIDENT_PATTERNS = {
  bombing: {
    keywords: [
      'bomb', 'bombing', 'explosion', 'explode', 'ied', 'blast',
      'detonate', 'suicide bomb', 'suicide bomber', 'ieds', 'roadside bomb',
      'car bomb', 'landmine', 'mine blast',
    ],
    weight: 10,
  },
  kidnapping: {
    keywords: [
      'kidnap', 'abduct', 'hostage', 'ransom', 'abduction', 'seized',
      'taken hostage', 'abducted', 'held captive', 'school abduction',
      'mass abduction', 'missing students',
    ],
    weight: 8,
  },
  massacre: {
    keywords: [
      'massacre', 'slaughter', 'mass killing', 'mass murder',
      'gruesomely killed', 'butchered', 'hacked to death',
    ],
    weight: 10,
  },
  banditry: {
    keywords: [
      'bandit', 'bandits', 'banditry', 'cattle rustl', 'rustling',
      'ransack', 'loot', 'pillage', 'marauder',
    ],
    weight: 6,
  },
  herder_clash: {
    keywords: [
      'herdsmen', 'herder', 'fulani', 'farmer-herder', 'herder-farmer',
      'grazing dispute', 'cattle herder', 'pastoralist',
    ],
    weight: 6,
  },
  terrorism: {
    keywords: [
      'boko haram', 'iswap', 'jihadist', 'insurgent', 'islamic state',
      'lakurawa', 'jnim', 'ansaru', 'terrorist', 'islamist',
      'jihadist group', 'armed group',
    ],
    weight: 9,
  },
  armed_attack: {
    keywords: [
      'gunmen', 'armed men', 'armed bandits', 'attack', 'ambush',
      'assault', 'raid', 'invasion', 'invade', 'shoot', 'shooting',
      'gunshot', 'open fire', 'fired on',
    ],
    weight: 5,
  },
  cult_violence: {
    keywords: [
      'cult', 'cultist', 'confraternity', 'gang war', 'rival cult',
      'fraternity clash', 'black axe', 'eiye', 'aiye',
    ],
    weight: 5,
  },
  displacement: {
    keywords: [
      'displaced', 'displacement', 'fled', 'idp', 'internally displaced',
      'refugee', 'communities flee', 'residents flee', 'evacuate',
    ],
    weight: 3,
  },
};

// Patterns to extract fatality numbers (covers both orderings: "kills 12" and "12 killed")
const FATALITY_PATTERNS = [
  // "kills/killed 12 people" or "kill 35 civilians"
  /kills?\s+(?:at\s+least\s+)?(\d+)\s*(?:people|persons|civilians|soldiers|farmers|students|villagers|others?|worshippers?|residents?|men|women|children)?/gi,
  // "35 people killed/murdered/slaughtered"
  /(\d+)\s*(?:people|persons|civilians|soldiers|farmers|students|villagers|others?|worshippers?|residents?|men|women|children)\s*(?:were\s+)?(?:killed|murdered|slaughtered|dead|shot\s+dead|hacked|butchered)/gi,
  // "killed/murdered at least 12"
  /(?:killed|murdered|dead)\s+(?:at\s+least\s+)?(\d+)/gi,
  // "at least 12 killed/dead/casualties"
  /(?:at\s+least\s+)?(\d+)\s*(?:killed|dead|deaths?|casualties|persons?\s+dead)/gi,
  // "death toll of 35" / "toll rises to 35"
  /(?:death\s+toll|toll\s+rises?\s+to)\s+(?:of\s+)?(\d+)/gi,
  // "claimed the lives of 12"
  /claimed\s+(?:the\s+lives?\s+of\s+)?(\d+)/gi,
  // "12 lives lost"
  /(\d+)\s*(?:lives?\s+)?(?:were\s+)?lost/gi,
];

// Patterns to extract kidnapping victim numbers
const VICTIM_PATTERNS = [
  /(\d+)\s*(?:people|persons|students|girls|boys|women|men|pupils?|workers?|farmers?|teachers?)\s*(?:were\s+)?(?:abducted|kidnapped|taken hostage|seized|taken)/gi,
  /(?:abducted|kidnapped|seized)\s+(?:at\s+least\s+)?(\d+)/gi,
  /(\d+)\s*(?:abductees?|hostages?|kidnap victims?)/gi,
  /freed?\s+(?:all\s+)?(\d+)\s*(?:abductees?|hostages?|kidnapped)/gi,
];

/**
 * Classify an incident by type using keyword scoring.
 * Returns the highest-scoring type, or 'armed_attack' as fallback.
 */
function classifyType(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const [type, { keywords, weight }] of Object.entries(INCIDENT_PATTERNS)) {
    scores[type] = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        scores[type] += weight;
      }
    }
  }

  const top = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a)[0];

  return top ? top[0] : 'armed_attack';
}

/** Extract highest plausible fatality and victim counts from text. */
function extractCasualties(text) {
  let fatalities = 0;
  let victims = 0;

  for (const pattern of FATALITY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) {
      const n = parseInt(m[1] ?? m[2]);
      if (n && n > fatalities && n < 5000) fatalities = n;
    }
  }

  for (const pattern of VICTIM_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) {
      const n = parseInt(m[1] ?? m[2]);
      if (n && n > victims && n < 5000) victims = n;
    }
  }

  return { fatalities, victims };
}

/** Assign severity tier based on type and casualty numbers. */
function scoreSeverity({ type, fatalities, victims }) {
  if (fatalities >= 30) return 'RED';
  if (type === 'massacre') return 'RED';
  if (type === 'bombing' && fatalities > 0) return 'RED';
  if (victims >= 100) return 'RED';

  if (fatalities >= 10) return 'ORANGE';
  if (victims >= 20) return 'ORANGE';
  if (type === 'terrorism' && fatalities > 0) return 'ORANGE';
  if (type === 'kidnapping' && victims >= 5) return 'ORANGE';

  if (fatalities >= 1) return 'YELLOW';
  if (victims >= 1) return 'YELLOW';
  if (['bombing', 'terrorism', 'kidnapping'].includes(type)) return 'YELLOW';

  return 'BLUE';
}

/**
 * Main classify function.
 * @param {string} title
 * @param {string} [description]
 * @returns {{ type, fatalities, victims, severity }}
 */
function classify(title, description = '') {
  const text = `${title} ${description}`;
  const type = classifyType(text);
  const { fatalities, victims } = extractCasualties(text);
  const severity = scoreSeverity({ type, fatalities, victims });
  return { type, fatalities, victims, severity };
}

module.exports = { classify, classifyType, extractCasualties, scoreSeverity };
