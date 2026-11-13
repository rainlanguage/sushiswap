import { Abi, Hex, Log, decodeEventLog, toEventSelector } from 'viem'

/** the move a Swap or Sync log tells about its pool, see moveOf */
export interface PoolMove {
  /** the event the log is, a univ3 style Swap or a univ2 Sync */
  kind: 'Swap' | 'Sync'
  /**
   * the move's direction: true when the pool received token0 and paid
   * token1, false the other way round, undefined when the log tells none
   */
  zeroForOne: boolean | undefined
  /** the reserves a Sync carries, undefined for a Swap or a Sync that does not decode */
  reserves?: [bigint, bigint]
}

/** the Swap and Sync selectors of each events abi, keyed by the abi object */
const selectors = new WeakMap<Abi, Map<Hex, 'Swap' | 'Sync'>>()

/** the Swap or Sync event of the abi the topic selects, undefined for any other */
function kindOf(abi: Abi, topic: Hex | undefined): 'Swap' | 'Sync' | undefined {
  if (!topic) return undefined
  let known = selectors.get(abi)
  if (!known) {
    known = new Map()
    for (const item of abi) {
      if (item.type !== 'event') continue
      if (item.name !== 'Swap' && item.name !== 'Sync') continue
      known.set(toEventSelector(item), item.name)
    }
    selectors.set(abi, known)
  }
  return known.get(topic)
}

/**
 * The move a log tells about its pool, undefined for a log that is not a
 * Swap or a Sync of the abi. A univ3 style Swap carries the direction in the
 * signs of its amounts, a positive one is what the pool received. A univ2
 * Sync carries the reserves alone, the direction is their change against the
 * reserves given as previous, one reserve up and the other down is a swap. The
 * direction is undefined when the log tells none: a univ2 mint or burn, both
 * reserves move the same way, a Sync with nothing to compare to, a swap of
 * nothing, or a log that does not decode
 * @param abi - the events abi of the pool's provider
 * @param log - the log
 * @param previous - (optional) the pool's reserves before the log, what a Sync is compared with
 */
export function moveOf(
  abi: Abi,
  log: Log,
  previous?: [bigint, bigint],
): PoolMove | undefined {
  const kind = kindOf(abi, log.topics[0])
  if (!kind) return undefined
  let args: Record<string, unknown>
  try {
    args = decodeEventLog({ abi, data: log.data, topics: log.topics })
      .args as unknown as Record<string, unknown>
  } catch {
    return { kind, zeroForOne: undefined }
  }
  if (kind === 'Swap') {
    const { amount0, amount1 } = args
    if (typeof amount0 !== 'bigint' || typeof amount1 !== 'bigint') {
      return { kind, zeroForOne: undefined }
    }
    if (amount0 > 0n && amount1 <= 0n) return { kind, zeroForOne: true }
    if (amount1 > 0n && amount0 <= 0n) return { kind, zeroForOne: false }
    return { kind, zeroForOne: undefined }
  }
  const { reserve0, reserve1 } = args
  if (typeof reserve0 !== 'bigint' || typeof reserve1 !== 'bigint') {
    return { kind, zeroForOne: undefined }
  }
  const reserves: [bigint, bigint] = [reserve0, reserve1]
  if (!previous) return { kind, zeroForOne: undefined, reserves }
  const delta0 = reserve0 - previous[0]
  const delta1 = reserve1 - previous[1]
  if (delta0 > 0n && delta1 < 0n) return { kind, zeroForOne: true, reserves }
  if (delta0 < 0n && delta1 > 0n) return { kind, zeroForOne: false, reserves }
  return { kind, zeroForOne: undefined, reserves }
}
