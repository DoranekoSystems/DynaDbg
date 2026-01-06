import { useCallback, useMemo, useState } from "react";
import { useLocalStorage } from "./useLocalStorage";

export type NetworkMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type NetworkStatus = number;

export interface NetworkEntry {
  id: string;
  timestamp: Date;
  method: NetworkMethod;
  url: string;
  endpoint: string;
  status?: NetworkStatus;
  duration?: number; // in milliseconds
  requestHeaders?: Record<string, string>;
  requestBody?: any;
  requestSize?: number; // in bytes
  responseHeaders?: Record<string, string>;
  responseBody?: any;
  responseSize?: number; // in bytes
  error?: string;
}

export interface NetworkLogger {
  requests: NetworkEntry[];
  allRequests: NetworkEntry[];
  endpoints: string[];
  methods: NetworkMethod[];
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  selectedMethod: NetworkMethod | "ALL";
  setSelectedMethod: (method: NetworkMethod | "ALL") => void;
  selectedStatus: NetworkStatus | "ALL";
  setSelectedStatus: (status: NetworkStatus | "ALL") => void;
  selectedEndpoint: string;
  setSelectedEndpoint: (endpoint: string) => void;
  sortField: "timestamp" | "duration" | "status" | "endpoint";
  setSortField: (
    field: "timestamp" | "duration" | "status" | "endpoint"
  ) => void;
  sortDirection: "asc" | "desc";
  setSortDirection: (direction: "asc" | "desc") => void;
  excludedEndpoints: string[];
  setExcludedEndpoints: (endpoints: string[]) => void;
  isPaused: boolean;
  setIsPaused: (paused: boolean) => void;
  addRequest: (request: Omit<NetworkEntry, "id" | "timestamp">) => string;
  updateRequest: (id: string, updates: Partial<NetworkEntry>) => void;
  clearRequests: () => void;
  exportRequests: () => void;
}

export const useNetworkLogger = (): NetworkLogger => {
  const [allRequests, setAllRequests] = useState<NetworkEntry[]>([]);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [selectedMethod, setSelectedMethod] = useState<NetworkMethod | "ALL">(
    "ALL"
  );
  const [selectedStatus, setSelectedStatus] = useState<NetworkStatus | "ALL">(
    "ALL"
  );
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>("ALL");
  const [sortField, setSortField] = useState<
    "timestamp" | "duration" | "status" | "endpoint"
  >("timestamp");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [excludedEndpoints, setExcludedEndpoints] = useLocalStorage<string[]>(
    "network-excluded-endpoints",
    []
  );
  const [isPaused, setIsPaused] = useState<boolean>(false);

  // Add new request
  const addRequest = useCallback(
    (request: Omit<NetworkEntry, "id" | "timestamp">): string => {
      if (isPaused) {
        return "";
      }

      const id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newRequest: NetworkEntry = {
        ...request,
        id,
        timestamp: new Date(),
      };

      setAllRequests((prev) => [...prev, newRequest]);
      return id;
    },
    [isPaused]
  );

  // Update existing request
  const updateRequest = useCallback(
    (id: string, updates: Partial<NetworkEntry>) => {
      setAllRequests((prev) =>
        prev.map((req) => (req.id === id ? { ...req, ...updates } : req))
      );
    },
    []
  );

  // Clear all requests
  const clearRequests = useCallback(() => {
    setAllRequests([]);
  }, []);

  // Export requests to JSON
  const exportRequests = useCallback(() => {
    const dataStr = JSON.stringify(allRequests, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `network_requests_${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [allRequests]);

  // Get unique endpoints
  const endpoints = useMemo(() => {
    const endpointSet = new Set(allRequests.map((req) => req.endpoint));
    return Array.from(endpointSet).sort();
  }, [allRequests]);

  // Get unique methods
  const methods = useMemo(() => {
    const methodSet = new Set(allRequests.map((req) => req.method));
    return Array.from(methodSet).sort() as NetworkMethod[];
  }, [allRequests]);

  // Filter and sort requests
  const requests = useMemo(() => {
    let filtered = allRequests;

    // Apply excluded endpoints filter first
    if (excludedEndpoints.length > 0) {
      filtered = filtered.filter(
        (req) => !excludedEndpoints.includes(req.endpoint)
      );
    }

    // Apply search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (req) =>
          req.url.toLowerCase().includes(searchLower) ||
          req.endpoint.toLowerCase().includes(searchLower) ||
          req.method.toLowerCase().includes(searchLower) ||
          (req.status?.toString() || "").includes(searchLower) ||
          JSON.stringify(req.requestBody || "")
            .toLowerCase()
            .includes(searchLower) ||
          JSON.stringify(req.responseBody || "")
            .toLowerCase()
            .includes(searchLower)
      );
    }

    // Apply method filter
    if (selectedMethod !== "ALL") {
      filtered = filtered.filter((req) => req.method === selectedMethod);
    }

    // Apply status filter
    if (selectedStatus !== "ALL") {
      if (selectedStatus === 200) {
        filtered = filtered.filter(
          (req) => req.status && req.status >= 200 && req.status < 300
        );
      } else if (selectedStatus === 300) {
        filtered = filtered.filter(
          (req) => req.status && req.status >= 300 && req.status < 400
        );
      } else if (selectedStatus === 400) {
        filtered = filtered.filter(
          (req) => req.status && req.status >= 400 && req.status < 500
        );
      } else if (selectedStatus === 500) {
        filtered = filtered.filter((req) => req.status && req.status >= 500);
      }
    }

    // Apply endpoint filter
    if (selectedEndpoint !== "ALL") {
      filtered = filtered.filter((req) => req.endpoint === selectedEndpoint);
    }

    // Apply sorting
    const sorted = [...filtered].sort((a, b) => {
      let aValue: any;
      let bValue: any;

      switch (sortField) {
        case "timestamp":
          aValue = a.timestamp.getTime();
          bValue = b.timestamp.getTime();
          break;
        case "duration":
          aValue = a.duration || 0;
          bValue = b.duration || 0;
          break;
        case "status":
          aValue = a.status || 0;
          bValue = b.status || 0;
          break;
        case "endpoint":
          aValue = a.endpoint;
          bValue = b.endpoint;
          break;
        default:
          return 0;
      }

      if (typeof aValue === "string" && typeof bValue === "string") {
        return sortDirection === "asc"
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      return sortDirection === "asc" ? aValue - bValue : bValue - aValue;
    });

    return sorted;
  }, [
    allRequests,
    searchTerm,
    selectedMethod,
    selectedStatus,
    selectedEndpoint,
    sortField,
    sortDirection,
    excludedEndpoints,
  ]);

  return useMemo(
    () => ({
      requests,
      allRequests,
      endpoints,
      methods,
      searchTerm,
      setSearchTerm,
      selectedMethod,
      setSelectedMethod,
      selectedStatus,
      setSelectedStatus,
      selectedEndpoint,
      setSelectedEndpoint,
      sortField,
      setSortField,
      sortDirection,
      setSortDirection,
      excludedEndpoints,
      setExcludedEndpoints,
      isPaused,
      setIsPaused,
      addRequest,
      updateRequest,
      clearRequests,
      exportRequests,
    }),
    [
      requests,
      allRequests,
      endpoints,
      methods,
      searchTerm,
      setSearchTerm,
      selectedMethod,
      setSelectedMethod,
      selectedStatus,
      setSelectedStatus,
      selectedEndpoint,
      setSelectedEndpoint,
      sortField,
      setSortField,
      sortDirection,
      setSortDirection,
      excludedEndpoints,
      setExcludedEndpoints,
      isPaused,
      setIsPaused,
      addRequest,
      updateRequest,
      clearRequests,
      exportRequests,
    ]
  );
};
