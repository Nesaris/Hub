/*
 * Les connexions du Hub, en workflows visibles.
 *
 * Tout ce qui se branche dans le Hub — par l'interface, par l'assistant, par
 * une mise à jour — se voit dans Workflows comme un lien (nœuds core.link) :
 * les IA du Hub, les noms publiés par Relay, le tunnel Cloudflare, les
 * alertes du Hub, le courriel des comptes. Chaque lien dit aussi la route
 * qui le change : l'assistant le lit et sait quoi appeler.
 *
 * Réconciliation : on calcule les liens voulus à partir de l'état réel, on
 * crée, renomme ou retire ceux d'origine Auto dont la clé commence par un
 * des préfixes tenus ici. Rien d'autre n'est touché.
 */
import { log } from './util/common.js';
import { SERVICE_HUB } from './connexions.js';
import { champsIA } from './choix-ia.js';

const PREFIXES = ['hubia:', 'pub:', 'route:', 'iasvc:', 'tunnel:', 'alertes:', 'courriel:'];
const lien = (id, name, params, extra = {}) => ({ id, type: 'core.link', name: String(name).slice(0, 80), params, ...extra });
const hoteDe = u => { try { return new URL(u).host; } catch { return String(u || ''); } };

export class LiensHub {
  constructor({ db, store, services, ai = null, audit = null, connexions = null }) { Object.assign(this, { db, store, services, ai, audit, connexions }); this.file = Promise.resolve(); this.minuteur = null; }
  attach({ ai, connexions }) { if (ai) this.ai = ai; if (connexions) this.connexions = connexions; }

  /** Les liens voulus, d'après l'état du Hub — et celui de Relay, qu'on lui demande. */
  async voulus() {
    const out = [];
    const tous = this.services.list();
    const nomDe = id => tous.find(i => i.id === id) || null;

    // Les IA du Hub (page IA) : qui sert l'assistant, les workflows, les embeddings.
    const ROLES = { config: 'l’assistant', workflows: 'les nœuds IA des workflows', embeddings: 'la mémoire (embeddings)', voix: 'la voix' };
    for (const c of this.ai?.list() || []) {
      const inst = c.instanceId ? nomDe(c.instanceId) : null;
      const source = inst ? lien('s', `${inst.name} · ${c.model || 'modèle par défaut'}`, { note: `${c.kindLabel || c.kind}, servi par ${inst.name}.` }, { instanceId: inst.id })
        : lien('s', `${c.kindLabel || c.kind} · ${c.model || 'modèle par défaut'}`, { note: `${c.cleRef ? `Clé « ${c.cleRef} » de Clés & API` : c.url ? hoteDe(c.url) : 'Fournisseur en ligne'}. Les questions partent chez ce fournisseur.` });
      const pour = (c.roles || []).map(r => ROLES[r] || r).join(', ') || 'rien pour l’instant';
      out.push({ cle: `hubia:${c.id}`, nom: `IA du Hub « ${c.name} » → ${c.model || c.kindLabel || c.kind}`, dossier: 'Hub / Liens',
        noeuds: [source, lien('c', 'Le Hub s’en sert', { note: `Pour : ${pour}. Se change : PUT /api/ai/${c.id} {model, roles} — ou la page IA.` })] });
    }

    // Les services qui parlent à l'IA du Hub sans choisir leur modèle dans leurs
    // réglages (ceux qui le choisissent ont leur lien « → IA du Hub · modèle »).
    const passerelle = this.services.iaServices;
    for (const inst of tous) {
      if (!passerelle?.utilise?.(inst) || champsIA(inst.manifest)) continue;
      out.push({ cle: `iasvc:${inst.id}`, nom: `${inst.name} → IA du Hub`, dossier: `${inst.manifest?.name || inst.name} / Liens`,
        noeuds: [lien('h', 'IA du Hub', { note: `Toutes les IA de la page IA (${(this.ai?.list() || []).map(c => c.name).join(', ') || 'aucune pour l’instant'}), par une API Ollama et OpenAI.` }),
          lien('c', `${inst.name} s’en sert`, { note: `Un modèle se nomme « connexion/modèle » ; un nom nu va à l’Ollama qui l’a. Se change dans ses réglages, ou page IA pour les connexions.` }, { instanceId: inst.id })] });
    }

    // Les noms publiés par Relay.
    const relay = tous.find(i => (i.manifest.capabilities?.provides || []).includes('edge.routes')) || null;
    const pubs = this.db.setting('publications', {}) || {};
    for (const [id, url] of Object.entries(pubs)) {
      const inst = id === SERVICE_HUB ? null : nomDe(id);
      if (id !== SERVICE_HUB && !inst) continue;
      const qui = inst ? inst.name : 'Le Hub';
      out.push({ cle: `pub:${id}`, nom: `${qui} publié sur ${hoteDe(url)}`, dossier: inst ? `${inst.manifest?.name || inst.name} / Liens` : 'Hub / Liens',
        noeuds: [
          lien('r', relay ? `${relay.name} sert ${hoteDe(url)}` : `Relay sert ${hoteDe(url)}`, { note: `Nom et certificat tenus par Relay : ${url}` }, relay ? { instanceId: relay.id } : {}),
          lien('c', `${qui} répond`, { note: `Se change : ${inst ? `PUT /api/connexions/services/${inst.id} {sousDomaine, mode}` : 'PUT /api/connexions/hub {sousDomaine, mode}'} ; se retire : DELETE de la même route — ou Connexions.` }, inst ? { instanceId: inst.id } : {}),
        ] });
    }

    // Ce que Relay sert réellement : les routes que le Hub n'a pas posées lui-même
    // (créées dans Relay, par son API ou une autre main) apparaissent aussi —
    // une connexion qui existe se voit ici, d'où qu'elle vienne.
    let etatRelay = null;
    if (relay && this.connexions) { try { etatRelay = await this.connexions.etat(); } catch { etatRelay = null; } }
    const connus = new Set(Object.values(pubs).map(hoteDe));
    for (const r of etatRelay?.routes || []) {
      if (!r?.hote || connus.has(r.hote)) continue;
      const parLeHub = String(r.proprietaire || '').startsWith('hub:');
      if (parLeHub && (r.proprietaire === `hub:${SERVICE_HUB}` || tous.some(i => i.name === r.proprietaire.slice(4)))) continue;
      out.push({ cle: `route:${r.hote}`, nom: `${r.hote} servi par ${relay.name}${parLeHub ? '' : ' (hors Hub)'}`, dossier: `${relay.manifest?.name || relay.name} / Liens`,
        noeuds: [
          lien('r', `${relay.name} sert ${r.hote}`, { note: `Route ${parLeHub ? 'd’un service que le Hub ne connaît plus' : 'créée dans Relay directement'}${r.proprietaire ? ` (propriétaire : ${r.proprietaire})` : ''}${r.cf ? ', par le tunnel Cloudflare' : r.mode ? `, mode ${r.mode}` : ''}.` }, { instanceId: relay.id }),
          lien('c', r.cible ? `→ ${String(r.cible).slice(0, 60)}` : 'cible réglée dans Relay', { note: `Se change : PATCH /api/connexions/routes/${r.id ?? '<id>'} ; se retire : DELETE de la même route — ou Connexions.` }),
        ] });
    }

    // Le tunnel Cloudflare : son connecteur tourne dans la pile de Relay — ou
    // Relay le dit lui-même (des noms en mode cloudflare).
    const tunnelActif = (relay && String(relay.config?.TUNNEL_ACTIF ?? '') === '1') || !!etatRelay?.cloudflare || (etatRelay?.routes || []).some(x => x.cf);
    if (relay && tunnelActif) {
      out.push({ cle: `tunnel:${relay.id}`, nom: `${relay.name} passe par le tunnel Cloudflare`, dossier: `${relay.manifest?.name || relay.name} / Liens`,
        noeuds: [lien('t', 'Tunnel Cloudflare', { note: 'Les noms en mode « cloudflare » arrivent par le tunnel, sans port ouvert chez toi.' }),
          lien('r', `${relay.name} le relaie`, { note: 'Se coupe : DELETE /api/connexions/tunnel ; tout y passer : POST /api/connexions/tunnel/tout — ou Connexions.' }, { instanceId: relay.id })] });
    }

    // Les alertes du Hub, sur un compte Telegram de Clés & API.
    const alertes = this.db.setting('alertes', null);
    if (alertes?.canal) {
      out.push({ cle: 'alertes:hub', nom: `Alertes du Hub → ${alertes.canal}`, dossier: 'Hub / Liens',
        noeuds: [lien('h', 'Le Hub', { note: `Prévient pour : ${Object.entries(alertes.types || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'les alertes choisies'}.` }),
          lien('t', `Telegram « ${alertes.canal} »`, { note: 'Compte de Clés & API. Se change : PUT /api/alertes {canal, types} — ou Réglages → Alertes.' })] });
    }

    // Le relais de courriel que les services reprennent pour leurs comptes.
    const courriel = this.db.setting('courriel_comptes', null);
    if (courriel?.relais?.hote) {
      out.push({ cle: 'courriel:hub', nom: `Courriel des comptes → ${courriel.relais.hote}`, dossier: 'Hub / Liens',
        noeuds: [lien('h', 'Comptes des services', { note: 'Invitations et réinitialisations envoyées par ce relais.' }),
          lien('s', `Relais ${courriel.relais.hote}:${courriel.relais.port || ''}`, { note: 'Se change : PUT /api/courriel {defaut, relais} — l’identifiant et le mot de passe se remplissent à la main (Réglages → Courriel des comptes).' })] });
    }
    return out;
  }

  /** Un passage à la fois ; plusieurs demandes rapprochées n'en font qu'un. */
  planifier(delai = 300) {
    clearTimeout(this.minuteur);
    this.minuteur = setTimeout(() => { this.reconcilier().catch(e => log.warn('liens', e.message)); }, delai);
    this.minuteur.unref?.();
  }

  reconcilier(acteur = 'hub') {
    const tour = this.file.then(() => this.passe(acteur)).catch(e => log.warn('liens', e.message));
    this.file = tour;
    return tour;
  }

  async passe(acteur) {
    const voulus = new Map((await this.voulus()).map(v => [v.cle, v]));
    const existants = this.db.all(`SELECT id, auto_key FROM workflows WHERE origin='Auto' AND (${PREFIXES.map(() => 'auto_key LIKE ?').join(' OR ')})`, ...PREFIXES.map(p => `${p}%`));
    const faits = [];
    for (const w of existants) if (!voulus.has(w.auto_key)) { await this.store.remove(w.id, acteur); faits.push(`retiré ${w.auto_key}`); }
    const range = this.store.list().some(x => x.dossier);
    for (const v of voulus.values()) {
      const graph = { nodes: v.noeuds.map((n, i) => ({ ...n, x: 360 + i * 300, y: 200 })), edges: v.noeuds.slice(1).map((n, i) => ({ from: v.noeuds[i].id, port: 'main', to: n.id })) };
      const w = existants.find(x => x.auto_key === v.cle);
      if (w) {
        const avant = this.store.get(w.id);
        const pareil = avant.name === v.nom && JSON.stringify(avant.graph.nodes.map(n => [n.name, n.instanceId || null, n.params?.note])) === JSON.stringify(graph.nodes.map(n => [n.name, n.instanceId || null, n.params.note]));
        if (!pareil) { await this.store.update(w.id, { name: avant.name === v.nom ? v.nom : this.store.nomLibre(v.nom), graph }, acteur); faits.push(`mis à jour ${v.cle}`); }
        continue;
      }
      const { workflow } = this.store.create({ name: v.nom, graph, origin: 'Auto', autoKey: v.cle }, acteur);
      if (range && v.dossier) { try { this.store.ranger([{ id: workflow.id, dossier: v.dossier }], acteur); } catch { /* reste à la racine */ } }
      faits.push(`créé ${v.cle}`);
    }
    if (faits.length) this.audit?.write(acteur, 'liens.hub', null, { changements: faits.slice(0, 20) });
    return faits;
  }
}
