"use strict";

/**
 * Fingerprint-based incident deduplication.
 *
 * Each incident gets a canonical fingerprint derived from:
 *   - date (±1 day window)
 *   - state
 *   - incident type
 *   - keyword signature (normalized headline tokens)
 *
 * Two incidents with matching fingerprints are considered the same
 * real-world event reported by different sources.
 */

const crypto = require("crypto");

// Words that carry signal for event identity
const SIGNAL_WORDS = new Set([
  "kill", "killed", "death", "dead", "die", "dies",
  "abduct", "abducted", "kidnap", "kidnapped", "hostage", "hostages",
  "bomb", "bombing", "blast", "explode", "explosion", "ied",
  "attack", "attacked", "assault", "ambush", "ambushed",
  "shoot", "shot", "shooting", "gunman", "gunmen",
  "massacre", "slaughter", "slaughtered",
  "bandit", "bandits", "terrorist", "terrorists", "iswap", "boko", "haram",
  "clash", "clashes", "herder", "herdsmen", "fulani",
  "cult", "cultist", "cultists",
  "displace", "displaced", "flee", "fled", "fleeing", "refugee",
  "overrun", "raid", "storm", "stormed",
  "rescue", "rescued", "freed", "free", "recover", "recovered",
  "soldier", "soldiers", "troop", "troops", "military", "army",
  "civilian", "civilians", "resident", "residents", "passenger", "passengers",
  "vigilante", "vigilance",
  "community", "village", "town", "market", "road", "highway",
]);

// Noise words to strip
const NOISE_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "for", "of", "and", "or", "but", "with",
  "by", "from", "into", "over", "after", "during", "before", "between",
  "under", "above", "below", "out", "up", "down", "off", "about",
  "that", "this", "these", "those", "it", "its", "they", "them",
  "he", "she", "we", "you", "i", "me", "him", "her", "us",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "must",
  "breaking", "news", "report", "says", "said", "according", "source",
  "several", "many", "multiple", "suspected", "suspect",
  "early", "morning", "afternoon", "evening", "night", "today",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "nigeria", "nigerian",
]);

/**
 * Extract a keyword signature from text.
 * Returns a sorted, deduplicated string of signal words found.
 */
function keywordSignature(text) {
  if (!text) return "";
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const signal = words.filter((w) => SIGNAL_WORDS.has(w));
  return [...new Set(signal)].sort().join(" ");
}

/**
 * Build a fingerprint for an incident.
 * Returns { dateKey, state, type, sig, hash }
 *
 * dateKey: YYYY-MM-DD (the reported date)
 * state: normalized state name (lowercase)
 * type: incident type
 * sig: keyword signature
 * hash: SHA1 of the combined fingerprint (for fast DB lookup)
 */
function buildFingerprint({ date, state, type, title, description }) {
  const dateKey = date || "";
  const stateNorm = (state || "").toLowerCase().trim();
  const typeNorm = (type || "armed_attack").toLowerCase().trim();
  const sig = keywordSignature(`${title || ""} ${description || ""}`);

  const raw = `${dateKey}|${stateNorm}|${typeNorm}|${sig}`;
  const hash = crypto.createHash("sha1").update(raw).digest("hex");

  return { dateKey, state: stateNorm, type: typeNorm, sig, hash };
}

/**
 * Check if two fingerprints likely match the same incident.
 * Uses a relaxed match: same date window + same state + same type + overlapping keywords.
 */
function fingerprintsMatch(fp1, fp2) {
  // Must share the same type
  if (fp1.type !== fp2.type) return false;

  // Must share the same state (or both unknown)
  if (fp1.state && fp2.state && fp1.state !== fp2.state) return false;

  // Date must be within ±1 day
  if (fp1.dateKey && fp2.dateKey) {
    const d1 = new Date(fp1.dateKey).getTime();
    const d2 = new Date(fp2.dateKey).getTime();
    const diffDays = Math.abs(d1 - d2) / (1000 * 60 * 60 * 24);
    if (diffDays > 1) return false;
  }

  // Keyword overlap: at least 2 shared signal words, or one side has no signature
  if (fp1.sig && fp2.sig) {
    const words1 = fp1.sig.split(" ");
    const words2 = fp2.sig.split(" ");
    const shared = words1.filter((w) => words2.includes(w));
    if (shared.length < 2) return false;
  }

  return true;
}

module.exports = { buildFingerprint, fingerprintsMatch, keywordSignature };
