import { defaultLocale, hasLocale, type Locale } from "@/i18n/config";

/** The languages an answer can be written in: the ones the site speaks. */
export type AnswerLanguage = Locale;

export const isAnswerLanguage = hasLocale;

// Words that give a language away in a short question. Legal terms that both
// languages share with the corpus ("decreto", "ley") are left out on purpose:
// "What does Decreto 829/2026 say?" is English.
const SPANISH =
  /[¿¡ñáéíóú]|\b(?:el|la|los|las|un|una|unos|unas|del|al|que|qué|cuál|cuáles|cómo|cuándo|dónde|quién|por|para|con|sin|sobre|entre|desde|hasta|es|son|está|están|hay|tiene|tienen|se|su|sus|lo|y|o|en|de|dice|establece|dispone|rige|norma|normas|artículo)\b/giu;
const ENGLISH =
  /\b(?:the|an|of|to|in|on|for|with|without|about|from|by|and|or|is|are|was|were|does|do|did|what|which|who|when|where|how|why|that|this|there|has|have|say|says|law|laws|act|article|regulation|regulations)\b/giu;

/**
 * Guesses whether a question is in Spanish or in English, by counting the
 * small words each language cannot do without. A tie goes to Spanish, the
 * language of the legislation and of the site by default.
 *
 * It only has to tell two languages apart, on a sentence a person typed. When
 * the caller knows the language (the page the question came from), it should
 * say so instead of leaving it to this.
 */
export function detectLanguage(question: string): AnswerLanguage {
  const count = (pattern: RegExp) => question.match(pattern)?.length ?? 0;

  return count(ENGLISH) > count(SPANISH) ? "en" : defaultLocale;
}
