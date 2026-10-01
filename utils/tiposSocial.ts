// utils/tiposSocial.ts
//
// Los tipos que cruzan entre las acciones de app/social.ts y las pantallas.
//
// POR QUÉ NO VIVEN EN app/social.ts: ese fichero es "use server" y de un
// fichero así sólo deben salir funciones asíncronas. Aquí no hay ni una línea
// que se ejecute, así que lo importan igual el servidor y el cliente.
//
// LA REGLA QUE ESTOS TIPOS HACEN VISIBLE: el id de Clerk de otra persona sólo
// aparece en `amigoId`, y sólo cuando ya sois amigos. En todo lo demás —la
// búsqueda, las peticiones, la ficha, los bloqueados— a un entrenador se le
// nombra por su código o por el id numérico de la fila de `friendships`. El id
// de Clerk basta hoy para abrir el álbum de alguien (getTrainerCollection), así
// que repartirlo a cualquiera con sesión, como hacía la búsqueda, era regalar
// la llave.

/**
 * A QUIÉN se refiere una acción, dicho de la forma en que lo sabe la pantalla
 * que la lanza. El servidor lo resuelve a un id y no lo devuelve nunca.
 *
 *  · `codigo`        → la hoja «Añadir amigo» y la página /invitar/[codigo].
 *  · `anuncioId`     → «de {vendedor}» en el bazar: el vendedor de un anuncio
 *                      ACTIVO, sin que el comprador llegue a ver su id.
 *  · `entrenadorId`  → /trainer/[id], que ya lleva el id en la ruta.
 */
export type Destino =
  | { codigo: string }
  | { anuncioId: number }
  | { entrenadorId: string };

/**
 * Qué hay entre quien pregunta y el otro, visto DESDE quien pregunta.
 *
 *  · `ninguna`    se le puede añadir.
 *  · `enviada`    tiene una petición mía (también si la rechazó: el rechazo es
 *                 silencioso). `peticionId` sirve para `cancelarPeticion`.
 *  · `recibida`   me ha pedido amistad. `peticionId` sirve para
 *                 `aceptarPeticion` / `rechazarPeticion`.
 *  · `amigos`     ya lo somos. `peticionId` es el id de la amistad
 *                 (`eliminarAmigo`).
 *  · `bloqueado`  le he bloqueado yo. `peticionId` sirve para `desbloquear`.
 *  · `yo`         soy yo mismo.
 */
export type RelacionSocial = "ninguna" | "enviada" | "recibida" | "amigos" | "bloqueado" | "yo";

export interface FichaEntrenador {
  nombre: string;
  /** Últimos 4 del código: `Nombre #2345`. Sirve también de semilla del color. */
  etiqueta: string;
  /**
   * El código entero SÓLO si la ficha se pidió por código (quien pregunta ya
   * lo tiene) o es la mía. Desde un anuncio o desde un perfil es `null`.
   */
  codigo: string | null;
  /** Cartas distintas. */
  unicas: number;
  /** Copias en total. */
  cartas: number;
  /** Amigos en común. */
  enComun: number;
  relacion: RelacionSocial;
  /** Id de la fila de `friendships` cuando la hay y me incumbe; si no, `null`. */
  peticionId: number | null;
  /** Id de Clerk, SÓLO con `relacion` 'amigos' o 'yo' (para «Ver álbum»). */
  amigoId: string | null;
}

/** Una fila de la búsqueda. Lleva código y nunca id. */
export interface EntrenadorEncontrado {
  codigo: string;
  nombre: string;
  etiqueta: string;
  unicas: number;
  cartas: number;
  enComun: number;
  relacion: RelacionSocial;
  peticionId: number | null;
}

export interface PeticionRecibida {
  /** Id de la petición: lo que reciben `aceptarPeticion` y `rechazarPeticion`. */
  id: number;
  nombre: string;
  etiqueta: string;
  unicas: number;
  enComun: number;
}

export interface PeticionEnviada {
  /** Id de la petición: lo que recibe `cancelarPeticion`. */
  id: number;
  nombre: string;
  etiqueta: string;
}

export interface EntrenadorBloqueado {
  /** Id de la fila: lo que recibe `desbloquear`. */
  id: number;
  nombre: string;
  etiqueta: string;
}

/** Fallo de cualquier acción social: siempre con un texto que se puede enseñar. */
export interface FalloSocial {
  ok: false;
  error: string;
}

/**
 * Por qué no hay ficha. La página de invitación lo necesita para no decir
 * «esta invitación ya no es válida» cuando lo que ha fallado es la red.
 *
 *  · `sesion`         no hay sesión.
 *  · `no_valido`      lo que llegó no tiene forma de código, anuncio o id.
 *  · `no_encontrado`  bien formado, pero no corresponde a nadie.
 *  · `error`          fallo del servidor: se puede reintentar.
 */
export type MotivoSinFicha = "sesion" | "no_valido" | "no_encontrado" | "error";

export type ResultadoCodigo = { ok: true; codigo: string } | FalloSocial;

export type ResultadoFicha =
  | { ok: true; ficha: FichaEntrenador }
  | (FalloSocial & { motivo: MotivoSinFicha });

export type ResultadoEnviarPeticion =
  | {
      ok: true;
      /** `amigos` cuando había una petición suya esperándome: se acepta sola. */
      estado: "enviada" | "amigos";
      nombre: string;
      /** Para ofrecer «Cancelar petición» sin recargar. `null` si no aplica. */
      peticionId: number | null;
    }
  | FalloSocial;

export type ResultadoAceptarPeticion = { ok: true; nombre: string } | FalloSocial;

export type ResultadoSocial = { ok: true } | FalloSocial;

export type ResultadoEliminarAmigo = { ok: true; ofertasCanceladas: number } | FalloSocial;

export type ResultadoBusqueda =
  | {
      ok: true;
      resultados: EntrenadorEncontrado[];
      /** Había más de los que se devuelven: «escribe más letras o pide su código». */
      hayMas: boolean;
      /** El resultado salió de buscar el código exacto, no el nombre. */
      porCodigo: boolean;
      /**
       * Lo tecleado tiene forma de código. Con `resultados` vacío es la señal
       * para decir «Ese código no existe» en vez de «Nadie con ese nombre».
       */
      pareceCodigo: boolean;
    }
  | FalloSocial;

export interface Peticiones {
  recibidas: PeticionRecibida[];
  enviadas: PeticionEnviada[];
  /**
   * La lectura FALLÓ y las dos listas vienen vacías por eso, no porque no haya
   * nada. Quien la reciba no debe tocar lo que tiene en pantalla.
   */
  error?: true;
}

export interface SocialPendientes {
  peticiones: number;
  ofertas: number;
}
