'use client';

import { createContext, useContext } from 'react';
import type { AdminConsoleState } from './use-admin-state';

export const ConsoleContext = createContext<AdminConsoleState | null>(null);

export function useConsole(): AdminConsoleState {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('Admin console pages must render inside ConsoleContext.');
  return value;
}
