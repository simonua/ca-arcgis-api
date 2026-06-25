import {
  type ApiRepresentationCache,
  type ApiRepresentationKey,
  createApiRepresentationCache,
} from '../src/cache/api-representation-cache.ts';

Deno.test('representation cache rejects invalid limits and hostile noncanonical keys', async () => {
  const invalidEntries = createApiRepresentationCache({ maxEntries: 0, maxBytes: 100 });
  assert(!invalidEntries.ok);
  assertEquals(invalidEntries.error.code, 'invalid-max-entries');

  const invalidBytes = createApiRepresentationCache({ maxEntries: 1, maxBytes: Number.NaN });
  assert(!invalidBytes.ok);
  assertEquals(invalidBytes.error.code, 'invalid-max-bytes');

  const cache = configuredCache();
  activate(cache, 1);
  let fills = 0;
  const rejectedFactory = () => {
    fills += 1;
    return { ignored: true };
  };
  const malformedPool = await cache.getOrCreate(
    { generation: 1, semanticEpoch: 0, route: 'pool', poolId: 'River-Hill' },
    rejectedFactory,
  );
  assertFailure(malformedPool, 'invalid-key');

  const emptyFilters = await cache.getOrCreate(
    { generation: 1, semanticEpoch: 0, route: 'pools', filters: {} },
    rejectedFactory,
  );
  assertFailure(emptyFilters, 'invalid-key');

  const arbitraryQuery = await cache.getOrCreate(
    { generation: 1, semanticEpoch: 0, route: 'pools', query: 'sourceUrl=unsafe' },
    rejectedFactory,
  );
  assertFailure(arbitraryQuery, 'invalid-key');

  const unknownFilter = await cache.getOrCreate(
    { generation: 1, semanticEpoch: 0, route: 'pools', filters: { access: 'busy' } },
    rejectedFactory,
  );
  assertFailure(unknownFilter, 'invalid-key');
  assertEquals(fills, 0);
  assertEquals(cache.stats().entries, 0);
});

Deno.test('representation cache canonicalizes allowlisted filters and returns stable UTF-8 ETags', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  let fills = 0;
  const firstKey = Object.freeze({
    generation: 1,
    semanticEpoch: 2,
    route: 'pools' as const,
    filters: Object.freeze({ locationType: 'outdoor' as const, access: 'open-public' as const }),
  });
  const equivalentKey = Object.freeze({
    generation: 1,
    semanticEpoch: 2,
    route: 'pools' as const,
    filters: Object.freeze({ access: 'open-public' as const, locationType: 'outdoor' as const }),
  });

  const first = await cache.getOrCreate(firstKey, () => {
    fills += 1;
    return { name: 'Synthetic Pool' };
  });
  const second = await cache.getOrCreate(equivalentKey, () => {
    fills += 1;
    return { name: 'Unexpected' };
  });

  assertSuccess(first, 'miss');
  assertSuccess(second, 'hit');
  assertEquals(fills, 1);
  assertEquals(decode(first.representation.body), '{"name":"Synthetic Pool"}');
  assertEquals(first.representation.byteLength, first.representation.body.byteLength);
  assertEquals(first.representation.etag, second.representation.etag);
  assertMatches(first.representation.etag, /^"sha256-[a-f0-9]{64}"$/);

  first.representation.body[0] = 0;
  const third = await cache.getOrCreate(firstKey, () => ({ name: 'Unexpected' }));
  assertSuccess(third, 'hit');
  assertEquals(decode(third.representation.body), '{"name":"Synthetic Pool"}');
});

Deno.test('representation cache coalesces concurrent fills for one canonical key', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  const gate = Promise.withResolvers<unknown>();
  let fills = 0;
  const key = poolKey('river-hill');
  const factory = () => {
    fills += 1;
    return gate.promise;
  };

  const firstPromise = cache.getOrCreate(key, factory);
  const secondPromise = cache.getOrCreate(key, factory);
  assertEquals(cache.stats().inFlight, 1);
  assertEquals(fills, 1);
  gate.resolve({ id: 'river-hill' });

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assertSuccess(first, 'miss');
  assertSuccess(second, 'coalesced');
  assertEquals(first.representation.etag, second.representation.etag);
  assertEquals(cache.stats().inFlight, 0);
  assertEquals(cache.stats().entries, 1);
});

Deno.test('representation cache owns a key copy across asynchronous fills', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  const gate = Promise.withResolvers<unknown>();
  const mutableKey = {
    generation: 1,
    semanticEpoch: 0,
    route: 'pool',
    poolId: 'river-hill',
  };

  const pending = cache.getOrCreate(mutableKey, () => gate.promise);
  mutableKey.poolId = 'athletic-club';
  gate.resolve({ id: 'river-hill' });
  assertSuccess(await pending, 'miss');

  const original = await cache.getOrCreate(poolKey('river-hill'), () => ({ unexpected: true }));
  const mutated = await cache.getOrCreate(
    poolKey('athletic-club'),
    () => ({ id: 'athletic-club' }),
  );
  assertSuccess(original, 'hit');
  assertSuccess(mutated, 'miss');
});

Deno.test('representation cache does not retain failed or oversized fills', async () => {
  const cache = configuredCache({ maxEntries: 4, maxBytes: 16 });
  activate(cache, 1);

  const factoryFailure = await cache.getOrCreate(poolKey('river-hill'), () => {
    throw new Error('private failure');
  });
  assertFailure(factoryFailure, 'factory-failed');

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const serializationFailure = await cache.getOrCreate(poolKey('athletic-club'), () => cyclic);
  assertFailure(serializationFailure, 'serialization-failed');

  const undefinedBody = await cache.getOrCreate(poolKey('clarys-forest'), () => undefined);
  assertFailure(undefinedBody, 'serialization-failed');

  const oversized = await cache.getOrCreate(poolKey('swansfield'), () => 'x'.repeat(20));
  assertFailure(oversized, 'representation-too-large');
  assertEquals(cache.stats().entries, 0);
  assertEquals(cache.stats().bytes, 0);
});

Deno.test('representation cache evicts least-recently-used entries under entry pressure', async () => {
  const cache = configuredCache({ maxEntries: 2, maxBytes: 1_000 });
  activate(cache, 1);
  let fills = 0;
  const fill = (id: string) => {
    fills += 1;
    return { id };
  };

  await cache.getOrCreate(poolKey('river-hill'), () => fill('river-hill'));
  await cache.getOrCreate(poolKey('athletic-club'), () => fill('athletic-club'));
  const touched = await cache.getOrCreate(poolKey('river-hill'), () => fill('unexpected'));
  assertSuccess(touched, 'hit');
  await cache.getOrCreate(poolKey('clarys-forest'), () => fill('clarys-forest'));

  const evicted = await cache.getOrCreate(poolKey('athletic-club'), () => fill('athletic-club'));
  assertSuccess(evicted, 'miss');
  assertEquals(fills, 4);
  assertEquals(cache.stats().entries, 2);
});

Deno.test('representation cache evicts under aggregate byte pressure', async () => {
  const cache = configuredCache({ maxEntries: 10, maxBytes: 11 });
  activate(cache, 1);
  let firstFills = 0;

  await cache.getOrCreate(poolKey('river-hill'), () => {
    firstFills += 1;
    return 'aaaa';
  });
  await cache.getOrCreate(poolKey('athletic-club'), () => 'bbbb');
  assertEquals(cache.stats().entries, 1);
  assertEquals(cache.stats().bytes, 6);

  const firstAgain = await cache.getOrCreate(poolKey('river-hill'), () => {
    firstFills += 1;
    return 'aaaa';
  });
  assertSuccess(firstAgain, 'miss');
  assertEquals(firstFills, 2);
  assertEquals(cache.stats().bytes, 6);
});

Deno.test('representation cache retires entries only when snapshot generation advances', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  await cache.getOrCreate(poolKey('river-hill'), () => ({ generation: 1 }));

  const unchanged = cache.activateGeneration(1);
  assert(unchanged.ok);
  assertEquals(unchanged.removedEntries, 0);
  assertEquals(cache.stats().entries, 1);

  const advanced = cache.activateGeneration(2);
  assert(advanced.ok);
  assertEquals(advanced.removedEntries, 1);
  assertEquals(cache.stats().entries, 0);
  assertEquals(cache.stats().activeGeneration, 2);

  const oldRead = await cache.getOrCreate(poolKey('river-hill'), () => ({ generation: 1 }));
  assertFailure(oldRead, 'inactive-generation');
  const staleActivation = cache.activateGeneration(1);
  assert(!staleActivation.ok);
  assertEquals(staleActivation.error.code, 'stale-generation');
});

Deno.test('generation changes prevent an older in-flight fill from being retained', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  const gate = Promise.withResolvers<unknown>();
  const oldFill = cache.getOrCreate(poolKey('river-hill'), () => gate.promise);

  const advanced = cache.activateGeneration(2);
  assert(advanced.ok);
  gate.resolve({ generation: 1 });
  const completed = await oldFill;

  assertSuccess(completed, 'miss');
  assertEquals(cache.stats().activeGeneration, 2);
  assertEquals(cache.stats().entries, 0);
});

Deno.test('semantic invalidation removes only affected scopes and blocks stale in-flight retention', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  const poolsKey = collectionKey('pools', 0);
  const closuresKey = collectionKey('closures', 0);
  const riverHillKey = poolKey('river-hill', 0);
  const athleticClubKey = poolKey('athletic-club', 0);

  await cache.getOrCreate(poolsKey, () => ({ route: 'pools' }));
  await cache.getOrCreate(closuresKey, () => ({ route: 'closures' }));
  await cache.getOrCreate(riverHillKey, () => ({ id: 'river-hill' }));
  await cache.getOrCreate(athleticClubKey, () => ({ id: 'athletic-club' }));

  const invalidated = cache.invalidate([{ route: 'pools' }, {
    route: 'pool',
    poolId: 'river-hill',
  }]);
  assert(invalidated.ok);
  assertEquals(invalidated.removedEntries, 2);

  const unaffectedClosures = await cache.getOrCreate(closuresKey, () => ({ unexpected: true }));
  const unaffectedPool = await cache.getOrCreate(athleticClubKey, () => ({ unexpected: true }));
  assertSuccess(unaffectedClosures, 'hit');
  assertSuccess(unaffectedPool, 'hit');

  const nextEpoch = poolKey('river-hill', 1);
  const gate = Promise.withResolvers<unknown>();
  const pending = cache.getOrCreate(nextEpoch, () => gate.promise);
  const duringFill = cache.invalidate([{ route: 'pool', poolId: 'river-hill' }]);
  assert(duringFill.ok);
  gate.resolve({ id: 'river-hill', state: 'degraded' });
  assertSuccess(await pending, 'miss');
  assertEquals(cache.stats().entries, 2);

  const refilled = await cache.getOrCreate(
    nextEpoch,
    () => ({ id: 'river-hill', state: 'degraded' }),
  );
  assertSuccess(refilled, 'miss');
  assertEquals(cache.stats().entries, 3);
});

Deno.test('semantic epochs remain distinct until their affected scope is invalidated', async () => {
  const cache = configuredCache();
  activate(cache, 1);
  let fills = 0;
  for (const semanticEpoch of [0, 1]) {
    await cache.getOrCreate(collectionKey('pools', semanticEpoch), () => {
      fills += 1;
      return { semanticEpoch };
    });
  }
  assertEquals(cache.stats().entries, 2);
  assertEquals(fills, 2);

  const invalidated = cache.invalidate([{ route: 'pools' }]);
  assert(invalidated.ok);
  assertEquals(invalidated.removedEntries, 2);
  assertEquals(cache.stats().entries, 0);
});

function configuredCache(
  overrides: Readonly<{ maxEntries?: number; maxBytes?: number }> = {},
): ApiRepresentationCache {
  const result = createApiRepresentationCache({
    maxEntries: overrides.maxEntries ?? 8,
    maxBytes: overrides.maxBytes ?? 4_096,
  });
  if (!result.ok) {
    throw new Error(`Unexpected cache configuration error: ${result.error.code}`);
  }
  return result.cache;
}

function activate(cache: ApiRepresentationCache, generation: number): void {
  const result = cache.activateGeneration(generation);
  if (!result.ok) {
    throw new Error(`Unexpected generation activation error: ${result.error.code}`);
  }
}

function poolKey(poolId: string, semanticEpoch = 0): ApiRepresentationKey {
  return Object.freeze({ generation: 1, semanticEpoch, route: 'pool', poolId });
}

function collectionKey(
  route: 'pools' | 'closures',
  semanticEpoch: number,
): ApiRepresentationKey {
  return Object.freeze({ generation: 1, semanticEpoch, route });
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function assertSuccess(
  result: Awaited<ReturnType<ApiRepresentationCache['getOrCreate']>>,
  status: 'hit' | 'miss' | 'coalesced',
): asserts result is Extract<typeof result, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected cache success, received ${result.error.code}`);
  }
  assertEquals(result.status, status);
}

function assertFailure(
  result: Awaited<ReturnType<ApiRepresentationCache['getOrCreate']>>,
  code: Extract<typeof result, { ok: false }>['error']['code'],
): asserts result is Extract<typeof result, { ok: false }> {
  if (result.ok) {
    throw new Error(`Expected cache failure, received ${result.status}`);
  }
  assertEquals(result.error.code, code);
}

function assert(condition: boolean, message = 'Assertion failed'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertMatches(actual: string, pattern: RegExp): void {
  if (!pattern.test(actual)) {
    throw new Error(`Expected ${actual} to match ${String(pattern)}`);
  }
}
