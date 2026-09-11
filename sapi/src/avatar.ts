/** 玩家头像槽位：数据库分配后映射到 U+E900..U+E9FF。 */

import type { Player } from "@minecraft/server";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
const AVATARS_TABLE = "sfmc_chat_avatars";

export const DEFAULT_AVATAR_SLOT = 0;
export const DEFAULT_AVATAR_GLYPH = String.fromCodePoint(0xe900);
const MAX_SLOT = 255;
const glyphCache = new Map<string, string>();
let glyphsEnabled = false;

interface AvatarRow extends Record<string, unknown> {
  player_id: string;
  player_name?: string;
  slot?: number;
  skin_hash?: string;
  dirty?: number;
  updated_at?: number;
}

function slotToGlyph(slot: number): string {
  return String.fromCodePoint(
    0xe900 + Math.max(0, Math.min(MAX_SLOT, Math.floor(slot))),
  );
}

export function getAvatarGlyph(playerId?: string): string {
  if (!glyphsEnabled) return "";
  return playerId
    ? (glyphCache.get(playerId) ?? DEFAULT_AVATAR_GLYPH)
    : DEFAULT_AVATAR_GLYPH;
}

/** 仅在头像资源包已随模块部署时启用，避免客户端显示缺字方框。 */
export function setAvatarGlyphsEnabled(enabled: boolean): void {
  glyphsEnabled = enabled;
}

export async function ensureAvatarSlot(player: Player): Promise<string> {
  try {
    const existing = await db.get<AvatarRow>(AVATARS_TABLE, player.id);
    if (existing && typeof existing.slot === "number") {
      const glyph = slotToGlyph(existing.slot);
      glyphCache.set(player.id, glyph);
      if (existing.player_name !== player.name) {
        await db.tx(
          async (tx) =>
            await tx.update(AVATARS_TABLE, player.id, {
              player_name: player.name,
              dirty: 1,
              updated_at: Date.now(),
            }),
        );
      }
      return glyph;
    }
    const rows = await db.query<AvatarRow>(AVATARS_TABLE, { limit: 512 });
    const used = new Set(
      rows.flatMap((row) => (typeof row.slot === "number" ? [row.slot] : [])),
    );
    let slot = 1;
    while (slot <= MAX_SLOT && used.has(slot)) slot++;
    if (slot > MAX_SLOT) slot = 1;
    await db.tx(
      async (tx) =>
        await tx.insert(AVATARS_TABLE, {
          player_id: player.id,
          player_name: player.name,
          slot,
          skin_hash: "",
          dirty: 1,
          updated_at: Date.now(),
        }),
    );
    const glyph = slotToGlyph(slot);
    glyphCache.set(player.id, glyph);
    return glyph;
  } catch (err) {
    debug.w(
      "CHAT",
      `avatar slot: ${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_AVATAR_GLYPH;
  }
}

export async function warmAvatarCache(player: Player): Promise<void> {
  if (!glyphsEnabled) return;
  await ensureAvatarSlot(player);
}

export function clearAvatarCache(): void {
  glyphCache.clear();
  glyphsEnabled = false;
}
