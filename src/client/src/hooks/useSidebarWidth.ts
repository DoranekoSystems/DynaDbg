import { useEffect } from 'react';

/**
 * Hook to force DOM updates when sidebar width changes
 * This ensures grid layout recalculates properly
 */
export const useSidebarWidth = (sidebarWidth: number) => {
  useEffect(() => {
    // Force a layout recalculation
    const gridElement = document.querySelector('[data-sidebar-grid]');
    if (gridElement) {
      // Trigger reflow by reading a layout property
      gridElement.getBoundingClientRect();
    }
  }, [sidebarWidth]);
};
