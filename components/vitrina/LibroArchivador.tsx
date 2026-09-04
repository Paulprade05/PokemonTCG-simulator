"use client";

// components/vitrina/LibroArchivador.tsx
//
// EL PASE DE PÁGINA: una hoja que gira sobre el lomo, como en un archivador de
// verdad.
//
// ============================================================================
// EL PROBLEMA, Y POR QUÉ NO ES "PONER UN rotateY Y YA"
// ============================================================================
//
// Girar una hoja en 3D pide `perspective` y `transform-style: preserve-3d`, y
// las dos están PROHIBIDAS en este repositorio sobre cualquier ancestro de una
// carta: WebKit promociona esa capa y la rasteriza a una escala fija, así que
// la ilustración sale borrosa en un iPhone aunque la fuente sea la de alta
// resolución (medido y documentado en components/PokemonCard.tsx:140-163 y en
// la cabecera de components/MazoCartas.tsx).
//
// La salida es la MISMA que ya usa PokemonCard para su propio giro, y está
// escrita allí: «en reposo la carta no necesita volumen, así que se pinta plana
// y el navegador la dibuja a resolución nativa. Durante el giro sí hace falta
// el 3D, pero ahí el movimiento tapa cualquier pérdida de nitidez».
//
// Aquí eso se traduce en una regla dura: MIENTRAS NO SE ESTÁ PASANDO PÁGINA, en
// este árbol no hay ni perspective, ni preserve-3d, ni backface-visibility, ni
// will-change. Nada. El escenario 3D se monta al empezar el gesto y se
// desmonta al acabarlo. Es lo que hace que un archivador de 441 cartas se lea
// nítido en el móvil y siga girando como un libro.
//
// ============================================================================
// LA MECÁNICA
// ============================================================================
//
// En reposo se pinta UNA hoja, plana. Al pasar página se montan dos:
//
//   · la hoja de DEBAJO, quieta, que es la que quedará a la vista;
//   · la hoja que GIRA, encima, con dos caras y el eje en el lomo (a la
//     izquierda, donde están las anillas).
//
// Hacia adelante, la que gira es la que dejas: sale del 0° al −180° y descubre
// la siguiente. Hacia atrás es exactamente lo mismo al revés, y por eso el
// componente sólo necesita una regla: LA HOJA QUE GIRA ES SIEMPRE LA DE NÚMERO
// MENOR, y la de debajo la otra. Adelante empieza a 0° y acaba a −180°; atrás
// empieza a −180° y acaba a 0°. Un solo camino de código para las dos.
//
// La cara de atrás es papel liso, que es lo que se ve al levantar una hoja de
// un archivador por el lado equivocado. No lleva las cartas de la hoja
// siguiente a propósito: en un archivador real sí las llevaría, pero eso obliga
// a montar tres hojas y a pintar las nueve cartas del reverso en espejo para
// que no salgan del revés — mucho coste para medio segundo de animación en el
// que además la cara trasera se ve dos décimas.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

/** Cuánto dura el giro. Medio segundo largo: se lee como papel, no como una
 *  transición de interfaz. Por debajo de 380 ms parece un corte. */
const DURACION_MS = 520;

/**
 * Lo que el padre puede pedirle al libro.
 *
 * El estado del giro vive DENTRO del componente a propósito: es un detalle de
 * la animación —perspectivas, keyframes, el cerrojo del doble toque— y subirlo
 * obligaría al archivador a saber de todo eso. Lo único que sale es la orden de
 * pasar y si está ocupado, que es lo que necesitan los botones y el gesto.
 */
export interface LibroHandle {
  pasar: (dir: 1 | -1) => void;
  girando: boolean;
}

interface Props {
  /** En React 19 la ref es una prop normal; no hace falta forwardRef. */
  ref?: Ref<LibroHandle>;
  /** Hoja visible ahora mismo. */
  hoja: number;
  /** Total de hojas montadas. */
  total: number;
  /** Pinta una hoja concreta. Se le pide la actual y la vecina del giro. */
  renderHoja: (numero: number) => ReactNode;
  /** Se llama cuando el giro TERMINA, para que el padre fije el estado. */
  onCambio: (nueva: number) => void;
  /**
   * Movimiento reducido: sin giro, cambio seco. Lo respeta toda la aplicación
   * (ver la media query de app/globals.css) y aquí importa el doble, porque un
   * giro de página a pantalla completa es de lo más molesto que hay para quien
   * lo tiene activado.
   */
  efectosApagados?: boolean;
  /**
   * Las URL de las ilustraciones de una hoja, para PRECARGAR las vecinas en
   * reposo. Ver `precargarVecinas` abajo. Opcional: sin ella el libro se
   * comporta como siempre.
   */
  urlsDeHoja?: (numero: number) => string[];
}

/**
 * Las URL que ya se han pedido en esta sesión, para no volver a pedirlas cada
 * vez que se pasa por la misma hoja. Es del módulo y no del componente porque
 * la caché del navegador también lo es: si ya se pidió, ya está.
 */
const precargadas = new Set<string>();

/**
 * ANCHO MÁXIMO DEL ARCHIVADOR EN ESCRITORIO (la tapa de Vitrina.tsx y su
 * esqueleto en Loader.tsx lo comparten; por eso vive aquí, que es el módulo
 * ligero que los dos pueden importar).
 *
 * Medido a 1280x800: con el tope de siempre (42rem = 672px) la tapa medía
 * 672x823 en una ventana de 800 de alto, y "Hoja 1 de 3" con sus flechas
 * quedaban en y=1093-1181: 446px de scroll para pasar de hoja. Lo que hay
 * por encima de la tapa y debajo de la barra superior son 187px fijos
 * (pt-6 24 + cabecera 50 + su margen 32 + barra de aviso 61 + hueco 20) y
 * los mandos necesitan 64 más (hueco 20 + fila de 44) por debajo: 251px en
 * total. El resto del alto de la app es para la tapa, y su ancho sale de la
 * proporción medida de la tapa (823/672 = 1,2247 → ×0,816). La barra de
 * progreso y la nota de abajo sí pueden quedar por debajo del pliegue: son
 * decorativas, la hoja y sus mandos no.
 *
 * `--app-height` la escribe hooks/useViewport.ts (y app/globals.css la deja
 * en 100dvh hasta entonces). Sólo se aplica a partir de `md`: en el móvil el
 * ancho de la pantalla ya es el tope y la página se desplaza como siempre.
 */
export const ANCHO_MAX_ARCHIVADOR =
  "min(42rem, calc((var(--app-height) - var(--sat) - var(--topbar-h) - 251px) * 0.816))";

export default function LibroArchivador({
  ref,
  hoja,
  total,
  renderHoja,
  onCambio,
  efectosApagados = false,
  urlsDeHoja,
}: Props) {
  /** Hacia dónde gira: +1 adelante, −1 atrás, 0 quieto. */
  const [girando, setGirando] = useState<0 | 1 | -1>(0);
  const temporizador = useRef<number | null>(null);

  /* Limpieza del temporizador si el componente se va a mitad del giro (cambio
   * de ruta, filtro que reinicia el archivador). Sin esto, el onCambio saltaría
   * sobre un componente ya desmontado. */
  useEffect(
    () => () => {
      if (temporizador.current !== null) window.clearTimeout(temporizador.current);
    },
    [],
  );

  /* PRECARGA DE LAS HOJAS VECINAS, EN REPOSO.
   *
   * Sólo se monta la hoja visible (ver la cabecera: cada hoja de más es un
   * árbol de nueve cartas). El precio era que la vecina se montaba EN EL
   * INSTANTE del giro con sus <img loading="lazy">: el navegador pedía todas
   * sus ilustraciones justo cuando empezaba la animación (medido, hasta 1,5 MB
   * por hoja) y a los 200 ms del giro tres de cinco fundas seguían vacías. Lo
   * que se descubre al pasar la página era un hueco.
   *
   * Aquí se piden las ilustraciones de la hoja anterior y la siguiente con
   * `new Image()` mientras el libro está quieto: van a la caché HTTP (y a la
   * del service worker, que las guarda como cualquier carta) y cuando la hoja
   * vecina se monta, sus <img> las encuentran hechas. No se montan hojas
   * ocultas para esto: `loading="lazy"` no pide nada que no esté en el
   * viewport, y montarlas visibles-pero-tapadas multiplicaría el árbol de la
   * vitrina por tres.
   *
   * Con un respiro de unos cientos de milisegundos, para que la hoja visible
   * pida lo suyo primero, y sólo con el libro quieto: a mitad de giro la red
   * es para la hoja que se está descubriendo. */
  useEffect(() => {
    if (!urlsDeHoja || girando !== 0) return;
    const pendientes = [...urlsDeHoja(hoja - 1), ...urlsDeHoja(hoja + 1)].filter(
      (u) => u && !precargadas.has(u),
    );
    if (pendientes.length === 0) return;
    const t = window.setTimeout(() => {
      for (const url of pendientes) {
        precargadas.add(url);
        const img = new Image();
        img.decoding = "async";
        img.src = url;
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [hoja, girando, urlsDeHoja]);

  const pasar = useCallback(
    (dir: 1 | -1) => {
      // Un solo giro a la vez: sin este cerrojo, tres toques rápidos montan tres
      // escenarios 3D encima y el estado acaba en cualquier sitio.
      if (girando !== 0) return;
      const destino = hoja + dir;
      if (destino < 0 || destino >= total) return;

      if (efectosApagados) {
        onCambio(destino);
        return;
      }

      setGirando(dir);
      /* El commit va por temporizador y NO por onAnimationEnd del CSS: si la
       * pestaña pasa a segundo plano a mitad del giro, el navegador puede no
       * disparar nunca el evento de fin de animación y la hoja se quedaría
       * atascada girada para siempre. Con el temporizador, al volver ya está
       * cambiada. Es el mismo criterio que el respaldo de 900 ms de
       * PokemonCard. */
      temporizador.current = window.setTimeout(() => {
        temporizador.current = null;
        setGirando(0);
        onCambio(destino);
      }, DURACION_MS);
    },
    [girando, hoja, total, efectosApagados, onCambio],
  );

  // Lo único que el padre puede pedir: pasar, y saber si está ocupado.
  useImperativeHandle(ref, () => ({ pasar, girando: girando !== 0 }), [pasar, girando]);

  /* La hoja que gira es SIEMPRE la de número menor (ver la cabecera): adelante
   * es la que dejamos, atrás es la que viene. */
  const numeroQueGira = girando === 1 ? hoja : hoja - 1;
  const numeroDebajo = girando === 1 ? hoja + 1 : hoja;

  return (
    <div
      className="relative w-full"
      /* EL ESCENARIO 3D SÓLO EXISTE MIENTRAS SE PASA PÁGINA. Ver la cabecera:
       * dejar la perspectiva puesta rasteriza las cartas y en iPhone se ven
       * borrosas. En reposo esto es un div normal y corriente.
       *
       * POR QUÉ 3000px Y NO 1800. Con el punto de fuga en el lomo (0% 50%), el
       * canto libre de la hoja se acerca a la cámara al girar y crece según
       * p / (p − z), con z el ancho de la hoja. Con 1800px y la hoja de 602px
       * del escritorio eso es ×1,5: +176px de alto a mitad de giro, que se
       * salían del archivador y pisaban la cabecera. Con 3000px se queda en
       * ×1,25 (y en ×1,1 con la hoja de 297px del móvil): sigue leyéndose como
       * papel que gira, pero el bulto ya cabe dentro del bloque. No se recorta
       * con overflow porque la hoja tiene que poder acabar a la IZQUIERDA del
       * lomo, fuera de esta caja —ver la nota de la ventana en Vitrina.tsx—. */
      style={
        girando !== 0
          ? { perspective: "3000px", perspectiveOrigin: "0% 50%" }
          : undefined
      }
      data-pasando={girando !== 0 ? "si" : undefined}
    >
      {/* LA HOJA DE DEBAJO. En reposo es la única que hay. */}
      <div>{renderHoja(numeroDebajo)}</div>

      {/* LA HOJA QUE GIRA. Sólo se monta durante el pase, y al desmontarse se
          lleva consigo todo el 3D. */}
      {girando !== 0 && (
        <div
          className="absolute inset-0"
          style={{
            transformStyle: "preserve-3d",
            transformOrigin: "left center",
            // will-change SÓLO durante la animación, como hace useSwipe: dejarlo
            // puesto mantiene la capa promocionada para siempre.
            willChange: "transform",
            animation: `archivador-gira-${girando === 1 ? "adelante" : "atras"} ${DURACION_MS}ms cubic-bezier(.36,.06,.28,1) forwards`,
          }}
        >
          {/* CARA DELANTERA: la hoja de número menor. */}
          <div className="absolute inset-0" style={{ backfaceVisibility: "hidden" }}>
            {renderHoja(numeroQueGira)}
          </div>

          {/* CARA TRASERA: papel liso. Va girada 180° para que se lea derecha
              cuando la hoja ha pasado del perfil, y con su propia sombra de
              lomo al otro lado —el doblez cambia de sitio al dar la vuelta—. */}
          <div
            className="absolute inset-0 rounded-2xl"
            style={{
              backfaceVisibility: "hidden",
              transform: "rotateY(180deg)",
              background:
                "var(--grain), linear-gradient(255deg, color-mix(in srgb, var(--ink) 6%, var(--surface)) 0%, var(--surface) 14%, var(--surface) 100%)",
              border: "1px solid var(--border)",
              boxShadow:
                "inset -14px 0 22px -18px rgba(0,0,0,0.55), 0 10px 26px -14px rgba(0,0,0,0.5)",
            }}
          />
        </div>
      )}

      {/* Los dos @keyframes van aquí y no en globals.css porque sólo existen
          mientras el archivador está en pantalla — es el mismo criterio que
          usa components/BoosterPack.tsx con el CSS del sobre. Y son una CADENA
          CONSTANTE: nada aquí depende de la hoja, así que no se inyecta una
          hoja de estilos nueva por cada pase. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
@keyframes archivador-gira-adelante {
  from { transform: rotateY(0deg); }
  to   { transform: rotateY(-180deg); }
}
@keyframes archivador-gira-atras {
  from { transform: rotateY(-180deg); }
  to   { transform: rotateY(0deg); }
}
/* El giro se apaga entero con movimiento reducido. El componente ya cambia de
   hoja sin animar en ese caso, pero si alguien activa la preferencia A MITAD
   de un pase, esto lo deja quieto en vez de dejarlo colgado a medio girar. */
@media (prefers-reduced-motion: reduce) {
  [data-pasando] > * { animation: none !important; }
}`,
        }}
      />
    </div>
  );
}

/** Duración del giro, para que el padre pueda sincronizar lo suyo. */
export const DURACION_PASE_MS = DURACION_MS;
