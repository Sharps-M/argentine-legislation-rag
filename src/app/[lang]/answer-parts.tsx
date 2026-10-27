import type { AnswerSource } from "@/answers/sources";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { fill, longDate } from "@/i18n/format";
import type { Block, Segment } from "@/ui/answer-text";

type Texts = Dictionary["ask"];

function SegmentView({ segment, texts }: { segment: Segment; texts: Texts }) {
  if (segment.kind === "text") return segment.text;

  if (segment.kind === "cite") {
    return (
      <span className="whitespace-nowrap text-sm">
        [
        {segment.refs.map(({ n, known }, index) => (
          <span key={`${n}-${index}`}>
            {index > 0 && ", "}
            {known ? (
              <a
                href={`#source-${n}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                {n}
              </a>
            ) : (
              <span className="text-danger" title={fill(texts.unknownCitation, { n })}>
                {n}
                <span className="sr-only"> ({fill(texts.unknownCitation, { n })})</span>
              </span>
            )}
          </span>
        ))}
        ]
      </span>
    );
  }

  const status = segment.check?.status;
  if (status === "other_source" || status === "not_found") {
    const note = texts.amount[status];
    return (
      <span
        className="underline decoration-warning decoration-wavy underline-offset-4"
        title={note}
        data-amount={status}
      >
        {segment.text}
        <span className="sr-only"> ({note})</span>
      </span>
    );
  }
  return <span data-amount={status ?? "unchecked"}>{segment.text}</span>;
}

const Line = ({ segments, texts }: { segments: Segment[]; texts: Texts }) =>
  segments.map((segment, index) => (
    <SegmentView key={index} segment={segment} texts={texts} />
  ));

/** The answer, with its citations as links to the sources and its doubtful amounts marked. */
export function AnswerText({ blocks, texts }: { blocks: Block[]; texts: Texts }) {
  return (
    <div className="space-y-3 leading-relaxed">
      {blocks.map((block, index) =>
        block.kind === "list" ? (
          <ul key={index} className="list-disc space-y-1 pl-6">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Line segments={item} texts={texts} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                <Line segments={line} texts={texts} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

/** The sources, numbered as the answer cites them, each with its link to the official text. */
export function SourceList({
  sources,
  cited,
  lang,
  texts,
}: {
  sources: AnswerSource[];
  /** The ones the answer cites, once it ended; until then, none is singled out. */
  cited: number[] | null;
  lang: Locale;
  texts: Texts;
}) {
  return (
    <ol className="space-y-4">
      {sources.map((source) => {
        const faded = cited !== null && !cited.includes(source.n);
        return (
          <li
            key={source.chunkId}
            id={`source-${source.n}`}
            className={`scroll-mt-6 rounded-lg border border-border p-4 target:border-accent ${faded ? "opacity-70" : ""}`}
          >
            <p className="font-medium">
              <span className="mr-2 text-muted">[{source.n}]</span>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                {source.title}
              </a>
            </p>
            <p className="mt-1 text-sm text-muted">
              {source.enactedOn &&
                fill(texts.source.enacted, { date: longDate(source.enactedOn, lang) })}
              {source.enactedOn && source.subject && " · "}
              {source.subject}
            </p>
            {source.abstractOnly && (
              <p className="mt-2 text-sm text-warning">{texts.source.abstractOnly}</p>
            )}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted hover:text-foreground">
                {texts.source.showText}
              </summary>
              <p className="mt-2 whitespace-pre-line">{source.content}</p>
            </details>
            {source.earlier.length > 0 && (
              <p className="mt-2 text-sm text-muted">
                {texts.source.earlier}{" "}
                {source.earlier.map((earlier, index) => (
                  <span key={earlier.regulationId}>
                    {index > 0 && ", "}
                    <a
                      href={earlier.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {earlier.name}
                    </a>
                    {earlier.enactedOn && ` (${longDate(earlier.enactedOn, lang)})`}
                  </span>
                ))}
                {source.earlierOmitted > 0 &&
                  ` ${fill(texts.source.older, { count: source.earlierOmitted })}`}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
