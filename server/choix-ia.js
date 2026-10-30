/*
 * L'IA d'un service, lue dans son manifeste et ses réglages.
 *
 * Un service choisit son IA par ses propres réglages (VIGIE_IA_MODE,
 * LLM_FOURNISSEUR, IA_MODELE…). Le Hub ne connaît pas ces clés par leur nom :
 * il les reconnaît à leur forme. Le modèle local est le choix fermé dont la
 * liste vient de l'Ollama du Hub (optionsFrom → llm.chat) ; le mode est le
 * choix fermé qui propose « locale » ou « ollama ». Rien d'autre n'est deviné.
 */

const LOCAL = new Set(['locale', 'local', 'ollama']);
const AUCUNE = /^(|aucune?|none|off|non|d[ée]sactiv\w*)$/i;
const valeur = o => (typeof o === 'string' ? o : o?.value);
const libelle = o => (typeof o === 'string' ? o : o?.label || o?.value);

/** Les champs d'IA d'un manifeste, ou null s'il n'en a pas. */
export function champsIA(manifest) {
  const config = manifest?.config || [];
  const mode = config.find(f => f.type === 'select' && (f.options || []).some(o => LOCAL.has(String(valeur(o)).toLowerCase()))) || null;
  // Un champ qui ne s'affiche que pour des modes locaux (ou toujours).
  const pourLocale = f => !f.showIf || (mode && Array.isArray(f.showIf[mode.key])
    && f.showIf[mode.key].length && f.showIf[mode.key].every(v => utiliseLocal(mode, v)));
  // Le modèle local : la liste d'Ollama, sinon un nom de modèle libre qui vaut aussi pour la locale.
  const modele = config.find(f => f.type === 'select' && f.optionsFrom?.from?.capability === 'llm.chat')
    || config.find(f => f !== mode && f.type === 'string' && /MODEL/i.test(f.key) && pourLocale(f))
    || null;
  if (!modele && !mode) return null;
  const nuage = mode ? config.find(f => f !== mode && f !== modele && f.type === 'select' && f.showIf && Object.hasOwn(f.showIf, mode.key)) || null : null;
  const modeleNuage = mode ? config.find(f => f !== mode && f.type === 'string' && /MODEL/i.test(f.key) && f.showIf && Object.hasOwn(f.showIf, mode.key)) || null : null;
  return { mode, modele, nuage, modeleNuage: modeleNuage || (modele?.type === 'string' && !modele.showIf ? modele : null) };
}

/** Cette valeur du mode fait-elle travailler l'IA locale ? (« les deux », « secours » : oui.) */
export function utiliseLocal(mode, v) {
  if (LOCAL.has(String(v).toLowerCase())) return true;
  const o = (mode.options || []).find(x => valeur(x) === v);
  return /\blocale?\b|ollama/i.test(String(libelle(o) || ''));
}

/** La valeur du mode qui veut dire « l'IA locale seule ». */
export const valeurLocale = mode => valeur((mode.options || []).find(o => LOCAL.has(String(valeur(o)).toLowerCase())));

const lu = (cfg, f) => (f ? (cfg?.[f.key] ?? f.default ?? '') : '');

/**
 * Ce que le service fait de l'IA en ce moment.
 * `fournisseur` : l'instance qui lui sert llm.chat (un Ollama), ou null.
 */
export function etatIA(inst, fournisseur) {
  const ch = champsIA(inst.manifest);
  if (!ch) return null;
  const cfg = inst.config || {};
  const vMode = lu(cfg, ch.mode);
  const optMode = ch.mode ? (ch.mode.options || []).find(o => valeur(o) === vMode) : null;
  const local = ch.mode ? utiliseLocal(ch.mode, vMode) : !!fournisseur;
  const nuage = ch.mode ? !AUCUNE.test(String(vMode)) && !LOCAL.has(String(vMode).toLowerCase()) : false;
  const nuageNom = !nuage ? null : ch.nuage
    ? libelle((ch.nuage.options || []).find(o => valeur(o) === lu(cfg, ch.nuage))) || lu(cfg, ch.nuage)
    : String(libelle(optMode) || vMode).split(/ [—-] /)[0];
  return {
    champs: ch,
    mode: vMode || null,
    modeLibelle: optMode ? String(libelle(optMode)).split(/ [—-] /)[0] : null,
    local: local && !!fournisseur,
    localSansFournisseur: local && !fournisseur,
    fournisseur: fournisseur || null,
    modele: local ? (String(lu(cfg, ch.modele) || '') || null) : null,
    modeleParDefaut: fournisseur?.config?.DEFAULT_MODEL || null,
    nuage,
    nuageNom,
    modeleNuage: nuage ? String(lu(cfg, ch.modeleNuage) || '') || null : null,
  };
}

/** Un nom de modèle tel qu'on le tape : « Qwen 3.8:9b » = « qwen3.8:9b ». */
export const cleModele = v => String(v || '').toLowerCase().replace(/:latest$/, '').replace(/[^a-z0-9]+/g, '');

/**
 * Le modèle nommé dans une phrase, parmi ceux qu'Ollama annonce.
 * { trouve } si un nom de la liste y est ; { cite } si un nom de modèle y est
 * écrit sans être dans la liste ; {} si la phrase n'en nomme aucun.
 */
export function modeleCite(texte, modeles) {
  const t = cleModele(texte);
  const parLongueur = [...modeles].sort((a, b) => cleModele(b).length - cleModele(a).length);
  const trouve = parLongueur.find(m => cleModele(m).length >= 3 && t.includes(cleModele(m)));
  if (trouve) return { trouve };
  // « qwen3.8:9b », « llama 3.1 », « mistral:7b » : un nom suivi d'une version ou d'une taille.
  const m = /\b((?:qwen|llama|mistral|mixtral|gemma|phi|deepseek|codellama|granite|command-r|nemotron|smollm|olmo|yi|glm|gpt-oss|ministral|magistral|devstral)[\w.-]*(?:\s?[\d.]+)?(?::[\w.-]+)?)/i.exec(String(texte));
  return m ? { cite: m[1].replace(/\s+/g, '') } : {};
}
