import React, { createContext, useContext, ReactNode } from "react";
import { NetworkLogger, useNetworkLogger } from "./useNetworkLogger";

interface NetworkLoggerProviderProps {
  children: ReactNode;
}

const NetworkLoggerContext = createContext<NetworkLogger | null>(null);

export const NetworkLoggerProvider: React.FC<NetworkLoggerProviderProps> = ({
  children,
}) => {
  const networkLogger = useNetworkLogger();

  return (
    <NetworkLoggerContext.Provider value={networkLogger}>
      {children}
    </NetworkLoggerContext.Provider>
  );
};

export const useGlobalNetworkLogger = (): NetworkLogger => {
  const context = useContext(NetworkLoggerContext);
  if (!context) {
    throw new Error(
      "useGlobalNetworkLogger must be used within a NetworkLoggerProvider"
    );
  }
  return context;
};
