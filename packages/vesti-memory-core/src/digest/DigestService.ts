import { deriveProjectKey } from '../storage/projectRegistry.js';
import { serializeVector } from '../search/VectorSearch.js';
import { stripInjectedContextBlocks } from '../utils/injectedBlocks.js';
import type { SessionDigest, SessionDigestStats, SessionMessage, WorkSession } from '../types.js';
import { parseDigestPayload, type DigestPayload } from './payload.js';
import {
  RECENT_MESSAGE_LIMIT,
  TRANSCRIPT_BUDGET_CHARS,
  buildDigestTranscript as buildTranscript,
  extractNumericFacts,
  formatNumericFactsBlock,
} from './transcript.js';

/**
 * Digest pipeline (P1.5): after each capture sync, sessions that are new or
 * grew since their last digest are queued (deduped, processed serially) and
 * summarized by the 'digest' agent kind into session_digests. LLM outages
 * degrade to a structural row (first user message as one_liner) — capture is
 * never blocked by digest failures. Bump DIGEST_VERSION when the digest
 * prompt structure changes; stale versions are regenerated automatically.
 *
 * v2 (bench C 2026-07-19 follow-up): numeric-fidelity rules in the prompt
 * (values must be kept verbatim), a wider transcript window (see
 * digestTranscript.ts), and degraded-digest detection: rows whose four
 * structured fields are all empty and whose one_liner echoes the first user
 * message get one LLM retry (only when the LLM is configured); a retry that
 * still degrades is marked embedding_status='degraded' and left alone until
 * the session grows or the version bumps. No new columns — the mark reuses
 * the existing embedding_status field (runtime judgment elsewhere).
 *
 * v3 (2026-07-22 发布前检查): injected-context stripping in the transcript
 * window and the fallback one_liner (codex <environment_context>, cursor
 * <timestamp>/<user_query>, kimi <git-context> were echoed into digests and
 * from there into project cards/briefs). The bump regenerates every digest
 * written during the 07-19..07-22 LLM outage in one pass.
 */
export const DIGEST_VERSION = 3;

const FALLBACK_ONE_LINER_CHARS = 100;
const MAX_RETRIES = 2;
const SCAN_DEBOUNCE_MS = 2_000;

/** Degraded one_liner detection thresholds (bench C: fallback rows paste the
 * raw first user prompt, 100-char truncated). */
const ECHO_MIN_ONE_LINER_CHARS = 90;
const ECHO_SIMILARITY_THRESHOLD = 0.8;
const ECHO_SAMPLE_CHARS = 400;

/** Transcript from the most recent messages plus task framing and file-write
 * context — see digestTranscript.ts. Keeps the v1 positional signature. */
export function buildDigestTranscript(
  messages: SessionMessage[],
  budgetChars = TRANSCRIPT_BUDGET_CHARS,
  recentLimit = RECENT_MESSAGE_LIMIT,
): string {
  return buildTranscript(messages, { budgetChars, recentLimit });
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Character-bigram Dice coefficient (0-1); 1 for identical strings. */
function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 <= a.length; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i + 2 <= b.length; i += 1) {
    const gram = b.slice(i, i + 2);
    const available = counts.get(gram) ?? 0;
    if (available > 0) {
      hits += 1;
      counts.set(gram, available - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

export interface DegradedDigestShape {
  oneLiner: string;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
  openQuestions: string[];
}

/**
 * Runtime degraded-digest judgment (no schema change): the four structured
 * fields are all empty AND the one_liner is just the first user message —
 * either a long truncated copy (fallback rows slice 100 chars) or an echo
 * with >80% bigram overlap.
 */
export function isDegradedDigest(digest: DegradedDigestShape, firstUserText: string): boolean {
  const structuredEmpty =
    digest.keyTopics.length === 0 &&
    digest.keyFiles.length === 0 &&
    digest.decisions.length === 0 &&
    digest.openQuestions.length === 0;
  if (!structuredEmpty) return false;
  const oneLiner = collapseWhitespace(digest.oneLiner ?? '');
  const firstUser = collapseWhitespace(firstUserText ?? '');
  if (!oneLiner || !firstUser) return false;
  if (oneLiner.length >= ECHO_MIN_ONE_LINER_CHARS && firstUser.startsWith(oneLiner)) return true;
  return bigramDice(
    oneLiner.slice(0, ECHO_SAMPLE_CHARS),
    firstUser.slice(0, ECHO_SAMPLE_CHARS),
  ) > ECHO_SIMILARITY_THRESHOLD;
}

/** One session plus its stored messages — the pipeline's read unit. */
export interface SessionDetail {
  session: WorkSession;
  messages: SessionMessage[];
}

/** Storage surface the pipeline needs; MemoryDatabase implements it. */
export interface DigestSessionStore {
  getSessionDetail(id: string): SessionDetail | null;
  listSessionsNeedingDigest(digestVersion: number): Array<{ id: string; messageCount: number }>;
  /** SQL pre-filter for degraded rows (four empty structured fields, non-empty
   * one_liner, embedding_status='skipped'); the exact echo check happens in
   * the service with the session's first user message. */
  listDegradedDigestCandidates(): SessionDigest[];
  getSessionDigestStats(): SessionDigestStats;
  upsertSessionDigest(digest: SessionDigest): void;
}

/**
 * Injected LLM runner for the 'digest' kind. The request always carries the
 * pre-built transcript in `transcriptOverride`; the result's `content` is the
 * raw model output (parsed with parseDigestPayload). No HTTP/SDK client lives
 * in this package — callers wire their own provider.
 */
export interface DigestAgentRequest {
  kind: 'digest';
  sessionId: string;
  transcriptOverride?: string;
}

export interface DigestAgentResult {
  content: string;
}

export interface DigestAgentRunner {
  run(request: DigestAgentRequest, options?: { persist?: boolean }): Promise<DigestAgentResult>;
}

export interface DigestEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  embedWithMetadata?(texts: string[]): Promise<{
    vectors: Float32Array[];
    metadata: {
      provider: string;
      model: string;
      dimensions: number;
      version: string;
    };
  }>;
}

function firstUserText(messages: SessionMessage[]): string {
  // Stripped of injected context so echo comparisons and fallbacks see the
  // user's actual words, matching what the digest transcript now carries.
  const firstUser = messages.find(
    message => message.role === 'user' && stripInjectedContextBlocks(message.contentText ?? '').trim(),
  );
  return stripInjectedContextBlocks(firstUser?.contentText ?? messages[0]?.contentText ?? '');
}

export class DigestService {
  private queue: string[] = [];
  private queued = new Set<string>();
  private retryCounts = new Map<string, number>();
  private degradedRetries = new Set<string>();
  /** Sessions that already got their one degraded-retry this app run. A
   * failing LLM now leaves rows 'skipped' (recoverable) instead of
   * 'degraded' (terminal), so without this cap every post-sync scan would
   * re-fire the same failing calls — one attempt per session per run. */
  private degradedAttempted = new Set<string>();
  private degradedRetryCount = 0;
  private degradedGaveUpCount = 0;
  private pumpPromise: Promise<void> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private scanCompleted?: () => void;

  constructor(
    private readonly store: DigestSessionStore,
    private readonly agent: DigestAgentRunner,
    private readonly embedding: DigestEmbedder,
    /** Degraded rows are retried only when the chat LLM is usable. */
    private readonly isLlmReady: () => boolean = () => true,
  ) {}

  setScanCompletedListener(listener: () => void): void {
    this.scanCompleted = listener;
  }

  /** Initial backfill scan at startup. */
  start(): void {
    void this.enqueuePending().catch(() => undefined);
  }

  /** Stop pending background work when the member signs out or expires.
   * An already-running network request is allowed to finish, but no queued
   * session is started afterwards. */
  stop(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.queue.length = 0;
    this.queued.clear();
    this.retryCounts.clear();
    this.degradedRetries.clear();
  }

  /** Capture-sync hook: debounced re-scan for new or grown sessions. */
  requestScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.enqueuePending().catch(() => undefined);
    }, SCAN_DEBOUNCE_MS);
    this.scanTimer.unref?.();
  }

  /** Scan for sessions needing a digest, enqueue them, and wait for the
   * queue to drain. */
  async enqueuePending(): Promise<void> {
    for (const candidate of this.store.listSessionsNeedingDigest(DIGEST_VERSION)) {
      this.enqueue(candidate.id);
    }
    this.enqueueDegradedRetries();
    await this.pumpPromise;
    this.logDigestHealth();
    this.scanCompleted?.();
  }

  /**
   * Degraded-digest statistics for future settings/diagnostics surfaces —
   * currently data layer + logs only: store-wide counts from capture-core
   * plus this run's retry counters.
   */
  getDigestStats(): { run: { degradedRetries: number; degradedGaveUp: number }; store: SessionDigestStats } {
    return {
      run: {
        degradedRetries: this.degradedRetryCount,
        degradedGaveUp: this.degradedGaveUpCount,
      },
      store: this.store.getSessionDigestStats(),
    };
  }

  private enqueueDegradedRetries(): void {
    if (!this.isLlmReady()) return;
    for (const digest of this.store.listDegradedDigestCandidates()) {
      if (this.queued.has(digest.sessionId)) continue;
      if (this.degradedAttempted.has(digest.sessionId)) continue;
      const detail = this.store.getSessionDetail(digest.sessionId);
      if (!detail || detail.messages.length === 0) continue;
      if (!isDegradedDigest(digest, firstUserText(detail.messages))) continue;
      this.degradedAttempted.add(digest.sessionId);
      this.degradedRetries.add(digest.sessionId);
      this.degradedRetryCount += 1;
      this.enqueue(digest.sessionId);
    }
  }

  private logDigestHealth(): void {
    try {
      const stats = this.getDigestStats();
      if (stats.store.emptyStructured > 0 || stats.store.failed > 0) {
        console.warn(
          `[digest] 健康检查：共 ${stats.store.total} 条 digest，四字段全空 ${stats.store.emptyStructured} 条` +
          `（本轮重试 ${stats.run.degradedRetries}、累计放弃 ${stats.run.degradedGaveUp}、已标记放弃 ${stats.store.gaveUp}），` +
          `失败 ${stats.store.failed} 条`,
        );
      }
    } catch { /* health logging is best-effort and must never break capture */ }
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.kick();
  }

  private kick(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        try {
          await this.process(id);
          this.retryCounts.delete(id);
          this.queued.delete(id);
        } catch {
          // Unexpected failure (e.g. storage): retry up to MAX_RETRIES times,
          // then leave a 'failed' row so the session is retried only when it
          // grows again — never loop forever on a broken session.
          const retries = (this.retryCounts.get(id) ?? 0) + 1;
          this.retryCounts.set(id, retries);
          if (retries <= MAX_RETRIES) {
            this.queue.push(id);
          } else {
            this.retryCounts.delete(id);
            this.queued.delete(id);
            this.writeFailedRow(id);
          }
        }
      }
    } finally {
      this.pumpPromise = null;
    }
  }

  private async process(sessionId: string): Promise<void> {
    const detail = this.store.getSessionDetail(sessionId);
    if (!detail || detail.messages.length === 0) return;
    let transcript = buildDigestTranscript(detail.messages);
    if (!transcript.trim()) return;

    // V4 (Digest V2): pre-extract numeric/unit facts from the transcript and
    // append them as a structured reference block so the LLM can integrate
    // provided values rather than discover them from scratch. Bench C showed
    // 6.4% numerical fidelity — this block addresses the root cause.
    const numericFacts = extractNumericFacts(transcript);
    const factsBlock = formatNumericFactsBlock(numericFacts);
    if (factsBlock) {
      transcript = `${transcript}\n\n${factsBlock}`;
    }

    // A degraded row gets exactly one retry pass; still-degraded output is
    // marked 'degraded' and never auto-retried again.
    const isDegradedRetry = this.degradedRetries.delete(sessionId);

    // LLM digest: one retry on bad/unreachable output, then degrade.
    let payload: DigestPayload | null = null;
    for (let attempt = 0; attempt < 2 && !payload; attempt += 1) {
      try {
        const result = await this.agent.run(
          { kind: 'digest', sessionId, transcriptOverride: transcript },
          { persist: false },
        );
        payload = parseDigestPayload(result.content);
      } catch {
        payload = null;
      }
    }

    const base = this.baseDigest(detail);
    if (!payload) {
      // LLM unreachable or unparseable output: structural fallback, no
      // embedding. Always 'skipped' — a transport failure says nothing
      // about the session, so the row stays recoverable once the LLM is
      // healthy again (the per-run attempted set stops same-run storms).
      // 'degraded' is reserved for the parsed-but-still-echo verdict below.
      this.store.upsertSessionDigest({
        ...base,
        oneLiner: this.fallbackOneLiner(detail.messages),
        embeddingStatus: 'skipped',
      });
      return;
    }

    if (isDegradedRetry && isDegradedDigest(
      {
        oneLiner: payload.one_liner,
        keyTopics: payload.key_topics,
        keyFiles: payload.key_files,
        decisions: payload.decisions,
        openQuestions: payload.open_questions,
      },
      firstUserText(detail.messages),
    )) {
      // Retry still degraded: keep the row, mark it, stop auto-retrying.
      this.store.upsertSessionDigest({
        ...base,
        oneLiner: payload.one_liner,
        embeddingStatus: 'degraded',
      });
      this.degradedGaveUpCount += 1;
      return;
    }

    // Embed the digest text (one_liner + topics); outages mark 'skipped'.
    let embedding: Buffer | null = null;
    let embeddingStatus: SessionDigest['embeddingStatus'] = 'skipped';
    let embeddingMetadata: {
      provider: string;
      model: string;
      dimensions: number;
      version: string;
    } | null = null;
    try {
      const texts = [[payload.one_liner, ...payload.key_topics].join('\n')];
      const result = this.embedding.embedWithMetadata
        ? await this.embedding.embedWithMetadata(texts)
        : { vectors: await this.embedding.embed(texts), metadata: null };
      const [vector] = result.vectors;
      if (vector) {
        embedding = serializeVector(vector);
        embeddingMetadata = result.metadata;
        embeddingStatus = 'ok';
      }
    } catch {
      embeddingStatus = 'skipped';
    }

    this.store.upsertSessionDigest({
      ...base,
      oneLiner: payload.one_liner,
      keyTopics: payload.key_topics,
      keyFiles: payload.key_files,
      decisions: payload.decisions,
      openQuestions: payload.open_questions,
      embedding,
      embeddingProvider: embeddingMetadata?.provider ?? null,
      embeddingModel: embeddingMetadata?.model ?? null,
      embeddingDimensions: embeddingMetadata?.dimensions ?? null,
      embeddingVersion: embeddingMetadata?.version ?? null,
      embeddingStatus,
    });
  }

  private baseDigest(detail: SessionDetail): SessionDigest {
    const session = detail.session;
    const host = session.host ?? 'native';
    return {
      sessionId: session.id,
      host,
      platform: session.platform,
      projectKey: deriveProjectKey({
        platform: session.platform,
        host,
        projectPath: session.projectPath ?? '',
        gitRemote: session.gitRemote,
      }),
      oneLiner: '',
      keyTopics: [],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
      embedding: null,
      embeddingStatus: 'none',
      digestVersion: DIGEST_VERSION,
      messageCount: session.messageCount || detail.messages.length,
      updatedAt: new Date().toISOString(),
    };
  }

  private fallbackOneLiner(messages: SessionMessage[]): string {
    // firstUserText strips injected context, so outage-fallback rows no longer
    // surface raw machine tags in the tree, project cards and relay packs.
    return collapseWhitespace(firstUserText(messages)).slice(0, FALLBACK_ONE_LINER_CHARS);
  }

  private writeFailedRow(sessionId: string): void {
    try {
      const detail = this.store.getSessionDetail(sessionId);
      if (!detail) return;
      this.store.upsertSessionDigest({
        ...this.baseDigest(detail),
        oneLiner: this.fallbackOneLiner(detail.messages),
        embeddingStatus: 'failed',
      });
    } catch { /* the digest pipeline must never break capture */ }
  }
}
