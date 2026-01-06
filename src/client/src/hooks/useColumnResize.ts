import { useState, useCallback, useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage";

interface ColumnWidths {
  [key: string]: number;
}

interface UseColumnResizeOptions {
  storageKey: string;
  defaultWidths: ColumnWidths;
  minWidth?: number;
  maxWidth?: number;
}

export const useColumnResize = ({
  storageKey,
  defaultWidths,
  minWidth = 50,
  maxWidth = 800,
}: UseColumnResizeOptions) => {
  const [columnWidths, setColumnWidths] = useLocalStorage<ColumnWidths>(
    storageKey,
    defaultWidths
  );
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [startX, setStartX] = useState<number>(0);
  const [startWidth, setStartWidth] = useState<number>(0);

  const handleResizeStart = useCallback(
    (columnKey: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingColumn(columnKey);
      setStartX(e.clientX);
      setStartWidth(columnWidths[columnKey] || defaultWidths[columnKey]);
    },
    [columnWidths, defaultWidths]
  );

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (!resizingColumn) return;

      const deltaX = e.clientX - startX;
      const newWidth = startWidth + deltaX;
      const constrainedWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);

      setColumnWidths((prev) => ({
        ...prev,
        [resizingColumn]: constrainedWidth,
      }));
    },
    [resizingColumn, startX, startWidth, minWidth, maxWidth, setColumnWidths]
  );

  const handleResizeEnd = useCallback(() => {
    setResizingColumn(null);
  }, []);

  useEffect(() => {
    if (resizingColumn) {
      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);

      // Prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      return () => {
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
    }
  }, [resizingColumn, handleResizeMove, handleResizeEnd]);

  const getColumnWidth = useCallback(
    (columnKey: string): number => {
      return columnWidths[columnKey] || defaultWidths[columnKey];
    },
    [columnWidths, defaultWidths]
  );

  return {
    columnWidths,
    resizingColumn,
    handleResizeStart,
    getColumnWidth,
  };
};
