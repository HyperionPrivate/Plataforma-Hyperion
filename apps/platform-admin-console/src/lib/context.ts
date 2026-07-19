import { createContext, useContext } from "react";
import type { AdminSession } from "./session.js";

export interface AdminContextValue {
  session: AdminSession;
  logout: () => void;
}

export const AdminContext = createContext<AdminContextValue | undefined>(undefined);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used within AdminContext");
  return value;
}
