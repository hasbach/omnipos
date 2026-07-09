import React, { createContext, useContext } from 'react';
import { usePos } from '../hooks/usePos';

export const PosContext = createContext<ReturnType<typeof usePos> | null>(null);

export function PosProvider({ children, tenant, setTenant, currentUser, setCurrentUser, users, setUsers, handleLogout }: any) {
  const posState = usePos(tenant, setTenant, currentUser, setCurrentUser, users, setUsers, handleLogout);
  return (
    <PosContext.Provider value={posState}>
      {children}
    </PosContext.Provider>
  );
}

export function usePosContext() {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePosContext must be used within PosProvider");
  return ctx;
}
