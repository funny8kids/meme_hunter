/**
 * 极简指标注册表：无依赖，输出 Prometheus 文本格式。
 *
 * 原则：每个「会出问题的地方」都必须有计数器，否则故障不可见。
 */

export class Metrics {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #startedAt = Date.now();

  inc(name: string, n = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + n);
  }

  set(name: string, v: number): void {
    this.#gauges.set(name, v);
  }

  get(name: string): number {
    return this.#counters.get(name) ?? this.#gauges.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number>; uptimeSec: number } {
    return {
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
      uptimeSec: Math.round((Date.now() - this.#startedAt) / 1000),
    };
  }

  render(prefix = 'meme'): string {
    const lines: string[] = [];
    lines.push(`# HELP ${prefix}_uptime_seconds 进程运行秒数`);
    lines.push(`# TYPE ${prefix}_uptime_seconds gauge`);
    lines.push(`${prefix}_uptime_seconds ${Math.round((Date.now() - this.#startedAt) / 1000)}`);

    for (const [k, v] of this.#counters) {
      lines.push(`# TYPE ${prefix}_${k} counter`);
      lines.push(`${prefix}_${k} ${v}`);
    }
    for (const [k, v] of this.#gauges) {
      lines.push(`# TYPE ${prefix}_${k} gauge`);
      lines.push(`${prefix}_${k} ${v}`);
    }
    return lines.join('\n') + '\n';
  }
}

/** 全局单例：所有模块共享 */
export const metrics = new Metrics();
