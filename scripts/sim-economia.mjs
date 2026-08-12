// Simulación de la economía con el CÓDIGO REAL del juego.
// Transpila utils/packLogic.ts al vuelo (quitando tipos) y usa los precios
// reales de utils/constanst.ts y las cartas reales de src/data/*.json.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();
const raiz = process.cwd();

async function cargarModulo(rel) {
  const fuente = readFileSync(join(raiz, rel), "utf8");
  const { code } = await transform(fuente, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, () => ({}));
  return mod.exports;
}

const packLogic = await cargarModulo("utils/packLogic.ts");
const constantes = await cargarModulo("utils/constanst.ts");
const { SELL_PRICES, PACK_PRICES, STARTING_COINS, DAILY_BASE, SET_COMPLETION_BONUS } = constantes;

const precioVenta = (r) => SELL_PRICES[r] ?? 10; // mismo respaldo que la app (getPrice)

const cartasDe = (setId) =>
  JSON.parse(readFileSync(join(raiz, "src", "data", setId + ".json"), "utf8"));

// ---------- 1) EV DE REVENTA TOTAL, TODOS LOS SETS × STANDARD ----------
const setsDisponibles = readdirSync(join(raiz, "src", "data"))
  .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
  .map((f) => f.replace(".json", ""));

const N_EV = 2000;
const filasEV = [];
for (const setId of setsDisponibles) {
  let cartas;
  try { cartas = cartasDe(setId); } catch { continue; }
  if (!Array.isArray(cartas) || cartas.length < 20) continue;
  let total = 0;
  const porSobre = [];
  for (let i = 0; i < N_EV; i++) {
    const sobre = packLogic.openStandardPack(cartas);
    const v = sobre.reduce((s, c) => s + precioVenta(c.rarity), 0);
    total += v;
    porSobre.push(v);
  }
  porSobre.sort((a, b) => a - b);
  filasEV.push({
    setId,
    n: cartas.length,
    media: total / N_EV,
    mediana: porSobre[Math.floor(N_EV / 2)],
    p95: porSobre[Math.floor(N_EV * 0.95)],
  });
}
filasEV.sort((a, b) => b.media - a.media);
console.log("== EV de VENDERLO TODO, sobre ESTÁNDAR (coste 50), " + N_EV + " sobres por set ==");
console.log("setId        cartas  media  %coste  mediana  p95");
for (const f of filasEV) {
  const alerta = f.media > 50 ? "  <-- ¡IMPRIME DINERO!" : f.media < 35 ? "  <-- muy tacaño" : "";
  console.log(
    f.setId.padEnd(12) + String(f.n).padStart(5) + "  " +
    f.media.toFixed(1).padStart(5) + "  " + ((100 * f.media) / 50).toFixed(0).padStart(4) + "%  " +
    String(f.mediana).padStart(6) + "  " + String(f.p95).padStart(4) + alerta,
  );
}

// ---------- 2) PREMIUM Y GOLDEN EN SETS REPRESENTATIVOS ----------
console.log("\n== EV de venderlo todo, PREMIUM (220) y GOLDEN (600) ==");
for (const setId of ["sv10", "sv8", "sv3pt5", "swsh12pt5"]) {
  let cartas; try { cartas = cartasDe(setId); } catch { continue; }
  for (const tipo of ["PREMIUM", "GOLDEN"]) {
    const coste = PACK_PRICES[tipo];
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const sobre = tipo === "PREMIUM"
        ? packLogic.openPremiumPack(cartas)
        : packLogic.openGoldenPack(cartas, []);
      total += sobre.reduce((s, c) => s + precioVenta(c.rarity), 0);
    }
    const media = total / 1000;
    console.log(
      setId.padEnd(10) + tipo.padEnd(9) + " media " + media.toFixed(0).padStart(4) +
      "  (" + ((100 * media) / coste).toFixed(0) + "% del coste)" +
      (media > coste ? "  <-- ¡IMPRIME DINERO!" : ""),
    );
  }
}

// ---------- 3) LA PREGUNTA DEL USUARIO: 1000 SOBRES SEGUIDOS ----------
// Dos jugadores sobre sv10 (el set nuevo), sobre estándar:
//  A) REVENDEDOR: vende todo lo que saca.
//  B) COLECCIONISTA: guarda la primera copia, vende duplicados; cobra el bonus
//     de set (+1000) si completa la colección.
// Cartera inicial 1000 (STARTING_COINS). Sin recompensas diarias: es el caso
// puro que pregunta el usuario.
function simular1000(setId, estrategia, semillas = 300) {
  const cartas = cartasDe(setId);
  const totalSet = new Set(cartas.map((c) => c.id)).size;
  let quiebras = 0, sobresHastaQuiebraAcum = 0, carterasFinales = [], maximas = [];
  let completadoEn = [];
  for (let s = 0; s < semillas; s++) {
    let cartera = STARTING_COINS;
    const coleccion = new Set();
    let maxCartera = cartera, quiebra = -1, completado = -1;
    for (let p = 0; p < 1000; p++) {
      if (cartera < PACK_PRICES.STANDARD) { quiebra = p; break; }
      cartera -= PACK_PRICES.STANDARD;
      const sobre = packLogic.openStandardPack(cartas);
      for (const c of sobre) {
        if (estrategia === "revendedor") {
          cartera += precioVenta(c.rarity);
        } else {
          if (coleccion.has(c.id)) cartera += precioVenta(c.rarity);
          else coleccion.add(c.id);
        }
      }
      if (estrategia === "coleccionista" && completado < 0 && coleccion.size >= totalSet) {
        cartera += SET_COMPLETION_BONUS;
        completado = p + 1;
      }
      if (cartera > maxCartera) maxCartera = cartera;
    }
    if (quiebra >= 0) { quiebras++; sobresHastaQuiebraAcum += quiebra; }
    else carterasFinales.push(cartera);
    maximas.push(maxCartera);
    if (completado > 0) completadoEn.push(completado);
  }
  carterasFinales.sort((a, b) => a - b);
  return {
    quiebras,
    pctQuiebra: (100 * quiebras) / semillas,
    sobresMediosHastaQuiebra: quiebras ? Math.round(sobresHastaQuiebraAcum / quiebras) : null,
    carteraFinalMediana: carterasFinales.length ? carterasFinales[Math.floor(carterasFinales.length / 2)] : null,
    carteraFinalMax: carterasFinales.length ? carterasFinales[carterasFinales.length - 1] : null,
    carteraMaximaTipica: maximas.sort((a, b) => a - b)[Math.floor(maximas.length / 2)],
    setCompletadoEnMediana: completadoEn.length ? completadoEn.sort((a, b) => a - b)[Math.floor(completadoEn.length / 2)] : null,
  };
}

console.log("\n== 1000 SOBRES SEGUIDOS (estándar, sv10, cartera inicial " + STARTING_COINS + ", 300 partidas) ==");
for (const estrategia of ["revendedor", "coleccionista"]) {
  const r = simular1000("sv10", estrategia);
  console.log("\n-- " + estrategia.toUpperCase() + " --");
  console.log("  se arruina: " + r.pctQuiebra.toFixed(1) + "% de las partidas" +
    (r.sobresMediosHastaQuiebra ? " (de media en el sobre " + r.sobresMediosHastaQuiebra + ")" : ""));
  if (r.carteraFinalMediana !== null)
    console.log("  cartera tras 1000 sobres (mediana de quienes sobreviven): " + r.carteraFinalMediana);
  if (r.carteraFinalMax !== null)
    console.log("  mejor cartera final vista: " + r.carteraFinalMax);
  console.log("  pico de cartera típico: " + r.carteraMaximaTipica);
  if (r.setCompletadoEnMediana)
    console.log("  set completado (mediana): sobre nº " + r.setCompletadoEnMediana + " (+1000 de bonus)");
}

// ---------- 4) ¿Y CON LA RECOMPENSA DIARIA? ----------
// Jugador diario realista: cobra el daily (150) y abre 3 sobres al día
// vendiendo duplicados. ¿Cuántos días aguanta la cartera?
{
  const cartas = cartasDe("sv10");
  let quiebras = 0, diasAcum = 0;
  const DIAS = 365, PARTIDAS = 200;
  let finales = [];
  for (let s = 0; s < PARTIDAS; s++) {
    let cartera = STARTING_COINS;
    const col = new Set();
    let quiebraDia = -1;
    for (let d = 0; d < DIAS; d++) {
      cartera += DAILY_BASE;
      for (let k = 0; k < 3 && cartera >= PACK_PRICES.STANDARD; k++) {
        cartera -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(cartas)) {
          if (col.has(c.id)) cartera += precioVenta(c.rarity);
          else col.add(c.id);
        }
      }
      if (cartera < PACK_PRICES.STANDARD && d > 30) { /* sigue: mañana hay daily */ }
    }
    finales.push(cartera);
  }
  finales.sort((a, b) => a - b);
  console.log("\n== COLECCIONISTA DIARIO (daily 150 + 3 sobres/día con venta de duplicados, 1 año) ==");
  console.log("  cartera al año: mediana " + finales[Math.floor(finales.length / 2)] +
    ", p5 " + finales[Math.floor(finales.length * 0.05)] + ", p95 " + finales[Math.floor(finales.length * 0.95)]);
}
