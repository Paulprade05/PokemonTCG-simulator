"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import PageHeader from "../../../components/PageHeader";
import Loader from "../../../components/Loader";
import EstadoError from "../../../components/ui/EstadoError";
import EstadoVacio from "../../../components/ui/EstadoVacio";
import { useToast } from "../../../components/ui/Toast";
import { BotonIniciarSesion } from "../../../components/social/AvisoSinSesion";
import { recordarInvitacion } from "../../../components/social/InvitacionPendiente";
import PanelEntrenador from "../../../components/social/PanelEntrenador";
import { copiarTexto } from "../../../components/social/utilidades";
import { IconoAviso, IconoMarca } from "../../../components/icons";
import { useHaptics } from "../../../hooks/useHaptics";
import { useIdentidad } from "../../../hooks/useIdentidad";
import SinConexion from "../../../components/ui/SinConexion";
import { useInstallMode } from "../../../hooks/useViewport";
import { formatearCodigoAmigo, normalizarCodigoAmigo, rutaDeInvitacion } from "../../../utils/codigoAmigo";
import type { MotivoSinFicha } from "../../../utils/tiposSocial";

/**
 * LA PÁGINA DE UNA INVITACIÓN: /invitar/CODIGO.
 *
 * Es a donde lleva el enlace que se comparte desde «Añadir amigo» y el QR.
 * Antes la única URL que identificaba a alguien era /trainer/user_…, que no
 * tenía botón de añadir, no enseñaba el nombre de un no-amigo y llevaba dentro
 * el id de Clerk. Ésta lleva el código de amigo, que se puede cambiar.
 *
 * ES PÚBLICA (el middleware no protege ninguna ruta) y quien la abre casi
 * nunca tiene sesión: llega desde un chat y se abre en SAFARI, aunque tenga la
 * app instalada, porque iOS no abre enlaces dentro de una PWA. De ahí salen
 * las tres reglas de esta pantalla:
 *
 *  1. NUNCA ENVÍA NADA AL CARGAR. Abrir un enlace es mirar; la petición sale
 *     de un toque en «Añadir a {nombre}». Tampoco al volver de iniciar sesión.
 *  2. SIN SESIÓN NO SE ENSEÑA EL NOMBRE. La ficha la sirve una acción que exige
 *     sesión; aquí sólo se ve el código que ya venía en el enlace.
 *  3. EL CÓDIGO ESTÁ SIEMPRE A LA VISTA Y SE PUEDE COPIAR, con la instrucción
 *     para quien tiene la app en la pantalla de inicio: allí sí hay sesión, y
 *     es más corto pegar el código en Social que iniciar sesión otra vez en
 *     Safari. (Dentro de la app instalada esa frase sobra y no se pinta.)
 *
 * EL AVISO DE INSTALAR NO SALE AQUÍ (components/pwa/InstallPrompt.tsx sólo se
 * enseña en las raíces de pestaña): aparecía a los 3,5 s y tapaba el botón
 * principal justo cuando el recién llegado iba a pulsarlo.
 */
export default function InvitacionPage() {
  const params = useParams();
  const crudo = typeof params.codigo === "string" ? params.codigo : "";
  /* Lo que llega en la ruta lo ha escrito quien sea: se normaliza (minúsculas,
   * guion, espacios codificados) y, si no queda un código con su forma exacta,
   * la invitación no es válida. No hace falta preguntar al servidor para eso. */
  const codigo = useMemo(() => {
    try {
      return normalizarCodigoAmigo(decodeURIComponent(crudo));
    } catch {
      // Una secuencia % mal formada hace lanzar a decodeURIComponent.
      return null;
    }
  }, [crudo]);

  const { isSignedIn } = useUser();
  // `useIdentidad` y no `isLoaded`: sin conexión Clerk no resuelve nunca y la
  // pantalla se quedaría en el esqueleto (utils/identidad.ts).
  const identidad = useIdentidad();
  const sesionResuelta = identidad !== "resolviendo";

  /* Cómo acabó la carga de la ficha: `undefined` mientras llega, `null` si la
   * hay, o el motivo por el que no. Sólo decide si el código se sigue
   * ofreciendo para copiar: si el servidor dice que ya no es de nadie, invitar
   * a pegarlo en Social sería mandar a alguien a un «Ese código no existe». */
  const [resultado, setResultado] = useState<MotivoSinFicha | null | undefined>(undefined);
  const codigoVivo = resultado === null || resultado === "error" || resultado === "sesion";

  if (!codigo) {
    return (
      <div className="w-full">
        <PageHeader back="/" title="Invitación" />
        <NoValida detalle="El enlace está incompleto o mal copiado. Pídele a tu amigo su código de amigo: está en Social → Añadir." />
      </div>
    );
  }

  if (!sesionResuelta) return <Loader label="Cargando invitación" />;

  const ruta = rutaDeInvitacion(codigo);

  // Tiene cuenta y no hay red: ofrecerle «Iniciar sesión y añadir» abría un
  // modal que sin red no carga, a quien además ya tiene la sesión iniciada. La
  // invitación no se pierde: el código sigue a la vista y la pantalla se
  // recarga sola al volver la conexión.
  if (identidad === "cuenta-sin-conexion") {
    return (
      <div className="w-full">
        <PageHeader back="/" title="Invitación" />
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
          <SinConexion detalle="No se ha podido comprobar tu sesión. La invitación sigue aquí: se abrirá en cuanto vuelva la conexión." />
          <BloqueCodigo codigo={codigo} />
        </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="w-full">
        <PageHeader back="/" title="Invitación" />
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
          <SinSesion codigo={codigo} ruta={ruta} />
          <BloqueCodigo codigo={codigo} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <PageHeader back="/friends" title="Invitación" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div className="surface rounded-3xl p-4 sm:p-5">
          <PanelEntrenador
            destino={{ codigo }}
            onResuelta={setResultado}
            sinFicha={(motivo, reintentar) => (
              <SinFicha motivo={motivo} reintentar={reintentar} codigo={codigo} ruta={ruta} />
            )}
          />
        </div>
        {codigoVivo && <BloqueCodigo codigo={codigo} />}
        <Link
          href="/friends"
          className="btn-ghost press control-44 t-cuerpo w-full rounded-xl px-4 font-medium"
        >
          Ir a Social
        </Link>
      </div>
    </div>
  );
}

/**
 * Sin sesión: de qué va esto y el único botón que hace falta.
 *
 * `alPulsar` apunta la invitación ANTES de abrir el modal, para poder volver a
 * ella si el alta termina en otra ruta (components/social/InvitacionPendiente).
 */
function SinSesion({ codigo, ruta }: { codigo: string; ruta: string }) {
  return (
    <div className="surface flex flex-col items-center gap-4 rounded-3xl px-5 py-8 text-center">
      <div className="btn-accent flex h-14 w-14 items-center justify-center rounded-2xl" aria-hidden="true">
        <IconoMarca tam={24} className="text-[#04110c]" />
      </div>
      <div className="min-w-0">
        <h2 className="t-titulo font-bold">Te han invitado a TCG Sim</h2>
        <p className="ink-soft t-cuerpo mx-auto mt-1 max-w-sm">
          Un entrenador quiere tenerte de amigo para intercambiar cartas. Inicia sesión o crea tu
          cuenta y podrás enviarle una petición.
        </p>
      </div>
      <BotonIniciarSesion
        volverA={ruta}
        rotulo="Iniciar sesión y añadir"
        alPulsar={() => recordarInvitacion(codigo)}
        className="btn-accent press control-44 t-cuerpo w-full rounded-xl px-4 font-semibold"
      />
    </div>
  );
}

/**
 * El código de la invitación, copiable, y cómo usarlo en la app instalada.
 *
 * Va siempre que el código pueda valer (sin sesión no se sabe, así que se
 * enseña): es lo único de esta página que sirve a quien tiene la sesión en
 * otro sitio, la app de la pantalla de inicio, que no comparte almacenamiento
 * con Safari.
 */
function BloqueCodigo({ codigo }: { codigo: string }) {
  const toast = useToast();
  const haptic = useHaptics();
  const instalada = useInstallMode() === "installed";

  const copiar = async () => {
    haptic("tap");
    if (await copiarTexto(formatearCodigoAmigo(codigo))) toast("Código copiado", "success");
    else toast("No se pudo copiar. Mantén pulsado el código para copiarlo.", "error");
  };

  return (
    <div className="surface-2 rounded-2xl p-4 text-center">
      <p className="t-etiqueta ink-soft">Código de amigo</p>
      {/* Seleccionable a mano: el body apaga la selección de texto en toda la
          app y esto es justo lo que hay que poder copiar si el botón falla. */}
      <code
        translate="no"
        className="t-display mt-1 block font-bold tracking-[0.12em] select-all"
        style={{ WebkitTouchCallout: "default" }}
      >
        {formatearCodigoAmigo(codigo)}
      </code>
      <button
        type="button"
        onClick={copiar}
        className="btn-ghost press control-44 t-cuerpo mt-3 w-full rounded-xl px-4 font-medium"
      >
        Copiar código
      </button>
      {!instalada && (
        <p className="ink-soft t-cuerpo-2 mt-3 leading-relaxed">
          ¿Ya tienes la app en la pantalla de inicio? Copia el código, ábrela y pégalo en Social →
          Añadir.
        </p>
      )}
    </div>
  );
}

/**
 * Cuando el servidor no da ficha. Son tres situaciones distintas y decir «ya no
 * es válida» en las tres sería mentir en dos: si lo que ha fallado es la red,
 * se ofrece reintentar; si es la sesión (la cookie caducó aunque el navegador
 * aún crea que la hay), se ofrece entrar.
 */
function SinFicha({
  motivo,
  reintentar,
  codigo,
  ruta,
}: {
  motivo: MotivoSinFicha;
  reintentar: () => void;
  codigo: string;
  ruta: string;
}) {
  if (motivo === "error") {
    return <EstadoError titulo="No se pudo cargar la invitación" onReintentar={reintentar} />;
  }
  if (motivo === "sesion") {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <p className="ink-soft t-cuerpo">Tu sesión ha caducado. Vuelve a entrar para ver la invitación.</p>
        <BotonIniciarSesion volverA={ruta} alPulsar={() => recordarInvitacion(codigo)} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
        <IconoAviso tam={24} className="[color:var(--warn)]" />
      </div>
      <p className="t-base font-semibold">Esta invitación ya no es válida</p>
      <p className="ink-soft t-cuerpo max-w-xs">
        Puede que tu amigo haya cambiado su código. Pídele el nuevo: está en Social → Añadir.
      </p>
    </div>
  );
}

/** El enlace no trae un código: ni siquiera se pregunta al servidor. */
function NoValida({ detalle }: { detalle: string }) {
  return (
    <EstadoVacio
      titulo="Esta invitación ya no es válida"
      detalle={detalle}
      icono={<IconoAviso tam={24} />}
      accion={
        <Link href="/friends" className="btn-accent press control-44 t-cuerpo rounded-xl px-5 font-semibold">
          Ir a Social
        </Link>
      }
    />
  );
}
