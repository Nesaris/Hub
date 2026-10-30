// Le mini-cerveau du Hub dans SYNAPSE.
//
// SYNAPSE est le cerveau commun des services : chaque service qui a son IA y pose sa
// fiche — ce qu'il sait, ce qu'il fait, ses règles — et son état du moment.
// Les autres IA la lisent pour savoir qui sait quoi, et à qui renvoyer une
// action. Le Hub est le chef d'orchestre : installer, relier, créer des
// workflows, envoyer des messages, c'est chez lui.
//
// Rien ne dépend de ceci : sans service de mémoire, ou avec un SYNAPSE trop
// ancien pour avoir l'annuaire, le Hub fonctionne exactement comme avant.

import { log } from '../util/common.js';

export const FICHE_HUB = {
  titre: 'Hub — chef d’orchestre des services',
  perimetre: 'Installe, met à jour et relie les services ; crée, modifie, active et lance les workflows ; gère les connexions IA, les clés & API, '
    + 'les utilisateurs et les notifications (Telegram, Discord, ntfy…). Voit l’état de tous les services installés et de leurs sondes.',
  sait: ['workflow', 'workflows', 'automatisation', 'automatiser', 'déclencheur', 'planification', 'cron', 'webhook', 'extension', 'catalogue',
    'installer', 'mise à jour', 'mettre à jour', 'service', 'services', 'sonde', 'sondes', 'clé', 'clés', 'api', 'secret', 'telegram', 'discord',
    'ntfy', 'notification', 'notifications', 'message', 'utilisateur', 'utilisateurs', 'connexion ia', 'ollama', 'modèle', 'hub'],
  actions: [
    { nom: 'créer, modifier, activer ou lancer un workflow', ou: 'Hub → Assistant' },
    { nom: 'installer, mettre à jour, redéployer ou retirer un service', ou: 'Hub → Extensions' },
    { nom: 'envoyer un message ou une alerte (Telegram, Discord, ntfy)', ou: 'Hub → Assistant' },
    { nom: 'ajouter une clé, une connexion IA ou un utilisateur', ou: 'Hub → Clés & API / Réglages' },
  ],
  regles: 'Rien ne change sans la validation de l’utilisateur (autonomie « validation »). Les secrets ne sont jamais montrés : l’IA cite des noms de clés, jamais leurs valeurs.',
};

const MOT = { online: 'en ligne', error: 'en erreur', offline: 'hors ligne', installing: 'installation', stopped: 'arrêté' };

export class CerveauHub {
  constructor({ services, runtime, store, db, ai }) {
    Object.assign(this, { services, runtime, store, db, ai, ancien: new Set() });
  }

  /** SYNAPSE (ou tout service qui rend un brief) en ligne. */
  memoires() {
    return this.services.list().filter(i => i.status === 'online' && (i.manifest.capabilities?.provides || []).includes('memory.brief'));
  }

  /** L'adresse du Hub vue par le navigateur, retenue à la dernière visite. */
  adresse() {
    return this.db.setting('hub_ui', '') || '';
  }

  etat() {
    const inst = this.services.list();
    const wfs = (() => { try { return this.store.list(); } catch { return []; } })();
    const actifs = wfs.filter(w => w.enabled);
    const enEchec = wfs.filter(w => w.lastStatus === 'error');
    const cnx = (() => { try { return this.ai.publicList?.() || this.ai.list?.() || []; } catch { return []; } })();
    const cfg = cnx.find(c => (c.roles || []).includes('config')) || cnx[0];
    return [
      `Services (${inst.length}) : ${inst.map(i => `${i.name} ${MOT[i.status] || i.status}${i.version ? ` v${i.version}` : ''}`).join(', ') || 'aucun'}.`,
      `Workflows : ${wfs.length} au total, ${actifs.length} actifs${enEchec.length ? `, en échec : ${enEchec.slice(0, 6).map(w => w.name).join(', ')}` : ', aucun en échec'}.`,
      cfg ? `IA du Hub : ${cfg.name}${cfg.model ? ` (${cfg.model})` : ''}.` : 'Aucune IA configurée dans le Hub.',
    ].join(' ');
  }

  /** Pose la fiche et l'état du Hub dans chaque SYNAPSE en ligne. */
  async publier() {
    const fiche = { ...FICHE_HUB, ui: this.adresse() };
    const etat = this.etat();
    let fait = 0;
    for (const inst of this.memoires()) {
      if (this.ancien.has(`${inst.id}@${inst.version}`)) continue;
      try {
        await this.runtime.request(inst, { method: 'PUT', path: '/v1/cerveaux/moi', body: fiche }, { timeout: 8000, brut: true });
        await this.runtime.request(inst, { method: 'PUT', path: '/v1/cerveaux/moi/etat', body: { etat } }, { timeout: 8000, brut: true });
        fait++;
      } catch (e) {
        // Un SYNAPSE d'avant l'annuaire répond 404 : on ne réessaie pas avant sa mise à jour.
        if (e.upstreamStatus === 404) { this.ancien.add(`${inst.id}@${inst.version}`); log.info('cerveau', `${inst.name} ${inst.version} n’a pas encore l’annuaire des cerveaux`); }
        else log.warn('cerveau', inst.name, e.message);
      }
    }
    return fait;
  }
}
