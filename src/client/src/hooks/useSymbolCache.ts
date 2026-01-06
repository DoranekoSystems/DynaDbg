import { useCallback, useRef, useState, useEffect } from "react";
import { useUIStore, CachedSymbol } from "../stores/uiStore";
import { getApiClient, ModuleInfo } from "../lib/api";
import { invoke } from "@tauri-apps/api/core";

interface GhidraFunctionEntry {
  name: string;
  address: string;
  size: number;
}

/**
 * シンボルキャッシュを管理するカスタムフック
 * オンデマンドでモジュールのシンボル情報をロードし、
 * アドレスからシンボルを検索できるようにする
 */
export function useSymbolCache() {
  const globalSymbolCache = useUIStore((state) => state.globalSymbolCache);
  const assemblyDemangleEnabled = useUIStore(
    (state) => state.debuggerState.assemblyDemangleEnabled
  );
  const actions = useUIStore((state) => state.actions);

  const loadingModulesRef = useRef<Set<number>>(new Set());

  const serverInfoRef = useRef<{ ip: string; port: number } | null>(null);

  const targetOsRef = useRef<string>("unknown");

  // Demangled names cache
  const [demangledNames, setDemangledNames] = useState<Map<string, string>>(
    new Map()
  );

  const isDemanglingRef = useRef(false);

  // Demangle symbols when cache changes or demangle setting changes
  useEffect(() => {
    if (!assemblyDemangleEnabled || globalSymbolCache.symbols.length === 0) {
      return;
    }

    if (isDemanglingRef.current) {
      return;
    }

    // Get unique names that need demangling
    const uniqueNames = new Set<string>();
    for (const symbol of globalSymbolCache.symbols) {
      if (!demangledNames.has(symbol.name)) {
        uniqueNames.add(symbol.name);
      }
    }

    const namesToDemangle = Array.from(uniqueNames).slice(0, 1000); // Limit to 1000 at a time

    if (namesToDemangle.length === 0) {
      return;
    }

    isDemanglingRef.current = true;

    // Call Tauri demangle command
    invoke<string[]>("demangle_symbols", { names: namesToDemangle })
      .then((demangled) => {
        const newCache = new Map(demangledNames);
        namesToDemangle.forEach((name, index) => {
          newCache.set(name, demangled[index]);
        });
        setDemangledNames(newCache);
      })
      .catch((error) => {
        console.error("Failed to demangle symbols:", error);
      })
      .finally(() => {
        isDemanglingRef.current = false;
      });
  }, [globalSymbolCache.symbols.length, assemblyDemangleEnabled]);

  /**
   * サーバー情報を更新
   */
  const updateServerInfo = useCallback(
    (serverInfo: { ip: string; port: number; targetOs?: string } | null) => {
      serverInfoRef.current = serverInfo;
      if (serverInfo?.targetOs) {
        targetOsRef.current = serverInfo.targetOs;
      }
    },
    []
  );

  /**
   * Simplify C++ template names by removing/shortening template arguments
   * e.g., "std::mersenne_twister_engine<unsigned long, 32, ...>" -> "std::mersenne_twister_engine<...>"
   */
  const simplifyTemplateName = useCallback((name: string): string => {
    // Find the first '<' and last '>'
    const firstBracket = name.indexOf("<");
    if (firstBracket === -1) return name;

    const lastBracket = name.lastIndexOf(">");
    if (lastBracket === -1 || lastBracket <= firstBracket) return name;

    // Get the base name and check template content length
    const baseName = name.substring(0, firstBracket);
    const templateContent = name.substring(firstBracket + 1, lastBracket);
    const suffix = name.substring(lastBracket + 1);

    // If template content is short enough, keep it
    if (templateContent.length <= 30) return name;

    // Count nested brackets to find first-level arguments
    let depth = 0;
    let firstArgEnd = -1;
    for (let i = 0; i < templateContent.length; i++) {
      const char = templateContent[i];
      if (char === "<") depth++;
      else if (char === ">") depth--;
      else if (char === "," && depth === 0) {
        firstArgEnd = i;
        break;
      }
    }

    if (firstArgEnd === -1) {
      // Single argument, just shorten it
      return `${baseName}<...>${suffix}`;
    }

    // Keep first argument if it's short, otherwise abbreviate
    const firstArg = templateContent.substring(0, firstArgEnd).trim();
    if (firstArg.length <= 20) {
      return `${baseName}<${firstArg}, ...>${suffix}`;
    }
    return `${baseName}<...>${suffix}`;
  }, []);

  /**
   * Get demangled name if enabled
   */
  const getDisplayName = useCallback(
    (name: string): string => {
      if (!assemblyDemangleEnabled) return name;
      const demangled = demangledNames.get(name) || name;
      // Simplify template names for readability
      return simplifyTemplateName(demangled);
    },
    [assemblyDemangleEnabled, demangledNames, simplifyTemplateName]
  );

  /**
   * 指定されたモジュールのシンボルをキャッシュにロード（内部用）
   */
  const loadModuleSymbolsInternal = useCallback(
    async (module: ModuleInfo): Promise<CachedSymbol[]> => {
      if (globalSymbolCache.loadedModules.has(module.base)) {
        return globalSymbolCache.symbols.filter(
          (s) => s.moduleBase === module.base
        );
      }

      if (loadingModulesRef.current.has(module.base)) {
        for (let i = 0; i < 50; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!loadingModulesRef.current.has(module.base)) {
            return globalSymbolCache.symbols.filter(
              (s) => s.moduleBase === module.base
            );
          }
        }
        return [];
      }

      loadingModulesRef.current.add(module.base);

      try {
        const client = getApiClient();
        const serverInfo = serverInfoRef.current;
        if (serverInfo) {
          client.updateConnection(serverInfo.ip, serverInfo.port);
        }
        const symbols = await client.enumerateSymbolsForModule(module);

        if (!symbols || symbols.length === 0) {
          actions.markModuleAsLoaded(module.base);
          return [];
        }

        const fullModuleName = module.modulename || module.name || "unknown";
        const moduleName =
          fullModuleName.split(/[\/\\]/).pop() || fullModuleName;

        // Filter symbols that are likely functions (for disassembly symbol resolution)
        // Include: Function, FUNC (ELF/PE), SECT with size (MachO functions in __TEXT)
        // Also include Public (Windows export symbols) and Thunk (Windows thunk functions)
        const functionSymbols = symbols.filter(
          (s) =>
            s.type === "Function" ||
            s.type === "FUNC" ||
            s.type === "Public" ||
            s.type === "Thunk" ||
            (s.type === "SECT" && s.size > 0)
        );

        const cachedSymbols: CachedSymbol[] = functionSymbols
          .map((symbol) => {
            const address = parseInt(symbol.address, 16);
            if (isNaN(address)) return null;

            return {
              address,
              endAddress: address + (symbol.size || 1),
              name: symbol.name,
              moduleName,
              moduleBase: module.base,
            };
          })
          .filter((s): s is CachedSymbol => s !== null);

        // Also load Ghidra analyzed functions from SQLite
        let ghidraSymbols: CachedSymbol[] = [];
        try {
          const targetOs = targetOsRef.current.toLowerCase();
          // Try multiple targetOs variations
          let functionsJson = await invoke<string | null>(
            "get_ghidra_functions",
            {
              targetOs: targetOs,
              moduleName: moduleName,
            }
          );
          if (!functionsJson) {
            functionsJson = await invoke<string | null>(
              "get_ghidra_functions",
              {
                targetOs: "unknown",
                moduleName: moduleName,
              }
            );
          }

          if (functionsJson) {
            const ghidraFunctions: GhidraFunctionEntry[] =
              JSON.parse(functionsJson);
            ghidraSymbols = ghidraFunctions
              .map((func) => {
                // Ghidra addresses are offsets from module base
                const offsetHex = func.address.startsWith("0x")
                  ? func.address
                  : `0x${func.address}`;
                const offset = parseInt(offsetHex, 16);
                if (isNaN(offset)) return null;

                const absoluteAddress = module.base + offset;

                return {
                  address: absoluteAddress,
                  endAddress: absoluteAddress + (func.size || 1),
                  name: func.name,
                  moduleName,
                  moduleBase: module.base,
                };
              })
              .filter((s): s is CachedSymbol => s !== null);

            if (ghidraSymbols.length > 0) {
              console.log(
                `[SymbolCache] Loaded ${ghidraSymbols.length} Ghidra functions for ${moduleName}`
              );
            }
          }
        } catch (e) {
          // Ghidra functions not available, continue with regular symbols
          console.log(`[SymbolCache] No Ghidra functions for ${moduleName}`);
        }

        // Merge symbols, preferring existing symbols over Ghidra ones for same address
        const symbolAddressSet = new Set(cachedSymbols.map((s) => s.address));
        const uniqueGhidraSymbols = ghidraSymbols.filter(
          (s) => !symbolAddressSet.has(s.address)
        );
        const allSymbols = [...cachedSymbols, ...uniqueGhidraSymbols];

        if (allSymbols.length > 0) {
          actions.addSymbolsToCache(allSymbols);
        }

        actions.markModuleAsLoaded(module.base);
        console.log(
          `[SymbolCache] Loaded ${cachedSymbols.length} symbols + ${uniqueGhidraSymbols.length} Ghidra functions for ${moduleName}`
        );
        return allSymbols;
      } catch (error) {
        console.error(
          `Failed to load symbols for module ${module.modulename}:`,
          error
        );
        actions.markModuleAsLoaded(module.base);
        return [];
      } finally {
        loadingModulesRef.current.delete(module.base);
      }
    },
    [globalSymbolCache.loadedModules, globalSymbolCache.symbols, actions]
  );

  /**
   * アドレスからシンボル情報を検索
   */
  const findSymbolForAddress = useCallback(
    (address: number): { symbol: CachedSymbol; offset: number } | null => {
      const symbol = actions.findSymbolForAddress(address);
      if (!symbol) return null;

      const offset = address - symbol.address;
      return { symbol, offset };
    },
    [actions]
  );

  /**
   * アドレスを「module@function + offset」形式に変換
   * 必要に応じてモジュールのシンボルを自動ロード
   */
  const formatAddressWithSymbol = useCallback(
    (
      address: number,
      modules: ModuleInfo[],
      format: "library" | "function"
    ): string | null => {
      const module = modules.find((m) => {
        const moduleEnd = m.base + m.size;
        return address >= m.base && address < moduleEnd;
      });

      if (!module) return null;

      const fullModuleName = module.modulename || module.name || "unknown";
      const moduleName = fullModuleName.split(/[\/\\]/).pop() || fullModuleName;
      const moduleOffset = address - module.base;

      if (format === "library") {
        return `${moduleName} + 0x${moduleOffset.toString(16)}`;
      }

      if (!globalSymbolCache.loadedModules.has(module.base)) {
        if (loadingModulesRef.current.has(module.base)) {
          return `${moduleName} + 0x${moduleOffset.toString(16)}`;
        }
        loadModuleSymbolsInternal(module);
        return `${moduleName} + 0x${moduleOffset.toString(16)}`;
      }

      const result = findSymbolForAddress(address);
      if (result) {
        const { symbol, offset } = result;
        const displayName = getDisplayName(symbol.name);

        if (offset === 0) {
          return `${moduleName}@${displayName}`;
        }
        return `${moduleName}@${displayName} + 0x${offset.toString(16)}`;
      }

      return `${moduleName} + 0x${moduleOffset.toString(16)}`;
    },
    [
      findSymbolForAddress,
      getDisplayName,
      globalSymbolCache.loadedModules,
      loadModuleSymbolsInternal,
    ]
  );

  /**
   * シンボル名からアドレスを検索
   * 必要に応じてモジュールのシンボルをロード
   */
  const findAddressForSymbol = useCallback(
    async (
      symbolName: string,
      moduleName: string,
      modules: ModuleInfo[]
    ): Promise<CachedSymbol | null> => {
      const module = modules.find((m) => {
        const fullModuleName = m.modulename || m.name || "";
        const shortName =
          fullModuleName.split(/[\/\\]/).pop() || fullModuleName;
        return (
          shortName.toLowerCase() === moduleName.toLowerCase() ||
          fullModuleName.toLowerCase().includes(moduleName.toLowerCase())
        );
      });

      if (!module) return null;

      if (!globalSymbolCache.loadedModules.has(module.base)) {
        await loadModuleSymbolsInternal(module);
      }

      const currentCache = useUIStore.getState().globalSymbolCache;
      const symbol = currentCache.symbols.find((s) => {
        if (s.moduleBase !== module.base) return false;
        return (
          s.name.toLowerCase().includes(symbolName.toLowerCase()) ||
          symbolName.toLowerCase().includes(s.name.toLowerCase())
        );
      });

      return symbol || null;
    },
    [globalSymbolCache.loadedModules, loadModuleSymbolsInternal]
  );

  /**
   * アドレスに対応するモジュールのシンボルを事前ロード
   * AssemblyView等で表示アドレスが変わったときに呼び出す
   * @param serverInfo サーバー接続情報（必須）
   * @returns ロードが開始されたかどうか
   */
  const ensureModuleSymbolsLoaded = useCallback(
    async (
      address: number,
      modules: ModuleInfo[],
      serverInfo: { ip: string; port: number } | null
    ): Promise<boolean> => {
      if (!serverInfo) {
        console.log(
          "[useSymbolCache] ensureModuleSymbolsLoaded: No server info provided"
        );
        return false;
      }

      const module = modules.find((m) => {
        const moduleEnd = m.base + m.size;
        return address >= m.base && address < moduleEnd;
      });

      if (!module) {
        console.log(
          `[useSymbolCache] ensureModuleSymbolsLoaded: No module found for address 0x${address.toString(16)}`
        );
        return false;
      }

      if (globalSymbolCache.loadedModules.has(module.base)) {
        console.log(
          `[useSymbolCache] ensureModuleSymbolsLoaded: Module ${module.modulename} already loaded`
        );
        return false;
      }

      serverInfoRef.current = serverInfo;

      console.log(
        `[useSymbolCache] ensureModuleSymbolsLoaded: Loading symbols for ${module.modulename}`
      );
      await loadModuleSymbolsInternal(module);
      return true;
    },
    [globalSymbolCache.loadedModules, loadModuleSymbolsInternal]
  );

  /**
   * キャッシュをクリア
   */
  const clearCache = useCallback(() => {
    actions.clearSymbolCache();
    setDemangledNames(new Map());
  }, [actions]);

  return {
    isLoading: globalSymbolCache.isLoading,
    loadingProgress: globalSymbolCache.loadingProgress,
    symbolCount: globalSymbolCache.symbols.length,
    loadedModuleCount: globalSymbolCache.loadedModules.size,
    loadedModules: globalSymbolCache.loadedModules,
    assemblyDemangleEnabled,

    updateServerInfo,
    findSymbolForAddress,
    findAddressForSymbol,
    formatAddressWithSymbol,
    ensureModuleSymbolsLoaded,
    getDisplayName,
    clearCache,
  };
}
