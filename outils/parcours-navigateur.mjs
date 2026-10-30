// Parcours réel du Hub dans Chromium (clé d'accès virtuelle) : installation
// par la porte du socle, chaque page et les principaux dialogues, contrôle de
// mise en page à chaque largeur. Contre la vitrine (outils/vitrine.mjs) :
//   node outils/parcours-navigateur.mjs http://localhost:8190 JETON DOSSIER
import { chromium } from 'playwright';
import fs from 'node:fs';
import { chevauchements, LARGEURS } from '../socle/essai/mise-en-page.mjs';
import { passerAssistant, ouvrirReglagesService } from '../socle/essai/assistant-navigateur.mjs';

const [base, jeton, sortie = '/tmp/captures-hub'] = process.argv.slice(2);
fs.mkdirSync(sortie, { recursive: true });
const navigateur = await chromium.launch();
const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 860 } });
const page = await contexte.newPage();
const erreurs = [];
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource.*(404|401)/.test(m.text())) erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push(String(e)));
// Une requête refusée par le serveur (schéma, droits) : l'adresse, pour savoir laquelle.
page.on('response', r => { if (r.status() === 400 || r.status() === 403 || r.status() >= 500) erreurs.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} ${r.request().postData() || ''}`.slice(0, 300)); });
const cdp = await contexte.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

const rapport = [];
async function controle(nom, { attendre = 250, avant } = {}) {
  for (const w of LARGEURS) {
    await page.setViewportSize({ width: w, height: w < 500 ? 780 : 900 });
    await page.waitForTimeout(attendre);
    if (avant) { await page.evaluate(avant); await page.waitForTimeout(100); }
    rapport.push({ ecran: nom, largeur: w, defauts: await page.evaluate(chevauchements) });
    if ([360, 768, 1280, 1920].includes(w)) await page.screenshot({ path: `${sortie}/${nom}-${w}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(150);
}
const aller = async (cle, titre) => {
  await page.locator(`[data-go="${cle}"]`).click();
  await page.getByRole('heading', { name: titre, exact: true }).first().waitFor();
  await page.waitForTimeout(300);
};
const dialogue = () => page.getByRole('dialog').last();
const fermer = async () => { await dialogue().getByRole('button', { name: 'Fermer' }).first().click(); await page.waitForTimeout(200); };

await page.goto(base);
await page.getByText('Premier compte').waitFor();
await controle('installation');
await page.getByLabel('Jeton d’installation').fill(jeton);
await page.getByLabel('Identifiant').fill('ana');
await page.getByLabel('Mot de passe').fill('phrase de passe pour le hub de la vitrine');
await page.getByRole('button', { name: 'Créer le compte' }).click();
await page.getByRole('button', { name: /Créer la clé maintenant/ }).click();
await page.getByText('J’ai rangé ces codes en lieu sûr.').click();
await page.getByRole('button', { name: 'Terminer' }).click();
await passerAssistant(page, { controle });
await page.locator('#appFrame').waitFor();
await page.getByRole('heading', { name: 'Vue d’ensemble' }).waitFor();
await page.waitForTimeout(600);
await controle('vue-ensemble');

await aller('ext', 'Extensions');
await controle('extensions-services');
await page.locator('[data-tab="catalog"]').click();
await page.waitForTimeout(300);
await controle('extensions-catalogue');
await page.locator('[data-add="vox"][data-mode="remote"]').click();
await dialogue().waitFor();
await controle('dialogue-connecter');
await dialogue().getByRole('button', { name: 'Annuler' }).click();
await page.locator('[data-tab="installed"]').click();
await page.locator('[data-inst]').first().waitFor();
await controle('extensions-installes');
await page.locator('[data-inst]').first().click();
await dialogue().waitFor();
await page.waitForTimeout(400);
await controle('dialogue-service');
await fermer();
await page.locator('[data-tab="sources"]').click();
await page.waitForTimeout(300);
await controle('extensions-registres');

await aller('wf', 'Workflows');
await controle('workflows');
// Étroit : les actions secondaires passent dans une feuille, la navigation dans un tiroir.
await page.setViewportSize({ width: 360, height: 780 });
await page.waitForTimeout(250);
await page.locator('#plusWf').click();
await dialogue().waitFor();
await page.waitForTimeout(300);
rapport.push({ ecran: 'feuille-workflows', largeur: 360, defauts: await page.evaluate(chevauchements) });
await page.screenshot({ path: `${sortie}/feuille-workflows-360.png` });
await page.keyboard.press('Escape');
await page.locator('.top .menu').click();
await page.waitForTimeout(400);
rapport.push({ ecran: 'tiroir', largeur: 360, defauts: await page.evaluate(chevauchements) });
await page.screenshot({ path: `${sortie}/tiroir-360.png` });
await page.locator('.voile-rail').click({ position: { x: 340, y: 400 } });
await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(250);
await page.locator('[data-open]').first().click();
await page.locator('#edbody').waitFor();
await page.waitForTimeout(600);
await controle('editeur');
await page.locator('.nd').first().click();
await page.waitForTimeout(300);
await controle('editeur-noeud');
await page.locator('#eBack').click();
await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();
// Un webhook : l'adresse, puis un secret neuf montré une seule fois.
await page.locator('[data-open]', { hasText: 'Formulaire de contact' }).first().click();
await page.locator('#edbody').waitFor();
await page.locator('.nd', { hasText: 'Formulaire reçu' }).first().click();
await page.locator('#hookSecret').click();
await dialogue().getByRole('button', { name: 'Remplacer' }).click();
await page.getByText('Copie-le maintenant').waitFor();
await controle('editeur-webhook');
await page.locator('#eBack').click();
await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();

await aller('probes', 'Sondes');
await controle('sondes');
await aller('liens', 'Liens');
await controle('liens');
await aller('conn', 'Connexions');
await controle('connexions');
await page.locator('[data-route="r_hyperv0000"]').click();
await dialogue().getByText('https://192.0.2.30:8006').waitFor();
await controle('connexions-actions-route');
await dialogue().getByRole('button', { name: 'Modifier' }).click();
await page.getByRole('dialog').getByText('Modifier hyperviseur-de-la-salle-serveur.home.arpa').waitFor();
await controle('connexions-modifier-route');
await fermer();
await page.locator('#cnNouvelle').click();
await controle('connexions-nouvelle-route');
await fermer();
await page.locator('[data-publier]').first().click();
await controle('connexions-publier');
await fermer();
// Un domaine ajouté, long, pour voir la liste et le menu des routes.
await page.locator('#domNeuf').fill('un-domaine-assez-long-pour-voir.example.org');
await page.locator('#domAjouter').click();
await page.getByText('un-domaine-assez-long-pour-voir.example.org', { exact: true }).waitFor();
await controle('connexions-domaines');
await page.locator('#cfConnecter').click();
await controle('connexions-cloudflare');
await page.locator('#cfJeton').fill('jeton-cloudflare-de-la-vitrine-0123456789');
await dialogue().getByRole('button', { name: 'Connecter' }).click();
await page.locator('[data-dom-ajouter="example.org"]').waitFor();
await page.locator('[data-dom-ajouter="example.org"]').click();
await page.getByText('Cloudflare : rien à installer sur les appareils').first().waitFor();
await controle('connexions-domaines-cloudflare');
await page.locator('#cnNouvelle').click();
await dialogue().locator('.saisie-domaine .csel-btn').click();
await page.locator('.csel-opt', { hasText: 'un-domaine-assez-long-pour-voir.example.org' }).click();
await dialogue().locator('.saisie-domaine .csel-btn', { hasText: 'un-domaine-assez-long' }).waitFor();
await controle('connexions-nouvelle-route-domaine');
await fermer();
await page.locator('#cnHubPublier').click();
await controle('connexions-publier-hub');
await fermer();
await aller('users', 'Comptes des services');
await controle('comptes-services');
// Les comptes d'un service du socle : fiche par compte, e-mail, clé d'accès, gestes.
await page.locator('[data-svc="vitrine-mapmylan"]').click();
await page.getByRole('dialog').getByText('Comptes de mapmylan').waitFor({ timeout: 8000 }).catch(async () => {
  // Renfort demandé : la vitrine le passe avec le mot de passe du compte d'essai.
  const champ = page.getByRole('dialog').locator('input[type=password]');
  if (await champ.count()) { await champ.fill(process.env.MDP_PARCOURS || ''); await page.getByRole('dialog').getByRole('button', { name: /Confirmer|Valider/ }).click(); }
  await page.getByRole('dialog').getByText('Comptes de mapmylan').waitFor({ timeout: 8000 });
});
// Une carte par compte, la carte « + » en dernier ; la fiche s'ouvre dans la même fenêtre.
await page.locator('.compte-carte').first().waitFor();
await page.waitForTimeout(300);
await controle('comptes-service-cartes');
await page.locator('.compte-carte.ajout').click();
await page.locator('#nuName').waitFor();
await controle('comptes-service-nouveau');
await page.locator('[data-vue="grille"]').click();
await page.locator('.compte-carte[data-ouvrir]').first().click();
await page.locator('.compte-fiche').waitFor();
await page.waitForTimeout(300);
await controle('comptes-service-fiches');
// Le lien de réinitialisation, et le même par l'adresse directe.
await page.getByRole('dialog').locator('[data-reinit]').first().click();
await page.locator('#lienAutre').waitFor();
await controle('lien-reinitialisation');
await dialogue().getByRole('button', { name: 'Fermer', exact: true }).last().click();
await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).last().click();
await aller('secrets', 'Clés & API');
await controle('cles');
await page.locator('[data-svc="telegram"]').click();
await dialogue().waitFor();
await page.waitForTimeout(300);
await controle('fiche-cle');
await dialogue().getByRole('button', { name: 'Annuler' }).click();
await aller('journal', 'Journal');
await controle('journal');
await aller('theme', 'Thème');
await controle('theme-commun');
await page.locator('[data-onglet="service"]').click();
await page.waitForTimeout(200);
await controle('theme-par-service');
// Le Hub seul passe dans l'autre gamme : la page la prend sans recharger,
// MapMyLAN garde la sienne et ne redémarre donc pas.
const gamme = await page.evaluate(() => document.documentElement.dataset.gamme);
const autre = gamme === 'console' ? 'soma' : 'console';
await page.locator(`[data-cle="hub"][data-g="${autre}"]`).click();
await page.locator('#themeSave').click();
await page.getByText(/^Appliqué\./).waitFor();
if (await page.evaluate(() => document.documentElement.dataset.gamme) !== autre) erreurs.push('thème : le Hub n’a pas pris sa gamme');
await controle('theme-applique');
await page.locator('[data-cle="hub"][data-g=""]').click();
await page.locator('#themeSave').click();
await page.getByText(/^Appliqué\./).waitFor();
if (await page.evaluate(() => document.documentElement.dataset.gamme) !== gamme) erreurs.push('thème : retour à la gamme commune non appliqué');
await aller('settings', 'Réglages');
await controle('reglages');
await aller('ia', 'IA');
await controle('ia');
await page.locator('[data-edit]').first().click();
await dialogue().waitFor();
await page.waitForTimeout(500);
await controle('dialogue-ia');
await dialogue().getByRole('button', { name: 'Annuler' }).click();
await aller('securite', 'Sécurité');
await controle('securite');
await aller('comptes', 'Comptes');
await controle('comptes-hub');

await aller('dash', 'Vue d’ensemble');
await page.locator('[data-go="ai"]').click();
await page.locator('#aiPanel #aiIn').waitFor();
// Une question que le Hub sait traiter seul (des widgets), puis une qui part au modèle (du texte mis en page).
await page.locator('#aiIn').fill('état des services');
await page.locator('#aiForm button').click();
await page.locator('#aiPanel .wg').first().waitFor({ timeout: 15000 });
await page.locator('#aiIn:not([disabled])').waitFor();
await page.locator('#aiIn').fill('Explique-moi ce que font mes services, en détail');
await page.locator('#aiForm button').click();
await page.locator('#aiPanel .md-tab').waitFor({ timeout: 15000 });
await page.waitForTimeout(400);
await controle('assistant', { avant: () => { const m = document.querySelector('#msgs'); if (m) m.scrollTop = m.scrollHeight; } });

const defauts = rapport.filter(r => r.defauts.length);
fs.writeFileSync(`${sortie}/rapport.json`, JSON.stringify({ rapport, erreurs }, null, 2));
console.log(`écrans×largeurs contrôlés : ${rapport.length}, avec défauts : ${defauts.length}, erreurs console : ${erreurs.length}`);
for (const r of defauts) for (const d of r.defauts.slice(0, 4)) console.log(`  ${r.ecran} @${r.largeur} — ${d.type} : ${d.detail}`);
for (const e of erreurs) console.log('  console :', e);
await navigateur.close();
process.exit(defauts.length || erreurs.length ? 1 : 0);
