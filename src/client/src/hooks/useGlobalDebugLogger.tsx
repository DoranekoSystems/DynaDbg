import React, { createContext, useContext, useMemo } from "react";
import { useDebugLogger, LogLevel, LogEntry } from "./useDebugLogger";

interface DebugLoggerContextType {
  // Actions
  addLog: (
    level: LogLevel,
    category: string,
    message: string,
    data?: any
  ) => void;
  logDebug: (category: string, message: string, data?: any) => void;
  logInfo: (category: string, message: string, data?: any) => void;
  logWarn: (category: string, message: string, data?: any) => void;
  logError: (category: string, message: string, data?: any) => void;
  logException: (category: string, message: string, data?: any) => void;
  logRegister: (category: string, message: string, data?: any) => void;
  clearLogs: () => void;
  exportLogs: () => void;

  // State
  logs: LogEntry[];
  allLogs: LogEntry[];
  searchTerm: string;
  selectedLevel: LogLevel | "ALL";
  selectedCategory: string | "ALL";
  categories: string[];
  isDevelopment: boolean;

  // Filters
  setSearchTerm: (term: string) => void;
  setSelectedLevel: (level: LogLevel | "ALL") => void;
  setSelectedCategory: (category: string | "ALL") => void;
}

const DebugLoggerContext = createContext<DebugLoggerContextType | null>(null);

export const DebugLoggerProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const logger = useDebugLogger();

  // Memoize the context value to prevent unnecessary re-renders
  // Include all properties from the logger
  const contextValue = useMemo(
    () => ({
      // Actions
      addLog: logger.addLog,
      logDebug: logger.logDebug,
      logInfo: logger.logInfo,
      logWarn: logger.logWarn,
      logError: logger.logError,
      logException: logger.logException,
      logRegister: logger.logRegister,
      clearLogs: logger.clearLogs,
      exportLogs: logger.exportLogs,

      // State
      logs: logger.logs,
      allLogs: logger.allLogs,
      searchTerm: logger.searchTerm,
      selectedLevel: logger.selectedLevel,
      selectedCategory: logger.selectedCategory,
      categories: logger.categories,
      isDevelopment: logger.isDevelopment,

      // Filters
      setSearchTerm: logger.setSearchTerm,
      setSelectedLevel: logger.setSelectedLevel,
      setSelectedCategory: logger.setSelectedCategory,
    }),
    [
      logger.addLog,
      logger.logDebug,
      logger.logInfo,
      logger.logWarn,
      logger.logError,
      logger.logException,
      logger.logRegister,
      logger.clearLogs,
      logger.exportLogs,
      logger.logs,
      logger.allLogs,
      logger.searchTerm,
      logger.selectedLevel,
      logger.selectedCategory,
      logger.categories,
      logger.isDevelopment,
      logger.setSearchTerm,
      logger.setSelectedLevel,
      logger.setSelectedCategory,
    ]
  );

  return (
    <DebugLoggerContext.Provider value={contextValue}>
      {children}
    </DebugLoggerContext.Provider>
  );
};

export const useGlobalDebugLogger = (): DebugLoggerContextType => {
  const context = useContext(DebugLoggerContext);
  if (!context) {
    throw new Error(
      "useGlobalDebugLogger must be used within a DebugLoggerProvider"
    );
  }
  return context;
};
