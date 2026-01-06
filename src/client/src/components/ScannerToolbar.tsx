import React from "react";

interface ScannerToolbarProps {
  // Legacy props for backward compatibility
  visible?: boolean;
  onFirstScan?: () => void;
}

export const ScannerToolbar: React.FC<ScannerToolbarProps> = ({
  visible = true,
}) => {
  if (!visible) return null;

  return null;
};
