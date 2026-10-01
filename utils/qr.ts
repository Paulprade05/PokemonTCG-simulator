// utils/qr.ts
//
// Generador de códigos QR PURO y sin dependencias, para pintar el enlace de
// invitación de un amigo (`/invitar/CODIGO`). No importa nada: lo cargan igual
// el navegador y scripts/test-invariantes.mjs.
//
// POR QUÉ ESTÁ ESCRITO A MANO: en las dependencias no hay ningún generador y no
// se puede añadir ninguno. Y POR QUÉ ES TAN CORTO: sólo hace lo que este juego
// necesita, que es un subconjunto pequeño y cerrado de ISO/IEC 18004:
//
//   · MODO BYTE. El enlace lleva minúsculas, barras y dos puntos; el modo
//     alfanumérico del estándar no tiene minúsculas.
//   · CORRECCIÓN L (recupera ~7%). Se pinta en una pantalla limpia, a un palmo
//     de la cámara: no hay manchas ni dobleces que corregir, y a menos
//     corrección, módulos más grandes para el mismo tamaño en pantalla.
//   · VERSIONES 1 A 5 (de 21×21 a 37×37 módulos, hasta 106 bytes). Son justo
//     las que tienen UN SOLO bloque Reed-Solomon en nivel L: no hace falta
//     intercalar bloques, que es la parte del estándar donde es más fácil
//     equivocarse. Tampoco llevan información de versión (empieza en la 7).
//
// Lo que no quepa en 106 bytes NO se pinta: `matrizQR` devuelve `null`. Un
// enlace de invitación ronda los 45.
//
// CONVENIO: `modulos[y][x]`, fila y columna desde la esquina superior
// izquierda; `true` es un módulo OSCURO. La zona de silencio (4 módulos claros
// alrededor) NO va en la matriz: la pone quien pinta (ver `trazadoQR`).

/** Lado de la versión `v`: 21 módulos la 1, y 4 más por versión. */
const lado = (version: number) => 17 + 4 * version;

/**
 * Palabras de código de cada versión en nivel L: las que hay en total y las
 * que son de corrección. La diferencia es lo que queda para datos. Índice =
 * versión; el 0 no existe. (ISO/IEC 18004, tabla 9.)
 */
const PALABRAS: readonly { total: number; correccion: number }[] = [
  { total: 0, correccion: 0 },
  { total: 26, correccion: 7 },
  { total: 44, correccion: 10 },
  { total: 70, correccion: 15 },
  { total: 100, correccion: 20 },
  { total: 134, correccion: 26 },
];

export const VERSION_MAXIMA_QR = 5;

/**
 * Bytes de texto que caben en la versión más grande: sus 108 palabras de datos
 * menos los 12 bits de cabecera (4 de modo y 8 de longitud), que ocupan dos.
 */
export const MAX_BYTES_QR = PALABRAS[VERSION_MAXIMA_QR].total - PALABRAS[VERSION_MAXIMA_QR].correccion - 2;

/* -------------------------------------------------------------------- *
 * Reed-Solomon sobre GF(256)
 * -------------------------------------------------------------------- *
 * El cuerpo es GF(2⁸) con el polinomio primitivo x⁸+x⁴+x³+x²+1 (0x11D) y el
 * generador α = 2, que es el que fija el estándar. Se multiplica «a la rusa»,
 * bit a bit, en vez de con tablas de logaritmos: para como mucho 134 palabras
 * la diferencia no se nota, y no hay tabla que pueda estar mal construida.
 */
function multiplicar(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z;
}

/**
 * Coeficientes del polinomio generador de grado `n`: (x−α⁰)(x−α¹)…(x−αⁿ⁻¹),
 * de mayor a menor grado y SIN el término principal, que siempre vale 1.
 */
function generador(n: number): number[] {
  const g: number[] = new Array(n).fill(0);
  g[n - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      g[j] = multiplicar(g[j], raiz);
      if (j + 1 < n) g[j] ^= g[j + 1];
    }
    raiz = multiplicar(raiz, 2);
  }
  return g;
}

/**
 * Las `n` palabras de corrección de `datos`: el resto de dividir
 * datos(x)·xⁿ entre el polinomio generador. Exportada para que los invariantes
 * la contrasten con los ejemplos publicados del estándar.
 */
export function correccionReedSolomon(datos: readonly number[], n: number): number[] {
  const g = generador(n);
  const resto: number[] = new Array(n).fill(0);
  for (const byte of datos) {
    const factor = byte ^ resto[0];
    resto.shift();
    resto.push(0);
    for (let i = 0; i < n; i++) resto[i] ^= multiplicar(g[i], factor);
  }
  return resto;
}

/* -------------------------------------------------------------------- *
 * Información de formato
 * -------------------------------------------------------------------- *
 * 15 bits: 2 del nivel de corrección (L = 01), 3 de la máscara y 10 de un
 * código BCH(15,5) con generador 0x537, todo ello pasado por XOR con 0x5412
 * para que nunca salga todo ceros. Es lo primero que lee un lector: si está
 * mal, no sabe qué máscara deshacer y el resto no sirve de nada.
 */
export function bitsDeFormato(mascara: number): number {
  const datos = (1 << 3) | mascara;
  let resto = datos;
  for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
  return ((datos << 10) | resto) ^ 0x5412;
}

/* -------------------------------------------------------------------- *
 * Las ocho máscaras
 * -------------------------------------------------------------------- *
 * `true` = ese módulo de datos se invierte. `x` es la columna e `y` la fila.
 * El estándar las define con (i, j) = (fila, columna): aquí están ya
 * traducidas, y por eso la 1 mira la fila y la 2 la columna.
 */
const MASCARAS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/* -------------------------------------------------------------------- *
 * Penalización de una matriz ya enmascarada
 * -------------------------------------------------------------------- *
 * Las cuatro reglas del estándar. No afectan a que el código se lea —las ocho
 * máscaras dan un QR válido—, sino a que se lea BIEN: evitan las manchas
 * grandes de un solo color y los dibujos que un lector puede confundir con
 * una esquina de localización.
 */
function penalizacion(m: boolean[][]): number {
  const n = m.length;
  let total = 0;

  // Regla 1: cinco o más módulos seguidos del mismo color, en filas y columnas.
  for (let eje = 0; eje < 2; eje++) {
    for (let a = 0; a < n; a++) {
      let racha = 1;
      for (let b = 1; b <= n; b++) {
        const actual = b < n ? (eje === 0 ? m[a][b] : m[b][a]) : null;
        const previo = eje === 0 ? m[a][b - 1] : m[b - 1][a];
        if (actual === previo) {
          racha++;
        } else {
          if (racha >= 5) total += 3 + (racha - 5);
          racha = 1;
        }
      }
    }
  }

  // Regla 2: bloques de 2×2 de un mismo color.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) total += 3;
    }
  }

  // Regla 3: el dibujo 1:1:3:1:1 de una esquina de localización con cuatro
  // módulos claros a un lado, en filas y columnas.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  for (let eje = 0; eje < 2; eje++) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b + 11 <= n; b++) {
        let esA = true;
        let esB = true;
        for (let k = 0; k < 11 && (esA || esB); k++) {
          const v = eje === 0 ? m[a][b + k] : m[b + k][a];
          if (v !== A[k]) esA = false;
          if (v !== B[k]) esB = false;
        }
        if (esA || esB) total += 40;
      }
    }
  }

  // Regla 4: cuánto se aparta del 50% la proporción de módulos oscuros.
  let oscuros = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) oscuros++;
  total += Math.floor(Math.abs((oscuros * 100) / (n * n) - 50) / 5) * 10;

  return total;
}

/** Lo que sale de codificar: la matriz y con qué versión y máscara se hizo. */
export interface CodigoQR {
  version: number;
  mascara: number;
  /** `modulos[y][x]`; `true` = oscuro. Sin zona de silencio. */
  modulos: boolean[][];
}

/** UTF-8, a mano: ni `TextEncoder` ni `Buffer` hacen falta para esto. */
function bytesUtf8(texto: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < texto.length; i++) {
    let c = texto.charCodeAt(i);
    // Un par sustituto bien formado es UN carácter de 4 bytes.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < texto.length) {
      const baja = texto.charCodeAt(i + 1);
      if (baja >= 0xdc00 && baja <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (baja - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return bytes;
}

/**
 * Las palabras de DATOS de una versión: cabecera de modo byte, el texto, el
 * terminador y el relleno hasta llenar la capacidad. Exportada para los
 * invariantes (permite comprobar el Reed-Solomon de un código ya montado).
 */
export function palabrasDeDatos(bytes: readonly number[], version: number): number[] {
  const capacidad = PALABRAS[version].total - PALABRAS[version].correccion;
  const bits: number[] = [];
  const poner = (valor: number, cuantos: number) => {
    for (let i = cuantos - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
  };
  poner(0b0100, 4); // modo byte
  poner(bytes.length, 8); // longitud: 8 bits en las versiones 1 a 9
  for (const b of bytes) poner(b, 8);
  // Terminador: hasta cuatro ceros, los que quepan.
  poner(0, Math.min(4, capacidad * 8 - bits.length));
  // Hasta el siguiente byte entero.
  while (bits.length % 8 !== 0) bits.push(0);
  const palabras: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let p = 0;
    for (let k = 0; k < 8; k++) p = (p << 1) | bits[i + k];
    palabras.push(p);
  }
  // Relleno: 0xEC y 0x11 alternados, que es lo que manda el estándar.
  for (let relleno = 0xec; palabras.length < capacidad; relleno ^= 0xec ^ 0x11) palabras.push(relleno);
  return palabras;
}

/**
 * Codifica `texto` y devuelve la matriz con su versión y su máscara, o `null`
 * si no cabe en la versión 5 (más de 106 bytes en UTF-8) o está vacío.
 */
export function codificarQR(texto: string): CodigoQR | null {
  if (typeof texto !== "string" || texto.length === 0) return null;
  const bytes = bytesUtf8(texto);
  if (bytes.length > MAX_BYTES_QR) return null;

  // La versión más pequeña en la que cabe: módulos más grandes en pantalla.
  let version = 1;
  while (PALABRAS[version].total - PALABRAS[version].correccion - 2 < bytes.length) version++;

  const n = lado(version);
  const modulos: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  // Qué módulos son de FUNCIÓN (localización, temporización, alineamiento,
  // formato): ni llevan datos ni se enmascaran.
  const reservado: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fijar = (x: number, y: number, oscuro: boolean) => {
    modulos[y][x] = oscuro;
    reservado[y][x] = true;
  };

  // Temporización: fila 6 y columna 6, alternando y empezando en oscuro. Va
  // antes que las esquinas, que la pisan donde se cruzan.
  for (let i = 0; i < n; i++) {
    fijar(6, i, i % 2 === 0);
    fijar(i, 6, i % 2 === 0);
  }

  // Las tres esquinas de localización (7×7) con su separador claro de un
  // módulo. `d` es la distancia al centro: oscuro el centro 3×3 (d ≤ 1) y el
  // anillo exterior (d = 3); claro el anillo intermedio (2) y el separador (4).
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        fijar(x, y, d !== 2 && d !== 4);
      }
    }
  }

  // Alineamiento (5×5), desde la versión 2. En las versiones 2 a 5 sólo hay
  // uno, centrado a 7 módulos de la esquina inferior derecha: los otros tres
  // que saldrían de la tabla del estándar caen encima de las esquinas de
  // localización y no se dibujan.
  if (version >= 2) {
    const c = n - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        fijar(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  // La información de formato va DOS veces: alrededor de la esquina superior
  // izquierda y repartida entre las otras dos. El bit 0 es el menos
  // significativo. Con ella va el módulo siempre oscuro de (8, n−8).
  const pintarFormato = (mascara: number) => {
    const f = bitsDeFormato(mascara);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) fijar(8, i, bit(i));
    fijar(8, 7, bit(6));
    fijar(8, 8, bit(7));
    fijar(7, 8, bit(8));
    for (let i = 9; i < 15; i++) fijar(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) fijar(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) fijar(8, n - 15 + i, bit(i));
    fijar(8, n - 8, true);
  };
  // Primera pasada sólo para RESERVAR el sitio antes de colocar los datos.
  pintarFormato(0);

  // Datos + corrección. Un solo bloque: las palabras van seguidas, sin
  // intercalar.
  const datos = palabrasDeDatos(bytes, version);
  const palabras = datos.concat(correccionReedSolomon(datos, PALABRAS[version].correccion));

  // Colocación en zigzag: columnas de dos en dos desde la derecha, subiendo y
  // bajando alternativamente, saltando la columna 6 (la de temporización) y
  // todo lo reservado. Dentro de cada palabra, del bit más significativo al
  // menos. Los bits que sobran al final (7 en las versiones 2 a 5) se quedan
  // claros.
  let k = 0;
  for (let derecha = n - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    for (let paso = 0; paso < n; paso++) {
      for (let j = 0; j < 2; j++) {
        const x = derecha - j;
        const sube = ((derecha + 1) & 2) === 0;
        const y = sube ? n - 1 - paso : paso;
        if (reservado[y][x] || k >= palabras.length * 8) continue;
        modulos[y][x] = ((palabras[k >>> 3] >>> (7 - (k & 7))) & 1) === 1;
        k++;
      }
    }
  }

  // Se prueban las ocho máscaras y se queda la de menor penalización. Aplicar
  // una máscara dos veces la deshace (es un XOR), así que se prueba y se
  // retira sobre la misma matriz.
  const enmascarar = (mascara: number) => {
    const f = MASCARAS[mascara];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!reservado[y][x] && f(x, y)) modulos[y][x] = !modulos[y][x];
      }
    }
  };
  let mejor = 0;
  let menor = Infinity;
  for (let mascara = 0; mascara < 8; mascara++) {
    enmascarar(mascara);
    pintarFormato(mascara);
    const p = penalizacion(modulos);
    if (p < menor) {
      menor = p;
      mejor = mascara;
    }
    enmascarar(mascara);
  }
  enmascarar(mejor);
  pintarFormato(mejor);

  return { version, mascara: mejor, modulos };
}

/**
 * La matriz de módulos de `texto` (`[y][x]`, `true` = oscuro), o `null` si no
 * cabe. Es lo que necesita quien sólo quiere pintar.
 */
export function matrizQR(texto: string): boolean[][] | null {
  return codificarQR(texto)?.modulos ?? null;
}

/**
 * El dibujo listo para un único `<path>` de SVG: cada racha horizontal de
 * módulos oscuros es un rectángulo de alto 1.
 *
 * UN SOLO PATH y no un `<rect>` por módulo: un QR de versión 3 tiene unos 400
 * módulos oscuros, y 400 nodos en el DOM por un dibujo estático son 400 nodos
 * de más. `lado` incluye la ZONA DE SILENCIO (`margen` módulos claros a cada
 * lado; el estándar pide 4 y los lectores la necesitan para encontrar las
 * esquinas): se usa como `viewBox="0 0 lado lado"`, con un fondo BLANCO del
 * mismo tamaño debajo, también en el tema oscuro. Y con
 * `shapeRendering="crispEdges"`: sin él, el suavizado deja una línea gris
 * entre módulos vecinos.
 */
export function trazadoQR(modulos: readonly (readonly boolean[])[], margen = 4): { lado: number; d: string } {
  const n = modulos.length;
  let d = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modulos[y][x]) {
        x++;
        continue;
      }
      let fin = x;
      while (fin < n && modulos[y][fin]) fin++;
      d += `M${x + margen} ${y + margen}h${fin - x}v1h${x - fin}z`;
      x = fin;
    }
  }
  return { lado: n + 2 * margen, d };
}
