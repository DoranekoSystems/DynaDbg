import React, {
  useMemo,
  useState,
  useRef,
  useEffect,
  CSSProperties,
  useCallback,
  forwardRef,
  ReactElement,
} from "react";
import { Box, styled, TableSortLabel } from "@mui/material";
import { List, RowComponentProps } from "react-window";

// Column definition for the table
export interface ColumnDef<T> {
  key: string;
  label: string;
  width: number; // percentage (initial width)
  minWidth?: number; // minimum percentage width
  align?: "left" | "right" | "center";
  sortable?: boolean;
  render: (item: T, index: number) => React.ReactNode;
  getCellStyle?: (item: T) => CSSProperties;
}

// Sort state
export type SortDirection = "asc" | "desc";

interface VirtualizedTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  rowHeight?: number;
  maxHeight?: number;
  sortField?: string;
  sortDirection?: SortDirection;
  onSort?: (field: string) => void;
  onRowClick?: (item: T, index: number) => void;
  isRowActive?: (item: T) => boolean;
  getRowColor?: (item: T) => string | undefined;
  getRowKey: (item: T, index: number) => string;
  // Column width persistence
  columnWidths?: Record<string, number>;
  onColumnWidthChange?: (key: string, width: number) => void;
}

// Styled components
const TableWrapper = styled(Box)({
  backgroundColor: "#1a1a1a",
  borderRadius: "4px",
  margin: "0 4px 4px 4px",
  border: "1px solid #333",
  overflow: "hidden",
  "@media (max-height: 800px)": {
    margin: "0 2px 2px 2px",
    borderRadius: "3px",
  },
});

const HeaderRow = styled(Box)({
  display: "flex",
  backgroundColor: "#2d2d30",
  borderBottom: "2px solid #4fc1ff",
  height: "22px",
  "@media (max-height: 800px)": {
    height: "18px",
  },
});

const HeaderCell = styled(Box)({
  padding: "4px 8px",
  fontSize: "10px",
  color: "#4fc1ff",
  fontWeight: 600,
  textTransform: "uppercase",
  cursor: "pointer",
  userSelect: "none",
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  position: "relative",
  "&:hover": {
    backgroundColor: "#3a3a3a",
  },
  "@media (max-height: 800px)": {
    padding: "2px 6px",
    fontSize: "9px",
  },
});

// Column resize handle
const ResizeHandle = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isResizing",
})<{ isResizing?: boolean }>(({ isResizing }) => ({
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: "6px",
  cursor: "col-resize",
  backgroundColor: isResizing ? "rgba(79, 193, 255, 0.6)" : "transparent",
  transition: "background-color 0.15s ease",
  "&:hover": {
    backgroundColor: "rgba(79, 193, 255, 0.4)",
  },
  zIndex: 1,
}));

const RowContainer = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "isActive" && prop !== "isEven" && prop !== "rowColor",
})<{ isActive?: boolean; isEven?: boolean; rowColor?: string }>(
  ({ isActive, isEven }) => ({
    display: "flex",
    cursor: "pointer",
    backgroundColor: isActive
      ? "rgba(79, 193, 255, 0.22)"
      : isEven
        ? "rgba(255, 255, 255, 0.02)"
        : "transparent",
    borderLeft: isActive ? "3px solid #4fc1ff" : "3px solid transparent",
    transition: "background-color 0.1s ease",
    "&:hover": {
      backgroundColor: isActive
        ? "rgba(79, 193, 255, 0.28)"
        : "rgba(79, 193, 255, 0.1)",
    },
  })
);

const CellContainer = styled(Box)({
  padding: "3px 8px",
  fontSize: "11px",
  color: "#d4d4d4",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  borderBottom: "1px solid #2a2a2a",
  display: "flex",
  alignItems: "center",
  "@media (max-height: 800px)": {
    padding: "2px 6px",
    fontSize: "10px",
  },
});

// Row props interface for react-window v2
interface RowProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  columnWidths: Record<string, number>;
  onRowClick?: (item: T, index: number) => void;
  isRowActive?: (item: T) => boolean;
  getRowColor?: (item: T) => string | undefined;
  getRowKey: (item: T, index: number) => string;
}

// Create a row component factory for react-window v2
function createRowComponent<T>(): React.ForwardRefExoticComponent<
  RowComponentProps<RowProps<T>> & React.RefAttributes<HTMLDivElement>
> {
  const Component = forwardRef<HTMLDivElement, RowComponentProps<RowProps<T>>>(
    function VirtualizedTableRow(
      { index, style, ...rowProps },
      ref
    ): ReactElement {
      const {
        data,
        columns,
        columnWidths,
        onRowClick,
        isRowActive,
        getRowColor,
        getRowKey,
      } = rowProps;
      const item = data[index];
      const isActive = isRowActive ? isRowActive(item) : false;
      const rowColor = getRowColor ? getRowColor(item) : undefined;
      const isEven = index % 2 === 1;

      const handleClick = useCallback(() => {
        if (onRowClick) {
          onRowClick(item, index);
        }
      }, [onRowClick, item, index]);

      return (
        <RowContainer
          ref={ref}
          style={style}
          isActive={isActive}
          isEven={isEven}
          onClick={handleClick}
          key={getRowKey(item, index)}
        >
          {columns.map((column: ColumnDef<T>) => {
            const cellStyle = column.getCellStyle
              ? column.getCellStyle(item)
              : {};
            const width = columnWidths[column.key] ?? column.width;
            return (
              <CellContainer
                key={column.key}
                sx={{
                  width: `${width}%`,
                  justifyContent:
                    column.align === "right"
                      ? "flex-end"
                      : column.align === "center"
                        ? "center"
                        : "flex-start",
                  color: rowColor,
                  fontWeight: isActive ? 600 : 400,
                  ...cellStyle,
                }}
              >
                {column.render(item, index)}
              </CellContainer>
            );
          })}
        </RowContainer>
      );
    }
  );
  return Component;
}

// Main VirtualizedTable component
export function VirtualizedTable<T>({
  data,
  columns,
  rowHeight = 24,
  maxHeight = 280,
  sortField,
  sortDirection,
  onSort,
  onRowClick,
  isRowActive,
  getRowColor,
  getRowKey,
  columnWidths: externalColumnWidths,
  onColumnWidthChange,
}: VirtualizedTableProps<T>) {
  // Internal column widths state (used if no external state provided)
  const [internalColumnWidths, setInternalColumnWidths] = useState<
    Record<string, number>
  >(() => {
    const initial: Record<string, number> = {};
    columns.forEach((col) => {
      initial[col.key] = col.width;
    });
    return initial;
  });

  // Use external or internal column widths
  const columnWidths = externalColumnWidths ?? internalColumnWidths;

  // Column resize state
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const resizeStartRef = useRef<{ x: number; width: number; key: string }>({
    x: 0,
    width: 0,
    key: "",
  });
  const tableRef = useRef<HTMLDivElement>(null);

  // Handle column resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, columnKey: string) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidth =
        columnWidths[columnKey] ??
        columns.find((c) => c.key === columnKey)?.width ??
        20;
      setResizingColumn(columnKey);
      resizeStartRef.current = {
        x: e.clientX,
        width: currentWidth,
        key: columnKey,
      };
    },
    [columnWidths, columns]
  );

  // Column resize effect
  useEffect(() => {
    if (!resizingColumn) return;

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const tableWidth = tableRef.current?.clientWidth || 1;
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaPercent = (deltaX / tableWidth) * 100;
      const column = columns.find((c) => c.key === resizingColumn);
      const minWidth = column?.minWidth ?? 10;
      const newWidth = Math.max(
        minWidth,
        Math.min(80, resizeStartRef.current.width + deltaPercent)
      );

      if (onColumnWidthChange) {
        onColumnWidthChange(resizingColumn, newWidth);
      } else {
        setInternalColumnWidths((prev) => ({
          ...prev,
          [resizingColumn]: newWidth,
        }));
      }
    };

    const handleMouseUp = () => {
      setResizingColumn(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingColumn, columns, onColumnWidthChange]);

  // Calculate actual list height - use full maxHeight to fill panel
  const listHeight = useMemo(() => {
    const contentHeight = data.length * rowHeight;
    const availableHeight = maxHeight - 22; // 22px for header
    // Always use at least the content height, but cap at available height
    return Math.min(contentHeight, availableHeight);
  }, [data.length, rowHeight, maxHeight]);

  // Create row component - needs to be stable
  const RowComponent = useMemo(() => createRowComponent<T>(), []);

  // Render header with resize handles
  const renderHeader = () => (
    <HeaderRow>
      {columns.map((column, index) => {
        const width = columnWidths[column.key] ?? column.width;
        const isLastColumn = index === columns.length - 1;
        return (
          <HeaderCell
            key={column.key}
            sx={{ width: `${width}%` }}
            onClick={() =>
              onSort && column.sortable !== false && onSort(column.key)
            }
          >
            {column.sortable !== false ? (
              <TableSortLabel
                active={sortField === column.key}
                direction={sortField === column.key ? sortDirection : "asc"}
                sx={{
                  color: "#4fc1ff",
                  "&:hover": { color: "#6dd0ff" },
                  "&.Mui-active": { color: "#4fc1ff" },
                  "& .MuiTableSortLabel-icon": {
                    color: "#4fc1ff !important",
                    fontSize: "12px",
                  },
                }}
              >
                {column.label}
              </TableSortLabel>
            ) : (
              column.label
            )}
            {/* Resize handle - not on last column */}
            {!isLastColumn && (
              <ResizeHandle
                isResizing={resizingColumn === column.key}
                onMouseDown={(e) => handleResizeStart(e, column.key)}
              />
            )}
          </HeaderCell>
        );
      })}
    </HeaderRow>
  );

  if (data.length === 0) {
    return null;
  }

  return (
    <TableWrapper ref={tableRef}>
      {renderHeader()}
      <List
        rowHeight={rowHeight}
        rowCount={data.length}
        rowComponent={RowComponent as any}
        rowProps={{
          data,
          columns,
          columnWidths,
          onRowClick,
          isRowActive,
          getRowColor,
          getRowKey,
        }}
        overscanCount={5}
        style={{
          height: listHeight,
          overflowX: "hidden",
        }}
      />
    </TableWrapper>
  );
}

export default VirtualizedTable;
