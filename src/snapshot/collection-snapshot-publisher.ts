import type { ArcGisCollectionResult } from '../harvesting/arcgis-client.ts';
import type { PoolNormalizationError, PoolNormalizer } from '../normalization/pool-normalizer.ts';
import type { PoolSnapshot } from '../contracts/pool-snapshot.ts';
import type { SnapshotStore, SnapshotStoreErrorCode } from './snapshot-store.ts';

export type CollectionSnapshotPublicationResult =
  | Readonly<{ ok: true; status: 'ignored' }>
  | Readonly<{ ok: true; status: 'published' | 'refreshed'; snapshot: PoolSnapshot }>
  | Readonly<{
    ok: false;
    error:
      | Readonly<{ code: 'normalization'; detail: PoolNormalizationError }>
      | Readonly<{ code: SnapshotStoreErrorCode }>;
  }>;

export interface CollectionSnapshotPublisher {
  apply(
    result: ArcGisCollectionResult,
    checkedAtEpochMs: number,
  ): CollectionSnapshotPublicationResult;
  sourceEtag(): string | undefined;
}

/** Publishes accepted collections while keeping source validators outside consumer snapshots. */
export function createCollectionSnapshotPublisher(
  normalizer: PoolNormalizer,
  store: SnapshotStore,
): CollectionSnapshotPublisher {
  let sourceEtag: string | undefined;

  return Object.freeze({
    apply(
      result: ArcGisCollectionResult,
      checkedAtEpochMs: number,
    ): CollectionSnapshotPublicationResult {
      if (!result.ok) {
        return Object.freeze({ ok: true, status: 'ignored' });
      }
      if (result.result === 'not-modified') {
        return fromStoreResult(store.refresh(checkedAtEpochMs), 'refreshed');
      }

      const normalized = normalizer.normalize(result.collection);
      if (!normalized.ok) {
        return Object.freeze({
          ok: false,
          error: Object.freeze({ code: 'normalization', detail: normalized.error }),
        });
      }
      const published = fromStoreResult(
        store.publish(normalized.value, checkedAtEpochMs),
        'published',
      );
      if (published.ok) {
        sourceEtag = result.etag;
      }
      return published;
    },

    sourceEtag(): string | undefined {
      return sourceEtag;
    },
  });
}

function fromStoreResult(
  result: ReturnType<SnapshotStore['publish']>,
  status: 'published' | 'refreshed',
): CollectionSnapshotPublicationResult {
  return result.ok
    ? Object.freeze({ ok: true, status, snapshot: result.snapshot })
    : Object.freeze({ ok: false, error: result.error });
}
