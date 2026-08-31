"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  comprarEnBazarAction,
  getBazar,
  getMisAnunciosBazar,
  getProfileStats,
  retirarDelBazarAction,
} from "../action";
import { SOBRES_PARA_VENDER } from "../../utils/bazar";
import { formatNumber } from "../../utils/format";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import MisAnuncios from "../../components/bazar/MisAnuncios";
import PublicarSheet from "../../components/bazar/PublicarSheet";
import ReglasBazar from "../../components/bazar/ReglasBazar";
import TarjetaAnuncio from "../../components/bazar/TarjetaAnuncio";
import type { AnuncioBazar, MiAnuncio } from "../../components/bazar/tipos";

/* ==================================================================== *
 * EL BAZAR ENTRE JUGADORES
 * ====================================================================
 *
 * QUÉ ES Y EN QUÉ SE DIFERENCIA DE /mercado, porque comparten pestaña y es la
 * primera pregunta que se hace cualquiera: en el mercado el que compra es la
 * MÁQUINA (un tablón de encargos que paga una prima por lotes de duplicados);
 * aquí la contraparte es OTRA PERSONA. Uno publica una carta suya y otro la
 * paga con sus monedas. Es el único sitio del juego donde el dinero cambia de
 * dueño.
 *
 * Y por eso esta pantalla está construida alrededor de tres avisos y un
 * cerrojo:
 *
 *  · LOS TRES AVISOS (precio acotado, comisión del 15 %, 25 sobres para poder
 *    vender) se pintan ANTES de tocar nada, en components/bazar/ReglasBazar.tsx.
 *    Son defensas anti-multicuenta —el porqué medido está en utils/bazar.ts— y
 *    el jugador honesto las sufre igual, así que la única salida decente es que
 *    las lea antes y no en el mensaje de error de un servidor que ya le ha
 *    dicho que no.
 *
 *  · EL CERROJO es `dineroLockRef`. Comprar mueve monedas de una cuenta a otra:
 *    dos toques seguidos en el mismo botón —o en dos anuncios distintos— no
 *    pueden entrar los dos. Es el mismo patrón que `saleLockRef` en
 *    app/collection/page.tsx y por el mismo motivo: `setState` no se ve hasta
 *    el siguiente render, así que el estado NO sirve de cerrojo.
 *
 * EL INVITADO PUEDE MIRAR. `getBazar` funciona sin sesión a propósito (es un
 * escaparate), así que la pantalla entera se pinta y lo que se apaga son los
 * botones, con su explicación. Enseñarle una puerta cerrada es mejor que
 * esconderle que el bazar existe.
 */

/**
 * Anuncios por página. LO FIJA EL SERVIDOR (`POR_PAGINA` dentro de `getBazar`,
 * app/action.ts:3500) y no está exportado, así que aquí se repite con el nombre
 * a la vista en lugar de un 40 suelto en medio de una condición.
 *
 * QUÉ PASA SI SE DESINCRONIZAN, que es lo que hay que saber antes de tocarlo: el
 * único uso es decidir si se ofrece el botón de "siguiente". Si aquí quedara un
 * número mayor, el botón no saldría nunca y se perderían páginas; si quedara
 * menor, llevaría a una página vacía, que tiene su propio mensaje y su botón de
 * volver. Ninguno de los dos rompe nada, pero el primero esconde anuncios.
 */
const POR_PAGINA = 40;

const ERRORES_COMPRA: Record<string, string> = {
  "es-tuyo": "Ese anuncio es tuyo: no puedes comprarte a ti mismo.",
  /* La barrera del comprador. El servidor devuelve además `faltan`, que es lo
   * que de verdad quiere saber quien se topa con esto; el mensaje con el número
   * lo compone quien recibe la respuesta, y esto es sólo el respaldo por si
   * llegara sin él. Ver SOBRES_PARA_COMPRAR en utils/bazar.ts: existe porque el
   * lavado de monedas entre dos cuentas de la misma persona pasa por la compra,
   * no por la venta. */
  novato: "Abre unos cuantos sobres más antes de comprar en el bazar.",
  /* El servidor no distingue los dos casos a propósito: la compra entera es una
   * sola sentencia y, si no sale, no puede decir cuál de las dos condiciones
   * falló sin volver a consultar. Se dicen las dos, que es lo honesto. */
  "no-disponible":
    "No se pudo comprar: o se la ha llevado otro antes, o no te llega el saldo.",
  "no-existe": "Ese anuncio ya no está a la venta.",
  "no-autorizado": "Inicia sesión para comprar en el bazar.",
  peticion: "Esa compra no es válida.",
  servidor: "No se pudo completar la compra. No se ha movido nada.",
};

const ERRORES_RETIRAR: Record<string, string> = {
  "no-existe": "Ese anuncio ya no estaba en venta.",
  "no-autorizado": "Inicia sesión para gestionar tus anuncios.",
  peticion: "Esa retirada no es válida.",
  servidor: "No se pudo retirar el anuncio. Inténtalo de nuevo.",
};

type Vista = "escaparate" | "mios";

export default function BazarPage() {
  const { isSignedIn, isLoaded } = useUser();
  const { coins, setCoins } = useCurrency();
  const toast = useToast();
  const haptic = useHaptics();

  const [estado, setEstado] = useState<"cargando" | "listo" | "error">("cargando");
  const [vista, setVista] = useState<Vista>("escaparate");
  const [anuncios, setAnuncios] = useState<AnuncioBazar[]>([]);
  const [pagina, setPagina] = useState(0);
  const [mios, setMios] = useState<MiAnuncio[]>([]);
  /** Sobres abiertos. `null` = todavía no se sabe; ver `cargarSobres`. */
  const [sobres, setSobres] = useState<number | null>(null);

  const [publicarAbierto, setPublicarAbierto] = useState(false);
  const [confirmarCompra, setConfirmarCompra] = useState<AnuncioBazar | null>(null);
  const [confirmarRetirada, setConfirmarRetirada] = useState<{
    id: number;
    name: string;
  } | null>(null);

  /** Id del anuncio con una operación en vuelo (para su propio botón). */
  const [enCurso, setEnCurso] = useState<number | null>(null);
  /**
   * EL CERROJO DE DINERO. Uno solo para comprar y retirar: mientras algo se
   * mueve, no se mueve nada más en esta pantalla. Es un ref y no un estado
   * porque el estado no se ve hasta el siguiente render y dos toques seguidos
   * entrarían los dos — el fallo que documenta app/collection/page.tsx:78-98.
   */
  const dineroLockRef = useRef(false);

  /**
   * Lee una página del escaparate.
   *
   * SI FALLA, LA PANTALLA SE VA AL ESTADO DE ERROR AUNQUE YA HUBIERA ANUNCIOS
   * PINTADOS, y es a propósito. Casi todas las recargas de aquí vienen DESPUÉS
   * de mover algo (una compra, una retirada), o sea que la lista que hay en
   * pantalla ya se sabe caducada: el anuncio que se acaba de comprar ya no
   * existe. Dejarla puesta invitaría a comprar por segunda vez algo que no
   * está. Se pierde la vista, sí, pero el botón de reintentar es un camino de
   * vuelta claro y lo que se enseña no miente.
   */
  const cargarEscaparate = useCallback(
    async (p: number, conSpinner = true) => {
      if (conSpinner) setEstado("cargando");
      try {
        const res = await getBazar(p);
        if (!res.ok) {
          setEstado("error");
          return;
        }
        setAnuncios(res.anuncios as AnuncioBazar[]);
        setPagina(p);
        setEstado("listo");
      } catch (e) {
        console.error("Error cargando el bazar:", e);
        setEstado("error");
      }
    },
    [],
  );

  /** Mis anuncios. Sin sesión no hay nada que pedir. */
  const cargarMios = useCallback(async () => {
    if (!isSignedIn) {
      setMios([]);
      return;
    }
    try {
      const res = await getMisAnunciosBazar();
      if (res.ok) setMios(res.anuncios as MiAnuncio[]);
    } catch (e) {
      // No se corta la pantalla por esto: el escaparate se lee igual y la
      // pestaña de anuncios propios se queda vacía hasta el siguiente intento.
      console.error("Error cargando mis anuncios:", e);
    }
  }, [isSignedIn]);

  /**
   * Sobres abiertos, para poder APAGAR el botón de vender en vez de dejar que
   * falle. Es la única fuente que hay: `packs_opened` sólo sale al cliente por
   * `getProfileStats`.
   *
   * VA SUELTO Y SIN BLOQUEAR EL PINTADO. Esa acción recorre la colección entera
   * para calcular patrimonio y expansiones completas, y aquí sólo se quiere un
   * número; metida en el `Promise.all` de la carga inicial, el escaparate
   * esperaría por ella. Mientras no se sepa (`null`), el botón se deja
   * ENCENDIDO: el servidor sigue comprobándolo y devuelve `faltan`, así que el
   * peor caso es un mensaje con el número exacto en vez de un botón apagado sin
   * explicación.
   */
  const cargarSobres = useCallback(async () => {
    if (!isSignedIn) {
      setSobres(null);
      return;
    }
    try {
      const stats = await getProfileStats();
      if (stats) setSobres(Number(stats.packsOpened) || 0);
    } catch (e) {
      console.error("Error leyendo los sobres abiertos:", e);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (!isLoaded) return;
    cargarEscaparate(0);
    cargarMios();
    cargarSobres();
  }, [isLoaded, cargarEscaparate, cargarMios, cargarSobres]);

  /**
   * Anuncios activos POR CARTA. Es lo que necesita el selector de publicar para
   * no ofrecer copias ya comprometidas: el servidor exige
   * `copias > activos_de_esa_carta + 1` (la copia que siempre se queda en el
   * álbum), así que sin esta cuenta se ofrecería una carta que va a fallar.
   */
  const activasPorCarta = useMemo(() => {
    const mapa = new Map<string, number>();
    for (const a of mios) {
      if (a.estado !== "activa") continue;
      mapa.set(a.cardId, (mapa.get(a.cardId) ?? 0) + 1);
    }
    return mapa;
  }, [mios]);

  const anunciosAbiertos = useMemo(
    () => mios.filter((a) => a.estado === "activa").length,
    [mios],
  );

  const faltanSobres =
    sobres === null ? null : Math.max(0, SOBRES_PARA_VENDER - sobres);
  // Encendido mientras no se sepa: ver el comentario de `cargarSobres`.
  const puedePublicar = Boolean(isSignedIn) && (faltanSobres === null || faltanSobres === 0);

  const comprar = async (anuncio: AnuncioBazar) => {
    if (dineroLockRef.current) return;
    dineroLockRef.current = true;
    setEnCurso(anuncio.id);
    try {
      const res = await comprarEnBazarAction(anuncio.id);
      if (!res.ok) {
        haptic("warning");
        /* Con "novato" el servidor manda además cuántos sobres faltan, y decir
         * el número es la diferencia entre una norma y un muro: "te faltan 7"
         * se entiende y se puede cumplir hoy mismo. */
        const mensaje =
          res.error === "novato" && "faltan" in res && typeof res.faltan === "number"
            ? `Te faltan ${res.faltan} ${res.faltan === 1 ? "sobre" : "sobres"} por abrir para poder comprar en el bazar.`
            : (ERRORES_COMPRA[res.error] ?? "No se pudo comprar.");
        toast(mensaje, "error");
        /* Cualquier desajuste (se lo llevó otro, el anuncio ya no existe) se
         * arregla releyendo el escaparate. Con "peticion" no: ahí el que está
         * mal es el id que se mandó, y recargar no cambiaría nada. */
        if (res.error !== "peticion") await cargarEscaparate(pagina, false);
        return;
      }
      haptic("success");
      // El saldo es el que devuelve el servidor, no una resta optimista: es el
      // mismo criterio que la venta de duplicados de la colección.
      setCoins(res.coins);
      toast(
        `${anuncio.name} es tuya · −${formatNumber(res.precio)} monedas`,
        "success",
      );
      // OBLIGATORIO recargar: ese anuncio ya no existe y dejarlo pintado
      // invitaría a comprarlo otra vez.
      await cargarEscaparate(pagina, false);
    } catch (e) {
      console.error("Error comprando en el bazar:", e);
      haptic("warning");
      toast("No se pudo comprar. Revisa tu conexión.", "error");
    } finally {
      dineroLockRef.current = false;
      setEnCurso(null);
    }
  };

  const retirar = async (id: number) => {
    if (dineroLockRef.current) return;
    dineroLockRef.current = true;
    setEnCurso(id);
    try {
      const res = await retirarDelBazarAction(id);
      if (!res.ok) {
        haptic("warning");
        toast(ERRORES_RETIRAR[res.error] ?? "No se pudo retirar.", "error");
      } else {
        haptic("success");
        toast("Anuncio retirado. La carta sigue en tu álbum.", "success");
      }
      // En los dos casos: si falló porque ya estaba cerrado, la lista pintada
      // es la que miente.
      await Promise.all([cargarMios(), cargarEscaparate(pagina, false)]);
    } catch (e) {
      console.error("Error retirando el anuncio:", e);
      toast("No se pudo retirar el anuncio. Revisa tu conexión.", "error");
    } finally {
      dineroLockRef.current = false;
      setEnCurso(null);
    }
  };

  const irAPagina = (siguiente: number) => {
    haptic("tap");
    cargarEscaparate(Math.max(0, siguiente), false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (estado === "cargando" && anuncios.length === 0) {
    return <Loader label="Abriendo el bazar" />;
  }

  if (estado === "error") {
    return (
      <>
        <PageHeader title="Bazar" subtitle="Cartas que ponen a la venta otros jugadores" />
        <div className="surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center">
          <p className="ink-soft text-sm">No se pudo cargar el escaparate.</p>
          <button
            type="button"
            onClick={() => cargarEscaparate(pagina)}
            className="btn-accent press touch-target flex items-center justify-center rounded-xl px-6 text-sm font-semibold"
          >
            Reintentar
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Bazar"
        subtitle="Cartas que ponen a la venta otros jugadores"
        actions={
          <>
            <button
              type="button"
              onClick={() => {
                haptic("tap");
                cargarEscaparate(pagina, false);
                cargarMios();
              }}
              aria-label="Actualizar el escaparate"
              className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            {isSignedIn && (
              <button
                type="button"
                onClick={() => {
                  haptic("tap");
                  setPublicarAbierto(true);
                }}
                disabled={!puedePublicar}
                // El texto va oculto en móvil con `hidden` (display:none), que
                // lo saca del árbol de accesibilidad: sin esta etiqueta el
                // botón se quedaría sin nombre. Y cuando está apagado, la
                // etiqueta dice POR QUÉ.
                aria-label={
                  puedePublicar
                    ? "Publicar una carta en el bazar"
                    : `Te faltan ${faltanSobres} sobres para poder vender`
                }
                className="btn-accent press touch-target flex items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span className="hidden sm:inline">Vender</span>
              </button>
            )}
          </>
        }
      />

      <div className="flex w-full flex-col gap-4">
        {!isSignedIn && (
          <div
            className="surface flex items-start gap-3 rounded-2xl p-4"
            style={{ borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--warn)" }} aria-hidden="true">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Estás jugando como invitado</p>
              <p className="ink-soft mt-1 text-xs leading-relaxed">
                Puedes mirar el escaparate, pero comprar y vender mueven monedas
                y cartas entre cuentas: eso ocurre en el servidor y las tuyas
                viven sólo en este dispositivo.{" "}
                <Link href="/" className="accent font-medium underline underline-offset-2">
                  Ir al inicio
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Las tres reglas, en corto y sin desplegar nada: quien entra a comprar
            tiene que ver de qué va esto sin leerse un manual, y quien entra a
            vender se encuentra ya contado por qué el botón de arriba está
            apagado si le faltan sobres. */}
        <ReglasBazar sobresAbiertos={sobres} />

        {isSignedIn && (
          <div className="surface-2 flex gap-1.5 rounded-2xl p-1.5">
            {(
              [
                ["escaparate", "Escaparate"],
                ["mios", `Mis anuncios${anunciosAbiertos > 0 ? ` · ${anunciosAbiertos}` : ""}`],
              ] as const
            ).map(([clave, rotulo]) => (
              <button
                key={clave}
                type="button"
                onClick={() => {
                  haptic("tap");
                  setVista(clave);
                }}
                aria-pressed={vista === clave}
                className={`press touch-target flex-1 rounded-xl text-[12px] font-semibold ${
                  vista === clave ? "btn-primary" : "ink-soft"
                }`}
              >
                {rotulo}
              </button>
            ))}
          </div>
        )}

        {vista === "mios" && isSignedIn ? (
          <MisAnuncios
            anuncios={mios}
            enCurso={enCurso}
            bloqueada={enCurso !== null}
            onRetirar={(a) => {
              haptic("tap");
              setConfirmarRetirada({ id: a.id, name: a.name });
            }}
            onPublicar={() => setPublicarAbierto(true)}
            puedePublicar={puedePublicar}
          />
        ) : anuncios.length === 0 ? (
          <div className="surface flex flex-col items-center gap-3 rounded-2xl px-6 py-16 text-center">
            <p className="text-sm font-semibold">
              {pagina === 0 ? "El bazar está vacío" : "No hay más anuncios"}
            </p>
            <p className="ink-soft max-w-xs text-xs leading-relaxed">
              {pagina === 0
                ? "Todavía no hay nadie vendiendo. Si tienes cartas repetidas, puedes ser el primero."
                : "Has llegado al final de la lista."}
            </p>
            {pagina > 0 && (
              <button
                type="button"
                onClick={() => irAPagina(pagina - 1)}
                className="btn-ghost press touch-target flex items-center justify-center rounded-xl px-5 text-sm font-medium"
              >
                Volver
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Dos columnas en móvil y no tres como la colección: aquí cada
                celda lleva además precio, vendedor y un botón de 44px, y a tres
                columnas el botón de comprar —el que mueve dinero— quedaba en
                una tira de texto ilegible. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-5">
              {anuncios.map((a) => (
                <TarjetaAnuncio
                  key={a.id}
                  anuncio={a}
                  saldo={coins}
                  puedeComprar={Boolean(isSignedIn)}
                  enCurso={enCurso === a.id}
                  bloqueada={enCurso !== null && enCurso !== a.id}
                  onComprar={() => {
                    haptic("tap");
                    setConfirmarCompra(a);
                  }}
                  onRetirar={() => {
                    haptic("tap");
                    setConfirmarRetirada({ id: a.id, name: a.name });
                  }}
                />
              ))}
            </div>

            {(pagina > 0 || anuncios.length === POR_PAGINA) && (
              <div className="flex items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => irAPagina(pagina - 1)}
                  disabled={pagina === 0}
                  aria-label="Página anterior"
                  className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <span className="chip ink tnum px-4 py-2 text-sm font-medium">
                  Página {pagina + 1}
                </span>
                <button
                  type="button"
                  onClick={() => irAPagina(pagina + 1)}
                  disabled={anuncios.length < POR_PAGINA}
                  aria-label="Página siguiente"
                  className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* CONFIRMAR LA COMPRA. No es paternalismo: es el único gesto de toda la
          pantalla que gasta monedas de verdad y no se puede deshacer. La hoja
          dice el precio, lo que queda después y —si está graduada— la nota, que
          es lo que justifica lo que cuesta. */}
      <ConfirmSheet
        open={confirmarCompra !== null}
        title={confirmarCompra ? `Comprar ${confirmarCompra.name}` : "Comprar"}
        description={
          confirmarCompra
            ? `Pagas ${formatNumber(confirmarCompra.precio)} monedas${
                confirmarCompra.nota !== null
                  ? ` por una copia graduada con nota ${confirmarCompra.nota}`
                  : ""
              }. La carta pasa a tu colección al momento.${
                coins >= confirmarCompra.precio
                  ? ` Te quedarán ${formatNumber(coins - confirmarCompra.precio)}.`
                  : ""
              }`
            : undefined
        }
        confirmLabel={
          confirmarCompra ? `Pagar ${formatNumber(confirmarCompra.precio)}` : "Pagar"
        }
        onConfirm={() => {
          if (confirmarCompra) comprar(confirmarCompra);
        }}
        onClose={() => setConfirmarCompra(null)}
      />

      {/* Retirar no cuesta nada, pero deshace algo que el jugador hizo a
          propósito: se pregunta, y se dice que no se pierde la carta. */}
      <ConfirmSheet
        open={confirmarRetirada !== null}
        title="¿Retirar el anuncio?"
        description={
          confirmarRetirada
            ? `${confirmarRetirada.name} dejará de estar a la venta. La carta nunca salió de tu álbum, así que no pierdes nada y puedes volver a publicarla cuando quieras.`
            : undefined
        }
        confirmLabel="Retirar"
        destructive
        onConfirm={() => {
          if (confirmarRetirada) retirar(confirmarRetirada.id);
        }}
        onClose={() => setConfirmarRetirada(null)}
      />

      <PublicarSheet
        open={publicarAbierto}
        onClose={() => setPublicarAbierto(false)}
        activasPorCarta={activasPorCarta}
        sobresAbiertos={sobres}
        anunciosAbiertos={anunciosAbiertos}
        onNovato={(faltan) => {
          // El servidor manda: si dice que faltan N, el botón se apaga aunque
          // `getProfileStats` hubiera dicho otra cosa.
          setSobres(SOBRES_PARA_VENDER - faltan);
          setPublicarAbierto(false);
        }}
        onPublicada={() => {
          setPublicarAbierto(false);
          // A "mis anuncios": es donde se ve que el anuncio existe de verdad y
          // donde se puede retirar. En el escaparate quedaría enterrado entre
          // los de todos los demás.
          setVista("mios");
          cargarMios();
          cargarEscaparate(0, false);
        }}
      />
    </>
  );
}
