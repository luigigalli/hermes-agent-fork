/**
 * Italian app-level language pack for Bot Mode's group surfaces — registered
 * by the plugin in `plugin.register` via `ctx.i18n.registerAppLocale('it', …)`
 * (meccanismo esistente, lingua parziale, fallback inglese; see
 * src/i18n/registry.ts). The user's config already carries
 * `display.language: it`; before this registration 'it' was not a resolvable
 * locale and the app fell back to English.
 *
 * Scope (card t_97e2e058): the strings Bot Mode's group surface renders,
 * i.e. the legacy-room gate copy (`gatewayGroupOpen.*`) and the app-level
 * generic verbs the canonical components read (`common.*`, `composer.stop`,
 * `fileMenu.download`). The Plugin-OWNED group copy rides
 * `BOTS_LOCALES.it` (canonical + legacyGate, see plugins/hermes-bots/i18n.ts).
 * Everything else falls back to the bundled English catalog — registration
 * is partial by design.
 */
export const ITALIAN_GROUP_LOCALE_PACK = {
  gatewayGroupOpen: {
    opening: 'Apertura del gruppo del gateway…',
    lookupFailed: 'Impossibile cercare questo gruppo sul gateway. Riprova.',
    missing: 'Questo gruppo del gateway non esiste più.'
  },
  common: {
    back: 'Indietro',
    cancel: 'Annulla',
    refresh: 'Aggiorna',
    retry: 'Riprova',
    send: 'Invia'
  },
  composer: {
    stop: 'Ferma'
  },
  fileMenu: {
    download: 'Scarica'
  }
}
