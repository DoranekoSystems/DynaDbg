import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalStorage } from "./useLocalStorage";

interface UseResizableOptions {
  storageKey: string;
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  orientation?: "horizontal" | "vertical";
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Hook for managing resizable panels with localStorage persistence
 */
export const useResizable = ({
  storageKey,
  defaultSize,
  minSize = 100,
  maxSize = Infinity,
  orientation = "vertical",
  containerRef,
}: UseResizableOptions) => {
  const [size, setSize] = useLocalStorage<number>(storageKey, defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const initialPositionRef = useRef<number>(0);
  const initialSizeRef = useRef<number>(0);
  const containerSizeRef = useRef<number>(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      initialPositionRef.current =
        orientation === "vertical" ? e.clientY : e.clientX;
      initialSizeRef.current = size;

      // Get container size for percentage calculations
      if (containerRef?.current) {
        containerSizeRef.current =
          orientation === "vertical"
            ? containerRef.current.clientHeight
            : containerRef.current.clientWidth;
      }
    },
    [size, orientation, containerRef]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const currentPosition =
        orientation === "vertical" ? e.clientY : e.clientX;
      const deltaPixels = currentPosition - initialPositionRef.current;

      // Convert pixel delta to percentage delta
      const containerSize = containerSizeRef.current || 1000; // Fallback to reasonable default
      const deltaPercentage = (deltaPixels / containerSize) * 100;
      const newSize = initialSizeRef.current + deltaPercentage;

      // Apply constraints
      const constrainedSize = Math.min(Math.max(newSize, minSize), maxSize);
      setSize(constrainedSize);
    },
    [isResizing, orientation, minSize, maxSize, setSize]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      // Prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor =
        orientation === "vertical" ? "ns-resize" : "ew-resize";

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp, orientation]);

  return {
    size,
    setSize,
    isResizing,
    handleMouseDown,
  };
};
