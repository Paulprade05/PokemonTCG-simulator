"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getTrainerCollection } from "../../action";
// El catálogo de expansiones, pedido una vez por sesión de navegador y
// compartido entre pantallas (ver utils/catalogoCliente.ts).
import { catalogoDeExpansiones } from "../../../utils/catalogoCliente";
import { aceptarPeticion, enviarPeticion, getFichaEntrenador } from "../../social";
import { rangoParaOrdenar } from "../../../utils/constanst";
import { formatNumber } from "../../../utils/format";
import { progresoPorExpansion } from "../../../utils/progresoPorExpansion";
import type { FichaEntrenador, MotivoSinFicha } from "../../../utils/tiposSocial";
import { useIdentidad } from "../../../hooks/useIdentidad";
import SinConexion from "../../../components/ui/SinConexion";
import { useHaptics } from "../../../hooks/useHaptics";
import PokemonCard from "../../../components/PokemonCard";
import PageHeader from "../../../components/PageHeader";
import Loader from "../../../components/Loader";
import CardDetailModal from "../../../components/CardDetailModal";
import AvisoSinSesion from "../../../components/social/AvisoSinSesion";
import { SIN_CONEXION } from "../../../components/social/utilidades";
import CampoBusqueda from "../../../components/ui/CampoBusqueda";
import EstadoError from "../../../components/ui/EstadoError";
import EstadoVacio from "../../../components/ui/EstadoVacio";
import { useToast } from "../../../components/ui/Toast";
import { IconoDesplegar } from "../../../components/icons";
import { esAccionCaducada } from "../../../utils/versionApp";

/**
 * Forma de un id de usuario de Clerk: `user_` y una ristra alfanumérica (27
 * caracteres hoy; se admite margen por si cambian la longitud). Cualquier otra
 * cosa en la URL no puede ser un entrenador: ver `noExiste` más abajo.
 */
const ID_DE_CLERK = /^user_[A-Za-z0-9]{20,64}$/;

export default function TrainerProfilePage() {
  const params = useParams();
  const trainerId = params.id as string;
  const { isSignedIn } = useUser();
  // `useIdentidad` y no `isLoaded` de Clerk: sin conexión, Clerk no resuelve
  // nunca y el esqueleto se quedaba girando para siempre. Con el plazo se deja
  // de esperar, y la identidad dice a quién (utils/identidad.ts).
  const identidad = useIdentidad();
  const sesionResuelta = identidad !== "resolviendo";
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /**
   * LA FICHA DEL ENTRENADOR: su nombre, su etiqueta y qué hay entre los dos.
   * `null` = el servidor aún no ha contestado (o ha fallado el transporte, que
   * a estos efectos es lo mismo: no se sabe). `sinFicha` es el motivo cuando
   * contesta que no hay ficha; ver la nota de `noExiste`.
   */
  const [ficha, setFicha] = useState<FichaEntrenador | null>(null);
  const [sinFicha, setSinFicha] = useState<MotivoSinFicha | null>(null);
  const [verTodasLasExpansiones, setVerTodasLasExpansiones] = useState(false);
  /** Hay una petición o una aceptación en vuelo desde la tira de amistad. */
  const [anadiendo, setAnadiendo] = useState(false);
  const toast = useToast();
  const haptic = useHaptics();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [filterRarity, setFilterRarity] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  const rarityOptions = useMemo(() => {
    const set = new Set<string>();
    cards.forEach((c) => c.rarity && set.add(c.rarity));
    return Array.from(set).sort((a, b) => rangoParaOrdenar(b) - rangoParaOrdenar(a));
  }, [cards]);

  // Todo dentro del mismo try/finally: si falla el transporte de cualquiera de
  // las dos peticiones (PWA sin cobertura, 500) la pantalla ofrece reintentar en
  // vez de quedarse con el Loader girando o fingir un álbum vacío.
  const loadTrainer = useCallback(async () => {
    if (!trainerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const sets = await catalogoDeExpansiones();
      setDbSets(sets);
      const trainerCards = await getTrainerCollection(trainerId);
      setCards(trainerCards);
    } catch (e) {
      console.error(e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [trainerId]);

  useEffect(() => { loadTrainer(); }, [loadTrainer]);

  /* EL NOMBRE SALE DE LA FICHA, NO DE LA LISTA DE AMIGOS.
   *
   * La ruta sólo lleva el id de Clerk, y el nombre se buscaba llamando a
   * `getSocialOverview`: la acción más cara de Social (agrega la colección de
   * TODOS los amigos) para sacar una cadena, y que además sólo conoce a los
   * amigos. El álbum de quien no lo era salía sin nombre, y con el álbum vacío
   * decía «No encontramos a este entrenador». `getFichaEntrenador` es una
   * lectura corta, vale para cualquiera con sesión y trae además la relación,
   * que es lo que permite ofrecer «Añadir» aquí mismo. Va aparte del álbum
   * para no retrasarlo. Sólo con sesión: sin ella la acción no da ficha. */
  useEffect(() => {
    if (!trainerId || !isSignedIn) return;
    let cancelled = false;
    getFichaEntrenador({ entrenadorId: trainerId })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setFicha(r.ficha);
          setSinFicha(null);
        } else {
          setSinFicha(r.motivo);
        }
      })
      .catch(() => {
        // Sin ficha no se puede afirmar nada: se queda en null y la pantalla
        // ni pone nombre ni dice que el entrenador no existe.
      });
    return () => { cancelled = true; };
  }, [trainerId, isSignedIn]);

  /**
   * "NO EXISTE" FRENTE A "EXISTE SIN CARTAS".
   *
   * `getTrainerCollection` devuelve `[]` en los tres casos —id inexistente,
   * álbum vacío y visitante sin sesión—, así que la pantalla no puede fiarse
   * de las cartas para decir que alguien no existe. Las dos señales buenas:
   *
   *  · la FORMA del id: lo que no parece un id de Clerk no es nadie;
   *  · la FICHA: el servidor comprueba que haya una fila en `users` y contesta
   *    `no_encontrado` si no la hay. Antes esto se deducía de la lista de
   *    amigos, y un desconocido con el álbum vacío —un jugador recién llegado
   *    al que se entra desde fuera de Social— salía como inexistente.
   *
   * Sólo se decide con las cartas ya cargadas; mientras la ficha no conteste,
   * o si falla, no se afirma nada.
   */
  const noExiste =
    !loading &&
    !loadError &&
    (!ID_DE_CLERK.test(trainerId) || sinFicha === "no_encontrado" || sinFicha === "no_valido");

  const trainerName = !ficha
    ? ""
    : ficha.relacion === "yo"
      ? "Tu álbum"
      : ficha.etiqueta
        ? `${ficha.nombre} #${ficha.etiqueta}`
        : ficha.nombre;

  /* LA MISMA CUENTA QUE LA COLECCIÓN, importada y no copiada.
   *
   * Aquí vivía una copia vieja: recorría TODAS las expansiones con un
   * `cards.filter` por cada una, las pintaba todas (ciento setenta logos
   * remotos de golpe al desplegar, casi todos de sets al 0 %) y escribía
   * «252/258» —con el total DECLARADO— al lado de un «100 %» calculado contra
   * las cartas que existen. utils/progresoPorExpansion.ts es la regla única:
   * cuenta en una pasada, mide contra `totalInSet` y ordena por progreso. */
  const setStats = useMemo(() => progresoPorExpansion(cards, dbSets), [cards, dbSets]);
  const setStatsEmpezados = useMemo(() => setStats.filter((s) => s.owned > 0), [setStats]);
  const setStatsVisibles = verTodasLasExpansiones ? setStats : setStatsEmpezados;

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterSet !== "all") result = result.filter((c) => c.id.startsWith(filterSet + "-"));
    if (filterRarity !== "all") result = result.filter((c) => c.rarity === filterRarity);
    result.sort((a, b) => {
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      switch (sortBy) {
        case "name_asc": return a.name.localeCompare(b.name);
        case "quantity_desc": return (b.quantity || 1) - (a.quantity || 1);
        case "rarity_desc": return rangoParaOrdenar(b.rarity) - rangoParaOrdenar(a.rarity);
        default: return 0;
      }
    });
    return result;
  }, [cards, searchTerm, filterSet, filterRarity, sortBy]);


  /* AÑADIR DESDE EL PROPIO ÁLBUM. Un solo botón para los dos casos: si no hay
   * nada entre los dos envía la petición, y si él ya me lo había pedido la
   * acepta. El estado de la tira sale de lo que contesta el servidor, no de
   * suponer que ha ido bien. */
  const anadirAmigo = async () => {
    if (!ficha || anadiendo) return;
    setAnadiendo(true);
    haptic("select");
    try {
      if (ficha.relacion === "recibida" && ficha.peticionId !== null) {
        const r = await aceptarPeticion(ficha.peticionId);
        if (!r.ok) {
          toast(r.error, "error");
          return;
        }
        toast(`Ahora eres amigo de ${r.nombre}`, "success");
        setFicha({ ...ficha, relacion: "amigos" });
        return;
      }
      const r = await enviarPeticion({ entrenadorId: trainerId });
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      if (r.estado === "amigos") {
        toast(`Ahora eres amigo de ${r.nombre}`, "success");
        setFicha({ ...ficha, relacion: "amigos", peticionId: r.peticionId });
      } else {
        toast(`Petición enviada a ${r.nombre}`, "success");
        setFicha({ ...ficha, relacion: "enviada", peticionId: r.peticionId });
      }
    } catch (e) {
      console.error(e);
      if (!esAccionCaducada(e)) toast(SIN_CONEXION, "error");
    } finally {
      setAnadiendo(false);
    }
  };

  if (loading || !sesionResuelta) return <Loader label="Cargando entrenador" />;

  // Tiene cuenta y no hay red: «Inicia sesión para ver este álbum» era mentira
  // —ya la tiene iniciada— y el botón abría un modal que sin red no carga.
  if (identidad === "cuenta-sin-conexion") {
    return (
      <div className="select-none w-full">
        <PageHeader back="/friends" title="Álbum de entrenador" />
        <SinConexion detalle="No se ha podido comprobar tu sesión, y los álbumes sólo se comparten entre cuentas. Se abrirá en cuanto vuelva la conexión." />
      </div>
    );
  }

  // Sin sesión el servidor no entrega ningún álbum (getTrainerCollection lo
  // exige a propósito): decirlo es mejor que enseñar un álbum "vacío".
  if (!isSignedIn) {
    return (
      <div className="select-none w-full">
        <PageHeader back="/friends" title="Álbum de entrenador" />
        {/* La caja del aviso de invitado y no la de un vacío: un vacío es
            "aquí todavía no has puesto nada"; esto es "hay algo y no puedes
            verlo", que no es lo mismo y no debe parecerlo. Y con el botón que
            ABRE el inicio de sesión y vuelve a este mismo álbum: antes la
            única salida era un enlace a la portada, y quien llegaba por un
            enlace perdía el álbum que venía a ver. */}
        <AvisoSinSesion titulo="Inicia sesión para ver este álbum" volverA={`/trainer/${trainerId}`}>
          Los álbumes sólo se comparten entre cuentas: inicia sesión para ver el
          de otros entrenadores.
        </AvisoSinSesion>
      </div>
    );
  }

  if (noExiste) {
    return (
      <div className="select-none w-full">
        <PageHeader back="/friends" title="Álbum de entrenador" />
        <EstadoVacio
          titulo="No encontramos a este entrenador"
          detalle="El enlace puede estar mal copiado o la cuenta ya no existe."
          accion={
            <Link
              href="/friends"
              className="btn-accent press control-44 t-cuerpo rounded-xl px-5 font-semibold"
            >
              Volver a Social
            </Link>
          }
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="select-none w-full">
        <PageHeader back="/friends" title="Álbum de entrenador" subtitle={trainerName || undefined} />
        <EstadoError titulo="No se ha podido cargar este álbum" onReintentar={loadTrainer} />
      </div>
    );
  }

  return (
    <div className="select-none w-full">
      <PageHeader back="/friends" title="Álbum de entrenador" subtitle={trainerName || undefined} />

      <div className="w-full flex flex-col gap-6">
        {/* LA TIRA DE AMISTAD. Se podía llegar al álbum de alguien que no es
            amigo y no había nada que hacer con él: ni añadirle ni saber si ya
            se le había pedido. Sólo sale cuando hay algo que decir —sin
            relación, petición enviada o petición recibida—; con un amigo, o
            en el álbum propio, no pinta nada.
            El texto encoge y trunca; el botón no: a 320 px el nombre largo se
            come los puntos suspensivos, nunca el «Añadir». */}
        {ficha && (ficha.relacion === "ninguna" || ficha.relacion === "enviada" || ficha.relacion === "recibida") && (
          <div className="surface rounded-2xl px-4 py-3 flex items-center justify-between gap-3" aria-live="polite">
            <div className="min-w-0">
              <p className="t-cuerpo font-medium truncate">
                {ficha.relacion === "ninguna"
                  ? "Aún no sois amigos"
                  : ficha.relacion === "enviada"
                    ? "Petición enviada"
                    : "Quiere ser tu amigo"}
              </p>
              {/* Frases cortas a propósito: a 320 px, con el botón al lado,
                  caben 28 caracteres. El nombre no se repite aquí porque ya
                  está en la cabecera, y uno largo se comía la frase entera. */}
              <p className="t-cuerpo-2 ink-soft truncate">
                {ficha.relacion === "ninguna"
                  ? "Añádele para intercambiar"
                  : ficha.relacion === "enviada"
                    ? "Te avisaremos en Social cuando acepte"
                    : "Acepta para intercambiar"}
              </p>
            </div>
            {ficha.relacion !== "enviada" && (
              <button
                type="button"
                onClick={anadirAmigo}
                disabled={anadiendo}
                aria-busy={anadiendo}
                className="btn-accent press control-44 t-cuerpo-2 shrink-0 rounded-xl px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ficha.relacion === "recibida" ? "Aceptar" : "Añadir"}
              </button>
            )}
          </div>
        )}

        <div>
          <button
            onClick={() => setShowStats(!showStats)}
            aria-expanded={showStats}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl surface-2 border border-[var(--border)] flex items-center justify-center">
                {/* --accent-2 en lugar de la paleta literal de Tailwind: el
                    azul/cian de la casa es un token, no un `blue-400` suelto
                    que no sabe nada del tema. */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 [color:var(--accent-2)]" aria-hidden="true">
                  <path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold t-cuerpo ink">Progreso del entrenador</h3>
                <p className="t-cuerpo-2 ink-faint">{showStats ? "Ocultar detalles" : "Ver por expansión"}</p>
              </div>
            </div>
            {/* El giro va en un envoltorio: el dibujo sale del vocabulario
                común (components/icons.tsx). */}
            <motion.span
              animate={{ rotate: showStats ? 180 : 0 }}
              className="ink-soft flex shrink-0"
              aria-hidden="true"
            >
              <IconoDesplegar tam={16} />
            </motion.span>
          </button>

          <AnimatePresence>
            {showStats && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                {setStatsVisibles.length === 0 ? (
                  <p className="t-cuerpo-2 ink-faint text-center py-8">
                    Este entrenador aún no tiene cartas de ninguna expansión.
                  </p>
                ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStatsVisibles.map((stat) => (
                    <div key={stat.id} className="surface rounded-2xl p-4">
                      <div className="flex items-center gap-3 mb-3">
                        {/* lazy + async: aun pintando sólo las empezadas pueden
                            ser decenas de logos remotos bajo el pliegue. */}
                        {stat.logo && <img src={stat.logo} alt={stat.name} loading="lazy" decoding="async" className="h-7 object-contain opacity-90" />}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium t-cuerpo ink truncate">{stat.name}</h3>
                          {/* `totalInSet` y no el total declarado: es el mismo
                              denominador con el que se calcula el porcentaje
                              de al lado. */}
                          <p className="t-micro ink-soft tnum">{stat.owned}/{stat.totalInSet}</p>
                        </div>
                        <span className="t-cuerpo-2 font-semibold ink-soft tnum">{stat.percentage}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] rounded-full overflow-hidden">
                        <div className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"} style={{ width: `${stat.percentage}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                )}

                {/* Las expansiones a cero no entran salvo que se pidan, igual
                    que en la colección: con la base sincronizada son más de
                    ciento cincuenta tarjetas con su logo remoto, y la sección
                    dejaba de responder a "cómo va" para ser un catálogo. */}
                {setStats.length > setStatsEmpezados.length && (
                  <button
                    type="button"
                    onClick={() => setVerTodasLasExpansiones((v) => !v)}
                    className="btn-ghost press touch-target mt-3 w-full rounded-xl t-cuerpo-2 font-medium"
                  >
                    {verTodasLasExpansiones
                      ? "Ver sólo las empezadas"
                      : `Ver las ${formatNumber(setStats.length - setStatsEmpezados.length)} expansiones sin empezar`}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="surface rounded-2xl px-3 py-3 flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center">
          <CampoBusqueda
            className="flex-1 sm:min-w-[180px]"
            etiqueta="Buscar en el álbum"
            marcador="Buscar..."
            valor={searchTerm}
            onCambio={setSearchTerm}
          />

          {/* Rejilla de dos columnas: con `w-full` en una fila flexible cada
              selector se llevaba una línea entera (cuatro filas apiladas). */}
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <select
              value={filterSet}
              onChange={(e) => setFilterSet(e.target.value)}
              aria-label="Filtrar por expansión"
              className="input-field col-span-2 w-full min-w-0 truncate px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer sm:col-span-1 sm:w-auto"
            >
              <option value="all">Todas</option>
              {dbSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
            </select>
            <select
              value={filterRarity}
              onChange={(e) => setFilterRarity(e.target.value)}
              aria-label="Filtrar por rareza"
              className="input-field w-full min-w-0 truncate px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer sm:w-auto"
            >
              <option value="all">Toda rareza</option>
              {rarityOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              aria-label="Ordenar por"
              className="input-field w-full min-w-0 truncate px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer sm:w-auto"
            >
              <option value="rarity_desc">Rareza</option>
              <option value="quantity_desc">Cantidad</option>
              <option value="name_asc">Nombre</option>
            </select>
          </div>
        </div>

        {processedCards.length === 0 ? (
          // Aquí ya se sabe que el entrenador existe (ver `noExiste`): o su
          // álbum está vacío de verdad, o son los filtros los que no dejan nada.
          <EstadoVacio
            titulo={
              cards.length === 0
                ? "Este entrenador todavía no tiene cartas"
                : "Ninguna carta coincide con los filtros"
            }
          />
        ) : (
          // Misma rejilla que colección y álbum: las cartas miden igual en
          // las tres pantallas y en móvil caben tres por fila.
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
            {processedCards.map((card) => (
              <div key={card.id} className="relative group">
                {card.quantity > 1 && (
                  // Variables de tema, no bg-white/text-black: el blanco fijo
                  // quedaba invisible en tema claro. Mismo badge que colección.
                  // Sobresale 4 px y no 8: con 8 por cada lado, la chapa de
                  // copias de una carta y el corazón de la siguiente sumaban
                  // 16 px en un hueco de 10 y se pisaban.
                  <div
                    className="absolute -top-2 -right-1 z-30 t-micro font-bold w-6 h-6 flex items-center justify-center rounded-full tnum"
                    style={{
                      background: "var(--ink)",
                      color: "var(--bg)",
                      border: "1px solid var(--border-strong)",
                      boxShadow: "var(--shadow-sm)",
                    }}
                  >
                    {card.quantity}
                  </div>
                )}
                {card.is_favorite && (
                  // Tres cosas de coherencia en la misma chapa: el rojo sale de
                  // --danger (token de fondo) y no de un `rose-500` literal; la
                  // sombra sale de la escala en vez de un `shadow-lg` que no
                  // cambia con el tema; y pasa a medir 24px con el corazón a 16,
                  // que son los escalones de la casa — y de paso queda igual que
                  // la chapa de copias que tiene enfrente, que ya medía 24.
                  <div
                    className="absolute -top-2 -left-1 z-30 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: "var(--danger)", boxShadow: "var(--shadow-sm)" }}
                  >
                    <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4" aria-hidden="true">
                      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                    </svg>
                  </div>
                )}
                {/* <button> y no <div onClick>: sin rol ni tabIndex la carta era
                    inalcanzable con teclado y un lector no anunciaba nada
                    accionable. Igual que la rejilla de colección. */}
                <button
                  type="button"
                  aria-label={`Ver ${card.name}`}
                  className="block w-full cursor-zoom-in text-left"
                  onClick={() => setSelectedCard(card)}
                >
                  <div className="transition transform group-hover:-translate-y-1 duration-[var(--d-base)] pointer-events-none">
                    <PokemonCard card={card} reveal={true} interactive={false} />
                  </div>
                </button>
                {/* En táctil no hay hover: el contador se ve siempre en móvil */}
                <div className="mt-2 flex justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-[var(--d-base)]">
                  <span className="chip ink-soft t-micro px-2 py-1 rounded-full">
                    {card.quantity > 1 ? `${card.quantity} copias` : "Única"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CardDetailModal card={selectedCard} onClose={() => setSelectedCard(null)} readOnly />
    </div>
  );
}
