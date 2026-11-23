// Relier un bot Telegram au Hub, pas à pas : le jeton se vérifie tout seul,
// puis on prouve que la discussion est bien la sienne en envoyant au bot un
// code à usage unique (/start <code>). Sans cette preuve, le compte ne
// s'active pas pour l'assistant.
import crypto from 'node:crypto';
import { config } from './config.js';
import { sortir } from './sortie.js';
import { HttpError } from './util/common.js';

const JETON = /^\d+:[\w-]{20,}$/;
const DUREE = 15 * 60e3;
const empreinte = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export class LiaisonTelegram {
  constructor({ db, secrets, audit, lecteurs = () => false }) {
    Object.assign(this, { db, secrets, audit, lecteurs });
    this.liaisons = new Map();
  }

  async appel(token, methode, params = {}, attente = 0) {
    const r = await sortir(`${config.telegramApi}/bot${token}/${methode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      signal: AbortSignal.timeout((attente + 10) * 1000),
    }).catch(e => { throw new HttpError(502, 'Telegram injoignable : ' + e.message); });
    return r.json().catch(() => ({ ok: false, description: 'réponse illisible' }));
  }

  jeton(token) {
    token = String(token || '').replace(/\s+/g, '');
    if (!JETON.test(token)) throw new HttpError(400, 'Ce n’est pas un jeton de bot : il ressemble à 123456789:AAE… (copie-le depuis @BotFather, /mybots → ton bot → API Token).');
    return token;
  }

  /** Étape 1 : le jeton, vérifié auprès de Telegram. */
  async verifier(brut, service = '') {
    const token = this.jeton(brut);
    const moi = await this.appel(token, 'getMe');
    if (!moi.ok) throw new HttpError(400, /unauthorized|not found/i.test(moi.description || '') ? 'Telegram ne reconnaît pas ce jeton : recopie-le depuis @BotFather (/mybots → ton bot → API Token).' : `Telegram refuse : ${moi.description}`);
    const wh = await this.appel(token, 'getWebhookInfo');
    const deja = this.secrets.list().filter(x => x.service !== service && x.champs.some(c => c.key.endsWith('_BOT_TOKEN') && c.rempli && this.secrets.valeur(c.key) === token)).map(x => x.compte || x.nom);
    return { bot: '@' + moi.result.username, nom: moi.result.first_name, id: String(moi.result.id), webhook: !!wh?.result?.url, deja, lu: this.lecteurs(token) };
  }

  /** Étape 2 : un code à usage unique, et le lien qui l'envoie au bot d'un seul geste. */
  async commencer(brut, service = '') {
    const v = await this.verifier(brut, service);
    if (v.webhook) throw new HttpError(409, `${v.bot} envoie ses messages à une adresse web (webhook) : un autre programme le lit. Retire le webhook, ou crée un autre bot pour le Hub.`);
    const now = Date.now();
    for (const [k, l] of this.liaisons) if (l.expire < now) this.liaisons.delete(k);
    const id = crypto.randomBytes(12).toString('base64url');
    const code = String(crypto.randomInt(100000, 1000000));
    this.liaisons.set(id, { token: this.jeton(brut), code, offset: null, expire: now + DUREE, chat: null, bot: v.bot });
    return { id, code, bot: v.bot, nom: v.nom, lien: `https://t.me/${v.bot.slice(1)}?start=${code}`, expire: now + DUREE };
  }

  /** Étape 3 : on attend (jusqu'à 20 s par appel) le message qui porte le code. */
  async attendre(id) {
    const l = this.liaisons.get(String(id));
    if (!l || l.expire < Date.now()) { this.liaisons.delete(String(id)); throw new HttpError(410, 'Ce code a expiré : recommence la liaison.'); }
    if (l.chat) return { ok: true, chat: l.chat };
    if (this.lecteurs(l.token)) throw new HttpError(409, 'Ce bot est déjà lu par le Hub (assistant ou alertes) : coupe-le dans Réglages le temps de le relier, ou prends un autre bot.');
    if (l.offset == null) l.offset = 0;
    const j = await this.appel(l.token, 'getUpdates', { offset: l.offset, timeout: 20, allowed_updates: ['message'] }, 20);
    if (!j.ok) {
      if (/conflict/i.test(j.description || '')) throw new HttpError(409, `Un autre programme lit déjà ${l.bot} : le Hub ne voit pas passer tes messages. Arrête-le, ou crée un autre bot pour le Hub.`);
      throw new HttpError(502, `Telegram refuse : ${j.description}`);
    }
    for (const u of j.result || []) {
      l.offset = u.update_id + 1;
      const m = u.message;
      if (!m?.chat || !String(m.text || '').includes(l.code) || m.from?.is_bot) continue;
      const c = m.chat;
      l.chat = { id: String(c.id), type: c.type, nom: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), de: String(m.from?.id ?? '') };
      await this.appel(l.token, 'sendMessage', { chat_id: c.id, text: '✅ Relié au Hub. Retourne dans le Hub et enregistre.' }).catch(() => {});
      // Les messages lus ici ne seront pas rejoués par l'assistant.
      await this.appel(l.token, 'getUpdates', { offset: l.offset, timeout: 0 }).catch(() => {});
      return { ok: true, chat: l.chat };
    }
    return { attente: true };
  }

  /** À l'enregistrement : la preuve correspond-elle au jeton et à la discussion posés ? */
  confirmer(preuve, service, actor) {
    const l = this.liaisons.get(String(preuve || ''));
    if (!l?.chat) return false;
    const cle = suffixe => this.secrets.list().find(x => x.service === service)?.champs.find(c => c.key.endsWith(suffixe) && c.rempli)?.key;
    const token = cle('_BOT_TOKEN') && this.secrets.valeur(cle('_BOT_TOKEN'));
    const chat = cle('_CHAT_ID') && String(this.secrets.valeur(cle('_CHAT_ID')) || '');
    if (token !== l.token || chat !== l.chat.id) return false;
    this.liaisons.delete(String(preuve));
    const v = { ...this.verifies() };
    v[service] = { chat: l.chat.id, jeton: empreinte(token), quand: Date.now() };
    this.db.setSetting('telegram_verifies', v);
    this.audit.write(actor, 'telegram.relié', service, { bot: l.bot, discussion: l.chat.type });
    return true;
  }

  verifies() { return this.db.setting('telegram_verifies', {}) || {}; }

  /** Ce compte a-t-il été relié, avec ce jeton et cette discussion-là ? */
  estVerifie(service) {
    const v = this.verifies()[service];
    if (!v) return false;
    const cle = suffixe => this.secrets.list().find(x => x.service === service)?.champs.find(c => c.key.endsWith(suffixe) && c.rempli)?.key;
    const token = cle('_BOT_TOKEN') && this.secrets.valeur(cle('_BOT_TOKEN'));
    const chat = cle('_CHAT_ID') && String(this.secrets.valeur(cle('_CHAT_ID')) || '');
    return !!token && empreinte(token) === v.jeton && chat === v.chat;
  }
}
