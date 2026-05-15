// 评价 / Tabelog 抓取结果缓存层（仅服务端使用）。
// 用 Google place_id 作为主键，TTL 7 天；任何 DB 错误都退化为"未命中"，绝不阻塞主流程。

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TabelogInfo } from "./tabelog.server";

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function isFresh(fetchedAt: string | null | undefined): boolean {
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CACHE_TTL_MS;
}

// ---- review_cache ----

export async function getCachedReview<T = unknown>(
  placeId: string,
): Promise<T | null> {
  if (!placeId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("review_cache")
      .select("payload, fetched_at")
      .eq("place_id", placeId)
      .maybeSingle();
    if (error) {
      console.warn(`[Cache] review get error: ${error.message}`);
      return null;
    }
    if (!data || !isFresh(data.fetched_at)) return null;
    return data.payload as T;
  } catch (e) {
    console.warn(`[Cache] review get throw:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function putCachedReview(
  placeId: string,
  city: string,
  payload: unknown,
): Promise<void> {
  if (!placeId || !payload) return;
  try {
    const { error } = await supabaseAdmin
      .from("review_cache")
      .upsert(
        { place_id: placeId, city, payload: payload as object, fetched_at: new Date().toISOString() },
        { onConflict: "place_id" },
      );
    if (error) console.warn(`[Cache] review put error: ${error.message}`);
  } catch (e) {
    console.warn(`[Cache] review put throw:`, e instanceof Error ? e.message : e);
  }
}

// ---- tabelog_cache ----

export async function getCachedTabelog(placeId: string): Promise<TabelogInfo | null> {
  if (!placeId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("tabelog_cache")
      .select("payload, fetched_at")
      .eq("place_id", placeId)
      .maybeSingle();
    if (error) {
      console.warn(`[Cache] tabelog get error: ${error.message}`);
      return null;
    }
    if (!data || !isFresh(data.fetched_at)) return null;
    return data.payload as TabelogInfo;
  } catch (e) {
    console.warn(`[Cache] tabelog get throw:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function putCachedTabelog(
  placeId: string,
  info: TabelogInfo,
): Promise<void> {
  if (!placeId || !info) return;
  try {
    const { error } = await supabaseAdmin
      .from("tabelog_cache")
      .upsert(
        { place_id: placeId, payload: info as unknown as object, fetched_at: new Date().toISOString() },
        { onConflict: "place_id" },
      );
    if (error) console.warn(`[Cache] tabelog put error: ${error.message}`);
  } catch (e) {
    console.warn(`[Cache] tabelog put throw:`, e instanceof Error ? e.message : e);
  }
}
