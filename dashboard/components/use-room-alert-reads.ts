'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomAlert } from '@/lib/control-room';
import {
  loadRoomAlertReads,
  roomAlertFingerprint,
  roomAlertReadKey,
  saveRoomAlertReads,
  type ReadRoomAlerts,
} from '@/lib/room-alert-reads';

type Snapshot = { key: string; reads: ReadRoomAlerts };

/** Read state is private to the owner and this browser, not a dismissal of an active issue. */
export function useRoomAlertReads(email: string, resolvedIds: readonly string[]) {
  const key = roomAlertReadKey(email);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: '', reads: {} });
  const current = useRef<Snapshot>(snapshot);

  useEffect(() => {
    const next = { key, reads: loadRoomAlertReads(key) };
    current.current = next;
    setSnapshot(next);
    if (!key) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      const updated = { key, reads: loadRoomAlertReads(key) };
      current.current = updated;
      setSnapshot(updated);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  useEffect(() => {
    if (!key || current.current.key !== key || resolvedIds.length === 0) return;
    const reads = { ...loadRoomAlertReads(key), ...current.current.reads };
    let changed = false;
    for (const id of resolvedIds) {
      if (Object.prototype.hasOwnProperty.call(reads, id)) {
        delete reads[id];
        changed = true;
      }
    }
    if (!changed) return;
    saveRoomAlertReads(key, reads);
    const next = { key, reads };
    current.current = next;
    setSnapshot(next);
  }, [key, resolvedIds]);

  const markRead = useCallback((alert: RoomAlert) => {
    if (!key) return;
    const reads = {
      ...loadRoomAlertReads(key),
      ...(current.current.key === key ? current.current.reads : {}),
      [alert.id]: roomAlertFingerprint(alert),
    };
    saveRoomAlertReads(key, reads);
    const next = { key, reads };
    current.current = next;
    setSnapshot(next);
  }, [key]);

  return { reads: snapshot.key === key ? snapshot.reads : {}, markRead };
}
