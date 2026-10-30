// Ce que le Hub raconte à SYNAPSE, tout seul, au fil de l'eau.
//
//   - un workflow qui échoue (une fois par workflow et par 10 min) ;
//   - toutes les heures, le bilan des exécutions, s'il y en a eu ;
//   - un service qui tombe, qui revient, qui change de version, qui arrive
//     ou qui part.
//
// Rien ne dépend de ceci : sans service de mémoire, les événements ne sont
// même pas mis en file. Les envois passent par une file bornée : une mémoire
// lente ou absente ne ralentit jamais le Hub. Jamais de secret ni de sortie
// de workflow dans un événement : des noms, des états, des erreurs.

import { log } from '../util/common.js';

const FILE_MAX = 300, LOT = 50;
const MOT = { online: 'en ligne', error: 'en erreur', offline: 'hors ligne', installing: 'en installation', stopped: 'arrêté' };
const enPanne = s => s === 'offline' || s === 'error';
const court = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Une exécution échouée devient un incident. */
export function depuisEchec(x) {
  const nom = court(x.workflowName || x.workflowId, 120);
  return {
    kind: 'incident.workflow', title: `Workflow « ${nom} » en échec : ${court(x.error || 'erreur inconnue', 200)}`,
    body: `Le workflow « ${nom} » a échoué${x.mode ? ` (lancement ${x.mode})` : ''}. Erreur : ${court(x.error || 'inconnue', 800)}`,
    ref: `workflow:${x.workflowId}`, tags: ['workflow', 'echec'],
    meta: { workflowId: x.workflowId, mode: x.mode || null },
  };
}

/** Un changement d'un service installé, ou null s'il n'y a rien à raconter. */
export function depuisService(avant, apres) {
  if (!avant && apres) return { kind: 'service.added', title: `Service ${apres.name} installé${apres.version ? ` (v${apres.version})` : ''}`, ref: `service:${apres.name}`, tags: ['service', 'installation'], meta: { version: apres.version || null } };
  if (avant && !apres) return { kind: 'service.removed', title: `Service ${avant.name} retiré`, ref: `service:${avant.name}`, tags: ['service', 'retrait'], meta: {} };
  if (!avant || !apres) return null;
  if (avant.version && apres.version && avant.version !== apres.version) {
    return { kind: 'service.updated', title: `Service ${apres.name} mis à jour : v${avant.version} → v${apres.version}`, ref: `service:${apres.name}`, tags: ['service', 'mise-a-jour'], meta: { avant: avant.version, apres: apres.version } };
  }
  if (avant.status === apres.status) return null;
  if (enPanne(apres.status) && !enPanne(avant.status) && avant.status !== 'installing') {
    return { kind: 'incident.service', title: `Service ${apres.name} ${MOT[apres.status]}${apres.detail ? ` : ${court(apres.detail, 200)}` : ''}`,
      body: `Le Hub ne joint plus ${apres.name} (état précédent : ${MOT[avant.status] || avant.status}).`, ref: `service:${apres.name}`, tags: ['service', 'panne'], meta: { avant: avant.status, apres: apres.status } };
  }
  if (apres.status === 'online' && enPanne(avant.status)) {
    return { kind: 'service.recovered', title: `Service ${apres.name} de nouveau en ligne`, ref: `service:${apres.name}`, tags: ['service', 'retour'], meta: { avant: avant.status } };
  }
  return null;
}

export class JournalHub {
  constructor({ bus, services, runtime }) {
    Object.assign(this, { bus, services, runtime });
    this.file = [];
    this.minuteur = null;
    this.attente = 5000;
    this.connus = new Map();          // id → { name, status, version, detail }
    this.echecsVus = new Map();       // workflowId → dernier envoi
    this.compte = new Map();          // workflowName → { ok, echec }
    this.etat = { envoyes: 0, echecs: 0, perdus: 0, dernierEnvoi: null, erreur: null };
  }

  /** La mémoire en ligne, s'il y en a une. */
  memoire() {
    const tous = this.services.list().filter(i => (i.manifest.capabilities?.provides || []).includes('memory.ingest'));
    return tous.find(i => i.status === 'online') || null;
  }

  raconter(e) {
    if (!this.memoire()) return;
    this.file.push({ occurred_at: new Date().toISOString(), ...e, tags: [...new Set(['hub', ...(e.tags || [])])] });
    while (this.file.length > FILE_MAX) { this.file.shift(); this.etat.perdus++; }
    if (!this.minuteur) { this.minuteur = setTimeout(() => this.vider(), 2000); this.minuteur.unref?.(); }
  }

  async vider() {
    this.minuteur = null;
    if (!this.file.length) return;
    const inst = this.memoire();
    const lot = this.file.slice(0, LOT);
    try {
      if (!inst) throw new Error('mémoire hors ligne');
      await this.runtime.request(inst, { method: 'POST', path: '/v1/ingest/batch', body: { events: lot } }, { timeout: 15000, brut: true });
      this.file.splice(0, lot.length);
      Object.assign(this.etat, { envoyes: this.etat.envoyes + lot.length, dernierEnvoi: new Date().toISOString(), erreur: null });
      this.attente = 5000;
    } catch (e) {
      this.etat.echecs++; this.etat.erreur = court(e.message, 160);
      this.attente = Math.min(300000, this.attente * 2);
      if (this.etat.echecs % 10 === 1) log.warn('journal', 'SYNAPSE', this.etat.erreur);
    }
    if (this.file.length) { this.minuteur = setTimeout(() => this.vider(), this.etat.erreur ? this.attente : 500); this.minuteur.unref?.(); }
  }

  photo() {
    const m = new Map();
    for (const i of this.services.list()) m.set(i.id, { name: i.name, status: i.status, version: i.version || null, detail: i.status_detail || null });
    return m;
  }

  /** Compare l'état des services à celui d'avant et raconte les différences. */
  comparer() {
    const neuf = this.photo();
    for (const [id, apres] of neuf) { const e = depuisService(this.connus.get(id), apres); if (e) this.raconter(e); }
    for (const [id, avant] of this.connus) if (!neuf.has(id)) { const e = depuisService(avant, null); if (e) this.raconter(e); }
    this.connus = neuf;
  }

  execution(x) {
    const nom = x.workflowName || x.workflowId;
    const c = this.compte.get(nom) || { ok: 0, echec: 0 };
    if (x.status === 'error') {
      c.echec++;
      const t = this.echecsVus.get(x.workflowId) || 0;
      if (Date.now() - t > 600000) { this.echecsVus.set(x.workflowId, Date.now()); this.raconter(depuisEchec(x)); }
    } else if (x.status === 'success' || x.status === 'done') c.ok++;
    this.compte.set(nom, c);
  }

  /** Le bilan horaire des exécutions : rien s'il n'y en a pas eu. */
  bilan() {
    if (!this.compte.size) return null;
    const lignes = [...this.compte].sort((a, b) => (b[1].ok + b[1].echec) - (a[1].ok + a[1].echec));
    const ok = lignes.reduce((s, [, c]) => s + c.ok, 0), ko = lignes.reduce((s, [, c]) => s + c.echec, 0);
    this.compte.clear();
    const e = {
      kind: 'hub.workflows', title: `Workflows, dernière heure : ${ok} exécutions réussies, ${ko} échouées`,
      body: lignes.slice(0, 15).map(([n, c]) => `- ${court(n, 80)} : ${c.ok} réussies${c.echec ? `, ${c.echec} échouées` : ''}`).join('\n'),
      tags: ['workflow', 'bilan'], meta: { changed: true, reussies: ok, echouees: ko },
    };
    this.raconter(e);
    return e;
  }

  demarrer() {
    this.connus = this.photo();     // l'état au démarrage n'est pas une nouvelle
    let relance = null;
    this.bus.on('instance', () => { clearTimeout(relance); relance = setTimeout(() => this.comparer(), 3000); relance.unref?.(); });
    this.bus.on('execution.finished', x => this.execution(x));
    const t = setInterval(() => this.bilan(), 3600e3); t.unref?.();
    return t;
  }

  vue() { return { ...this.etat, enAttente: this.file.length, relie: !!this.memoire() }; }
}
