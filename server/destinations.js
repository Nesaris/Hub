// Destinations internes autorisées : ce qu'un administrateur a connecté
// (services, IA, registres, réglages d'exploitation) ou déclaré lui-même.
// Le reste du réseau privé est refusé aux requêtes du Hub (voir sortie.js).
import { configurer, lireEntree, classer } from './sortie.js';
import { config } from './config.js';
import { HttpError } from './util/common.js';

const MAX = 200;
const hote = u => { try { return new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; } };

export class Destinations {
  constructor({ db, audit, services, registry }) {
    Object.assign(this, { db, audit, services, registry });
    configurer({ internes: () => this.toutes() });
  }

  liste() { return this.db.setting('destinations_internes', []); }

  /** Ce qui est autorisé sans liste : chaque entrée dit d'où elle vient. */
  automatiques() {
    const out = [];
    for (const i of this.services.list()) out.push({ origine: 'service', nom: i.name, hote: hote(i.url) });
    for (const r of this.db.all('SELECT name, url FROM ai_connections WHERE url IS NOT NULL AND url != \'\'')) out.push({ origine: 'ia', nom: r.name, hote: hote(r.url) });
    for (const [nom, u] of [['HUB_TELEGRAM_API', config.telegramApi], ['HUB_ELEVEN_API', config.elevenApi]]) if (u) out.push({ origine: 'reglage', nom, hote: hote(u) });
    for (const s of this.registry.sources()) if (/^https:\/\//.test(s)) out.push({ origine: 'registre', nom: s, hote: hote(s) });
    return out.filter(a => a.hote);
  }

  toutes() { return [...this.liste(), ...this.automatiques().map(a => a.hote)]; }

  poser(entrees, acteur) {
    if (!Array.isArray(entrees) || entrees.length > MAX) throw new HttpError(400, `Une liste de ${MAX} entrées au plus.`);
    const vues = new Set(), propres = [];
    for (const brut of entrees) {
      let e;
      try { e = lireEntree(brut); } catch (err) { throw new HttpError(400, err.message); }
      if (e && !vues.has(e.texte)) { vues.add(e.texte); propres.push(e.texte); }
    }
    const avant = this.liste();
    this.db.setSetting('destinations_internes', propres);
    this.audit.write(acteur, 'destinations.modifiées', null, { ajoutées: propres.filter(x => !avant.includes(x)), retirées: avant.filter(x => !propres.includes(x)) });
    return { destinations: propres };
  }

  /*
   * Une fois, à la mise à jour : les destinations internes que les workflows
   * existants appelaient déjà (adresses écrites en clair, pas les
   * expressions) entrent dans la liste. Sans cela, la mise à jour aurait
   * coupé des workflows qui marchaient ; avec, rien d'autre n'est ouvert.
   */
  reprendre() {
    if (this.db.setting('destinations_reprises', false)) return [];
    const trouvees = new Set();
    const noter = brut => {
      const s = String(brut || '').trim();
      if (!s || s.includes('{{')) return;
      const h = /^[a-z]+:\/\//i.test(s) ? hote(s) : s.toLowerCase();
      if (!h) return;
      const ip = h.replace(/^\[|\]$/g, '');
      const interne = /^[\d.]+$|:/.test(ip) ? classer(ip) === 'interne' : !ip.includes('.') || /\.(lan|local|internal|home\.arpa|localdomain|intranet|corp)$/.test(ip);
      if (!interne) return;
      try { if (lireEntree(ip)) trouvees.add(ip); } catch { /* entrée invalide : ignorée */ }
    };
    for (const r of this.db.all('SELECT graph FROM workflows')) {
      let g; try { g = JSON.parse(r.graph); } catch { continue; }
      for (const n of g.nodes || []) {
        const p = n.params || {};
        if (n.type === 'net.http' || n.type === 'out.webhook' || n.type === 'trigger.poll') noter(p.url);
        if (n.type === 'out.ntfy') noter(p.server);
        if (n.type === 'net.port') noter(p.host);
      }
    }
    const deja = new Set(this.toutes().map(x => String(x).toLowerCase()));
    const nouvelles = [...trouvees].filter(x => !deja.has(x));
    if (nouvelles.length) {
      this.db.setSetting('destinations_internes', [...this.liste(), ...nouvelles].slice(0, MAX));
      this.audit.write('hub', 'destinations.reprises', null, { entrées: nouvelles });
    }
    this.db.setSetting('destinations_reprises', true);
    return nouvelles;
  }
}
