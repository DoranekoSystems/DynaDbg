import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalStorage } from "./useLocalStorage";

interface ColumnWidths {
  [columnId: string]: number;
}

interface UseTableColumnResizeOptions {
  storageKey: string;
  defaultWidths: ColumnWidths;
  minWidth?: number;
  maxWidth?: number;
}

/**
 * Hook for managing table column widths with localStorage persistence
 */
export const useTableColumnResize = ({
  storageKey,
  defaultWidths,
  minWidth = 30,
  maxWidth = 500,
}: UseTableColumnResizeOptions) => {
  const [columnWidths, setColumnWidths] = useLocalStorage<ColumnWidths>(
    storageKey,
    defaultWidths
  );
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const initialPositionRef = useRef<number>(0);
  const initialWidthRef = useRef<number>(0);

  const handleResizeStart = useCallback(
    (columnId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingColumn(columnId);
      initialPositionRef.current = e.clientX;
      initialWidthRef.current =
        columnWidths[columnId] || defaultWidths[columnId];
    },
    [columnWidths, defaultWidths]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!resizingColumn) return;

      const delta = e.clientX - initialPositionRef.current;
      const newWidth = initialWidthRef.current + delta;

      // Apply constraints
      const constrainedWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);

      setColumnWidths((prev) => ({
        ...prev,
        [resizingColumn]: constrainedWidth,
      }));
    },
    [resizingColumn, minWidth, maxWidth, setColumnWidths]
  );

  const handleMouseUp = useCallback(() => {
    setResizingColumn(null);
  }, []);

  useEffect(() => {
    if (resizingColumn) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      // Prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
    }
  }, [resizingColumn, handleMouseMove, handleMouseUp]);

  const getColumnWidth = useCallback(
    (columnId: string): number => {
      return columnWidths[columnId] || defaultWidths[columnId];
    },
    [columnWidths, defaultWidths]
  );

  return {
    columnWidths,
    getColumnWidth,
    resizingColumn,
    handleResizeStart,
  };
};
