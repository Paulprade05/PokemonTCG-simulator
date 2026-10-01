"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  aceptarPeticion,
  bloquearEntrenador,
  cancelarPeticion,
  desbloquear,
  enviarPeticion,
  getFichaEntrenador,
  rechazarPeticion,
} from "../../app/social";
import type { Destino, FichaEntrenador, MotivoSinFicha } from "../../utils/tiposSocial";
import { useHaptics } from "../../hooks/useHaptics";
import { useSocialPendientes } from "../../hooks/useSocialPendientes";
import { cifraCorta } from "../../utils/format";
import { useToast } from "../ui/Toast";
import AvatarEntrenador from "./AvatarEntrenador";
import { SIN_CONEXION } from "./utilidades";
import { esAccionCaducada } from "../../utils/versionApp";

/**
 * LA FICHA DE UN ENTRENADOR: QUIÉN ES, QUÉ HAY ENTRE LOS DOS Y EL BOTÓN QUE TOCA.
 *
 * Es UNA pieza para los sitios desde los que se llega a alguien que aún no es
 * amigo —el vendedor de un anuncio del bazar y la página de una invitación—,
 * porque antes no había ninguna: desde el bazar había que ir a Social y buscar
 * «Marta» esperando que no hubiera dos, y un enlace a /trainer/[id] no tenía ni
 * botón de añadir.
 *
 * SÓLO RECIBE UN `Destino` (un código, un anuncio o un id de ruta) y pregunta
 * al servidor con `getFichaEntrenador`, que devuelve nombre, etiqueta y tres
 * números. El id de Clerk del otro no pasa por aquí salvo que ya sea amigo
 * (`amigoId`, para «Ver álbum»).
 *
 * NUNCA ESCRIBE NADA AL MONTARSE. Cargar la ficha es una lectura; enviar,
 * aceptar, cancelar o bloquear piden siempre un toque. Importa sobre todo en
 * la invitación: abrir un enlace no puede convertirse en una petición.
 *
 * UNA SOLA ACCIÓN A LA VEZ. El cerrojo es un ref (el estado no se ve hasta el
 * siguiente render) y el estado sólo apaga los botones: dos toques rápidos en
 * «Añadir» no lanzan dos peticiones.
 */

type Carga =
  | { clave: string; fase: "lista"; ficha: FichaEntrenador }
  | { clave: string; fase: "sin"; motivo: MotivoSinFicha; error: string };

interface PanelEntrenadorProps {
  destino: Destino;
  /** Algo ha cambiado entre los dos: quien tenga listas detrás las refresca. */
  onCambio?: () => void;
  /** Se va a salir de aquí («Ver álbum»): la hoja que lo contiene se cierra. */
  onNavegar?: () => void;
  /**
   * Qué pintar cuando no hay ficha. La invitación tiene su propio texto para
   * «este código ya no vale»; sin esta prop sale un aviso corto con reintento.
   */
  sinFicha?: (motivo: MotivoSinFicha, reintentar: () => void) => ReactNode;
  /**
   * Avisa de cómo ha terminado la carga: `null` si hay ficha, o el motivo por
   * el que no la hay. La invitación lo usa para no ofrecer «Copiar código» de
   * un código que el servidor acaba de decir que no existe.
   */
  onResuelta?: (motivo: MotivoSinFicha | null) => void;
}

export default function PanelEntrenador({
  destino,
  onCambio,
  onNavegar,
  sinFicha,
  onResuelta,
}: PanelEntrenadorProps) {
  const toast = useToast();
  const haptic = useHaptics();
  const { refrescar: refrescarInsignia } = useSocialPendientes();

  /* El destino llega como objeto y quien lo pasa suele crearlo en cada render:
   * se reduce a sus tres campos primitivos para que los efectos dependan de
   * QUIÉN es y no de la identidad del objeto. */
  const codigo = "codigo" in destino ? destino.codigo : null;
  const anuncioId = "anuncioId" in destino ? destino.anuncioId : null;
  const entrenadorId = "entrenadorId" in destino ? destino.entrenadorId : null;
  const estable = useMemo<Destino>(
    () =>
      codigo !== null ? { codigo } : anuncioId !== null ? { anuncioId } : { entrenadorId: entrenadorId ?? "" },
    [codigo, anuncioId, entrenadorId],
  );

  const [intento, setIntento] = useState(0);
  const clave = [codigo ?? "", anuncioId ?? "", entrenadorId ?? "", intento].join("/");
  const [carga, setCarga] = useState<Carga | null>(null);
  // La carga de OTRO destino (o de un intento anterior) no es la de éste: se
  // deriva en vez de borrarla en un efecto, y así no hay un fotograma con la
  // ficha de la persona anterior.
  const actual = carga && carga.clave === clave ? carga : null;

  // Por ref: quien pasa el aviso suele crearlo en cada render, y no por eso
  // hay que volver a pedir la ficha.
  const onResueltaRef = useRef(onResuelta);
  useEffect(() => {
    onResueltaRef.current = onResuelta;
  }, [onResuelta]);

  useEffect(() => {
    let cancelado = false;
    getFichaEntrenador(estable)
      .then((r) => {
        if (cancelado) return;
        setCarga(
          r.ok
            ? { clave, fase: "lista", ficha: r.ficha }
            : { clave, fase: "sin", motivo: r.motivo, error: r.error },
        );
        onResueltaRef.current?.(r.ok ? null : r.motivo);
      })
      .catch((e) => {
        console.error(e);
        if (cancelado) return;
        setCarga({ clave, fase: "sin", motivo: "error", error: SIN_CONEXION });
        onResueltaRef.current?.("error");
      });
    return () => {
      cancelado = true;
    };
  }, [estable, clave]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  const cerrojoRef = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  /** El aviso de bloquear vive DENTRO del panel: ver la nota en el JSX. */
  const [confirmandoBloqueo, setConfirmandoBloqueo] = useState(false);

  const parchear = useCallback((cambios: Partial<FichaEntrenador>) => {
    setCarga((previa) =>
      previa && previa.fase === "lista" ? { ...previa, ficha: { ...previa.ficha, ...cambios } } : previa,
    );
  }, []);

  /** Vuelve a leer la ficha SIN esqueleto: lo que hay en pantalla se queda
   *  hasta que llega lo nuevo. Si falla, se conserva lo que había. */
  const releer = useCallback(async () => {
    try {
      const r = await getFichaEntrenador(estable);
      if (r.ok) setCarga({ clave, fase: "lista", ficha: r.ficha });
    } catch {
      // Lo que ya se pinta sigue valiendo.
    }
  }, [estable, clave]);

  const ejecutar = useCallback(
    async (trabajo: () => Promise<void>) => {
      if (cerrojoRef.current) return;
      cerrojoRef.current = true;
      setOcupado(true);
      try {
        await trabajo();
      } catch (e) {
        console.error(e);
        if (!esAccionCaducada(e)) toast(SIN_CONEXION, "error");
      } finally {
        cerrojoRef.current = false;
        setOcupado(false);
      }
    },
    [toast],
  );

  if (!actual) return <Esqueleto />;

  if (actual.fase === "sin") {
    if (sinFicha) return <>{sinFicha(actual.motivo, reintentar)}</>;
    return (
      <div className="flex min-h-[12rem] flex-col items-center justify-center gap-3 py-6 text-center">
        <p className="ink-soft t-cuerpo">{actual.error}</p>
        {actual.motivo === "error" && (
          <button
            type="button"
            onClick={reintentar}
            className="btn-accent press control-44 t-cuerpo rounded-xl px-6 font-semibold"
          >
            Reintentar
          </button>
        )}
      </div>
    );
  }

  const { ficha } = actual;
  const { nombre, relacion, peticionId } = ficha;

  const anadir = () =>
    ejecutar(async () => {
      haptic("select");
      const r = await enviarPeticion(estable);
      if (!r.ok) {
        toast(r.error, "error");
        await releer();
        return;
      }
      if (r.estado === "amigos") {
        // Había una petición suya esperándome: añadirle ha sido aceptarla.
        toast(`Ahora eres amigo de ${r.nombre}`, "success");
        parchear({ relacion: "amigos", peticionId: r.peticionId });
        refrescarInsignia();
        // `amigoId` (para «Ver álbum») sólo lo da el servidor, y sólo ahora.
        await releer();
      } else {
        toast(`Petición enviada a ${r.nombre}`, "success");
        parchear({ relacion: "enviada", peticionId: r.peticionId });
      }
      onCambio?.();
    });

  const cancelar = () =>
    ejecutar(async () => {
      if (peticionId === null) return;
      haptic("tap");
      const r = await cancelarPeticion(peticionId);
      if (!r.ok) {
        toast(r.error, "error");
        await releer();
        return;
      }
      toast("Petición cancelada", "info");
      parchear({ relacion: "ninguna", peticionId: null });
      onCambio?.();
    });

  const aceptar = () =>
    ejecutar(async () => {
      if (peticionId === null) return;
      haptic("select");
      const r = await aceptarPeticion(peticionId);
      if (!r.ok) {
        toast(r.error, "error");
        await releer();
        return;
      }
      toast(`Ahora eres amigo de ${r.nombre}`, "success");
      parchear({ relacion: "amigos" });
      refrescarInsignia();
      await releer();
      onCambio?.();
    });

  const rechazar = () =>
    ejecutar(async () => {
      if (peticionId === null) return;
      haptic("tap");
      const r = await rechazarPeticion(peticionId);
      if (!r.ok) {
        toast(r.error, "error");
        await releer();
        return;
      }
      toast(`Petición de ${nombre} rechazada`, "info");
      // Para quien rechaza no queda nada entre los dos: puede añadirle luego.
      parchear({ relacion: "ninguna", peticionId: null });
      refrescarInsignia();
      onCambio?.();
    });

  const bloquear = () =>
    ejecutar(async () => {
      haptic("warning");
      const r = await bloquearEntrenador(estable);
      setConfirmandoBloqueo(false);
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      toast(`Has bloqueado a ${nombre}`, "info");
      parchear({ relacion: "bloqueado", peticionId: null, amigoId: null });
      refrescarInsignia();
      // El id del bloqueo (para «Desbloquear») sólo lo sabe el servidor.
      await releer();
      onCambio?.();
    });

  const levantarBloqueo = () =>
    ejecutar(async () => {
      if (peticionId === null) return;
      haptic("tap");
      const r = await desbloquear(peticionId);
      if (!r.ok) {
        toast(r.error, "error");
        await releer();
        return;
      }
      toast(`${nombre} ya no está bloqueado`, "info");
      parchear({ relacion: "ninguna", peticionId: null });
      onCambio?.();
    });

  const cifras = [
    { rotulo: "Únicas", valor: ficha.unicas },
    { rotulo: "Cartas", valor: ficha.cartas },
    { rotulo: "En común", valor: ficha.enComun },
  ];

  const botonPrincipal =
    "btn-accent press control-44 t-cuerpo w-full rounded-xl px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50";
  const botonSecundario =
    "btn-ghost press control-44 t-cuerpo w-full rounded-xl px-4 font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <AvatarEntrenador nombre={nombre} etiqueta={ficha.etiqueta} tam="lg" destacado={relacion === "yo"} />

      <div className="max-w-full min-w-0">
        {/* Dos líneas como mucho y corte dentro de la palabra: Clerk admite
            nombres de 64 caracteres sin un espacio. */}
        <p className="t-titulo line-clamp-2 font-bold break-all">{nombre}</p>
        {ficha.etiqueta && <p className="ink-soft t-cuerpo-2 mt-0.5">#{ficha.etiqueta}</p>}
      </div>

      <div className="grid w-full grid-cols-3 gap-2">
        {cifras.map((c) => (
          // px-1: «EN COMÚN» mide 67 px con su espaciado, y en la página de la
          // invitación a 320 px cada tesela se queda en 80.
          <div key={c.rotulo} className="surface-2 min-w-0 rounded-2xl px-1 py-2.5">
            <p className="t-etiqueta ink-soft truncate">{c.rotulo}</p>
            <p className="t-base tnum mt-0.5 truncate font-bold">{cifraCorta(c.valor)}</p>
          </div>
        ))}
      </div>

      {/* aria-live: al añadir o aceptar, lo que cambia es este bloque, y sin la
          región viva un lector de pantalla no se entera de que ha funcionado. */}
      <div aria-live="polite" className="flex w-full flex-col gap-2">
        {confirmandoBloqueo ? (
          /* LA CONFIRMACIÓN VA AQUÍ DENTRO Y NO EN OTRA HOJA. Este panel ya
             vive dentro de una hoja (o de una página con su botón principal a
             la vista): abrir una segunda hoja encima apila dos telones y dos
             trampas de foco para decir tres líneas. El paso ocupa el sitio de
             los botones, que es donde ya está el dedo. */
          <>
            <p className="t-cuerpo font-semibold break-words">¿Bloquear a {nombre}?</p>
            <p className="ink-soft t-cuerpo-2 leading-relaxed">
              No podrá enviarte peticiones ni ofertas y dejaréis de veros en el buscador. Si sois
              amigos dejaréis de serlo, y las ofertas pendientes entre los dos se cancelan. Puedes
              deshacerlo en Social, en la lista de bloqueados.
            </p>
            <button
              type="button"
              onClick={bloquear}
              disabled={ocupado}
              aria-busy={ocupado}
              className="press control-44 t-cuerpo w-full rounded-xl px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                background: "color-mix(in srgb, var(--danger) 16%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                // --danger-ink: es texto, y --danger es el token de fondo.
                color: "var(--danger-ink)",
              }}
            >
              Bloquear
            </button>
            <button
              type="button"
              onClick={() => setConfirmandoBloqueo(false)}
              disabled={ocupado}
              className={botonSecundario}
            >
              No bloquear
            </button>
          </>
        ) : (
          <>
            {relacion === "yo" && (
              <p className="ink-soft t-cuerpo">
                Este eres tú. Comparte tu código para que otros entrenadores te envíen una petición.
              </p>
            )}

            {relacion === "ninguna" && (
              <button type="button" onClick={anadir} disabled={ocupado} aria-busy={ocupado} className={botonPrincipal}>
                {/* El nombre trunca DENTRO del botón: «Añadir a» se lee siempre. */}
                <span className="shrink-0">{ocupado ? "Enviando…" : "Añadir a"}</span>
                {!ocupado && <span className="ml-1 truncate">{nombre}</span>}
              </button>
            )}

            {relacion === "enviada" && (
              <>
                <p className="t-cuerpo font-semibold">Petición enviada</p>
                <p className="ink-soft t-cuerpo-2">Te avisaremos en la pestaña Social cuando acepte.</p>
                {/* Sin id no hay nada que cancelar: el servidor contesta
                    «enviada» sin escribir cuando el otro no admite peticiones. */}
                {peticionId !== null && (
                  <button
                    type="button"
                    onClick={cancelar}
                    disabled={ocupado}
                    aria-busy={ocupado}
                    className={botonSecundario}
                  >
                    Cancelar petición
                  </button>
                )}
              </>
            )}

            {relacion === "recibida" && (
              <>
                <p className="t-cuerpo font-semibold">Quiere ser tu amigo</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={aceptar}
                    disabled={ocupado}
                    aria-busy={ocupado}
                    className={botonPrincipal}
                  >
                    Aceptar
                  </button>
                  <button type="button" onClick={rechazar} disabled={ocupado} className={botonSecundario}>
                    Rechazar
                  </button>
                </div>
              </>
            )}

            {relacion === "amigos" && (
              <>
                <p className="t-cuerpo font-semibold">Ya sois amigos</p>
                {ficha.amigoId && (
                  <Link href={`/trainer/${ficha.amigoId}`} onClick={onNavegar} className={botonPrincipal}>
                    Ver álbum
                  </Link>
                )}
              </>
            )}

            {relacion === "bloqueado" && (
              <>
                <p className="ink-soft t-cuerpo">
                  Has bloqueado a este entrenador: no puede enviarte peticiones ni ofertas.
                </p>
                {peticionId !== null && (
                  <button
                    type="button"
                    onClick={levantarBloqueo}
                    disabled={ocupado}
                    aria-busy={ocupado}
                    className={botonSecundario}
                  >
                    Desbloquear
                  </button>
                )}
              </>
            )}

            {relacion !== "yo" && relacion !== "bloqueado" && (
              <button
                type="button"
                onClick={() => {
                  haptic("tap");
                  setConfirmandoBloqueo(true);
                }}
                disabled={ocupado}
                className="ink-soft press-flat t-cuerpo-2 mx-auto min-h-11 px-4 underline underline-offset-2 disabled:opacity-50"
              >
                Bloquear
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * El hueco mientras llega la ficha, con el alto de la ficha: la hoja se abre ya
 * a su tamaño en vez de crecer cuando contesta el servidor (el salto movía el
 * botón de añadir justo cuando el dedo iba hacia él).
 */
function Esqueleto() {
  return (
    <div
      className="flex min-h-[19rem] flex-col items-center gap-4"
      aria-busy="true"
      aria-label="Cargando entrenador"
      role="status"
    >
      <div className="skeleton h-16 w-16 rounded-full" />
      <div className="skeleton h-6 w-40 rounded-lg" />
      <div className="grid w-full grid-cols-3 gap-2">
        <div className="skeleton h-[60px] rounded-2xl" />
        <div className="skeleton h-[60px] rounded-2xl" />
        <div className="skeleton h-[60px] rounded-2xl" />
      </div>
      <div className="skeleton h-11 w-full rounded-xl" />
    </div>
  );
}
