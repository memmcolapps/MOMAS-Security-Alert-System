'use strict';

/**
 * Cheap regex gate that runs before the LLM. Returns true only when text
 * plausibly describes a Nigerian security incident — at least one security
 * verb/noun AND at least one Nigeria/state/region token.
 *
 * False positives are fine (LLM will filter); false negatives waste a real
 * incident, so keep the vocabulary broad.
 */

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
  return SECURITY_RE.test(text) && NIGERIA_RE.test(text);
}

module.exports = { looksLikeSecurityIncident };
