// Owns the single KybernClient for the app and the stored endpoint.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionStatus, type Endpoint, KybernClient } from "@/protocol";
import { clearEndpoint, loadEndpoint, saveEndpoint } from "./store";

interface ConnectionValue {
  /** null until SecureStore has been read. */
  ready: boolean;
  endpoint: Endpoint | null;
  client: KybernClient | null;
  status: ConnectionStatus;
  statusDetail: string | undefined;
  /** Persist and connect. Resolves once the socket opens or rejects on the first failure. */
  connectTo(ep: Endpoint): Promise<void>;
  disconnect(): Promise<void>;
}

const Ctx = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [client, setClient] = useState<KybernClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  const clientRef = useRef<KybernClient | null>(null);

  const start = useCallback((ep: Endpoint): KybernClient => {
    clientRef.current?.close();
    const c = new KybernClient(ep);
    clientRef.current = c;
    setClient(c);
    setEndpoint(ep);
    c.onStatus((s, d) => {
      setStatus(s);
      setStatusDetail(d);
    });
    c.connect();
    return c;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadEndpoint()
      .then((ep) => {
        if (cancelled) return;
        if (ep) start(ep);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      clientRef.current?.close();
    };
  }, [start]);

  const connectTo = useCallback(
    async (ep: Endpoint) => {
      const c = start(ep);
      await new Promise<void>((resolve, reject) => {
        const off = c.onStatus((s, d) => {
          if (s === "open") {
            off();
            resolve();
          } else if (s === "reconnecting" || s === "closed") {
            off();
            c.close();
            reject(new Error(d ?? "Could not reach the daemon"));
          }
        });
      });
      // Verify the token actually works before persisting.
      await c.call("daemon.info", {});
      await saveEndpoint(ep);
    },
    [start],
  );

  const disconnect = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    setEndpoint(null);
    setStatus("idle");
    await clearEndpoint();
  }, []);

  const value = useMemo<ConnectionValue>(
    () => ({ ready, endpoint, client, status, statusDetail, connectTo, disconnect }),
    [ready, endpoint, client, status, statusDetail, connectTo, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnection(): ConnectionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnection outside ConnectionProvider");
  return v;
}
