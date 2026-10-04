export type EmbeddingContext = {
  type: string;
  number: string | null;
  enactedOn: string | null;
  topic: string | null;
  title: string | null;
  label: string | null;
  content: string;
};

/** "Decreto 282/2026", "Ley 27817", "Decreto S/N". */
export function regulationName(regulation: {
  type: string;
  number: string | null;
  enactedOn: string | null;
}): string {
  const number = regulation.number?.trim();
  if (!number) return regulation.type;

  // Laws are numbered once and for all; everything else restarts every year.
  const year = regulation.enactedOn?.slice(0, 4);
  const yearly =
    regulation.type.toLowerCase() !== "ley" && /^\d+$/.test(number) && year;

  return `${regulation.type} ${number}${yearly ? `/${year}` : ""}`;
}

/**
 * The text that gets embedded for a chunk.
 *
 * An article on its own ("Comuníquese al Poder Ejecutivo.") says little about
 * where it belongs. Prefixing the regulation's name, topic, title and the
 * article label gives the vector that context, so a question that names the
 * regulation or its subject lands on the right chunks.
 */
export function embeddingInput(context: EmbeddingContext): string {
  const header = [regulationName(context), context.topic, context.title, context.label]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return `${header}\n\n${context.content}`;
}
