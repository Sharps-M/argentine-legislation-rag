/**
 * How long a question may be, and which years a filter may name. In a module of its own, with no imports, so that
 * the page can check a question before sending it without taking the search
 * code into the browser.
 */
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 500;
export const MIN_YEAR = 1810;
export const MAX_YEAR = 2100;
