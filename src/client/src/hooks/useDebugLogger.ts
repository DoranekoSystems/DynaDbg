import { useState, useCallback, useRef, useEffect } from "react";

export type LogLevel =
  | "DEBUG"
  | "INFO"
  | "WARN"
  | "ERROR"
  | "EXCEPTION"
  | "REGISTER";

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
}

interface UseDebugLoggerOptions {
  maxEntries?: number;
  enabledCategories?: string[];
}

export const useDebugLogger = (options: UseDebugLoggerOptions = {}) => {
  const { maxEntries = 1000, enabledCategories = [] } = options;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | "ALL">("ALL");
  const [selectedCategory, setSelectedCategory] = useState<string | "ALL">(
    "ALL"
  );
  const idCounter = useRef(0);
  const enabledCategoriesRef = useRef(enabledCategories);

  // Check if development mode
  const isDevelopment =
    import.meta.env.DEV || import.meta.env.MODE === "development";

  // Update ref when enabledCategories changes
  useEffect(() => {
    enabledCategoriesRef.current = enabledCategories;
  }, [enabledCategories]);

  const addLog = useCallback(
    (level: LogLevel, category: string, message: string, data?: any) => {
      // Always add logs for debugging (remove development mode check)
      // if (!isDevelopment) return;

      // Check if category is enabled (if enabledCategories is specified)
      if (
        enabledCategoriesRef.current.length > 0 &&
        !enabledCategoriesRef.current.includes(category)
      ) {
        return;
      }

      const newLog: LogEntry = {
        id: `log_${idCounter.current++}`,
        timestamp: new Date(),
        level,
        category,
        message,
        data,
      };

      setLogs((prev) => {
        const newLogs = [newLog, ...prev];
        // Limit the number of entries
        return newLogs.slice(0, maxEntries);
      });
    },
    [maxEntries]
  ); // Removed enabledCategories from dependencies

  // Convenience methods for different log levels
  const logDebug = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("DEBUG", category, message, data);
    },
    [addLog]
  );

  const logInfo = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("INFO", category, message, data);
    },
    [addLog]
  );

  const logWarn = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("WARN", category, message, data);
    },
    [addLog]
  );

  const logError = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("ERROR", category, message, data);
    },
    [addLog]
  );

  const logException = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("EXCEPTION", category, message, data);
    },
    [addLog]
  );

  const logRegister = useCallback(
    (category: string, message: string, data?: any) => {
      addLog("REGISTER", category, message, data);
    },
    [addLog]
  );

  // Filter logs based on search term, level, and category
  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      searchTerm === "" ||
      log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (log.data &&
        JSON.stringify(log.data)
          .toLowerCase()
          .includes(searchTerm.toLowerCase()));

    const matchesLevel = selectedLevel === "ALL" || log.level === selectedLevel;
    const matchesCategory =
      selectedCategory === "ALL" || log.category === selectedCategory;

    return matchesSearch && matchesLevel && matchesCategory;
  });

  // Get unique categories
  const categories = Array.from(
    new Set(logs.map((log) => log.category))
  ).sort();

  // Clear all logs
  const clearLogs = useCallback(() => {
    setLogs([]);
    idCounter.current = 0;
  }, []);

  // Export logs as JSON
  const exportLogs = useCallback(() => {
    const dataStr = JSON.stringify(filteredLogs, null, 2);
    const dataUri =
      "data:application/json;charset=utf-8," + encodeURIComponent(dataStr);

    const exportFileDefaultName = `debug_logs_${new Date().toISOString().split("T")[0]}.json`;

    const linkElement = document.createElement("a");
    linkElement.setAttribute("href", dataUri);
    linkElement.setAttribute("download", exportFileDefaultName);
    linkElement.click();
  }, [filteredLogs]);

  return {
    // State
    logs: filteredLogs,
    allLogs: logs,
    searchTerm,
    selectedLevel,
    selectedCategory,
    categories,
    isDevelopment,

    // Actions
    addLog,
    logDebug,
    logInfo,
    logWarn,
    logError,
    logException,
    logRegister,
    clearLogs,
    exportLogs,

    // Filters
    setSearchTerm,
    setSelectedLevel,
    setSelectedCategory,
  };
};
