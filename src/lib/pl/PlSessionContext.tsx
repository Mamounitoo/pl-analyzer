"use client";

import React, { createContext, useContext, useMemo, useState } from "react";

export type PlPeriod = { key: string; label: string };

export type PlNode = {
  id: string;
  label: string;
  kind: "line" | "subtotal";
  values: number[]; // length 4
  pct: number[]; // length 4 (0-1)
  status?: "good" | "watch" | "bad";
  flags?: string[];
  children?: PlNode[];
};

export type PlSession = {
  fileName?: string;
  periods?: PlPeriod[];
  cadence?: "week" | "month" | "period";
  revenue?: number[];
  tree?: PlNode[];
};

type Ctx = {
  session: PlSession;
  setSession: React.Dispatch<React.SetStateAction<PlSession>>;
  reset: () => void;
};

const PlSessionContext = createContext<Ctx | null>(null);

export function PlSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<PlSession>({});
  const value = useMemo(() => ({ session, setSession, reset: () => setSession({}) }), [session]);
  return <PlSessionContext.Provider value={value}>{children}</PlSessionContext.Provider>;
}

export function usePlSession() {
  const ctx = useContext(PlSessionContext);
  if (!ctx) throw new Error("usePlSession must be used within PlSessionProvider");
  return ctx;
}