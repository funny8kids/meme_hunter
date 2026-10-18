/**
 * Telegram 告警。
 *
 * 未配置时静默降级为 no-op（本地开发不打扰）。
 * 发送失败绝不影响交易主流程。
 */

export interface NotifyOpts {
  token?: string;
  chatId?: string;
  timeoutMs?: number;
}

export function makeNotifier(opts: NotifyOpts = {}) {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const timeout = opts.timeoutMs ?? 5000;

  if (!token || !chatId) {
    return async (_text: string): Promise<void> => {
      /* 未配置，静默 */
    };
  }

  const enabled = { token, chatId, timeout };

  return async function notify(text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${enabled.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: enabled.chatId,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(enabled.timeout),
      });
      if (!res.ok) {
        // 告警失败不能影响交易
        console.error(`[notify] telegram ${res.status}`);
      }
    } catch (e) {
      console.error(`[notify] ${(e as Error).message}`);
    }
  };
}

/** 心跳：超过 thresholdMs 没调用就告警 */
export class Heartbeat {
  #last = Date.now();
  #timer: ReturnType<typeof setInterval> | null = null;
  #notify: (t: string) => Promise<void>;
  #thresholdMs: number;
  #name: string;

  constructor(notify: (t: string) => Promise<void>, thresholdMs = 5 * 60_000, name = 'engine') {
    this.#notify = notify;
    this.#thresholdMs = thresholdMs;
    this.#name = name;
  }

  beat(): void {
    this.#last = Date.now();
  }

  start(): void {
    this.#timer = setInterval(() => {
      const idle = Date.now() - this.#last;
      if (idle > this.#thresholdMs) {
        void this.#notify(`💀 ${this.#name} 心跳停止 ${Math.round(idle / 1000)}s`);
      }
    }, 60_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
