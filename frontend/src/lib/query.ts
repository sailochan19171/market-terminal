"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Filter state kept in the URL, so views can be shared and survive reloads.
 * Changing any filter other than `page` sends the user back to page 1.
 */
export function useQueryParams(defaults: Record<string, string> = {}) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const get = useCallback((key: string) => search.get(key) ?? defaults[key] ?? "", [search, defaults]);

  const set = useCallback((changes: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === undefined || v === "" || v === defaults[k]) next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in changes)) next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [search, router, pathname, defaults]);

  /** API query string from the current URL plus fixed extras. */
  const toApi = useCallback((keys: string[], extra: Record<string, string> = {}) => {
    const q = new URLSearchParams();
    for (const k of keys) {
      const v = get(k);
      if (v) q.set(k, v);
    }
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString();
  }, [get]);

  const clear = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);

  return { get, set, toApi, clear, search };
}
