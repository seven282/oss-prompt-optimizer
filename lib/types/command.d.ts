import type { Context } from '@deepseek-ai/cordis';
import type { PromptOptimizerService } from './optimizer.js';
/**
 * Register the `/optimize` and `/template` commands. The browser client drives
 * the input-box buttons through the already-generated `commands` Remote
 * namespace (`ctx.remote.commands.execute(sessionId, ...)`) — the one
 * client→host RPC path that ships with strict descriptors and is guaranteed to
 * be claimed by the host gateway (custom `@Remote` namespaces require SRC
 * discovery, which is unreliable in deployed compositions).
 *
 * The `/optimize` command supports sub-commands via flags:
 *   `/optimize <instruction>`           — optimize a raw instruction
 *   `/optimize --stats`                 — report run statistics
 *   `/optimize --status`                — live status (params/source/stats/prefs/events)
 *   `/optimize --language <mode>`       — switch role-document language
 *   `/optimize --auto <on|off|toggle>`  — switch auto-optimize mode
 *
 * Effect-scoped: the registrations are removed on plugin dispose.
 */
export declare function registerOptimizeCommand(ctx: Context, service: PromptOptimizerService): void;
