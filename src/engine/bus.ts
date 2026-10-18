/**
 * 有界队列（不变量 I4）。
 *
 * 规则：任何队列都必须有容量、有溢出策略、有计数器。
 * 没有计数器的队列 = 隐形炸弹。
 */

export type OverflowPolicy = 'drop-oldest' | 'drop-newest' | 'reject';

export interface QueueStats {
  name: string;
  capacity: number;
  pushed: number;
  popped: number;
  dropped: number;
  spilled: number;
  depth: number;
  maxDepth: number;
}

export class BoundedQueue<T> {
  readonly name: string;
  readonly capacity: number;
  readonly policy: OverflowPolicy;

  #buf: Array<T | undefined>;
  #head = 0;
  #size = 0;

  #pushed = 0;
  #popped = 0;
  #dropped = 0;
  #spilled = 0;
  #maxDepth = 0;

  /** 溢出回调：用于把丢弃的数据写到 overflow 文件，而不是凭空消失 */
  onSpill?: (item: T) => void;

  constructor(name: string, capacity: number, policy: OverflowPolicy, onSpill?: (item: T) => void) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    this.name = name;
    this.capacity = capacity;
    this.policy = policy;
    this.onSpill = onSpill;
    this.#buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  /** 返回 false 表示本条被拒绝（仅 reject 策略会返回 false） */
  push(item: T): boolean {
    this.#pushed++;

    if (this.#size === this.capacity) {
      this.#dropped++;
      if (this.policy === 'reject') return false;
      if (this.policy === 'drop-newest') {
        this.onSpill?.(item);
        return true;
      }
      // drop-oldest：让出一格
      const old = this.#buf[this.#head];
      this.#buf[this.#head] = undefined;
      this.#head = (this.#head + 1) % this.capacity;
      this.#size--;
      if (old !== undefined) this.onSpill?.(old);
    }

    const tail = (this.#head + this.#size) % this.capacity;
    this.#buf[tail] = item;
    this.#size++;
    if (this.#size > this.#maxDepth) this.#maxDepth = this.#size;
    return true;
  }

  /** 取出当前全部（FIFO） */
  drain(): T[] {
    const out: T[] = [];
    while (this.#size > 0) {
      const item = this.#buf[this.#head];
      this.#buf[this.#head] = undefined;
      this.#head = (this.#head + 1) % this.capacity;
      this.#size--;
      if (item !== undefined) {
        out.push(item);
        this.#popped++;
      }
    }
    return out;
  }

  stats(): QueueStats {
    return {
      name: this.name,
      capacity: this.capacity,
      pushed: this.#pushed,
      popped: this.#popped,
      dropped: this.#dropped,
      spilled: this.#spilled,
      depth: this.#size,
      maxDepth: this.#maxDepth,
    };
  }
}
