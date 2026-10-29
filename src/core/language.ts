/**
 * Lightweight detection of the language the user is currently writing in, so
 * the fold can pin the summary to a CONCRETE language. A soft "match the
 * user's language" instruction is ignored by CJK-defaulting backends (they
 * keep answering in Chinese); naming the target language explicitly is what
 * actually changes their output.
 *
 * Pure function over text; no cordis, no I/O, no model calls.
 */

/** The languages the fold can pin the output to. */
export type SessionLanguage = 'zh' | 'fr' | 'en' | 'other'

/** Human names used in the prompt ("write in French"). */
export const LANGUAGE_NAMES: Record<Exclude<SessionLanguage, 'other'>, string> = {
  zh: 'Chinese',
  fr: 'French',
  en: 'English',
}

/** Han ideographs (CJK Unified Ideographs + common extensions). */
const HAN = /\p{Script=Han}/gu
/** Latin letters, with or without diacritics. */
const LATIN = /[A-Za-zÀ-ÖØ-öø-ÿ]/g
/**
 * Distinctive French function words (curated: none of them is an English
 * word, so hits in a latin-script text are reliable French signals).
 */
const FRENCH_WORDS =
  /\b(le|la|les|un|une|des|du|est|sont|et|ou|que|qui|quoi|vous|votre|vos|nous|notre|je|tu|il|elle|pour|avec|dans|sur|sous|mais|donc|alors|oui|non|bien|bon|merci|salut|aujourd'hui|demain|hier|quand|pourquoi|parce|très|aussi|encore|tout|tous|toutes|peu|plus|moins|peut|faire|fait|cette|cet|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|leur|leurs|être|avoir|ceci|cela)\b/giu
/** Accented letters — French text almost always carries several; English almost never does. */
const FRENCH_ACCENTS = /[éèêëàâäîïôùûüçœæ]/gu

/** Below this much text the signal is too weak to detect anything. */
const MIN_LETTERS = 20
/** A Han share at or above this means the user is writing in Chinese. */
const HAN_SHARE_THRESHOLD = 0.3

/**
 * Detect the dominant language of the user's recent messages.
 * @param text - the user's message text (recent turns).
 * @returns 'zh' for Chinese, 'fr' for French, 'en' for English, 'other' when
 *   the text is too short or ambiguous to classify.
 */
export function detectSessionLanguage(text: string): SessionLanguage {
  const han = text.match(HAN) ?? []
  const latin = text.match(LATIN) ?? []
  const total = han.length + latin.length
  if (total < MIN_LETTERS) return 'other'
  // The user is writing in Chinese: keep Chinese output (do not force Latin).
  if (han.length / total >= HAN_SHARE_THRESHOLD) return 'zh'
  // Latin script: French if it carries clear French signals.
  const accents = (text.match(FRENCH_ACCENTS) ?? []).length
  const words = (text.match(FRENCH_WORDS) ?? []).length
  if (accents >= 4 || words >= 4) return 'fr'
  return 'en'
}
