// Disposition du menu : la valeur du service (SOCLE_DISPOSITION), la page
// rendue avec elle et le choix de la personne posé avant tout rendu, les
// quatre positions dans chaque gamme, et le choix côté navigateur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lireConfig } from '../src/config.js';
import { SPEC_SOCLE, DISPOSITIONS, avecDisposition, definirDisposition } from '../src/index.js';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

test('SOCLE_DISPOSITION : à gauche par défaut, haut, bas et droite admises, toute autre valeur arrête le démarrage', () => {
  assert.deepEqual(DISPOSITIONS, ['gauche', 'haut', 'bas', 'droite']);
  assert.equal(lireConfig(SPEC_SOCLE, {}).disposition, 'gauche');
  assert.equal(lireConfig(SPEC_SOCLE, { SOCLE_DISPOSITION: '' }).disposition, 'gauche');
  for (const d of DISPOSITIONS) assert.equal(lireConfig(SPEC_SOCLE, { SOCLE_DISPOSITION: d }).disposition, d);
  assert.throws(() => lireConfig(SPEC_SOCLE, { SOCLE_DISPOSITION: 'milieu' }), /SOCLE_DISPOSITION/);
});

test('la page porte la disposition du service ; le choix de la personne est lu avant le premier rendu', () => {
  const page = '<!doctype html><html lang="fr" data-gamme="soma"><head><meta charset="utf-8"></head><body></body></html>';
  const r = avecDisposition(page, { disposition: 'haut', nonce: 'Abc123+/=' });
  assert.match(r, /<html lang="fr" data-gamme="soma" data-disposition="haut" data-disposition-defaut="haut">/);
  assert.match(r, /<head><script nonce="Abc123\+\/=">try\{var d=localStorage\.getItem\('socle\.disposition'\);if\(\/\^\(gauche\|haut\|bas\|droite\)\$\/\.test\(d\)\)/);
  assert.equal((r.match(/<script/g) || []).length, 1);
  // Valeur inconnue ou tentative d'injection : à gauche.
  assert.match(avecDisposition(page, { disposition: '"><script>' }), /data-disposition="gauche"/);
  // Sans nonce valable, aucun script n'est ajouté (la page reste conforme à sa CSP).
  assert.doesNotMatch(avecDisposition(page, { disposition: 'bas' }), /<script/);
  assert.doesNotMatch(avecDisposition(page, { disposition: 'bas', nonce: 'a"b' }), /<script/);
  // Une page qui pose déjà sa disposition la garde ; __DISPOSITION__ est remplacé.
  assert.match(avecDisposition('<html data-disposition="__DISPOSITION__"><head></head></html>', { disposition: 'droite' }), /^<html data-disposition="droite"><head><\/head><\/html>$/);
  // La valeur du service, posée au démarrage du socle, sert par défaut.
  definirDisposition('bas');
  assert.match(avecDisposition(page), /data-disposition="bas"/);
  definirDisposition('nimporte');
  assert.match(avecDisposition(page), /data-disposition="gauche"/);
});

test('les quatre positions dans chaque gamme : barre en haut ou en bas, rail à droite, tiroir à droite sur téléphone', () => {
  const css = fs.readFileSync(path.join(WEB, 'soma.css'), 'utf8');
  assert.match(css, /html\[data-disposition="droite"\] nav\.rail\{order:9\}/);
  assert.match(css, /html\[data-disposition="haut"\] :has\(>nav\.rail\)\{grid-template-rows:auto minmax\(0,1fr\)\}/);
  assert.match(css, /html\[data-disposition="bas"\] :has\(>nav\.rail\)\{grid-template-rows:minmax\(0,1fr\) auto\}/);
  assert.match(css, /html\[data-gamme="lavande"\]\[data-disposition="haut"\] nav\.rail \.nav\.on::before/);
  assert.match(css, /html\[data-gamme="lavande"\]\[data-disposition="bas"\] nav\.rail \.nav\.on::before/);
  assert.match(css, /html\[data-gamme="lavande"\]\[data-disposition="droite"\] nav\.rail \.nav\.on::before/);
  assert.match(css, /html\[data-disposition="haut"\]:is\(\[data-gamme="console"\],\[data-gamme="exploitation"\]\) nav\.rail\{border-right:0;border-bottom/);
  assert.match(css, /html\[data-disposition="droite"\] nav\.rail\{left:auto;right:0;transform:translateX\(100%\)\}/);
  assert.match(css, /\.top \.menu,html:is\(\[data-disposition="haut"\],\[data-disposition="bas"\]\) \.voile-rail\{display:none!important\}/);
  // Les aperçus de la page Thème (i.rail) ne sont jamais pris pour le menu.
  const bloc = css.slice(css.indexOf('/* Disposition du menu'), css.indexOf('/* Le bouton de la barre du haut'));
  assert.deepEqual(bloc.split('\n').filter(l => /(^|[\s,(>])\.rail(?![\w-])/.test(l)), []);
});

test('navigateur : choix gardé par application, « par défaut » rend celle du service, valeur inconnue ignorée', async () => {
  const attrs = { 'data-disposition-defaut': 'haut', 'data-disposition': 'haut' };
  const stock = new Map();
  globalThis.document = { documentElement: { getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = String(v); } }, querySelector: () => null, addEventListener() {} };
  globalThis.localStorage = { getItem: k => stock.get(k) ?? null, setItem: (k, v) => stock.set(k, String(v)), removeItem: k => stock.delete(k) };
  globalThis.addEventListener = () => {};
  try {
    const m = await import('../web/disposition.js');
    m.installerDisposition();
    assert.equal(m.dispositionActuelle(), 'haut');
    const vus = [];
    m.surDisposition(d => vus.push(d));
    m.choisirDisposition('droite');
    assert.equal(attrs['data-disposition'], 'droite');
    assert.equal(stock.get('socle.disposition'), 'droite');
    assert.equal(m.choixPersonnel(), 'droite');
    m.choisirDisposition(null);
    assert.equal(attrs['data-disposition'], 'haut', 'retour à celle du service');
    assert.equal(stock.has('socle.disposition'), false);
    stock.set('socle.disposition', 'milieu');
    m.installerDisposition();
    assert.equal(attrs['data-disposition'], 'haut', 'une valeur gardée inconnue est ignorée');
    assert.deepEqual(vus, ['droite', 'haut', 'haut']);
  } finally { delete globalThis.document; delete globalThis.localStorage; delete globalThis.addEventListener; }
});
