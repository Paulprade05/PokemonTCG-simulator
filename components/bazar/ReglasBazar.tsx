"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  COMISION,
  MAX_ANUNCIOS_ABIERTOS,
  PRECIO_MAXIMO_FRACCION,
  PRECIO_MINIMO_FRACCION,
  SOBRES_PARA_COMPRAR,
  SOBRES_PARA_VENDER,
} from "../../utils/bazar";
import { IconoDesplegar } from "../icons";

/**
 * LAS TRES REGLAS DEL BAZAR, DICHAS ANTES DE QUE PASE NADA.
 *
 * ESTO NO ES DECORACIÓN Y NO SE PUEDE QUITAR PARA GANAR SITIO. El bazar tiene
 * tres comportamientos que sorprenden —el precio está acotado, hay comisión, y
 * sin unos cuantos sobres abiertos no se puede ni comprar ni vender— y los tres
 * son DEFENSAS de economía: están ahí para que dos cuentas de la misma persona
 * no puedan pasarse dinero (el porqué medido está en utils/bazar.ts). Como el
 * jugador honesto las sufre igual, la única salida decente es que las lea ANTES
 * de tocar nada, no en el mensaje de error que le devuelve el servidor cuando
 * ya ha elegido carta y precio. Un error que se podía haber contado antes es
 * una pantalla mintiendo por omisión.
 *
 * NINGÚN NÚMERO ESTÁ ESCRITO A MANO. El 50 %, el 150 %, el 15 % y los sobres
 * salen de las constantes de utils/bazar.ts, que son las MISMAS que aplica el
 * servidor. Si mañana la comisión sube al 20 %, este texto sube solo; escrito a
 * mano, la pantalla seguiría prometiendo un 15 % que ya no se cobra, que es la
 * peor forma posible de mentir sobre dinero.
 *
 * Y LA TERCERA REGLA TIENE DOS UMBRALES, NO UNO. Esta pieza decía «sólo hace
 * falta para publicar, no para comprar» y «comprar sí puedes desde ya», y era
 * falso: el servidor exige SOBRES_PARA_COMPRAR sobres abiertos al comprador
 * (`comprarEnBazarAction`; el motivo, en el comentario de esa constante). Una
 * cuenta con tres sobres leía que podía comprar, tocaba «Comprar», confirmaba
 * «Pagar 120» y sólo entonces se enteraba de que le faltaban siete: tres toques
 * para descubrir que la regla escrita era mentira. Se cuentan los dos números,
 * y con los sobres del jugador en la mano se dice cuánto le falta para cada uno.
 */

/** "15 %", "50 %"... Redondeado: las fracciones son 0,15 / 0,5 / 1,5 exactas. */
const pct = (fraccion: number) => `${Math.round(fraccion * 100)} %`;

const sobresDe = (n: number) => `${n} ${n === 1 ? "sobre" : "sobres"}`;

/* ==================================================================== *
 * A PARTIR DE LA SEGUNDA VISITA, PLEGADAS
 * ====================================================================
 *
 * En móvil las tres fichas van apiladas y miden unos 240 px: es lo primero que
 * se ve en CADA visita, antes del primer anuncio, y quien entra por décima vez
 * ya se las sabe. La primera vez se enseñan enteras —eso no se negocia, es el
 * motivo de que existan— y desde entonces llegan recogidas en una fila que
 * sigue diciendo lo esencial y se despliega con un toque.
 *
 * LO QUE NO SE PLIEGA NUNCA ES LO QUE LE FALTA AL JUGADOR: si aún no llega a
 * los sobres de comprar o de vender, la fila plegada lo dice con su número.
 * Recoger las reglas es ahorrar sitio; esconder por qué un botón no va a
 * funcionar sería volver al error contado tarde.
 *
 * SE DECIDE UNA VEZ POR ARRANQUE DE LA APP, y por eso la lectura se guarda en
 * una variable de módulo y no se repite en cada montaje. La marca se escribe
 * en cuanto las fichas se pintan; si cada montaje releyera, el segundo de la
 * misma visita (la pantalla de error que da paso a la buena, o el doble
 * montaje de desarrollo) ya la encontraría puesta y plegaría las reglas a quien
 * todavía no ha tenido tiempo de leerlas.
 *
 * SE LEE CON useSyncExternalStore, como components/ui/Portal.tsx y
 * SidebarExtras, y no con un estado que enciende un efecto: así quien vuelve
 * las recibe plegadas desde el PRIMER pintado, sin ver las tres fichas un
 * fotograma y luego un salto de 200 px con el escaparate subiendo. El servidor
 * y la hidratación leen «no vistas» (desplegadas), que es además lo que
 * pintaría un navegador sin almacenamiento.
 */
const CLAVE_REGLAS_VISTAS = "tcg:bazar-reglas-vistas";
let yaVistasAlArrancar: boolean | null = null;

function leerYaVistas(): boolean {
  if (yaVistasAlArrancar === null) {
    try {
      yaVistasAlArrancar = window.localStorage.getItem(CLAVE_REGLAS_VISTAS) === "1";
    } catch {
      // Sin almacenamiento (navegación privada de iOS) las reglas se quedan
      // desplegadas siempre: es el lado seguro del fallo.
      yaVistasAlArrancar = false;
    }
  }
  return yaVistasAlArrancar;
}

function marcarVistas() {
  try {
    window.localStorage.setItem(CLAVE_REGLAS_VISTAS, "1");
  } catch {
    /* Sin sitio o sin permiso: se volverán a enseñar enteras. No pasa nada. */
  }
}

/** La marca no cambia mientras la app está abierta: no hay nada a lo que
 *  suscribirse. Fuera del componente para que la referencia sea estable. */
const sinSuscripcion = () => () => {};
const noVistasEnServidor = () => false;

interface ReglasBazarProps {
  /**
   * Versión larga (dentro de la hoja de publicar) frente a la tira de tres
   * fichas del escaparate. La corta existe porque el comprador también tiene
   * que ver de qué va esto, pero no necesita el manual entero para comprar.
   */
  detallado?: boolean;
  /**
   * Sobres abiertos por el jugador. `null` = todavía no se sabe (o es un
   * invitado): entonces la regla se cuenta en genérico, sin prometer un estado
   * que no se ha comprobado.
   */
  sobresAbiertos?: number | null;
  /** Anuncios propios abiertos ahora mismo, para el aviso del tope. */
  anunciosAbiertos?: number;
}

/** Ficha de una regla en la versión corta. */
function Ficha({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="surface-2 min-w-0 flex-1 rounded-2xl px-3 py-2.5">
      <p className="ink t-cuerpo-2 leading-tight font-semibold">{titulo}</p>
      <p className="ink-soft mt-1 t-meta leading-snug">{detalle}</p>
    </div>
  );
}

/** Fila de una regla en la versión larga: icono, título y explicación. */
function Regla({
  icono,
  titulo,
  children,
}: {
  icono: React.ReactNode;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        {icono}
      </div>
      <div className="min-w-0">
        {/* t-cuerpo y no t-cuerpo-2: es el título de la regla y lo que tiene
            debajo ya son 12px; igualarlos borraría la jerarquía de la fila. */}
        <p className="ink t-cuerpo leading-tight font-semibold">{titulo}</p>
        <p className="ink-soft mt-1 t-cuerpo-2 leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

const ICONO = "w-4 h-4 ink-soft";

export default function ReglasBazar({
  detallado = false,
  sobresAbiertos = null,
  anunciosAbiertos = 0,
}: ReglasBazarProps) {
  /* Los dos umbrales, cada uno con lo que le falta al jugador. `null` = no se
   * sabe cuántos sobres lleva: se cuenta la norma y no se promete ningún estado. */
  const faltanComprar =
    sobresAbiertos === null ? null : Math.max(0, SOBRES_PARA_COMPRAR - sobresAbiertos);
  const faltanVender =
    sobresAbiertos === null ? null : Math.max(0, SOBRES_PARA_VENDER - sobresAbiertos);

  /** `true` cuando ya las había visto en otra visita: entonces hay fila-resumen. */
  const yaVistas = useSyncExternalStore(sinSuscripcion, leerYaVistas, noVistasEnServidor);
  const plegable = !detallado && yaVistas;
  /** Lo que el jugador ha elegido con el botón; `null` = aún no lo ha tocado. */
  const [elegido, setElegido] = useState<boolean | null>(null);
  const abiertas = elegido ?? !plegable;
  const idFichas = useId();

  // Sólo la versión corta cuenta como "vistas": la larga vive en la hoja de
  // publicar, a la que no se llega sin haber pasado por las fichas.
  useEffect(() => {
    if (!detallado) marcarVistas();
  }, [detallado]);

  if (!detallado) {
    const fichas = (
      <div id={idFichas} className="flex flex-col gap-2 sm:flex-row">
        <Ficha
          titulo="Precio acotado"
          detalle={`Entre el ${pct(PRECIO_MINIMO_FRACCION)} y el ${pct(PRECIO_MAXIMO_FRACCION)} de lo que vale la carta.`}
        />
        <Ficha
          titulo={`Comisión del ${pct(COMISION)}`}
          detalle="El vendedor cobra menos de lo que paga el comprador."
        />
        <Ficha
          titulo={`${SOBRES_PARA_COMPRAR} sobres para comprar, ${SOBRES_PARA_VENDER} para vender`}
          detalle={
            // Con `null` (invitado, o todavía sin comprobar) no se promete nada
            // sobre lo que puede hacer: se dice la norma y ya.
            faltanComprar === null || faltanVender === null
              ? "Hay que haberlos abierto antes: es la antigüedad que pide el bazar."
              : faltanComprar > 0
                ? `Llevas ${sobresAbiertos}. Te faltan ${faltanComprar} para comprar y ${faltanVender} para vender.`
                : faltanVender > 0
                  ? `Ya puedes comprar. Te faltan ${faltanVender} para vender.`
                  : "Ya puedes comprar y vender."
          }
        />
      </div>
    );

    if (!plegable) return fichas;

    /* Lo que le falta, si le falta algo. Va en la tinta de aviso porque es lo
     * único de la fila que le toca a ÉL y no a todo el mundo. */
    const aviso =
      faltanComprar === null || faltanVender === null
        ? null
        : faltanComprar > 0
          ? `Te faltan ${sobresDe(faltanComprar)} para comprar`
          : faltanVender > 0
            ? `Te faltan ${sobresDe(faltanVender)} para vender`
            : null;

    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setElegido(!abiertas)}
          aria-expanded={abiertas}
          aria-controls={idFichas}
          className="surface-2 press touch-target flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="ink t-cuerpo-2 block leading-tight font-semibold">
              Reglas del bazar
            </span>
            <span className="ink-soft t-meta mt-1 block leading-snug">
              Precio entre el {pct(PRECIO_MINIMO_FRACCION)} y el{" "}
              {pct(PRECIO_MAXIMO_FRACCION)} · comisión del {pct(COMISION)}
              {aviso ? (
                <>
                  {" · "}
                  <span className="font-semibold" style={{ color: "var(--warn-ink)" }}>
                    {aviso}
                  </span>
                </>
              ) : (
                faltanComprar === null &&
                ` · ${SOBRES_PARA_COMPRAR} sobres para comprar, ${SOBRES_PARA_VENDER} para vender`
              )}
            </span>
          </span>
          <IconoDesplegar
            tam={16}
            className={`ink-soft shrink-0 transition-transform duration-[var(--d-fast)] ${
              abiertas ? "rotate-180" : ""
            }`}
          />
        </button>
        {abiertas && fichas}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      <Regla
        titulo="El precio no lo eliges del todo"
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <path d="M4 12h16" /><path d="M7 8v8" /><path d="M17 8v8" />
          </svg>
        }
      >
        Tiene que caer entre el {pct(PRECIO_MINIMO_FRACCION)} y el{" "}
        {pct(PRECIO_MAXIMO_FRACCION)} de lo que vale la carta. El valor lo calcula
        el servidor con la rareza y el precio real del día, así que el deslizador
        ya viene topado: dentro de él, cualquier precio vale.
      </Regla>

      <Regla
        titulo={`La casa se queda el ${pct(COMISION)}`}
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" />
          </svg>
        }
      >
        El comprador paga el precio del anuncio y tú cobras ese precio menos la
        comisión. Verás siempre las dos cifras juntas antes de publicar: aquí no
        se enseña un precio a secas.
      </Regla>

      <Regla
        titulo={`Hacen falta ${SOBRES_PARA_VENDER} sobres abiertos`}
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <path d="M4 7h16v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
            <path d="M4 7 7 3h10l3 4" /><path d="M12 3v18" />
          </svg>
        }
      >
        {/* Esta versión vive en la hoja de PUBLICAR, así que el titular es el
            umbral de vender; el de comprar se dice igual, porque aquí ponía que
            para comprar no se pedía nada y no era verdad. */}
        {faltanComprar === null || faltanVender === null
          ? `Para publicar hay que llevar ${SOBRES_PARA_VENDER} sobres abiertos, y para comprar, ${SOBRES_PARA_COMPRAR}.`
          : faltanVender > 0
            ? `Te faltan ${sobresDe(faltanVender)} para poder publicar. ${
                faltanComprar > 0
                  ? `Para comprar hacen falta ${SOBRES_PARA_COMPRAR}: te faltan ${faltanComprar}.`
                  : `Comprar ya puedes: para eso bastan ${SOBRES_PARA_COMPRAR}.`
              }`
            : "Ya los llevas: puedes publicar cuando quieras."}
      </Regla>

      {/* Estas dos no son "reglas del bazar" sino las dos formas en que una
          publicación se cae SIN que el jugador entienda por qué. Van aquí, en
          letra pequeña, porque el mensaje del servidor ("sin-copias",
          "demasiados-anuncios") no se explica solo. */}
      <li
        // ink-soft y no ink-faint: la línea mide 11px y ink-faint sólo vale de
        // 12 en adelante.
        className="ink-soft pt-1 t-meta leading-relaxed"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <span className="pt-3 block">
          De cada carta te queda siempre una copia en el álbum: sólo se publican
          las que te sobran, graduadas incluidas. Y no puedes tener más de{" "}
          {MAX_ANUNCIOS_ABIERTOS} anuncios abiertos a la vez
          {anunciosAbiertos > 0 ? ` (ahora tienes ${anunciosAbiertos})` : ""}.
        </span>
      </li>
    </ul>
  );
}
