import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

/**
 * EL INICIO DE SESIÓN, EN ESPAÑOL.
 *
 * Toda la app habla español y el modal de Clerk salía en inglés ("Sign in",
 * "Continue", "Don't have an account?"): es la primera pantalla que ve quien
 * llega por una invitación, y parecía de otra aplicación.
 *
 * POR QUÉ ESTÁ ESCRITO A MANO Y NO ES `esES` DE `@clerk/localizations`: ese
 * paquete no está entre las dependencias y añadir una no entraba en este
 * cambio. `localization` admite un objeto PARCIAL —lo que no se nombra aquí
 * sale con el texto de fábrica—, así que se traduce lo que de verdad se pisa:
 * entrar, crear la cuenta, el código del correo, la contraseña, el menú del
 * avatar y los errores más corrientes. El perfil de usuario ("Gestionar
 * cuenta") sigue en inglés: son cientos de claves y ahí sí compensa el paquete.
 * El día que se instale, esto se sustituye por `import { esES }` y se borra.
 *
 * El tipo sale de las props del propio proveedor para no importar de
 * `@clerk/types`, que está en node_modules sólo de rebote. Con él, una clave
 * mal escrita o que Clerk retire en una versión nueva es un error de tsc y no
 * un texto que vuelve al inglés sin avisar.
 */
type Localizacion = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

export const clerkEs: Localizacion = {
  locale: "es-ES",

  // Las claves con parámetro llevan un tipo marcado que una cadena normal no
  // cumple; la conversión es sólo de tipo, el texto se interpola igual.
  socialButtonsBlockButton:
    "Continuar con {{provider|titleize}}" as Localizacion["socialButtonsBlockButton"],
  dividerText: "o",
  lastAuthenticationStrategy: "Último usado",
  backButton: "Volver",
  formButtonPrimary: "Continuar",
  formButtonPrimary__verify: "Verificar",
  footerActionLink__useAnotherMethod: "Usar otro método",

  formFieldLabel__emailAddress: "Correo electrónico",
  formFieldLabel__emailAddress_username: "Correo electrónico o nombre de usuario",
  formFieldLabel__username: "Nombre de usuario",
  formFieldLabel__password: "Contraseña",
  formFieldLabel__newPassword: "Contraseña nueva",
  formFieldLabel__confirmPassword: "Repite la contraseña",
  formFieldLabel__firstName: "Nombre",
  formFieldLabel__lastName: "Apellidos",
  formFieldInputPlaceholder__emailAddress: "Tu correo electrónico",
  formFieldInputPlaceholder__emailAddress_username: "Correo o nombre de usuario",
  formFieldInputPlaceholder__username: "Tu nombre de usuario",
  formFieldInputPlaceholder__password: "Tu contraseña",
  formFieldAction__forgotPassword: "¿Has olvidado la contraseña?",
  formFieldHintText__optional: "Opcional",

  signIn: {
    start: {
      title: "Entra en {{applicationName}}",
      subtitle: "Inicia sesión para guardar tus cartas",
      actionText: "¿Todavía no tienes cuenta?",
      actionLink: "Crear cuenta",
      actionLink__use_email: "Usar el correo",
      actionLink__use_username: "Usar el nombre de usuario",
      actionLink__use_email_username: "Usar correo o nombre de usuario",
    },
    password: {
      title: "Escribe tu contraseña",
      subtitle: "La contraseña de tu cuenta",
      actionLink: "Usar otro método",
    },
    emailCode: {
      title: "Mira tu correo",
      subtitle: "Te hemos enviado un código para continuar",
      formTitle: "Código de verificación",
      resendButton: "¿No te ha llegado? Reenviar",
    },
    emailLink: {
      title: "Mira tu correo",
      subtitle: "Te hemos enviado un enlace para continuar",
      formTitle: "Enlace de verificación",
      formSubtitle: "Abre el enlace que te hemos enviado por correo",
      resendButton: "¿No te ha llegado? Reenviar",
    },
    forgotPasswordAlternativeMethods: {
      title: "¿Has olvidado la contraseña?",
      label__alternativeMethods: "O entra con otro método",
      blockButton__resetPassword: "Cambiar la contraseña",
    },
    forgotPassword: {
      title: "Cambiar la contraseña",
      subtitle: "Te hemos enviado un código para cambiarla",
      formTitle: "Código para cambiar la contraseña",
      resendButton: "¿No te ha llegado? Reenviar",
    },
    resetPassword: {
      title: "Elige una contraseña nueva",
      formButtonPrimary: "Guardar contraseña",
      successMessage: "Contraseña cambiada. Entrando…",
    },
    alternativeMethods: {
      title: "Usar otro método",
      subtitle: "¿Algún problema? Puedes entrar con cualquiera de estos",
      actionLink: "Pedir ayuda",
      actionText: "¿No tienes ninguno?",
      blockButton__password: "Entrar con la contraseña",
    },
  },

  signUp: {
    start: {
      title: "Crea tu cuenta",
      subtitle: "Para guardar tus cartas y jugar con tus amigos",
      actionText: "¿Ya tienes cuenta?",
      actionLink: "Entrar",
    },
    emailCode: {
      title: "Verifica tu correo",
      subtitle: "Escribe el código que te hemos enviado",
      formTitle: "Código de verificación",
      formSubtitle: "Escribe el código que te hemos enviado por correo",
      resendButton: "¿No te ha llegado? Reenviar",
    },
    emailLink: {
      title: "Verifica tu correo",
      subtitle: "Te hemos enviado un enlace para continuar",
      formTitle: "Enlace de verificación",
      formSubtitle: "Abre el enlace que te hemos enviado por correo",
      resendButton: "¿No te ha llegado? Reenviar",
    },
    continue: {
      title: "Completa tus datos",
      subtitle: "Faltan un par de cosas para terminar",
      actionText: "¿Ya tienes cuenta?",
      actionLink: "Entrar",
    },
  },

  userButton: {
    action__manageAccount: "Gestionar cuenta",
    action__signOut: "Cerrar sesión",
    action__signOutAll: "Cerrar todas las sesiones",
    action__addAccount: "Añadir cuenta",
    action__openUserMenu: "Abrir el menú de usuario",
    action__closeUserMenu: "Cerrar el menú de usuario",
  },

  unstable__errors: {
    form_identifier_not_found: "No hay ninguna cuenta con esos datos.",
    form_password_incorrect: "La contraseña no es correcta. Prueba otra vez o usa otro método.",
    form_password_or_identifier_incorrect: "El correo o la contraseña no son correctos.",
    form_code_incorrect: "El código no es correcto.",
    form_identifier_exists__email_address: "Ya hay una cuenta con ese correo.",
    form_identifier_exists__username: "Ese nombre de usuario ya está cogido.",
    form_param_format_invalid__email_address: "Escribe un correo electrónico válido.",
    form_password_length_too_short: "La contraseña es demasiado corta.",
    form_password_pwned:
      "Esa contraseña ha aparecido en una filtración. Elige otra, por seguridad.",
    form_param_nil: "Este campo es obligatorio.",
    not_allowed_access: "Este correo no tiene permiso para entrar.",
    captcha_invalid: "No se ha podido comprobar que no eres un robot. Recarga la página y prueba otra vez.",
  },
};
