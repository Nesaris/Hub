// Mémoire de l'assistant, branchée par capacité.
//
// Le Hub ne connaît pas SYNAPSE : il connaît `memory.search` et
// `memory.ingest`. N'importe quel service qui annonce ces capacités devient la
// mémoire de l'assistant, et un jour SYNAPSE pourra être remplacé sans qu'une
// ligne d'ici ne bouge.
//
// La distinction qui compte — MÉMOIRE commune, APPRENTISSAGE propre à chaque
// modèle — ne se joue pas dans des noms d'espaces inventés ici. Le Hub dit
// simplement QUI parle, en passant le nom de la connexion ; le fournisseur
// décide comment il range. Un fait reste vrai quel que soit le modèle qui le
// lit, tandis que ce qui rattrape Kimi déroute Qwen : c'est au service de
// mémoire de tenir cette séparation, pas au Hub de la lui imposer par une
// convention de nommage qu'il ne connaît pas.
//
// L'espace est `shared` : SYNAPSE réserve ses espaces par source et refuse,
// sans rien dire, un nom inventé ici (rien ne s'écrirait). C'est le seul nom
// qu'un service de mémoire comprend par défaut ; celui qui en veut un autre le
// déclare dans son manifeste.

import { log } from '../util/common.js';
import { config } from '../config.js';

/* Deux éléments dont le texte, une fois normalisé, est le même : on n'en garde qu'un. */
export function sansDoublons(liste) {
  const vus = new Set();
  return (Array.isArray(liste) ? liste : []).filter(x => {
    const k = String(typeof x === 'string' ? x : (x?.texte ?? x?.text ?? x?.trait ?? JSON.stringify(x))).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k || vus.has(k)) return false;
    vus.add(k); return true;
  });
}

export const ESPACE_COMMUN = 'shared';

export class Memoire {
  constructor({ services, runtime, audit, db }) { Object.assign(this, { services, runtime, audit, db }); }

  /** Les instances en ligne qui annoncent cette capacité. */
  fournisseurs(capacite) {
    return this.services.list().filter(i => (i.manifest.capabilities?.provides || []).includes(capacite));
  }

  /** Y a-t-il un cerveau branché ? C'est ce qui décide d'afficher la proposition. */
  active() { return this.fournisseurs('memory.ingest').length > 0; }

  /** L'action d'une instance qui porte cette capacité. */
  #action(inst, capacite) {
    return inst.manifest.actions.find(a => a.capability === capacite);
  }

  /**
   * Le briefing complet, quand le service sait en rendre un.
   *
   * `memory.brief` répond en un appel ce que trois recherches donnaient,
   * et il rend davantage : le profil appris de l'utilisateur, et les
   * corrections déjà faites à ce modèle-là. Un service qui ne l'annonce
   * pas n'est pas diminué — on retombe sur `rappeler`, qui existait
   * avant lui.
   */
  async briefer(texte, { connexion } = {}) {
    for (const inst of this.fournisseurs('memory.brief')) {
      const a = this.#action(inst, 'memory.brief');
      if (!a) continue;
      try {
        /* Trois secondes au plus : une mémoire occupée (elle partage souvent
           Ollama avec l'assistant) ne doit pas faire attendre la réponse. */
        const r = await Promise.race([
          this.runtime.action(inst, a.id, { agent: connexion || 'inconnu', query: texte, space: ESPACE_COMMUN }),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`mémoire trop lente (${config.memoireDelai / 1000} s), réponse sans elle`)), config.memoireDelai)),
        ]);
        if (r && (r.profil || r.memoire || r.corrections)) {
          /* Sans doublons : la même phrase stockée dix fois devenait dix
             lignes du prompt — et le modèle les recopiait en boucle. */
          return {
            profil: sansDoublons(r.profil || []), corrections: sansDoublons(r.corrections || []),
            souvenirs: sansDoublons((r.memoire || []).map(m => ({ espace: 'commun', texte: String(m.extrait || m.titre || '').slice(0, 400) }))),
            // Les autres cerveaux concernés par la question, avec leur état (SYNAPSE 1.8+).
            cerveaux: (Array.isArray(r.cerveaux) ? r.cerveaux : []).filter(c => c?.nom !== 'hub').slice(0, 3)
              .map(c => ({ nom: c.nom, titre: c.titre, etat: String(c.etat || '').slice(0, 600), action: c.action || null, adresse: c.ui || null })),
            tronque: !!r.tronque,
          };
        }
      } catch (e) { log.warn('mémoire', inst.name, 'briefing', e.message); }
    }
    return { profil: [], corrections: [], souvenirs: sansDoublons(await this.rappeler(texte, { connexion })), cerveaux: [], tronque: false };
  }

  /**
   * Ce que la mémoire sait de cette demande.
   *
   * Cherche dans le commun et dans l'espace du modèle qui va répondre. Une
   * recherche qui échoue ne fait rien échouer : l'assistant répond sans
   * mémoire, comme avant qu'elle existe.
   */
  async rappeler(texte, { connexion } = {}) {
    const out = [];
    for (const inst of this.fournisseurs('memory.search')) {
      const a = this.#action(inst, 'memory.search');
      if (!a) continue;
      try {
        const r = await this.runtime.action(inst, a.id, { query: texte, space: ESPACE_COMMUN, agent: connexion || '' });
        const items = Array.isArray(r) ? r : (r?.results || r?.facts || r?.items || r?.hits || []);
        for (const x of items.slice(0, 8)) {
          const t = typeof x === 'string' ? x : (x.text || x.content || x.fact || x.snippet || x.title);
          if (t) out.push({ espace: 'commun', texte: String(t).slice(0, 400) });
        }
      } catch (e) { log.warn('mémoire', inst.name, 'recherche', e.message); }
    }
    return out.slice(0, 12);
  }

  /**
   * Écrit un fait, sans bloquer et sans jamais faire échouer l'appelant : une
   * mémoire injoignable est une mémoire absente, pas une erreur à l'écran.
   */
  retenir(texte, { espace = ESPACE_COMMUN, tags = [] } = {}) {
    const t = String(texte || '').trim();
    if (!t) return;
    for (const inst of this.fournisseurs('memory.ingest')) {
      const a = this.#action(inst, 'memory.ingest');
      if (!a) continue;
      this.runtime.action(inst, a.id, { text: t.slice(0, 4000), tags, space: espace })
        .catch(e => log.warn('mémoire', inst.name, 'écriture', e.message));
    }
  }

  /**
   * L'utilisateur dit que la réponse était fausse, et ce qu'il fallait dire.
   *
   * C'est le seul mécanisme par lequel une réponse à côté cesse de se
   * répéter. La correction est rangée chez le modèle qui s'est trompé :
   * elle ne pénalise pas les autres, qui n'ont rien fait.
   */
  corriger({ connexion, question, correction, faux }) {
    const fins = this.fournisseurs('memory.correct');
    if (!fins.length) {
      this.retenir(`Sur « ${question} », la bonne réponse est : ${correction}`,
        { tags: ['assistant', 'correction', ...(connexion ? [`modele:${connexion}`] : [])] });
      return { via: 'mémoire simple' };
    }
    for (const inst of fins) {
      const a = this.#action(inst, 'memory.correct');
      if (!a) continue;
      this.runtime.action(inst, a.id, { agent: connexion || 'inconnu', question, correction, faux: faux || '' })
        .catch(e => log.warn('mémoire', inst.name, 'correction', e.message));
    }
    return { via: fins.map(i => i.name).join(', ') };
  }

  /**
   * Range un échange : le fait dans le commun, la leçon chez le modèle.
   *
   * Ce que l'utilisateur a demandé et ce qui a été fait appartiennent au Hub.
   * Comment ce modèle-là s'en est tiré n'appartient qu'à lui.
   */
  apprendre({ demande, reponse, etapes = [], connexion, probleme, resultat }) {
    const fin = resultat ? `\nRésultat : ${resultat}` : '';
    /* Un service qui sait consigner un échange le fait mieux que nous :
       il en tirera des traits. Sinon, l'échange devient un fait ordinaire. */
    const fins = this.fournisseurs('memory.learn');
    if (fins.length) {
      for (const inst of fins) {
        const a = this.#action(inst, 'memory.learn');
        if (!a) continue;
        this.runtime.action(inst, a.id, {
          agent: connexion || 'inconnu', question: demande,
          reponse: `${reponse}${etapes.length ? `\nPlan : ${etapes.join(' ; ')}` : ''}${fin}`,
          space: ESPACE_COMMUN,
        }).catch(e => log.warn('mémoire', inst.name, 'échange', e.message));
      }
    } else {
      this.retenir(`Demande : ${demande}\nRéponse : ${reponse}${etapes.length ? `\nPlan : ${etapes.join(' ; ')}` : ''}${fin}`,
        { tags: ['assistant', 'échange'] });
    }
    if (connexion && probleme) {
      this.retenir(`Sur « ${demande} », la réponse a dû être corrigée : ${probleme}`,
        { tags: ['assistant', 'correction', `modele:${connexion}`] });
    }
  }
}
