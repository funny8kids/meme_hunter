/**
 * confirm.ts — code-enforced human-in-the-loop gate for financial writes.
 *
 * Commands that move real funds (swap, multi-swap, token creation, strategy
 * order creation) must not execute on the say-so of an AI agent alone. A hijacked
 * agent — e.g. one that read a prompt-injection payload out of token metadata — can
 * emit any command line it wants, so a plain `--yes` flag is not a real barrier:
 * the injected instructions can just tell the agent to pass `--yes`.
 *
 * This gate enforces confirmation in CODE, not in a SKILL.md instruction:
 *
 *   1. Interactive terminal (default): we read a typed "yes" directly from the
 *      controlling TTY (/dev/tty), NOT from stdin. An autonomous agent driving the
 *      CLI over a pipe cannot answer this prompt, and no text in the agent's
 *      context can satisfy it — a real human must be present at the keyboard.
 *
 *   2. Intentional automation: to run headless, the operator must BOTH pass
 *      `--yes` AND set the environment variable GMGN_ALLOW_AUTOMATED_TRADES=1 in
 *      their own shell, out of band. Requiring the env var (which the CLI never
 *      sets and an injected instruction should not know to set) plus the flag makes
 *      autonomous execution a deliberate, two-factor human decision.
 *
 * If neither path is satisfied, the trade is refused before any signature is made.
 */
export interface TradeSummary {
    action: string;
    lines: string[];
}
/**
 * Enforce human confirmation for a financial write. Prints a summary, then either
 * reads an interactive "yes" from the TTY or verifies the explicit automation
 * opt-in. Aborts the process if confirmation is not obtained.
 */
export declare function confirmTrade(summary: TradeSummary, assumeYes: boolean): void;
//# sourceMappingURL=confirm.d.ts.map