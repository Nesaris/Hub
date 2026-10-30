// La voix de l'assistant : entendre et parler, en empruntant un service qui
// fournit « voice.stt » et « voice.tts » (VOX).
//
// Le cerveau reste celui du Hub : la question transcrite passe par le même
// assistant que celle tapée au clavier, avec ses widgets et ses plans. Le
// service vocal ne fait que l'oreille (Whisper) et la bouche (la voix choisie).
import crypto from 'node:crypto';
import { HttpError, log } from './util/common.js';
import { sortir } from './sortie.js';

const MOTS_ARRET = /^\s*(stop|arr[êe]te(-toi)?|c'?est bon|c'?est tout|merci c'?est tout|laisse tomber|au revoir|bye|termin[ée])\s*[.!]*\s*$/i;

export class Voix {
  constructor({ services, runtime, registry, secrets, store }) { Object.assign(this, { services, runtime, registry, secrets, store, poussee: null }); }

  /* La clé ElevenLabs de Clés & API, pour que VOX parle avec elle sans qu'on
     la saisisse une seconde fois dans sa console. Un compte nommé
     (« Voix VoxAI ») compte autant que le compte sans nom, qui passe en
     premier. Une valeur qui ne commence pas par « sk_ » est l'identifiant de
     la clé, pas la clé : ElevenLabs la refuse, on ne l'envoie pas. */
  cleEleven() {
    const v = k => { try { return String(this.secrets?.valeur(k) || '').trim(); } catch { return ''; } };
    let comptes = [];
    try { comptes = (this.secrets?.list() || []).filter(e => e.base === 'elevenlabs'); } catch { /* pas de coffre */ }
    comptes.sort((a, b) => (a.compte ? 1 : 0) - (b.compte ? 1 : 0));
    let identifiant = null;
    for (const e of comptes) {
      const nom = suffixe => e.champs.find(c => c.key.endsWith('_' + suffixe) && c.rempli)?.key || '';
      const cle = nom('API_KEY') && v(nom('API_KEY'));
      if (!cle) continue;
      if (!/^sk_/.test(cle)) { identifiant ??= { identifiant: true, compte: e.compte || '' }; continue; }
      return { ok: true, cle, voix: nom('VOICE_ID') && v(nom('VOICE_ID')), modele: nom('MODEL') && v(nom('MODEL')), compte: e.compte || '', nomCle: nom('API_KEY') };
    }
    return identifiant || { absente: true };
  }

  eleven() {
    const e = this.cleEleven();
    return e.ok ? e : null;
  }

  /* Poussée à VOX avant de parler, une fois par valeur : changer la clé ou la
     voix dans Clés & API suffit, le prochain tour vocal la prend.
     Rend « ok », « déjà », « ancien » (VOX trop vieux), « refus » ou « erreur ». */
  async pousserEleven(inst, url, entetes) {
    const e = this.eleven();
    if (!e) return 'absente';
    const empreinte = crypto.createHash('sha256').update([inst.id, e.cle, e.voix, e.modele].join('\n')).digest('hex');
    if (this.poussee === empreinte) return 'déjà';
    try {
      const r = await sortir(`${url}/v1/hub/voix`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { ...entetes, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eleven: e.cle, voice: e.voix ? `eleven:${e.voix}` : undefined, eleven_model: e.modele || undefined }),
      });
      if (r.ok) { this.poussee = empreinte; log.info('voix', `clé ElevenLabs transmise à ${inst.name}`); return 'ok'; }
      if (r.status === 404) { this.poussee = empreinte; log.warn('voix', `${inst.name} ne sait pas recevoir la clé ElevenLabs : mets VOX à jour (6.4+)`); return 'ancien'; }
      log.warn('voix', `${inst.name} a refusé la clé ElevenLabs (HTTP ${r.status})`);
      return 'refus';
    } catch (err) { log.warn('voix', `clé ElevenLabs vers ${inst.name} : ${err.message}`); return 'erreur'; }
  }

  /* Le service qui fournit la capacité, en ligne de préférence. */
  fournisseur(capacite) {
    const tous = this.services.list().filter(i => (i.manifest.capabilities?.provides || []).includes(capacite));
    return tous.find(i => i.status === 'online') || tous[0] || null;
  }

  /**
   * Le lien « VOX utilise la voix ElevenLabs » : visible dans Workflows comme
   * les autres liens entre services, créé quand la clé est dans Clés & API et
   * qu'un service de voix est là, retiré quand l'un des deux disparaît. Au
   * passage, la clé part tout de suite chez VOX au lieu d'attendre le premier
   * tour vocal.
   */
  async synchroniserLien() {
    if (!this.store) return 'absente';
    const tts = this.fournisseur('voice.tts');
    const cle = this.eleven();
    const cleLien = tts ? `eleven:${tts.id}` : null;
    const existants = this.store.list().filter(w => String(w.autoKey || '').startsWith('eleven:'));
    for (const w of existants) if (!cle || w.autoKey !== cleLien) await this.store.remove(w.id, 'hub');
    if (cle && tts && !existants.some(w => w.autoKey === cleLien)) {
      const w = this.store.create({
        name: `${tts.name} utilise la voix ElevenLabs`, origin: 'Auto', autoKey: cleLien,
        graph: {
          nodes: [
            { id: 'k', type: 'core.link', name: `ElevenLabs${cle.compte ? ` « ${cle.compte} »` : ''} (Clés & API)`, params: { note: `Clé ${cle.nomCle}${cle.voix ? ', avec sa voix' : ''}${cle.modele ? `, modèle ${cle.modele}` : ''}` }, x: 360, y: 200 },
            { id: 'v', type: 'core.link', name: `${tts.name} parle avec elle`, instanceId: tts.id, params: { note: 'Le Hub transmet la clé et la voix à VOX, et les retransmet quand elles changent.' }, x: 660, y: 200 },
          ],
          edges: [{ from: 'k', port: 'main', to: 'v' }],
        },
      }, 'hub');
      // Des workflows déjà rangés : le lien rejoint les autres liens de ce service.
      if (this.store.list().some(x => x.dossier)) {
        try { this.store.ranger([{ id: w.workflow.id, dossier: `${tts.manifest?.name || tts.name} / Liens` }], 'hub'); } catch { /* reste à la racine */ }
      }
    }
    if (!cle || !tts) return cle ? 'sans-vox' : 'absente';
    if (tts.status !== 'online') return 'hors-ligne';
    try { const { inst, url, entetes } = this.cible('voice.tts'); return await this.pousserEleven(inst, url, entetes); } catch { return 'erreur'; }
  }

  etat() {
    const stt = this.fournisseur('voice.stt'), tts = this.fournisseur('voice.tts');
    const pret = !!(stt && tts && stt.status === 'online' && tts.status === 'online');
    /* Pas installé : l'extension qui le fournit, si le catalogue la connaît —
       le panneau propose alors de l'installer d'un clic. */
    const aInstaller = !stt && !tts ? (this.registry?.list() || []).find(e => (e.manifest.capabilities?.provides || []).includes('voice.stt')) : null;
    return {
      disponible: pret,
      voixCloud: this.eleven() ? 'ElevenLabs' : null,
      service: stt?.name || tts?.name || null,
      instance: (stt || tts)?.id || null,
      installer: aInstaller ? { extId: aInstaller.id, nom: aInstaller.manifest.name, mode: aInstaller.manifest.install.type === 'compose' ? 'compose' : 'remote' } : null,
      raison: pret ? null : !stt && !tts
        ? (aInstaller ? `Le mode vocal a besoin de ${aInstaller.manifest.name} : il n'est pas encore installé.` : 'Aucun service vocal au catalogue : ajoute le registre qui contient VOX (Extensions → Registres).')
        : `${(stt || tts).name} n'est pas en ligne (${(stt || tts).status}).`,
    };
  }

  cible(capacite) {
    const inst = this.fournisseur(capacite);
    if (!inst) throw new HttpError(409, 'Aucun service vocal installé : ajoute VOX depuis Extensions.');
    if (inst.status !== 'online') throw new HttpError(503, `${inst.name} n'est pas en ligne (${inst.status}).`);
    const { service } = this.runtime.context(inst);
    return { inst, url: service.url, entetes: service.token ? { Authorization: `Bearer ${service.token}` } : {} };
  }

  /* L'audio (WAV 16 kHz mono) → le texte. */
  async transcrire(audio) {
    if (!audio?.length) throw new HttpError(400, 'Audio vide');
    const { inst, url, entetes } = this.cible('voice.stt');
    const r = await sortir(`${url}/v1/transcrire`, { method: 'POST', headers: { ...entetes, 'Content-Type': 'audio/wav' }, body: audio, signal: AbortSignal.timeout(45000) })
      .catch(e => { throw new HttpError(502, `${inst.name} injoignable : ${e.message}`); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, `${inst.name} : ${j.error || 'HTTP ' + r.status}`);
    const texte = String(j.text || '').trim();
    return { texte, arret: MOTS_ARRET.test(texte), ms: j.ms ?? null };
  }

  /* Le texte → l'audio (WAV, ou MP3 selon la voix). */
  async dire(texte) {
    const t = String(texte || '').trim();
    if (!t) throw new HttpError(400, 'Rien à dire');
    const { inst, url, entetes } = this.cible('voice.tts');
    await this.pousserEleven(inst, url, entetes);
    const r = await sortir(`${url}/v1/dire`, { method: 'POST', headers: { ...entetes, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.slice(0, 1500) }), signal: AbortSignal.timeout(30000) })
      .catch(e => { throw new HttpError(502, `${inst.name} injoignable : ${e.message}`); });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      log.warn('voix', inst.name, j.error || r.status);
      throw new HttpError(502, `${inst.name} : ${j.error || 'HTTP ' + r.status}`);
    }
    return { son: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'audio/wav' };
  }
}

/* Ce qui se dit d'une réponse écrite : sans markdown, sans puces, sans
   emojis, en phrases. Les chiffres détaillés restent dans les widgets. */
export function aDire(texte, max = 600) {
  let t = String(texte || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#+\s*/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/^\s*[-•*]\s+(.*)$/gm, (_, x) => /[.!?:]$/.test(x.trim()) ? x.trim() : x.trim() + '.')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > max) {
    const coupe = t.slice(0, max);
    const fin = Math.max(coupe.lastIndexOf('. '), coupe.lastIndexOf('! '), coupe.lastIndexOf('? '));
    t = (fin > max * 0.4 ? coupe.slice(0, fin + 1) : coupe.replace(/\s+\S*$/, '') + '…');
  }
  return t;
}
