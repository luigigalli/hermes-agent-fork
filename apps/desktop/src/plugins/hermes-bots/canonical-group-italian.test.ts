import { expect, it } from 'vitest'

import { BOTS_LOCALES } from './i18n'

// The Italian pack (card t_97e2e058): the user's config already carries
// `display.language: it`; the plugin registers it as a partial runtime locale
// (canonical-group-italian-pack.ts), so this bundle is the contract the
// switcher's «Italiano» entry resolves against.
const italian = BOTS_LOCALES.it as Record<string, unknown> | undefined
const italianCanonical = (italian?.canonical || {}) as Record<string, string>

it('the Italian canonical copy covers the exact key set of the English bundle, complete and distinct', async () => {
  const { CANONICAL_GROUP_LOCALES, CANONICAL_GROUP_LOCALE_ITALIAN } = await import('./canonical-group-locales')
  const english = CANONICAL_GROUP_LOCALES.en

  expect(Object.keys(italianCanonical).sort()).toEqual(Object.keys(english).sort())

  for (const [key, value] of Object.entries(CANONICAL_GROUP_LOCALE_ITALIAN)) {
    expect(String(value).trim(), `it.${key}`).not.toBe('')
    expect(italianCanonical[key], `BOTS_LOCALES.it.canonical.${key}`).toBe(value)
  }
})

it('the Italian gate copy carries the same keys as the English gate bundle', () => {
  const englishGate = ((BOTS_LOCALES.en as unknown as Record<string, unknown>).legacyGate || {}) as Record<
    string,
    string
  >
  const italianGate = ((italian?.legacyGate || {}) as Record<string, string>) ?? {}

  expect(Object.keys(italianGate).sort()).toEqual(Object.keys(englishGate).sort())
  expect(italianGate.legacyRoom.trim(), 'it.legacyGate.legacyRoom').not.toBe('')
  expect(italianGate.legacyRoom).not.toBe(englishGate.legacyRoom)
})

it('the app-level Italian pack covers the strings the group surfaces read from the app catalog', async () => {
  const { ITALIAN_GROUP_LOCALE_PACK } = await import('./canonical-group-italian-pack')

  expect(ITALIAN_GROUP_LOCALE_PACK.gatewayGroupOpen).toMatchObject({
    lookupFailed: expect.any(String),
    missing: expect.any(String),
    opening: expect.any(String)
  })
  expect(ITALIAN_GROUP_LOCALE_PACK.common).toMatchObject({
    back: expect.any(String),
    cancel: expect.any(String),
    refresh: expect.any(String),
    retry: expect.any(String),
    send: expect.any(String)
  })
  expect(ITALIAN_GROUP_LOCALE_PACK.composer).toMatchObject({ stop: expect.any(String) })
  expect(ITALIAN_GROUP_LOCALE_PACK.fileMenu).toMatchObject({ download: expect.any(String) })
})
