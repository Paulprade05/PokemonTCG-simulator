// scripts/generar-imagenes-pwa.mjs
//
// LAS IMÁGENES DE LA APP INSTALADA QUE SALEN DE OTRAS QUE YA ESTÁN.
//
// Genera, SIN dependencias (el zlib de Node y nada más):
//
//   · public/splash/splash-<tamaño>-claro.png, una por cada pantalla de arranque
//     oscura: la misma imagen con el fondo cambiado al --bg del tema claro. iOS
//     elige una u otra por `prefers-color-scheme` (app/layout.tsx,
//     STARTUP_IMAGES). El icono se conserva píxel a píxel; sólo se recompone su
//     borde suavizado, que es mezcla del icono con el fondo oscuro y dejaría un
//     cerco negro sobre el claro.
//   · public/icons/apple-touch-icon-v2.png (180×180): el icono de la pantalla de
//     inicio A SANGRE, sacado del recorte central del maskable de 512. iOS
//     recorta el icono con su propia forma; el anterior traía el cuadrado
//     redondeado dibujado dentro de un fondo oscuro y salía una ficha dentro de
//     otra.
//
// POR QUÉ ESTÁ EN EL REPOSITORIO: el día que salga un iPhone con otra
// resolución hay que añadir su arranque oscuro y su fila en STARTUP_IMAGES, y
// la variante clara se saca con esto en vez de a mano.
//
// NO PISA NADA: si el fichero de destino ya existe, se para y lo dice. Para
// rehacer uno, se retira antes a mano o se pasa --sobrescribir-lo-mio.
//
// Uso (desde la raíz del repositorio):  node scripts/generar-imagenes-pwa.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* ------------------------------ PNG ------------------------------ */
const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function leerPNG(fichero) {
  const b = fs.readFileSync(fichero);
  if (!b.subarray(0, 8).equals(FIRMA)) throw new Error("no es PNG: " + fichero);
  let pos = 8;
  let ihdr = null;
  const datos = [];
  while (pos < b.length) {
    const largo = b.readUInt32BE(pos);
    const tipo = b.toString("latin1", pos + 4, pos + 8);
    const cuerpo = b.subarray(pos + 8, pos + 8 + largo);
    if (tipo === "IHDR") ihdr = cuerpo;
    else if (tipo === "IDAT") datos.push(cuerpo);
    else if (tipo === "IEND") break;
    pos += 12 + largo;
  }
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[12] !== 0) throw new Error("solo 8 bits sin entrelazar");
  const canales = { 2: 3, 6: 4 }[ihdr[9]];
  if (!canales) throw new Error("tipo de color no soportado: " + ihdr[9]);
  const crudo = zlib.inflateSync(Buffer.concat(datos));
  const paso = w * canales;
  const px = Buffer.alloc(w * h * 4);
  let ant = Buffer.alloc(paso);
  for (let y = 0; y < h; y++) {
    const filtro = crudo[y * (paso + 1)];
    const fila = Buffer.from(crudo.subarray(y * (paso + 1) + 1, (y + 1) * (paso + 1)));
    for (let i = 0; i < paso; i++) {
      const a = i >= canales ? fila[i - canales] : 0;
      const bb = ant[i];
      const c = i >= canales ? ant[i - canales] : 0;
      let suma = 0;
      if (filtro === 1) suma = a;
      else if (filtro === 2) suma = bb;
      else if (filtro === 3) suma = (a + bb) >> 1;
      else if (filtro === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        suma = pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      } else if (filtro !== 0) throw new Error("filtro " + filtro);
      fila[i] = (fila[i] + suma) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = fila[x * canales];
      px[o + 1] = fila[x * canales + 1];
      px[o + 2] = fila[x * canales + 2];
      px[o + 3] = canales === 4 ? fila[x * canales + 3] : 255;
    }
    ant = fila;
  }
  return { w, h, px };
}

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function trozo(tipo, cuerpo) {
  const cab = Buffer.alloc(8);
  cab.writeUInt32BE(cuerpo.length, 0);
  cab.write(tipo, 4, "latin1");
  const fin = Buffer.alloc(4);
  fin.writeUInt32BE(crc(Buffer.concat([cab.subarray(4), cuerpo])), 0);
  return Buffer.concat([cab, cuerpo, fin]);
}

/** Escribe RGB opaco de 8 bits (sin canal alfa: ni el icono ni el arranque lo quieren). */
function escribirPNG(fichero, w, h, px) {
  const paso = w * 3;
  const crudo = Buffer.alloc((paso + 1) * h);
  let ant = Buffer.alloc(paso);
  const fila = Buffer.alloc(paso);
  const candidatos = [0, 1, 2, 4].map(() => Buffer.alloc(paso));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      fila[x * 3] = px[o];
      fila[x * 3 + 1] = px[o + 1];
      fila[x * 3 + 2] = px[o + 2];
    }
    // El filtro que deja la fila "mas plana" (heuristica de siempre: menor suma
    // de valores absolutos), entre ninguno, Sub, Up y Paeth.
    let mejor = 0, mejorCoste = Infinity;
    [0, 1, 2, 4].forEach((filtro, k) => {
      const out = candidatos[k];
      let coste = 0;
      for (let i = 0; i < paso; i++) {
        const a = i >= 3 ? fila[i - 3] : 0;
        const bb = ant[i];
        const c = i >= 3 ? ant[i - 3] : 0;
        let pred = 0;
        if (filtro === 1) pred = a;
        else if (filtro === 2) pred = bb;
        else if (filtro === 4) {
          const p = a + bb - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
        }
        const v = (fila[i] - pred) & 255;
        out[i] = v;
        coste += v < 128 ? v : 256 - v;
      }
      if (coste < mejorCoste) { mejorCoste = coste; mejor = k; }
    });
    crudo[y * (paso + 1)] = [0, 1, 2, 4][mejor];
    candidatos[mejor].copy(crudo, y * (paso + 1) + 1);
    ant = Buffer.from(fila);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    FIRMA,
    trozo("IHDR", ihdr),
    trozo("IDAT", zlib.deflateSync(crudo, { level: 9 })),
    trozo("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(fichero, png);
  return png.length;
}

/* ------------------------- arranque en claro ------------------------- */
const CLARO = [0xf4, 0xef, 0xe4]; // --bg del tema claro (app/globals.css)

function arranqueClaro(origen, destino) {
  const { w, h, px } = leerPNG(origen);
  const fondo = [px[0], px[1], px[2]];
  const esFondo = (i) => px[i * 4] === fondo[0] && px[i * 4 + 1] === fondo[1] && px[i * 4 + 2] === fondo[2];
  // 1. El fondo CONECTADO con el borde de la imagen. El dibujo de dentro del
  //    icono es casi del mismo color que el fondo, pero no esta conectado con
  //    el exterior: asi no se confunde con el.
  const fuera = new Uint8Array(w * h);
  const pila = [];
  const sembrar = (x, y) => {
    const i = y * w + x;
    if (!fuera[i] && esFondo(i)) { fuera[i] = 1; pila.push(i); }
  };
  for (let x = 0; x < w; x++) { sembrar(x, 0); sembrar(x, h - 1); }
  for (let y = 0; y < h; y++) { sembrar(0, y); sembrar(w - 1, y); }
  while (pila.length) {
    const i = pila.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) sembrar(x - 1, y);
    if (x < w - 1) sembrar(x + 1, y);
    if (y > 0) sembrar(x, y - 1);
    if (y < h - 1) sembrar(x, y + 1);
  }
  // 2. La caja del icono y su centro.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fuera[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error("sin icono: " + origen);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const salida = Buffer.from(px);
  let anillo = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    if (fuera[i]) { salida[o] = CLARO[0]; salida[o + 1] = CLARO[1]; salida[o + 2] = CLARO[2]; salida[o + 3] = 255; continue; }
    // 3. El anillo suavizado: pixeles del icono pegados al fondo. Son mezcla
    //    del color del icono y del fondo OSCURO; se deshace esa mezcla y se
    //    rehace contra el claro. El color "puro" se toma unos pixeles hacia
    //    dentro, donde el degradado apenas ha cambiado.
    let enAnillo = false;
    for (let dy = -2; dy <= 2 && !enAnillo; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && fuera[yy * w + xx]) { enAnillo = true; break; }
    }
    if (!enAnillo) continue;
    const vx = cx - x, vy = cy - y;
    const n = Math.hypot(vx, vy) || 1;
    const ix = Math.round(x + (vx / n) * 6), iy = Math.round(y + (vy / n) * 6);
    const p = (iy * w + ix) * 4;
    const puro = [px[p], px[p + 1], px[p + 2]];
    // Cobertura por el canal que mas separa el icono del fondo.
    let canal = 0, sep = -1;
    for (let k = 0; k < 3; k++) { const d = Math.abs(puro[k] - fondo[k]); if (d > sep) { sep = d; canal = k; } }
    if (sep < 24) continue; // demasiado parecido: no se toca
    let a = (px[o + canal] - fondo[canal]) / (puro[canal] - fondo[canal]);
    a = Math.max(0, Math.min(1, a));
    if (a > 0.985) continue; // ya es icono entero
    for (let k = 0; k < 3; k++) salida[o + k] = Math.round(a * puro[k] + (1 - a) * CLARO[k]);
    salida[o + 3] = 255;
    anillo++;
  }
  const bytes = escribirPNG(destino, w, h, salida);
  return { w, h, fondo, caja: [x0, y0, x1, y1], anillo, bytes };
}

/* ------------------------- icono a sangre ------------------------- */
function iconoASangre(origen, destino, lado, recorte) {
  const { w, h, px } = leerPNG(origen);
  // Recorte central de `recorte` px por lado y reduccion por promedio de area.
  const m = (w - recorte) / 2;
  const salida = Buffer.alloc(lado * lado * 4);
  const esc = recorte / lado;
  for (let y = 0; y < lado; y++) for (let x = 0; x < lado; x++) {
    const xa = m + x * esc, xb = m + (x + 1) * esc, ya = m + y * esc, yb = m + (y + 1) * esc;
    let r = 0, g = 0, b = 0, peso = 0;
    for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
      const py = Math.min(yb, yy + 1) - Math.max(ya, yy);
      for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
        const pw = (Math.min(xb, xx + 1) - Math.max(xa, xx)) * py;
        const o = (Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 4;
        r += px[o] * pw; g += px[o + 1] * pw; b += px[o + 2] * pw; peso += pw;
      }
    }
    const o = (y * lado + x) * 4;
    salida[o] = Math.round(r / peso); salida[o + 1] = Math.round(g / peso); salida[o + 2] = Math.round(b / peso); salida[o + 3] = 255;
  }
  return { bytes: escribirPNG(destino, lado, lado, salida) };
}

/* ------------------------------ principal ------------------------------ */
const raiz = process.cwd();
const pisar = process.argv.includes("--sobrescribir-lo-mio");
/** ¿Se puede escribir ahí? Lo que ya existe se deja, salvo que se pida pisarlo. */
function libre(destino) {
  if (!fs.existsSync(destino) || pisar) return true;
  console.log(`${path.basename(destino)}  ya existe: se deja como está`);
  return false;
}

// Una clara por cada arranque oscuro que haya en la carpeta: así un tamaño
// nuevo no pide tocar este fichero.
const carpeta = path.join(raiz, "public", "splash");
const oscuras = fs.readdirSync(carpeta).filter((n) => /^splash-\d+x\d+\.png$/.test(n)).sort();
for (const nombre of oscuras) {
  const destino = path.join(carpeta, nombre.replace(/\.png$/, "-claro.png"));
  if (!libre(destino)) continue;
  const r = arranqueClaro(path.join(carpeta, nombre), destino);
  console.log(`${path.basename(destino)}  ${r.w}x${r.h}  fondo #${r.fondo.map((v) => v.toString(16).padStart(2, "0")).join("")}  icono ${r.caja.join(",")}  anillo ${r.anillo} px  ${r.bytes} bytes`);
}
{
  const destino = path.join(raiz, "public", "icons", "apple-touch-icon-v2.png");
  if (libre(destino)) {
    // 448 de los 512: el margen que se recorta deja el dibujo al tamaño que
    // tenía en el icono anterior.
    const r = iconoASangre(path.join(raiz, "public", "icons", "icon-maskable-512.png"), destino, 180, 448);
    console.log(`apple-touch-icon-v2.png  180x180  ${r.bytes} bytes`);
  }
}
