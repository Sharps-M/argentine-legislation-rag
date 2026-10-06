import { createHash } from "node:crypto";

import type { Regulation } from "@/db/schema";

import { chunkRegulation, type Chunk } from "./chunker";
import type { PageFetcher } from "./fetcher";
import { decodeHtml, htmlToText } from "./html-to-text";

export type TextSource = "updated" | "original" | "summary";

export type ExtractedText = {
  source: TextSource;
  sourceUrl: string | null;
  content: string;
  contentHash: string;
};

/** The subset of a regulation the text pipeline needs. */
export type RegulationRef = Pick<
  Regulation,
  | "id"
  | "type"
  | "number"
  | "title"
  | "topic"
  | "summary"
  | "originalTextUrl"
  | "updatedTextUrl"
>;

/** Raw pages already downloaded, so re-chunking never hits the network again. */
export type PageCache = {
  read: (regulationId: number, source: TextSource) => Promise<Uint8Array | null>;
  write: (regulationId: number, source: TextSource, bytes: Uint8Array) => Promise<void>;
};

export type TextStore = {
  /** Hash of the stored text, or `null` when the regulation has none yet. */
  currentHash: (regulationId: number) => Promise<string | null>;
  save: (regulationId: number, text: ExtractedText, chunks: Chunk[]) => Promise<void>;
};

export type TextPipelineOptions = {
  /** Never use the network: process only pages already in the cache. */
  onlyCached?: boolean;
  /** Download again even when the page is cached. */
  refetch?: boolean;
  /** Re-chunk and save even when the text did not change. */
  force?: boolean;
  maxChars?: number;
  /** Give up after this many "403 Forbidden" in a row: the server is refusing us. */
  maxConsecutiveForbidden?: number;
  onProgress?: (done: number, total: number) => void;
};

export type TextReport = {
  processed: number;
  downloaded: number;
  fromCache: number;
  summaries: number;
  unchanged: number;
  saved: number;
  chunks: number;
  failed: number;
  failureReasons: Record<string, number>;
  failedExamples: { id: number; reason: string }[];
  /** Set when the run stopped early. */
  aborted: string | null;
};

/** Pages shorter than this are error pages or empty shells, not regulations. */
const MIN_TEXT_LENGTH = 80;

export const hashText = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/** Text source for a regulation: the consolidated text when there is one. */
export function pickSource(
  regulation: RegulationRef,
): { source: "updated" | "original"; url: string } | null {
  if (regulation.updatedTextUrl) {
    return { source: "updated", url: regulation.updatedTextUrl };
  }
  if (regulation.originalTextUrl) {
    return { source: "original", url: regulation.originalTextUrl };
  }
  return null;
}

/**
 * Text for a regulation InfoLEG publishes no full text for: what the dataset
 * does provide (type and number, title, topic and abstract).
 */
export function summaryText(regulation: RegulationRef): string {
  const heading = [regulation.type, regulation.number].filter(Boolean).join(" ");

  return [regulation.topic, heading, regulation.title, regulation.summary]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

/**
 * Downloads (or reads from cache), cleans and chunks the text of each
 * regulation, then stores it. Safe to re-run: unchanged texts are skipped.
 */
export async function processTexts(
  regulations: RegulationRef[],
  deps: { fetchPage: PageFetcher; cache: PageCache; store: TextStore },
  options: TextPipelineOptions = {},
): Promise<TextReport> {
  const { fetchPage, cache, store } = deps;
  const maxForbidden = options.maxConsecutiveForbidden ?? 5;

  const report: TextReport = {
    processed: 0,
    downloaded: 0,
    fromCache: 0,
    summaries: 0,
    unchanged: 0,
    saved: 0,
    chunks: 0,
    failed: 0,
    failureReasons: {},
    failedExamples: [],
    aborted: null,
  };

  const fail = (id: number, reason: string) => {
    report.failed += 1;
    report.failureReasons[reason] = (report.failureReasons[reason] ?? 0) + 1;
    if (report.failedExamples.length < 10) report.failedExamples.push({ id, reason });
  };

  let consecutiveForbidden = 0;

  for (const regulation of regulations) {
    report.processed += 1;
    options.onProgress?.(report.processed, regulations.length);

    const picked = pickSource(regulation);
    let text: ExtractedText;
    let chunks: Chunk[];

    if (!picked) {
      const content = summaryText(regulation);
      if (!content) {
        fail(regulation.id, "no text and no summary");
        continue;
      }

      report.summaries += 1;
      text = {
        source: "summary",
        sourceUrl: null,
        content,
        contentHash: hashText(content),
      };
      chunks = [{ ordinal: 0, section: "summary", label: null, content }];
    } else {
      let bytes = options.refetch
        ? null
        : await cache.read(regulation.id, picked.source);
      let contentType: string | null = null;

      if (bytes) {
        report.fromCache += 1;
      } else if (options.onlyCached) {
        fail(regulation.id, "not in cache");
        continue;
      } else {
        const page = await fetchPage(picked.url);

        if (!page.ok) {
          fail(regulation.id, page.reason);

          consecutiveForbidden = page.status === 403 ? consecutiveForbidden + 1 : 0;
          if (consecutiveForbidden >= maxForbidden) {
            report.aborted = `Stopped after ${maxForbidden} consecutive "403 Forbidden" responses: the server is refusing these requests.`;
            break;
          }
          continue;
        }

        consecutiveForbidden = 0;
        report.downloaded += 1;
        bytes = page.bytes;
        contentType = page.contentType;
        await cache.write(regulation.id, picked.source, bytes);
      }

      const content = htmlToText(decodeHtml(bytes, contentType));
      if (content.length < MIN_TEXT_LENGTH) {
        fail(regulation.id, "page has no text");
        continue;
      }

      text = {
        source: picked.source,
        sourceUrl: picked.url,
        content,
        contentHash: hashText(content),
      };
      chunks = chunkRegulation(content, { maxChars: options.maxChars });
    }

    if (
      !options.force &&
      (await store.currentHash(regulation.id)) === text.contentHash
    ) {
      report.unchanged += 1;
      continue;
    }

    // One text the database rejects must not end a run of hours: it is counted
    // as a failure and the run goes on.
    try {
      await store.save(regulation.id, text, chunks);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fail(regulation.id, `could not save: ${reason.slice(0, 120)}`);
      continue;
    }

    report.saved += 1;
    report.chunks += chunks.length;
  }

  return report;
}
