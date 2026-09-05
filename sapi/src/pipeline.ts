/**
 * 聊天管道插槽：拦截器 + 观察者
 */

import type { Player } from "@minecraft/server";

export type InterceptorHandler = (ctx: {
  player: Player;
  message: string;
}) => boolean | Promise<boolean>;

export type ObserverHandler = (ctx: {
  player: Player;
  message: string;
  channelId: string;
  formatted: string;
}) => void | Promise<void>;

interface InterceptorEntry {
  id: string;
  priority: number;
  handler: InterceptorHandler;
}

interface ObserverEntry {
  id: string;
  handler: ObserverHandler;
}

const interceptors: InterceptorEntry[] = [];
const observers: ObserverEntry[] = [];

export function registerInterceptor(input: {
  id: string;
  priority?: number;
  handler: InterceptorHandler;
}): { ok: boolean } {
  if (!input?.id || typeof input.handler !== "function") return { ok: false };
  const idx = interceptors.findIndex((e) => e.id === input.id);
  const entry: InterceptorEntry = {
    id: input.id,
    priority: input.priority ?? 100,
    handler: input.handler,
  };
  if (idx >= 0) interceptors[idx] = entry;
  else interceptors.push(entry);
  interceptors.sort((a, b) => a.priority - b.priority);
  return { ok: true };
}

export function registerObserver(input: {
  id: string;
  handler: ObserverHandler;
}): { ok: boolean } {
  if (!input?.id || typeof input.handler !== "function") return { ok: false };
  const idx = observers.findIndex((e) => e.id === input.id);
  const entry: ObserverEntry = { id: input.id, handler: input.handler };
  if (idx >= 0) observers[idx] = entry;
  else observers.push(entry);
  return { ok: true };
}

/** 按优先级执行拦截器；任一返回 true 则消费消息。 */
export async function runInterceptors(
  player: Player,
  message: string,
): Promise<boolean> {
  for (const e of interceptors) {
    try {
      if (await e.handler({ player, message })) return true;
    } catch {
      /* 单个拦截器失败不阻断管道 */
    }
  }
  return false;
}

/** 触发观察者（消息已确认投递）。 */
export async function runObservers(ctx: {
  player: Player;
  message: string;
  channelId: string;
  formatted: string;
}): Promise<void> {
  for (const e of observers) {
    try {
      await e.handler(ctx);
    } catch {
      /* ignore */
    }
  }
}

export function clearPipeline(): void {
  interceptors.length = 0;
  observers.length = 0;
}

export function interceptorCount(): number {
  return interceptors.length;
}

export function observerCount(): number {
  return observers.length;
}
