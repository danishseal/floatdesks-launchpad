"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  subscribe,
  type LiveConnectionStatus,
} from "@/lib/api";
import { TOKENS_QUERY_KEY } from "@/hooks/use-tokens";
import { TOKEN_DETAIL_QUERY_KEY } from "@/hooks/use-token-detail";
import { TOKEN_TRADES_QUERY_KEY, TOKEN_HOLDERS_QUERY_KEY } from "@/lib/api";

export function useFloorlaunchLive(market?: string) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveConnectionStatus>("connecting");
  useEffect(() => {
    return subscribe(
      (message) => {
        queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
        if (!market || message.market !== market) return;
        queryClient.invalidateQueries({
          queryKey: TOKEN_DETAIL_QUERY_KEY(market),
        });
        queryClient.invalidateQueries({
          queryKey: TOKEN_TRADES_QUERY_KEY(market),
        });
        queryClient.invalidateQueries({ queryKey: ["candles", market] });
        queryClient.invalidateQueries({
          queryKey: TOKEN_HOLDERS_QUERY_KEY(market),
        });
      },
      setStatus,
    );
  }, [market, queryClient]);
  return status;
}
