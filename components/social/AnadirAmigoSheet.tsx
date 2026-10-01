"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  buscarEntrenadores,
  enviarPeticion,
  getMiCodigoDeAmigo,
  regenerarCodigoDeAmigo,
} from "../../app/social";
import type { EntrenadorEncontrado, PeticionRecibida } from "../../utils/tiposSocial";
import { formatearCodigoAmigo, rutaDeInvitacion } from "../../utils/codigoAmigo";
import { formatNumber } from "../../utils/format";
import { useHaptics } from "../../hooks/useHaptics";
import CabeceraDeHoja from "../ui/CabeceraDeHoja";
import CampoBusqueda from "../ui/CampoBusqueda";
import Sheet from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import AvatarEntrenador from "./AvatarEntrenador";
import CodigoQR, { cabeEnQR } from "./CodigoQR";
import FilaPeticion from "./FilaPeticion";
import { SIN_CONEXION, copiarTexto } from "./utilidades";
import { esAccionCaducada } from "../../utils/versionApp";

/**
 * LA HOJA «AÑADIR AMIGO».
 *
 * La anterior tenía un buscador por nombre y, al fondo, «Tu ID»: el id de
 * Clerk, que se podía copiar pero no pegar en ningún sitio, porque el único
 * campo buscaba por nombre. Para añadir a un amigo que no está al lado había
 * que dictarle el nombre exacto y esperar que no hubiera dos iguales.
 *
 * LO QUE HAY AHORA, de arriba abajo:
 *
 *  1. LAS PETICIONES QUE TE HAN LLEGADO, si hay alguna. Dos amigos con el móvil
 *     en la mano tienen los dos esta hoja abierta: quien recibe la petición la
 *     contesta aquí mismo, sin salir a buscar el bloque de peticiones. Mientras
 *     la hoja está abierta se vuelve a preguntar cada pocos segundos.
 *  2. UN SOLO CAMPO, «Nombre o código». Admite el código tecleado (con o sin
 *     guion), el enlace pegado o el mensaje entero de «Compartir»: el servidor
 *     lo reconoce (utils/codigoAmigo.ts). Cada resultado lleva su `#2345` y su
 *     color, que es lo que distingue a dos «Paul».
 *  3. TU CÓDIGO, con «Compartir», «Copiar» y «QR».
 *
 * EL CAMPO VA ANTES QUE TU CÓDIGO, y no al revés, por el teclado: en un iPhone
 * pequeño, con el teclado abierto, a la hoja le quedan unos 260 px de alto. Con
 * el bloque del código arriba (200 px) el campo y sus resultados caían debajo
 * del borde y había que desplazar la hoja a ciegas para ver a quién se
 * añadía. Con el campo arriba los resultados salen justo debajo de lo que se
 * escribe, y sin teclado caben las dos cosas a la vez.
 *
 * SIN `autoFocus`: la hoja ya no es sólo un buscador. Abrir el teclado al
 * montarla tapaba el código, que es justo lo que se viene a compartir la mitad
 * de las veces.
 */

/** Cada cuánto se pregunta por peticiones nuevas con la hoja abierta. */
const SONDEO_MS = 5_000;
/** Y durante cuánto: una hoja olvidada abierta no sondea toda la tarde. */
const SONDEO_MAX_MS = 120_000;
/** Peticiones que se enseñan aquí; el resto está en la pestaña Amigos. */
const PETICIONES_A_LA_VISTA = 3;
/** Tope de lo que se manda a buscar: un mensaje pegado entero cabe de sobra. */
const MAX_CONSULTA = 400;

type Busqueda =
  | { consulta: string; fallo: null; resultados: EntrenadorEncontrado[]; hayMas: boolean; pareceCodigo: boolean }
  | { consulta: string; fallo: string };

interface AnadirAmigoSheetProps {
  open: boolean;
  onClose: () => void;
  /** Peticiones recibidas: las guarda la pantalla, aquí sólo se pintan. */
  recibidas: PeticionRecibida[];
  /** Ids de petición con una respuesta en vuelo. */
  ocupadas: ReadonlySet<number>;
  onAceptar: (peticion: PeticionRecibida) => void;
  onRechazar: (peticion: PeticionRecibida) => void;
  /** Volver a leer las peticiones. Lo llama el sondeo. */
  onSondear: () => void;
  /** Desde aquí se ha enviado una petición, o ha nacido una amistad. */
  onCambio: (que: "peticiones" | "amigos") => void;
}

const SIN_SUSCRIPCION = () => () => {};

export default function AnadirAmigoSheet({
  open,
  onClose,
  recibidas,
  ocupadas,
  onAceptar,
  onRechazar,
  onSondear,
  onCambio,
}: AnadirAmigoSheetProps) {
  const toast = useToast();
  const haptic = useHaptics();

  /* ---------- mi código ---------- */

  const [codigo, setCodigo] = useState<string | null>(null);
  const [errorCodigo, setErrorCodigo] = useState(false);
  const [cambiando, setCambiando] = useState(false);
  const [confirmandoCambio, setConfirmandoCambio] = useState(false);
  const [verQR, setVerQR] = useState(false);

  // Se pide la primera vez que la hoja se abre y se conserva: el código no
  // cambia entre dos aperturas, y `getMiCodigoDeAmigo` puede costar un
  // CREATE TABLE la primera vez que alguien lo llama.
  useEffect(() => {
    if (!open || codigo || errorCodigo) return;
    let cancelado = false;
    getMiCodigoDeAmigo()
      .then((r) => {
        if (cancelado) return;
        if (r.ok) setCodigo(r.codigo);
        else setErrorCodigo(true);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelado) setErrorCodigo(true);
      });
    return () => {
      cancelado = true;
    };
  }, [open, codigo, errorCodigo]);

  // El origen sólo existe en el navegador: el servidor y la hidratación ven la
  // cadena vacía y el enlace se compone después.
  const origen = useSyncExternalStore(
    SIN_SUSCRIPCION,
    () => window.location.origin,
    () => "",
  );
  const enlace = codigo && origen ? `${origen}${rutaDeInvitacion(codigo)}` : "";
  const hayQR = enlace !== "" && cabeEnQR(enlace);

  const compartir = async () => {
    if (!codigo || !enlace) return;
    haptic("tap");
    /* EL CÓDIGO Y EL ENLACE VIAJAN EN EL MISMO TEXTO, sin el campo `url`.
     *
     * Dos motivos. Con `text` y `url` por separado, en iOS hay aplicaciones de
     * destino que se quedan sólo con la URL y tiran el texto. Y el enlace se
     * abre en Safari, nunca en la app instalada, donde puede no haber sesión:
     * quien ya tiene la app necesita el CÓDIGO para teclearlo o pegarlo en
     * Social, así que tiene que llegar escrito sí o sí. El campo de esta misma
     * hoja reconoce el mensaje entero si se pega tal cual. */
    const mensaje = `Añádeme en TCG Sim. Mi código de amigo es ${formatearCodigoAmigo(codigo)}\n${enlace}`;
    // En escritorio `navigator.share` no existe (es undefined, no una función
    // que falle): se pregunta por el tipo y no se llama a ciegas.
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ text: mensaje });
        return;
      } catch (e) {
        // Cerrar la hoja de compartir sin elegir destino no es un fallo: no
        // se copia nada a espaldas de quien acaba de decir que no.
        if ((e as { name?: string } | null)?.name === "AbortError") return;
      }
    }
    if (await copiarTexto(mensaje)) toast("Enlace copiado", "success");
    else toast("No se pudo copiar. Mantén pulsado el código para copiarlo.", "error");
  };

  const copiar = async () => {
    if (!codigo) return;
    haptic("tap");
    if (await copiarTexto(formatearCodigoAmigo(codigo))) toast("Código copiado", "success");
    else toast("No se pudo copiar. Mantén pulsado el código para copiarlo.", "error");
  };

  const cambiarCodigo = async () => {
    if (cambiando) return;
    setCambiando(true);
    haptic("warning");
    try {
      const r = await regenerarCodigoDeAmigo();
      if (r.ok) {
        setCodigo(r.codigo);
        setConfirmandoCambio(false);
        toast("Código cambiado", "success");
      } else {
        toast(r.error, "error");
      }
    } catch (e) {
      console.error(e);
      if (!esAccionCaducada(e)) toast(SIN_CONEXION, "error");
    } finally {
      setCambiando(false);
    }
  };

  /* ---------- buscar ---------- */

  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState<Busqueda | null>(null);

  const texto = q.trim();
  const consulta = open && texto.length >= 2 && texto.length <= MAX_CONSULTA ? texto : null;
  // El resultado de OTRA consulta no es el de ésta: se deriva, y así «buscando»
  // no necesita un estado propio que alguien tenga que acordarse de apagar.
  const vigente = busqueda && busqueda.consulta === consulta ? busqueda : null;
  const buscando = consulta !== null && vigente === null;

  useEffect(() => {
    if (consulta === null) return;
    // Cancelar el temporizador no cancela la petición ya lanzada: sin esta
    // bandera, la respuesta lenta de un texto anterior pisaba la del actual.
    let cancelado = false;
    const espera = window.setTimeout(async () => {
      try {
        const r = await buscarEntrenadores(consulta);
        if (cancelado) return;
        setBusqueda(
          r.ok
            ? { consulta, fallo: null, resultados: r.resultados, hayMas: r.hayMas, pareceCodigo: r.pareceCodigo }
            : { consulta, fallo: r.error },
        );
      } catch (e) {
        console.error(e);
        if (!cancelado) setBusqueda({ consulta, fallo: "No se pudo buscar. Revisa tu conexión." });
      }
    }, 300);
    return () => {
      cancelado = true;
      window.clearTimeout(espera);
    };
  }, [consulta]);

  // Añadir en vuelo, por código. El ref es el cerrojo (dos toques seguidos no
  // lanzan dos peticiones) y el estado apaga el botón de esa fila.
  const enVueloRef = useRef<Set<string>>(new Set());
  const [enVuelo, setEnVuelo] = useState<ReadonlySet<string>>(new Set());

  const parchearFila = useCallback((codigoFila: string, cambios: Partial<EntrenadorEncontrado>) => {
    setBusqueda((previa) =>
      previa && previa.fallo === null
        ? {
            ...previa,
            resultados: previa.resultados.map((f) => (f.codigo === codigoFila ? { ...f, ...cambios } : f)),
          }
        : previa,
    );
  }, []);

  const anadir = async (fila: EntrenadorEncontrado) => {
    if (enVueloRef.current.has(fila.codigo)) return;
    enVueloRef.current.add(fila.codigo);
    setEnVuelo(new Set(enVueloRef.current));
    haptic("select");
    try {
      // Sirve también para «Aceptar»: si el otro ya me lo había pedido, el
      // servidor acepta su petición en vez de crear una cruzada.
      const r = await enviarPeticion({ codigo: fila.codigo });
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      if (r.estado === "amigos") {
        toast(`Ahora eres amigo de ${r.nombre}`, "success");
        parchearFila(fila.codigo, { relacion: "amigos", peticionId: r.peticionId });
        onCambio("amigos");
      } else {
        toast(`Petición enviada a ${r.nombre}`, "success");
        parchearFila(fila.codigo, { relacion: "enviada", peticionId: r.peticionId });
        onCambio("peticiones");
      }
    } catch (e) {
      console.error(e);
      if (!esAccionCaducada(e)) toast(SIN_CONEXION, "error");
    } finally {
      enVueloRef.current.delete(fila.codigo);
      setEnVuelo(new Set(enVueloRef.current));
    }
  };

  /* ---------- sondeo de peticiones ---------- */

  // Por ref: la función cambia en cada render de la pantalla y el intervalo no
  // tiene por qué reiniciar su cuenta cada vez.
  const sondearRef = useRef(onSondear);
  useEffect(() => {
    sondearRef.current = onSondear;
  }, [onSondear]);

  useEffect(() => {
    if (!open) return;
    const inicio = Date.now();
    const intervalo = window.setInterval(() => {
      if (Date.now() - inicio > SONDEO_MAX_MS) {
        window.clearInterval(intervalo);
        return;
      }
      // Con la pestaña oculta (o la app en segundo plano) no se pregunta: al
      // volver, la pantalla ya refresca por su cuenta.
      if (document.visibilityState !== "visible") return;
      sondearRef.current();
    }, SONDEO_MS);
    return () => window.clearInterval(intervalo);
  }, [open]);

  /* ---------- cerrar ---------- */

  // La hoja queda limpia para la próxima vez. Se hace AL CERRAR y no en un
  // efecto sobre `open`: así no hay un render de más ni un fotograma con la
  // búsqueda anterior al reabrir.
  const cerrar = () => {
    setQ("");
    setBusqueda(null);
    setVerQR(false);
    setConfirmandoCambio(false);
    setErrorCodigo(false);
    onClose();
  };

  const resultados = vigente && vigente.fallo === null ? vigente.resultados : [];
  const aLaVista = recibidas.slice(0, PETICIONES_A_LA_VISTA);

  return (
    <Sheet open={open} onClose={cerrar} label="Añadir amigo">
      {/* Sheet ya añade la safe area inferior (y la descuenta si sube el
          teclado), así que aquí basta con el respiro visual. */}
      <div className="px-5 pt-2 pb-6">
        {/* Con aspa: al escribir, el teclado deja el asa a media pantalla y el
            fondo casi no se ve; el aspa es la salida evidente. Ver la nota de
            components/ui/CabeceraDeHoja. */}
        <CabeceraDeHoja titulo="Añadir amigo" onCerrar={cerrar} />

        {aLaVista.length > 0 && (
          <div className="mt-4 flex flex-col gap-2" aria-live="polite">
            {aLaVista.map((p) => (
              <FilaPeticion
                key={p.id}
                peticion={p}
                conFrase
                ocupada={ocupadas.has(p.id)}
                onAceptar={() => onAceptar(p)}
                onRechazar={() => onRechazar(p)}
              />
            ))}
            {recibidas.length > aLaVista.length && (
              <p className="ink-soft t-cuerpo-2 text-center">
                Y {formatNumber(recibidas.length - aLaVista.length)} más en la pestaña Amigos.
              </p>
            )}
          </div>
        )}

        <p className="t-etiqueta ink-soft mt-5 mb-2">Añadir a alguien</p>
        <CampoBusqueda
          etiqueta="Nombre o código de amigo"
          marcador="Nombre o código…"
          valor={q}
          onCambio={setQ}
        />

        {consulta !== null && (
          <div className="mt-2 flex flex-col gap-1.5" aria-live="polite">
            {buscando && <p className="ink-soft t-cuerpo-2 py-3 text-center">Buscando…</p>}

            {vigente && vigente.fallo !== null && (
              // --danger-ink: esto es texto, y --danger es el token de fondo.
              <p className="t-cuerpo-2 py-3 text-center" style={{ color: "var(--danger-ink)" }}>
                {vigente.fallo}
              </p>
            )}

            {vigente && vigente.fallo === null && resultados.length === 0 && (
              <p className="ink-soft t-cuerpo-2 py-3 text-center">
                {vigente.pareceCodigo
                  ? "Ese código no existe."
                  : "Nadie con ese nombre. Pídele su código de amigo: está en Social → Añadir."}
              </p>
            )}

            {resultados.map((fila) => (
              <FilaResultado
                key={fila.codigo}
                fila={fila}
                enviando={enVuelo.has(fila.codigo)}
                onAnadir={() => anadir(fila)}
              />
            ))}

            {vigente && vigente.fallo === null && vigente.hayMas && (
              <p className="ink-soft t-cuerpo-2 py-1 text-center">
                Hay más resultados: escribe más letras o pide su código.
              </p>
            )}
          </div>
        )}

        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="t-etiqueta ink-soft mb-2">Tu código de amigo</p>

          {codigo ? (
            <>
              {/* SELECCIONABLE: el body apaga la selección de texto en toda la
                  app, y esto es justo lo que se quiere poder copiar a mano si
                  el portapapeles falla. Sin `.tnum`: no es una cifra, es un
                  identificador que se dicta carácter a carácter; el <code> ya
                  trae la monoespaciada. `translate="no"`: el traductor de
                  Safari no tiene nada que hacer con ocho caracteres al azar. */}
              <code
                translate="no"
                className="surface-2 t-display block rounded-xl py-3 text-center font-bold tracking-[0.12em] select-all"
                style={{ WebkitTouchCallout: "default" }}
              >
                {formatearCodigoAmigo(codigo)}
              </code>

              <div className={`mt-2 grid gap-2 ${hayQR ? "grid-cols-3" : "grid-cols-2"}`}>
                <button
                  type="button"
                  onClick={compartir}
                  className="btn-accent press control-44 t-cuerpo-2 rounded-xl px-2 font-semibold"
                >
                  Compartir
                </button>
                <button
                  type="button"
                  onClick={copiar}
                  className="btn-ghost press control-44 t-cuerpo-2 rounded-xl px-2 font-medium"
                >
                  Copiar
                </button>
                {hayQR && (
                  <button
                    type="button"
                    onClick={() => {
                      haptic("tap");
                      setVerQR((v) => !v);
                    }}
                    aria-expanded={verQR}
                    className="btn-ghost press control-44 t-cuerpo-2 rounded-xl px-2 font-medium"
                  >
                    {verQR ? "Ocultar QR" : "QR"}
                  </button>
                )}
              </div>

              {verQR && hayQR && (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <CodigoQR texto={enlace} etiqueta="Código QR de tu invitación" />
                  <p className="ink-soft t-cuerpo-2 text-center">
                    Que lo enfoque con la cámara: se abrirá tu invitación.
                  </p>
                </div>
              )}

              <p className="ink-soft t-cuerpo-2 mt-3 leading-relaxed">
                Quien use tu código te enviará una petición. Tú decides si la aceptas.
              </p>

              {confirmandoCambio ? (
                /* La confirmación va DENTRO de la hoja: abrir otra encima
                   apilaría dos telones para decir una frase. */
                <div className="surface-2 mt-3 rounded-xl p-3">
                  <p className="t-cuerpo-2 leading-relaxed">
                    Los enlaces y códigos QR que ya hayas compartido dejarán de funcionar.
                  </p>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={cambiarCodigo}
                      disabled={cambiando}
                      aria-busy={cambiando}
                      className="press control-44 t-cuerpo-2 rounded-lg px-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      style={{
                        background: "color-mix(in srgb, var(--danger) 16%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                        color: "var(--danger-ink)",
                      }}
                    >
                      Cambiar código
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmandoCambio(false)}
                      disabled={cambiando}
                      className="btn-ghost press control-44 t-cuerpo-2 rounded-lg px-2 font-medium disabled:opacity-50"
                    >
                      Mantener
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    haptic("tap");
                    setConfirmandoCambio(true);
                  }}
                  // -mb-3: los 44 px de dedo se comen el relleno inferior de
                  // la hoja en vez de alargarla.
                  className="ink-soft press-flat t-cuerpo-2 -mb-3 min-h-11 underline underline-offset-2"
                >
                  Cambiar código
                </button>
              )}
            </>
          ) : errorCodigo ? (
            <div className="flex items-center justify-between gap-3">
              <p className="ink-soft t-cuerpo-2 min-w-0">No se pudo cargar tu código.</p>
              <button
                type="button"
                onClick={() => setErrorCodigo(false)}
                className="btn-ghost press control-44 t-cuerpo-2 shrink-0 rounded-xl px-4 font-medium"
              >
                Reintentar
              </button>
            </div>
          ) : (
            // Mismo alto que el código y sus botones: la hoja no crece cuando
            // contesta el servidor.
            <div aria-busy="true" aria-label="Cargando tu código" role="status">
              <div className="skeleton h-[60px] rounded-xl" />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="skeleton h-11 rounded-xl" />
                <div className="skeleton h-11 rounded-xl" />
                <div className="skeleton h-11 rounded-xl" />
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Un resultado de la búsqueda: quién es, lo justo para reconocerle, y a la
 * derecha lo que se puede hacer con él AHORA.
 *
 * La columna de la derecha mide siempre lo mismo (el botón tiene ancho mínimo
 * y los rótulos de estado van centrados en ese mismo ancho): «Enviando…» es
 * más largo que «Añadir» y sin esto el nombre saltaba al pulsar.
 */
function FilaResultado({
  fila,
  enviando,
  onAnadir,
}: {
  fila: EntrenadorEncontrado;
  enviando: boolean;
  onAnadir: () => void;
}) {
  const estado: Record<string, string> = {
    enviada: "Enviada",
    amigos: "Amigos",
    yo: "Tú",
    bloqueado: "Bloqueado",
  };
  const accionable = fila.relacion === "ninguna" || fila.relacion === "recibida";

  return (
    <div className="surface-2 flex items-center gap-2.5 rounded-xl p-2.5">
      <AvatarEntrenador nombre={fila.nombre} etiqueta={fila.etiqueta} tam="sm" destacado={fila.relacion === "yo"} />
      <div className="min-w-0 flex-1">
        <p className="t-cuerpo flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium">{fila.nombre}</span>
          {fila.etiqueta && <span className="ink-soft t-cuerpo-2 shrink-0">#{fila.etiqueta}</span>}
        </p>
        <p className="ink-soft t-meta tnum truncate">
          {formatNumber(fila.unicas)} únicas
          {fila.enComun > 0 ? ` · ${formatNumber(fila.enComun)} en común` : ""}
        </p>
      </div>
      {accionable ? (
        <button
          type="button"
          onClick={onAnadir}
          disabled={enviando}
          aria-busy={enviando}
          aria-label={`${fila.relacion === "recibida" ? "Aceptar a" : "Añadir a"} ${fila.nombre} #${fila.etiqueta}`}
          className="btn-accent press control-44 t-cuerpo-2 min-w-[5.5rem] shrink-0 rounded-lg px-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          {enviando ? "Enviando…" : fila.relacion === "recibida" ? "Aceptar" : "Añadir"}
        </button>
      ) : (
        <span className="ink-soft t-cuerpo-2 min-w-[5.5rem] shrink-0 text-center font-medium">
          {estado[fila.relacion] ?? ""}
        </span>
      )}
    </div>
  );
}
