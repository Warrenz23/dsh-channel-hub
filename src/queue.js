/**
 * 会话内串行队列。
 *
 * 为什么必须有：DSH 的 `followup()` 每调一次就开一轮，同一会话并发两轮会让
 * 回复错位（用户的第二个问题被第一轮的回答"接住"）。IM 通道天然会并发
 * （用户连发三条），所以按 peer 排队是硬需求，不是优化。
 *
 * 队列有上界：刷屏的人不该把内存吃满，超限的那条直接回一句提示。
 */
export class PeerQueue {
  /** @param {{maxDepth?: number, log?: {warn: (m: string) => void}}} [options] */
  constructor({ maxDepth = 8, log } = {}) {
    this.maxDepth = maxDepth
    this.log = log
    /** @type {Map<string, {chain: Promise<void>, depth: number}>} */
    this.slots = new Map()
  }

  depth(key) {
    return this.slots.get(key)?.depth ?? 0
  }

  isBusy(key) {
    return this.depth(key) > 0
  }

  /**
   * 把一个任务排进 key 的队尾。
   *
   * @param {string} key
   * @param {() => Promise<any>} task
   * @returns {Promise<any>} 任务自己的结果；队列满时 reject 一个带 code 的错误。
   */
  enqueue(key, task) {
    const slot = this.slots.get(key) ?? { chain: Promise.resolve(), depth: 0 }
    this.slots.set(key, slot)
    if (slot.depth >= this.maxDepth) {
      const error = new Error('queue is full')
      error.code = 'QUEUE_FULL'
      throw error
    }
    slot.depth += 1
    // 计数在任务自己的 finally 里减，而不是链上再挂一层：这样 `await` 返回时
    // 队列状态已经更新，调用方（和测试）不会看到"已结束但仍 busy"的中间态。
    const run = slot.chain.then(async () => {
      try {
        return await task()
      } finally {
        slot.depth -= 1
        if (slot.depth === 0) this.slots.delete(key)
      }
    })
    // 链只关心"上一件事结束了"，不关心成败。
    slot.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 等待所有队列排空（退出时用，避免回一半的回复）。 */
  async drain() {
    await Promise.all([...this.slots.values()].map((slot) => slot.chain))
  }
}
