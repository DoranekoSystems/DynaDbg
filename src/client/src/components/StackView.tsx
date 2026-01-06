import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Paper,
  styled,
  IconButton,
  Tooltip,
} from "@mui/material";
import { ViewList as StackIcon, Refresh } from "@mui/icons-material";
import { getApiClient, ModuleInfo } from "../lib/api";
import { encodeAddressToLibraryExpression } from "../utils/addressEncoder";

// スタックエントリーのデータ型
interface StackEntry {
  address: string;
  dword: string; // DWORDに戻す
  value: string;
}

// Props interface
interface StackViewProps {
  spRegister?: string | null; // SPレジスタの値
  isInBreakState?: boolean; // ブレーク状態かどうか
  currentThreadId?: number | null; // 現在のスレッドID
  attachedModules?: ModuleInfo[]; // モジュール情報（library+offset表示用）
  onNavigateToAddress?: (address: string) => void; // アドレスへのナビゲーションハンドラー
  resolveFunctionName?: (libraryPath: string, offset: number) => string | null; // 関数名解決
}

// Styled components for Stack View
const StackContainer = styled(Box)(() => ({
  height: "100%",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "#1e1e1e",
  position: "relative",
  flex: "1 1 40%", // スタックビューを40%の幅に
  minWidth: "450px", // 最小幅をさらに増やす
  borderLeft: "1px solid #2d2d30",
}));

const StackHeader = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #2d2d30",
  minHeight: "48px",
  height: "48px",
  "@media (max-height: 800px)": {
    padding: "4px 8px",
    minHeight: "36px",
    height: "36px",
    gap: "4px",
  },
}));

const StackDisplay = styled(Paper)(() => ({
  margin: "8px",
  backgroundColor: "#1a1a1a",
  border: "1px solid #2d2d30",
  borderRadius: "4px",
  display: "flex",
  flexDirection: "column",
  height: "calc(100% - 16px)",
  overflow: "hidden",
  "@media (max-height: 800px)": {
    margin: "4px",
    height: "calc(100% - 8px)",
  },
}));

const StackHeaderRow = styled(Box)(() => ({
  padding: "4px",
  borderBottom: "1px solid #2d2d30",
  backgroundColor: "#252526",
  position: "sticky",
  top: 0,
  zIndex: 1,
  "@media (max-height: 800px)": {
    padding: "2px",
  },
}));

const StackContent = styled(Box)(() => ({
  flex: 1,
  overflow: "auto",
  padding: "4px",
  "&::-webkit-scrollbar": {
    width: "8px",
  },
  "&::-webkit-scrollbar-track": {
    background: "#1e1e1e",
  },
  "&::-webkit-scrollbar-thumb": {
    background: "#424242",
    borderRadius: "4px",
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: "#5a5a5e",
  },
}));

const StackRow = styled(Box)(() => ({
  display: "flex",
  fontSize: "11px",
  fontFamily: "monospace",
  padding: "2px 8px",
  minHeight: "18px", // 高さを少し増やす
  borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
  alignItems: "center", // 垂直方向の中央揃え
  "&:hover": {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  "@media (max-height: 800px)": {
    fontSize: "9px",
    padding: "1px 4px",
    minHeight: "14px",
  },
}));

const StackAddressColumn = styled(Box)(() => ({
  width: "160px", // Address列をさらに広げる
  minWidth: "160px",
  color: "#4fc1ff",
  textAlign: "left",
  paddingRight: "16px",
  paddingLeft: "8px", // 8pxから16pxに変更してヘッダーと合わせる
  fontFamily: "monospace",
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  "@media (max-height: 800px)": {
    fontSize: "9px",
    width: "120px",
    minWidth: "120px",
    paddingRight: "8px",
    paddingLeft: "8px",
  },
}));

const StackDwordColumn = styled(Box)(() => ({
  width: "120px", // Dword列の幅を調整
  minWidth: "120px",
  color: "#dcdcaa",
  textAlign: "left",
  paddingRight: "16px",
  paddingLeft: "0px", // ヘッダーと一致
  fontFamily: "monospace",
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  "@media (max-height: 800px)": {
    fontSize: "9px",
    width: "90px",
    minWidth: "90px",
    paddingRight: "8px",
    paddingLeft: "0px",
  },
}));

const StackValueColumn = styled(Box)(() => ({
  width: "420px",
  minWidth: "420px",
  color: "#ce9178",
  textAlign: "left",
  paddingLeft: "0px", // ヘッダーと一致
  fontFamily: "monospace",
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  "@media (max-height: 800px)": {
    fontSize: "9px",
    width: "300px",
    minWidth: "300px",
    paddingLeft: "0px",
  },
}));

const StackValueHeaderColumn = styled(Box)(() => ({
  width: "420px",
  minWidth: "420px",
  color: "#ce9178",
  textAlign: "left",
  paddingLeft: "0px", // データ行と一致させる（StackValueColumnにはpaddingLeft未設定）
  fontFamily: "monospace",
  fontSize: "10px",
  fontWeight: 600,
  "@media (max-height: 800px)": {
    width: "300px",
    minWidth: "300px",
    paddingLeft: "0px",
  },
}));

export const StackView: React.FC<StackViewProps> = ({
  spRegister = null,
  isInBreakState = false,
  currentThreadId = null,
  attachedModules = [],
  onNavigateToAddress,
  resolveFunctionName,
}) => {
  const [stackData, setStackData] = useState<StackEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiClient = getApiClient();

  // Compute library+offset expressions for stack values (with function name resolution)
  const stackValueDetails = useMemo(() => {
    const detailsMap = new Map<
      string,
      { libraryExpr: string; functionName?: string }
    >();
    if (!attachedModules || attachedModules.length === 0) {
      return detailsMap;
    }

    stackData.forEach((entry) => {
      // Skip NULL values
      if (entry.value === "NULL") return;

      // Parse value address
      const valueMatch = entry.value.match(/0x([0-9A-F]+)/i);
      if (!valueMatch) return;

      const valueNum = parseInt(valueMatch[1], 16);
      if (isNaN(valueNum)) return;

      // Try to encode to library+offset expression
      const libraryExpr = encodeAddressToLibraryExpression(
        valueNum,
        attachedModules,
        true // prefer short filename
      );

      if (libraryExpr) {
        // Try to resolve function name if resolver is available
        let functionName: string | undefined;
        if (resolveFunctionName) {
          // Find which module this address belongs to
          for (const mod of attachedModules) {
            const modBase = mod.base;
            const modSize = mod.size || 0;
            if (valueNum >= modBase && valueNum < modBase + modSize) {
              const offset = valueNum - modBase;
              const modulePath = mod.path || mod.modulename || mod.name || "";
              const resolved = resolveFunctionName(modulePath, offset);
              if (resolved) {
                functionName = resolved;
              }
              break;
            }
          }
        }
        detailsMap.set(entry.address, { libraryExpr, functionName });
      }
    });

    return detailsMap;
  }, [stackData, attachedModules, resolveFunctionName]);

  // スタックデータを読み取る関数
  const loadStackData = useCallback(async () => {
    if (!isInBreakState || !spRegister) {
      setStackData([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log(
        `Loading stack data for thread ${currentThreadId || "default"} with SP: ${spRegister}`
      );

      // SPレジスタの値をパース
      const spValue = parseInt(spRegister, 16);
      if (isNaN(spValue)) {
        throw new Error("Invalid SP register value");
      }

      // スタックを読み取り（21エントリー分、各8バイト）
      const stackSize = 21 * 8; // 168バイト
      const memoryData = await apiClient.readMemory(
        `0x${spValue.toString(16)}`,
        stackSize
      );

      // ArrayBufferをUint8Arrayに変換
      const bytes = new Uint8Array(memoryData);

      // 8バイトずつ処理してスタックエントリーを作成
      const entries: StackEntry[] = [];
      for (let i = 0; i < bytes.length; i += 8) {
        const address = `0x${(spValue + i).toString(16).padStart(16, "0").toUpperCase()}`;

        // 4バイト（DWORD）を読み取り（リトルエンディアン）
        let dwordValue = 0;
        for (let j = 0; j < 4 && i + j < bytes.length; j++) {
          dwordValue += bytes[i + j] * Math.pow(256, j);
        }

        // 8バイト（値）を読み取り（リトルエンディアン）
        let value = 0;
        for (let j = 0; j < 8 && i + j < bytes.length; j++) {
          value += bytes[i + j] * Math.pow(256, j);
        }

        const dword = `0x${dwordValue.toString(16).padStart(8, "0").toUpperCase()}`;

        // 値を解釈（prefixなし）
        let interpretation;
        if (value === 0) {
          interpretation = "NULL";
        } else {
          interpretation = `0x${value.toString(16).padStart(16, "0").toUpperCase()}`;
        }

        entries.push({
          address,
          dword,
          value: interpretation,
        });
      }

      setStackData(entries);
    } catch (err) {
      console.error("Failed to load stack data:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load stack data"
      );
      setStackData([]);
    } finally {
      setIsLoading(false);
    }
  }, [isInBreakState, spRegister, apiClient, currentThreadId]);

  // ブレーク状態になったときにスタックデータを読み込む
  useEffect(() => {
    if (isInBreakState && spRegister) {
      loadStackData();
    } else {
      setStackData([]);
      setError(null);
    }
  }, [isInBreakState, spRegister, loadStackData]);

  // リフレッシュハンドラー
  const handleRefresh = useCallback(() => {
    loadStackData();
  }, [loadStackData]);

  return (
    <StackContainer>
      {/* Stack Header */}
      <StackHeader>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            height: "100%",
          }}
        >
          <StackIcon sx={{ fontSize: "16px", color: "#4fc1ff" }} />
          <Typography
            variant="body2"
            sx={{
              fontSize: "12px",
              fontWeight: 600,
              color: "#4fc1ff",
              lineHeight: 1,
              "@media (max-height: 800px)": {
                fontSize: "10px",
              },
            }}
          >
            Stack
          </Typography>
        </Box>

        {/* リフレッシュボタン */}
        {isInBreakState && (
          <Tooltip title="Refresh stack data">
            <IconButton
              size="small"
              onClick={handleRefresh}
              disabled={isLoading}
              sx={{
                color: "#9cdcfe",
                "&:hover": { backgroundColor: "#2d2d30" },
                "&:disabled": { color: "#666" },
              }}
            >
              <Refresh fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </StackHeader>

      {/* Stack Content */}
      <Box
        sx={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <StackDisplay elevation={0}>
          {/* Fixed Header */}
          <StackHeaderRow>
            <Box
              sx={{
                display: "flex",
                fontSize: "10px",
                color: "#9b9b9b",
                fontFamily: "monospace",
                fontWeight: 600,
              }}
            >
              <Box
                sx={{
                  width: "160px",
                  minWidth: "160px",
                  paddingRight: "16px",
                  paddingLeft: "8px", // データ行と一致させる
                  textAlign: "left",
                  color: "#4fc1ff", // Addressに青色を追加
                  fontWeight: 600,
                  "@media (max-height: 800px)": {
                    width: "120px",
                    minWidth: "120px",
                    paddingRight: "8px",
                    paddingLeft: "8px",
                  },
                }}
              >
                Address
              </Box>
              <Box
                sx={{
                  width: "120px",
                  minWidth: "120px",
                  paddingRight: "16px",
                  paddingLeft: "0px", // データ行と一致させる（StackDwordColumnはpaddingLeft未設定）
                  textAlign: "left",
                  color: "#dcdcaa", // Dwordに黄色を追加
                  fontWeight: 600,
                  "@media (max-height: 800px)": {
                    width: "90px",
                    minWidth: "90px",
                    paddingRight: "8px",
                    paddingLeft: "0px",
                  },
                }}
              >
                Dword
              </Box>
              <StackValueHeaderColumn>Value</StackValueHeaderColumn>
            </Box>
          </StackHeaderRow>

          {/* Scrollable Stack Rows */}
          <StackContent>
            {isLoading ? (
              <Box
                sx={{ padding: "16px", textAlign: "center", color: "#9b9b9b" }}
              >
                <Typography variant="body2" sx={{ fontSize: "12px" }}>
                  Loading stack data...
                </Typography>
              </Box>
            ) : error ? (
              <Box
                sx={{ padding: "16px", textAlign: "center", color: "#f48771" }}
              >
                <Typography variant="body2" sx={{ fontSize: "12px" }}>
                  Error: {error}
                </Typography>
              </Box>
            ) : !isInBreakState || !spRegister ? (
              <Box
                sx={{ padding: "16px", textAlign: "center", color: "#9b9b9b" }}
              >
                <Typography variant="body2" sx={{ fontSize: "12px" }}>
                  {!isInBreakState
                    ? "Program must be paused to view stack"
                    : "SP register not available"}
                </Typography>
              </Box>
            ) : stackData.length === 0 ? (
              <Box
                sx={{ padding: "16px", textAlign: "center", color: "#9b9b9b" }}
              >
                <Typography variant="body2" sx={{ fontSize: "12px" }}>
                  No stack data available
                </Typography>
              </Box>
            ) : (
              stackData.map((row, index) => {
                const detail = stackValueDetails.get(row.address);
                return (
                  <StackRow key={`stack-${index}`}>
                    <StackAddressColumn>{row.address}</StackAddressColumn>
                    <StackDwordColumn>{row.dword}</StackDwordColumn>
                    <StackValueColumn>
                      {detail ? (
                        <>
                          {row.value}{" "}
                          <Box
                            component="span"
                            onClick={() => {
                              if (onNavigateToAddress) {
                                onNavigateToAddress(row.value);
                              }
                            }}
                            sx={{
                              color: "#4fc1ff",
                              cursor: "pointer",
                              textDecoration: "underline",
                              "&:hover": {
                                color: "#6fd8ff",
                              },
                            }}
                          >
                            ({detail.libraryExpr})
                          </Box>
                          {detail.functionName && (
                            <Box
                              component="span"
                              sx={{
                                color: "#dcdcaa",
                                ml: 0.5,
                              }}
                            >
                              [{detail.functionName}]
                            </Box>
                          )}
                        </>
                      ) : (
                        row.value
                      )}
                    </StackValueColumn>
                  </StackRow>
                );
              })
            )}
          </StackContent>
        </StackDisplay>
      </Box>
    </StackContainer>
  );
};
