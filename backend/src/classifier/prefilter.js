'use strict';

/**
 * Cheap regex gate that runs before the LLM. Returns true only when text
 * plausibly describes a Nigerian security incident — at least one security
 * verb/noun AND at least one Nigeria/state/region token.
 *
 * Also blocks political reactions/commentary unless a concrete event is
 * described (e.g., "Peter Obi condemns abduction..." → blocked, but
 * "10 abducted by bandits..." → passes).
 *
 * False positives are fine (LLM will filter); false negatives waste a real
 * incident, so keep the vocabulary broad.
 */

// Concrete security event indicators — must be present if reaction words appear
const SECURITY_RE = new RegExp(
  [
    'kill(?:ed|ing|s)?', 'dead', 'death', 'fatal(?:ity|ities)?', 'casualt',
    'shot', 'shoot(?:ing|out)?', 'gun(?:men|man|fire|shot)', 'ambush',
    'attack(?:ed|s|ing)?', 'raid(?:ed|s|ing)?', 'assault(?:ed|s)?',
    'bomb(?:ed|ing|s)?', 'blast', 'explos(?:ion|ive)', 'ied', 'landmine',
    'kidnap(?:ped|ping|pers?)?', 'abduct(?:ed|ion|ions)?', 'hostage', 'ransom',
    'bandit', 'terror(?:ist|ism)?', 'insurgen(?:t|cy)', 'militant',
    'boko haram', 'iswap', 'ansaru', 'lakurawa', 'jnim',
    'massacre', 'slaughter',
    'herder', 'herdsmen?', 'farmer[- ]herder', 'pastoralist',
    'cult(?:ist|ists|ism)?', 'confraternity',
    'idps?', 'displac(?:e|es|ed|ing|ement)', 'refugee', 'flee(?:ing|d|s)?',
    'armed', 'gunfire', 'clash(?:es|ed)?', 'violence',
    'fire(?:outbreak|disaster)?', 'burn(?:t|ed|ing)?', 'blaze',
    'flood(?:ing|ed|s)?', 'building\\s+collap', 'crash(?:ed|es)?',
  ].join('|'),
  'i',
);

// Reaction/commentary patterns — block these UNLESS concrete event words also present
const NON_EVENT_RE = new RegExp(
  [
    'condemns?', 'reacts?\\s+to', 'calls?\\s+for', 'expresses?\\s+(concern|shock|outrage)',
    'urges?\\s+(government|authorities|security|end|stop)', 'demands?\\s+(action|investigation|justice|end)',
    'statement\\s+on', 'speaks?\\s+out', 'slams', 'criticis(e|z)es?\\s+(handling|response|failure)',
    'appeals?\\s+(to|for)', 'pledges?\\s+(support|help|assistance)', 'promises?\\s+(to\\s+(end|tackle|address|investigate))',
    'meets?\\s+with', 'visits?\\s+(victims|scene|hospital)', 'offers?\\s+(condolences?|sympathy|prayers)',
    'mourns?', 'extends?\\s+(condolences?|sympathy)', 'saddened\\s+by',
  ].join('|'),
  'i',
);

const NIGERIA_RE = new RegExp(
  [
    'nigeria', 'nigerian',
    'abuja', 'lagos', 'kano',
    'borno', 'yobe', 'adamawa', 'bauchi', 'gombe', 'taraba',
    'kaduna', 'katsina', 'zamfara', 'sokoto', 'kebbi', 'niger', 'plateau',
    'nasarawa', 'benue', 'kogi', 'kwara', 'osun', 'oyo', 'ogun', 'ondo', 'ekiti',
    'edo', 'delta', 'rivers', 'bayelsa', 'akwa ibom', 'cross river', 'imo',
    'abia', 'anambra', 'enugu', 'ebonyi', 'jigawa',
    'maiduguri', 'jos', 'kaduna', 'sokoto', 'zaria', 'ibadan', 'ilorin',
    'port harcourt', 'calabar', 'warri', 'yola', 'damaturu', 'gusau',
    'birnin gwari', 'sambisa',
    'lake chad', 'middle belt', 'north[- ]?east', 'north[- ]?west',
    'south[- ]?east', 'south[- ]?south',
  ].join('|'),
  'i',
);

function looksLikeSecurityIncident(title, description = '') {
  const text = `${title} ${description}`;
  if (!text.trim()) return false;
  if (!NIGERIA_RE.test(text)) return false;
  // Block reaction/commentary pieces unless they also describe a concrete event
  if (NON_EVENT_RE.test(text) && !SECURITY_RE.test(text)) return false;
  return SECURITY_RE.test(text);
}

module.exports = { looksLikeSecurityIncident };
