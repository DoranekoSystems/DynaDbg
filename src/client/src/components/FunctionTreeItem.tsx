import React from "react";
import TreeItem from "./TreeItem";

interface ChipData {
  label: string;
  color?:
    | "default"
    | "primary"
    | "secondary"
    | "error"
    | "info"
    | "success"
    | "warning";
  variant?: "filled" | "outlined";
}

interface FunctionTreeItemProps {
  children: React.ReactNode;
  functionAddress?: string;
  icon?: React.ComponentType;
  color?: string;
  active?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
  chips?: ChipData[];
}

export default function FunctionTreeItem({
  children,
  functionAddress,
  icon,
  color,
  active,
  highlighted,
  onClick,
  chips = [],
}: FunctionTreeItemProps) {
  return (
    <TreeItem
      icon={icon}
      color={color}
      active={active}
      highlighted={highlighted}
      onClick={onClick}
      chips={chips}
      details={functionAddress}
    >
      {children}
    </TreeItem>
  );
}
