// Refresh-on-return for the keep-mounted pages: each page loads
// on mount, then refreshes once whenever the user navigates back
// to it. The first activation is skipped (the mount load already
// fetched); later activations refresh. The polling-pause checks
// that gate background polling while a page is hidden are
// separate and stay in the pages.
//
// The refresh callback must be stable (useCallback): it runs in
// the effect's dependency list, so a fresh identity every render
// would re-trigger the refresh.
import { useEffect, useRef } from "react";
import { useAppStore, type PageKey } from "../stores/useAppStore";

export function usePageRefresh(page: PageKey, refresh: () => unknown): void {
  const appPage = useAppStore((state) => state.page);
  const firstActivation = useRef(true);
  useEffect(() => {
    if (firstActivation.current) {
      firstActivation.current = false;
      return;
    }
    if (appPage === page) void refresh();
  }, [appPage, page, refresh]);
}
