/**
 * 红包：两阶段 debit → 本地记录；失败补偿 credit
 */

import { Player } from "@minecraft/server";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Msg, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { REDPACKETS_TABLE, broadcast } from "./core.js";

export async function sendRedPacket(
  player: Player,
  amount: number,
  count: number,
): Promise<{ ok: boolean; id?: string }> {
  if (amount <= 0 || count <= 0) {
    Msg.error("红包金额/份数无效", player);
    return { ok: false };
  }
  const id = `hb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const idempotencyKey = `hb_send_${id}`;

  try {
    const debit = (await service.call("economy.account.debit", {
      playerId: player.id,
      amount,
      reason: "chat.redpacket.send",
      idempotencyKey,
    })) as { ok?: boolean };
    if (!debit?.ok) {
      Msg.error("扣款失败，余额不足或服务不可用", player);
      return { ok: false };
    }
  } catch (err) {
    Msg.error("经济服务不可用，无法发红包", player);
    debug.w("CHAT", `debit: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }

  try {
    await db.tx(async (tx) => {
      await tx.insert(REDPACKETS_TABLE, {
        id,
        sender_id: player.id,
        sender_name: player.name,
        total_amount: amount,
        remain_amount: amount,
        total_count: count,
        remain_count: count,
        claimants_json: "[]",
        expires_at: Date.now() + 3600_000,
        created_at: Date.now(),
      });
    });
  } catch (err) {
    // 本地失败：补偿退款
    try {
      await service.call("economy.account.credit", {
        playerId: player.id,
        amount,
        reason: "chat.redpacket.rollback",
        idempotencyKey: `hb_rollback_${id}`,
      });
    } catch (e2) {
      debug.e(
        "CHAT",
        "红包补偿失败",
        e2 instanceof Error ? e2 : new Error(String(e2)),
      );
    }
    Msg.error("红包创建失败，已尝试退款", player);
    return { ok: false };
  }

  await broadcast({
    content: `§e${player.name} §f发了一个红包（共 ${amount}，${count} 份）！用 §a!hongbao §f领取`,
    prefix: "红包",
  });
  Msg.success(`红包已发送：${id}`, player);
  return { ok: true, id };
}

export async function claimRedPacket(
  player: Player,
  redpacketId?: string,
): Promise<{ ok: boolean }> {
  const rows = await db.query<{
    id: string;
    remain_amount: number;
    remain_count: number;
    claimants_json: string;
    expires_at: number;
  }>(REDPACKETS_TABLE, {
    where: redpacketId
      ? { eq: ["id", redpacketId] }
      : { gt: ["remain_count", 0] },
    orderBy: { field: "created_at", dir: "desc" },
    limit: 1,
  });
  const row = rows[0];
  if (!row) {
    Msg.error("没有可领取的红包", player);
    return { ok: false };
  }
  if (row.expires_at < Date.now() || row.remain_count <= 0) {
    Msg.error("红包已过期或领完", player);
    return { ok: false };
  }
  let claimants: string[] = [];
  try {
    claimants = JSON.parse(String(row.claimants_json || "[]")) as string[];
  } catch {
    claimants = [];
  }
  if (claimants.includes(player.id)) {
    Msg.error("你已经领过这个红包", player);
    return { ok: false };
  }

  const share =
    row.remain_count === 1
      ? row.remain_amount
      : Math.max(1, Math.floor(row.remain_amount / row.remain_count));
  const idempotencyKey = `hb_claim_${row.id}_${player.id}`;

  try {
    const credit = (await service.call("economy.account.credit", {
      playerId: player.id,
      amount: share,
      reason: "chat.redpacket.claim",
      idempotencyKey,
    })) as { ok?: boolean };
    if (!credit?.ok) {
      Msg.error("入账失败", player);
      return { ok: false };
    }
  } catch {
    Msg.error("经济服务不可用", player);
    return { ok: false };
  }

  claimants.push(player.id);
  try {
    await db.tx(async (tx) => {
      await tx.update(REDPACKETS_TABLE, row.id, {
        remain_amount: row.remain_amount - share,
        remain_count: row.remain_count - 1,
        claimants_json: JSON.stringify(claimants),
      });
    });
  } catch (err) {
    // 本地失败：尝试扣回
    try {
      await service.call("economy.account.debit", {
        playerId: player.id,
        amount: share,
        reason: "chat.redpacket.claim_rollback",
        idempotencyKey: `hb_claim_rb_${row.id}_${player.id}`,
      });
    } catch {
      /* ignore */
    }
    debug.e("CHAT", "claim local fail", err instanceof Error ? err : new Error(String(err)));
    Msg.error("领取记录失败", player);
    return { ok: false };
  }

  Msg.success(`领取红包成功：+${share}`, player);
  return { ok: true };
}
