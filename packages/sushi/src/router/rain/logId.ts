import { Log } from 'viem'

/**
 * one log's identity, the dedupe key of the stream: the tx hash and the log
 * index, or the log's own fields when a pending log has none
 */
export function logId(log: Log): string {
  if (log.transactionHash && log.logIndex !== null)
    return `${log.transactionHash}:${log.logIndex}`
  return `${log.blockNumber}:${log.address}:${log.topics.join()}:${log.data}`
}
