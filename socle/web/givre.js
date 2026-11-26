// Décor « givre » de la porte d'entrée : deux mains de 55 000 points qui
// cherchent à se toucher, derrière une vitre dépolie (la carte), sur un fond
// de givre qui coule. Les mains s'écartent sous le pointeur, se dispersent au
// clic, et se touchent quand la connexion aboutit.
//
// Rien de bloquant : sans WebGL, le décor ne se pose pas et la porte garde son
// fond ordinaire ; les points se chargent à part (givre-mains.json), le fond
// s'anime en attendant. Mouvement réduit : mains posées, fond figé.

const GX = 1075, GY = 677;      // point de contact des deux index, dans le repère des données
const SHX = 31, SHY = 16;       // trajet de chaque main quand elles se touchent
const BGK = 0.42;               // le fond est calculé en basse résolution, agrandi par le navigateur

// Deux palettes : givre de jour, givre de nuit. Le fond (blanc, glace, lavande, eau, courbes, halo), puis les mains, puis les cristaux.
const PALETTES = {
  jour: { fond: [[.988, .994, 1], [.82, .915, .98], [.885, .885, .985], [.84, .955, .97], [.70, .84, .95], [.80, .93, .985]],
    encre: [22 / 255, 38 / 255, 58 / 255], accent: [36 / 255, 170 / 255, 214 / 255], cristal: [.42, .64, .82] },
  nuit: { fond: [[.047, .078, .118], [.071, .149, .224], [.098, .114, .231], [.055, .165, .196], [.165, .337, .463], [.11, .24, .33]],
    encre: [.80, .89, .96], accent: [.30, .78, .93], cristal: [.55, .75, .92] },
};

const sombre = () => {
  const d = document.documentElement.dataset;
  return d.theme ? d.theme === 'dark' : d.gamme === 'console' || matchMedia('(prefers-color-scheme: dark)').matches;
};

function programme(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const U = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i).name; U[nm] = gl.getUniformLocation(p, nm); }
  return { p, U };
}
const HP = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

const FS_FOND = HP + `
uniform vec2 uRes,uM;uniform float uT;uniform vec3 c0,c1,c2,c3,c4,c5;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+1.),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;vec2 p=vec2(uv.x*uRes.x/uRes.y,uv.y)*1.6;float t=uT*.03;
  vec2 q=vec2(fbm(p+vec2(0.,t)),fbm(p+vec2(5.2,1.3)-t));
  vec2 r=vec2(fbm(p+2.*q+vec2(1.7,9.2)+t*.7),fbm(p+2.*q+vec2(8.3,2.8)-t*.5));
  float f=fbm(p+2.2*r);
  vec3 c=mix(c0,c1,smoothstep(.38,.82,f));
  c=mix(c,c2,smoothstep(.42,.88,r.x)*.75);
  c=mix(c,c3,smoothstep(.5,.95,q.y)*.55);
  float iso=abs(fract(f*8.-uT*.05)-.5);
  c=mix(c,c4,(1.-smoothstep(.0,.05,iso))*.48*smoothstep(.28,.72,f));
  float m=length((gl_FragCoord.xy-uM)/uRes.y);
  c=mix(c,c5,exp(-m*m*22.)*.45);
  float v=length((uv-vec2(.5,.42))*vec2(uRes.x/uRes.y,1.));
  c=mix(c,c0,(1.-smoothstep(.05,.7,v))*.22);
  gl_FragColor=vec4(c,1.);
}`;
const VS_MAINS = `
attribute vec3 aP;attribute float aS;uniform vec2 uRes,uOff;uniform float uSc;
varying float vE,vR,vA,vPs;
void main(){
  vec2 px=aP.xy*uSc+uOff;
  gl_Position=vec4(px/uRes*2.-1.,0.,1.);gl_Position.y=-gl_Position.y;
  float r=min(aS*uSc,1.3);vA=1.;
  if(r<.6){vA=r*r/.36;r=.6;}
  vR=r;vPs=2.*r+2.;gl_PointSize=vPs;vE=aP.z;
}`;
const FS_MAINS = `precision mediump float;
varying float vE,vR,vA,vPs;uniform vec3 uInk,uAcc;
void main(){
  float d=length(gl_PointCoord-.5)*vPs,a=clamp(vR+.5-d,0.,1.)*vA;
  if(a<.004)discard;
  gl_FragColor=vec4(mix(uInk,uAcc,vE)*a,a);
}`;
const VS_CRISTAUX = `
attribute vec4 aSeed;uniform vec2 uRes,uM;uniform float uT,uDpr;
varying float vA,vRot,vPs;
void main(){
  float sp=(5.+aSeed.z*13.)*uDpr;
  float y=mod(aSeed.y*(uRes.y+40.*uDpr)+uT*sp,uRes.y+40.*uDpr)-20.*uDpr;
  float x=aSeed.x*uRes.x+sin(uT*.4+aSeed.w*6.28)*18.*uDpr+uT*(aSeed.w-.5)*6.*uDpr;
  x=mod(x+20.*uDpr,uRes.x+40.*uDpr)-20.*uDpr;
  vec2 p=vec2(x,y),d=p-uM;float l=length(d),R=95.*uDpr;
  if(l<R){float k=1.-l/R;p+=d/(l+.1)*k*k*40.*uDpr;}
  gl_Position=vec4(p/uRes*2.-1.,0.,1.);gl_Position.y=-gl_Position.y;
  vPs=(2.*(1.8+aSeed.z*3.8)+3.)*uDpr;gl_PointSize=vPs;
  vA=.3+.34*(.5+.5*sin(uT*(.6+aSeed.w*1.4)+aSeed.x*30.));
  vRot=aSeed.y*6.28+uT*(aSeed.z-.5)*.5;
}`;
const FS_CRISTAUX = `precision mediump float;
varying float vA,vRot,vPs;uniform vec3 uCol;
void main(){
  vec2 p=gl_PointCoord-.5;float L=length(p),a=0.;
  for(int i=0;i<3;i++){float an=vRot+float(i)*1.0472;a=max(a,1.-smoothstep(.35,.9,abs(dot(p,vec2(-sin(an),cos(an))))*vPs));}
  a*=1.-smoothstep(.34,.46,L);
  a=max(a,(1.-smoothstep(.05,.12,L))*.9);
  a*=vA;
  gl_FragColor=vec4(uCol*a,a);
}`;

/**
 * Pose le décor dans la porte. carte : l'élément qui reste lisible devant les
 * mains (la boîte de l'écran courant). Renvoie null sans WebGL.
 */
export function poserGivre(porte, carte, { donnees = '/socle/givre-mains.json' } = {}) {
  const fondCv = document.createElement('canvas'), mainsCv = document.createElement('canvas'), eclat = document.createElement('div');
  fondCv.className = 'givre-fond'; mainsCv.className = 'givre-mains'; eclat.className = 'givre-eclat';
  for (const x of [fondCv, mainsCv, eclat]) x.setAttribute('aria-hidden', 'true');
  const fond = fondCv.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
  const gl = mainsCv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!fond || !gl) return null;
  let FOND, MAINS, CRISTAUX;
  try {
    FOND = programme(fond, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}', FS_FOND);
    MAINS = programme(gl, VS_MAINS, FS_MAINS);
    CRISTAUX = programme(gl, VS_CRISTAUX, FS_CRISTAUX);
  } catch { return null; }
  porte.prepend(fondCv, mainsCv, eclat);
  porte.classList.add('givre');

  const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;
  { const b = fond.createBuffer(); fond.bindBuffer(fond.ARRAY_BUFFER, b); fond.bufferData(fond.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), fond.STATIC_DRAW);
    const a = fond.getAttribLocation(FOND.p, 'a'); fond.enableVertexAttribArray(a); fond.vertexAttribPointer(a, 2, fond.FLOAT, false, 0, 0); }

  // Les points arrivent à part : jusque-là, fond et cristaux seulement.
  let N = 0, IW = 2172, IH = 1448, P, S, hx, hy, bx, by, cote, vx, vy, dl;
  const bufP = gl.createBuffer(), bufS = gl.createBuffer(), bufF = gl.createBuffer();
  const NF = reduit ? 24 : Math.round(Math.min(80, innerWidth * innerHeight / 18000)), F = new Float32Array(NF * 4);
  for (let i = 0; i < F.length; i++) F[i] = Math.random();
  gl.bindBuffer(gl.ARRAY_BUFFER, bufF); gl.bufferData(gl.ARRAY_BUFFER, F, gl.STATIC_DRAW);
  const aP = gl.getAttribLocation(MAINS.p, 'aP'), aS = gl.getAttribLocation(MAINS.p, 'aS'), aF = gl.getAttribLocation(CRISTAUX.p, 'aSeed');
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);
  let image = 0, eveil = 400, sale = true, arrete = false;

  fetch(donnees).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).then(d => {
    if (arrete || !(d?.n > 0)) return;
    IW = d.w; IH = d.h; N = d.n;
    P = new Float32Array(N * 3); S = new Float32Array(N);
    hx = new Float32Array(N); hy = new Float32Array(N); bx = new Float32Array(N); by = new Float32Array(N); cote = new Int8Array(N);
    vx = new Float32Array(N); vy = new Float32Array(N); dl = new Float32Array(N);
    const b = atob(d.xy), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    const xy = new Uint16Array(u.buffer), s = atob(d.s);
    for (let i = 0; i < N; i++) {
      bx[i] = hx[i] = xy[2 * i] / 8; by[i] = hy[i] = xy[2 * i + 1] / 8; cote[i] = bx[i] < GX ? 1 : -1;
      const eb = Math.min(bx[i], IW - bx[i], by[i], IH - by[i]), fe = Math.min(1, eb / 70);
      S[i] = (0.42 + 0.95 * s.charCodeAt(i) / 255) * 1.45 * (fe * fe * (3 - 2 * fe));
      if (reduit) { P[3 * i] = hx[i]; P[3 * i + 1] = hy[i]; }
      else { const a = Math.random() * 6.283, r = (0.6 + Math.random() * 0.9) * IW; P[3 * i] = GX + Math.cos(a) * r; P[3 * i + 1] = GY + Math.sin(a) * r * 0.6; }
      dl[i] = Math.hypot(hx[i] - GX, hy[i] - GY) / IW * 90 + Math.random() * 25;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufP); gl.bufferData(gl.ARRAY_BUFFER, P, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufS); gl.bufferData(gl.ARRAY_BUFFER, S, gl.STATIC_DRAW);
    image = 0; eveil = 400;
  }).catch(() => { /* sans les points, le givre seul */ });

  // Cadrage : l'espace entre les index au tiers haut, la carte en dessous.
  let W = 0, H = 0, dpr = 1, sc = 1, ox = 0, oy = 0;
  function cadrer() {
    const cw = innerWidth, ch = innerHeight, mob = cw < 640;
    const s = mob ? cw * 1.75 / IW : Math.min(cw * 1.04 / IW, ch * 0.92 / (1167 - 354));
    const gy = mob ? Math.max(110, ch * 0.2) : Math.max(150, ch * 0.29);
    const h = carte.offsetHeight || 470;
    const haut = Math.max(16, Math.min(gy + (mob ? 70 : Math.max(60, s * 110)), ch - h - 44));
    porte.style.setProperty('--givre-haut', `${Math.round(haut)}px`);
    return { s, gx: cw / 2, gy };
  }
  function redimensionner() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = mainsCv.width = Math.round(innerWidth * dpr); H = mainsCv.height = Math.round(innerHeight * dpr); gl.viewport(0, 0, W, H);
    fondCv.width = Math.max(2, Math.round(innerWidth * BGK)); fondCv.height = Math.max(2, Math.round(innerHeight * BGK)); fond.viewport(0, 0, fondCv.width, fondCv.height);
    const L = cadrer(); sc = L.s * dpr; ox = L.gx * dpr - GX * sc; oy = L.gy * dpr - GY * sc;
    eclat.style.left = `${L.gx}px`; eclat.style.top = `${L.gy}px`;
  }
  const suivi = new ResizeObserver(() => cadrer());
  suivi.observe(carte);

  // Pointeur : les mains s'écartent, sauf au-dessus de la carte.
  let mx = -1e9, my = -1e9, pmx = 0, pmy = 0, mvx = 0, mvy = 0, actif = false, dernier = 0, ms = 0, sx = -1e4, sy = -1e4, smx = -1e4, smy = -1e4;
  const versDonnees = e => [(e.clientX * dpr - ox) / sc, (e.clientY * dpr - oy) / sc];
  const bouge = e => {
    sx = e.clientX; sy = e.clientY;
    if (carte.contains(e.target)) { actif = false; return; }
    const [a, b] = versDonnees(e); if (!actif) { pmx = a; pmy = b; } mx = a; my = b; actif = true; dernier = performance.now(); eveil = Math.max(eveil, 90);
  };
  const sort = () => { actif = false; sx = sy = -1e4; };
  addEventListener('pointermove', bouge, { passive: true });
  document.addEventListener('pointerleave', sort);
  addEventListener('resize', redimensionner);
  mainsCv.addEventListener('pointerdown', e => { const [a, b] = versDonnees(e); mx = a; my = b; pmx = a; pmy = b; actif = true; dernier = performance.now(); });
  mainsCv.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') actif = false; });
  mainsCv.addEventListener('click', e => { const [a, b] = versDonnees(e); disperser(a, b, 0.9); });
  function disperser(cx, cy, k) {
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      const dx = P[j] - cx, dy = P[j + 1] - cy, d = Math.hypot(dx, dy) + 1, f = k * (30 + Math.random() * 50) * Math.exp(-d / (IW * 0.45));
      vx[i] += dx / d * f; vy[i] += dy / d * f; P[j + 2] = 1;
    }
    eveil = 400;
  }

  // Contact des deux mains.
  let contact = 0, contactVise = 0, onde = -1;
  function pas() {
    image++;
    const Rc = Math.max(55, Math.min(130, innerWidth * 0.085)), R = Rc * dpr / sc, R2 = R * R, Fo = R * 0.05;
    if (actif) { mvx = mvx * 0.6 + (mx - pmx) * 0.4; mvy = mvy * 0.6 + (my - pmy) * 0.4; pmx = mx; pmy = my; } else { mvx *= 0.8; mvy *= 0.8; }
    const repos = performance.now() - dernier, vise = actif ? Math.max(0, Math.min(1, 1 - (repos - 700) / 1200)) : 0; ms += (vise - ms) * 0.12;
    if (Math.abs(contactVise - contact) > 0.001) {
      const d = contactVise - contact; contact += Math.sign(d) * Math.min(Math.abs(d), 0.012 + Math.abs(d) * 0.03);
      const e = contact * contact * (3 - 2 * contact);
      for (let i = 0; i < N; i++) { hx[i] = bx[i] + cote[i] * SHX * e; hy[i] = by[i] + cote[i] * SHY * e; }
      if (contactVise === 1 && contact > 0.985 && onde < 0) { onde = 0; eclat.classList.remove('go'); void eclat.offsetWidth; eclat.classList.add('go'); }
      eveil = Math.max(eveil, 30);
    }
    const rr = onde >= 0 ? onde * 13 : -1; if (onde >= 0 && ++onde > 110) onde = -1;
    const intro = !reduit && image < 230, pousse = ms > 0.01;
    let maxv = 0;
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      const X = P[j], Y = P[j + 1]; let VX = vx[i], VY = vy[i];
      if (pousse) {
        const dx = X - mx, dy = Y - my, d2 = dx * dx + dy * dy;
        if (d2 < R2) { const d = Math.sqrt(d2) + 0.01, f = 1 - d / R, ff = f * f * Fo * ms; VX += dx / d * ff + mvx * f * 0.2; VY += dy / d * ff + mvy * f * 0.2; }
      }
      if (rr > 0) {
        const dx = X - GX, dy = Y - GY, d = Math.sqrt(dx * dx + dy * dy) + 0.01, w = 1 - Math.abs(d - rr) / 38;
        if (w > 0) { const k = w * 1.6 * (1 - rr / 1500); VX += dx / d * k; VY += dy / d * k; if (w > P[j + 2]) P[j + 2] = w; }
      }
      let k = 0.016;
      if (intro && image < dl[i] + 60) k *= image < dl[i] ? 0.004 : (image - dl[i]) / 60;
      VX = (VX + (hx[i] - X) * k) * 0.87; VY = (VY + (hy[i] - Y) * k) * 0.87;
      P[j] = X + VX; P[j + 1] = Y + VY; vx[i] = VX; vy[i] = VY;
      const sp = (VX < 0 ? -VX : VX) + (VY < 0 ? -VY : VY); if (sp > maxv) maxv = sp;
      const e = P[j + 2] * 0.94, es = sp / 3; P[j + 2] = es > e ? (es > 1 ? 1 : es) : e;
    }
    if (pousse || onde >= 0) eveil = Math.max(eveil, 2);
    if (maxv > 0.03) eveil = Math.max(eveil, 20);
  }

  let pal = PALETTES.jour, nuit = null;
  function peindre(t) {
    if (image % 30 === 0 || nuit === null) { const n = sombre(); if (n !== nuit) { nuit = n; pal = n ? PALETTES.nuit : PALETTES.jour; porte.classList.toggle('nuit', n); } }
    fond.useProgram(FOND.p);
    fond.uniform2f(FOND.U.uRes, fondCv.width, fondCv.height); fond.uniform1f(FOND.U.uT, t);
    pal.fond.forEach((c, i) => fond.uniform3fv(FOND.U[`c${i}`], c));
    smx += (sx - smx) * 0.08; smy += (sy - smy) * 0.08;
    fond.uniform2f(FOND.U.uM, smx * BGK, (innerHeight - smy) * BGK);
    fond.drawArrays(fond.TRIANGLES, 0, 3);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (N) {
      gl.useProgram(MAINS.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
      if (sale) { gl.bufferSubData(gl.ARRAY_BUFFER, 0, P); sale = false; }
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufS); gl.enableVertexAttribArray(aS); gl.vertexAttribPointer(aS, 1, gl.FLOAT, false, 0, 0);
      gl.uniform2f(MAINS.U.uRes, W, H); gl.uniform2f(MAINS.U.uOff, ox, oy); gl.uniform1f(MAINS.U.uSc, sc);
      gl.uniform3fv(MAINS.U.uInk, pal.encre); gl.uniform3fv(MAINS.U.uAcc, pal.accent);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aS);
    }
    gl.useProgram(CRISTAUX.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufF); gl.enableVertexAttribArray(aF); gl.vertexAttribPointer(aF, 4, gl.FLOAT, false, 0, 0);
    gl.uniform2f(CRISTAUX.U.uRes, W, H); gl.uniform2f(CRISTAUX.U.uM, sx * dpr, sy * dpr); gl.uniform1f(CRISTAUX.U.uT, t); gl.uniform1f(CRISTAUX.U.uDpr, dpr);
    gl.uniform3fv(CRISTAUX.U.uCol, pal.cristal);
    gl.drawArrays(gl.POINTS, 0, NF);
    gl.disableVertexAttribArray(aF);
  }
  function boucle(now) {
    if (arrete) return;
    if (N && (eveil > 0 || actif)) { pas(); eveil--; sale = true; }
    else image++;
    peindre(reduit ? 0 : now / 1000);
    requestAnimationFrame(boucle);
  }
  redimensionner();
  requestAnimationFrame(boucle);

  return {
    /** Les deux mains se touchent (connexion aboutie), ou se séparent. */
    toucher(oui = true) { contactVise = oui ? 1 : 0; eveil = 500; },
    arreter() {
      arrete = true; suivi.disconnect();
      removeEventListener('pointermove', bouge); document.removeEventListener('pointerleave', sort); removeEventListener('resize', redimensionner);
      fond.getExtension('WEBGL_lose_context')?.loseContext(); gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
