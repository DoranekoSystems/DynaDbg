import { ModuleInfo, getApiClient } from "../lib/api";
import { useUIStore, CachedSymbol } from "../stores/uiStore";

async function loadModuleSymbolsOnDemand(
  serverInfo: { ip: string; port: number },
  module: ModuleInfo
): Promise<CachedSymbol[]> {
  const globalSymbolCache = useUIStore.getState().globalSymbolCache;
  const actions = useUIStore.getState().actions;

  if (globalSymbolCache.loadedModules.has(module.base)) {
    return globalSymbolCache.symbols.filter(
      (s) => s.moduleBase === module.base
    );
  }

  try {
    const client = getApiClient();
    client.updateConnection(serverInfo.ip, serverInfo.port);
    const symbols = await client.enumerateSymbolsForModule(module);

    if (!symbols || symbols.length === 0) {
      actions.markModuleAsLoaded(module.base);
      return [];
    }

    const fullModuleName = module.modulename || module.name || "unknown";
    const moduleName = fullModuleName.split(/[\/\\]/).pop() || fullModuleName;

    const functionSymbols = symbols.filter(
      (s) => s.type === "Function" || s.type === "FUNC"
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

    if (cachedSymbols.length > 0) {
      actions.addSymbolsToCache(cachedSymbols);
    }

    actions.markModuleAsLoaded(module.base);
    console.log(
      `[addressEncoder] Loaded ${cachedSymbols.length} symbols for ${moduleName}`
    );
    return cachedSymbols;
  } catch (error) {
    console.error(
      `Failed to load symbols for module ${module.modulename}:`,
      error
    );
    actions.markModuleAsLoaded(module.base);
    return [];
  }
}

/**
 * Parses a library+offset or library@function+offset expression and converts it to a numeric address
 * Supports formats:
 * - "lib.so + 0x1234" or "lib.so+0x1234" (library + offset)
 * - "lib.so@func + 0x10" or "lib.so@func+0x10" (library@function + offset)
 * - "lib.so@func" (library@function without offset)
 * @param expression - The expression to parse
 * @param modules - Array of loaded modules with their base addresses
 * @returns The numeric address or null if parsing fails
 */
export function decodeLibraryExpression(
  expression: string,
  modules: ModuleInfo[]
): number | null {
  if (!expression || !modules || modules.length === 0) {
    return null;
  }

  // Trim whitespace
  const trimmed = expression.trim();

  // Check if it's a library@function format (contains @ before the + sign or no + sign)
  const atIndex = trimmed.indexOf("@");
  const plusIndex = trimmed.indexOf("+");

  if (atIndex > 0 && (plusIndex === -1 || atIndex < plusIndex)) {
    // This is a library@function format
    return decodeLibraryFunctionExpression(trimmed, modules);
  }

  // Match pattern: "LibraryName + 0xOffset" or "LibraryName+0xOffset"
  const match = trimmed.match(/^(.+?)\s*\+\s*(0x[0-9a-fA-F]+|\d+)$/);

  if (!match) {
    return null;
  }

  const libraryName = match[1].trim();
  const offsetStr = match[2].trim();

  // Parse offset (supports both hex and decimal)
  let offset: number;
  if (offsetStr.startsWith("0x") || offsetStr.startsWith("0X")) {
    offset = parseInt(offsetStr, 16);
  } else {
    offset = parseInt(offsetStr, 10);
  }

  if (isNaN(offset)) {
    return null;
  }

  // Find the module by name (case-insensitive, partial match)
  // Support both filename and full module path
  const module = modules.find((mod) => {
    const fullModuleName = mod.modulename || mod.name || "";
    const fileName = fullModuleName.split("/").pop() || fullModuleName;

    // Try exact match first
    if (
      fullModuleName.toLowerCase() === libraryName.toLowerCase() ||
      fileName.toLowerCase() === libraryName.toLowerCase()
    ) {
      return true;
    }

    // Try partial match (library name contains the search term)
    if (
      fullModuleName.toLowerCase().includes(libraryName.toLowerCase()) ||
      fileName.toLowerCase().includes(libraryName.toLowerCase())
    ) {
      return true;
    }

    return false;
  });

  if (!module) {
    console.warn(
      `Module "${libraryName}" not found in loaded modules. Available modules:`,
      modules.map((m) => m.modulename || m.name)
    );
    return null;
  }

  // Calculate final address
  const address = module.base + offset;

  console.log(
    `Decoded library expression: "${expression}" -> Module: ${module.modulename || module.name} (base: 0x${module.base.toString(16)}) + offset: 0x${offset.toString(16)} = 0x${address.toString(16)}`
  );

  return address;
}

/**
 * Parses a library@function+offset expression
 * Supports formats:
 * - "lib.so@func + 0x10" or "lib.so@func+0x10"
 * - "lib.so@func" (without offset)
 */
function decodeLibraryFunctionExpression(
  expression: string,
  modules: ModuleInfo[]
): number | null {
  // Match patterns:
  // "lib.so@func + 0x10" -> lib.so, func, 0x10
  // "lib.so@func" -> lib.so, func, null
  const matchWithOffset = expression.match(
    /^(.+?)@(.+?)\s*\+\s*(0x[0-9a-fA-F]+|\d+)$/
  );
  const matchWithoutOffset = expression.match(/^(.+?)@([^+\s]+)$/);

  let libraryName: string;
  let funcName: string;
  let offset = 0;

  if (matchWithOffset) {
    libraryName = matchWithOffset[1].trim();
    funcName = matchWithOffset[2].trim();
    const offsetStr = matchWithOffset[3].trim();
    if (offsetStr.startsWith("0x") || offsetStr.startsWith("0X")) {
      offset = parseInt(offsetStr, 16);
    } else {
      offset = parseInt(offsetStr, 10);
    }
    if (isNaN(offset)) offset = 0;
  } else if (matchWithoutOffset) {
    libraryName = matchWithoutOffset[1].trim();
    funcName = matchWithoutOffset[2].trim();
  } else {
    return null;
  }

  // Find the module
  const module = modules.find((mod) => {
    const fullModuleName = mod.modulename || mod.name || "";
    const fileName = fullModuleName.split(/[\/\\]/).pop() || fullModuleName;
    return (
      fullModuleName.toLowerCase() === libraryName.toLowerCase() ||
      fileName.toLowerCase() === libraryName.toLowerCase() ||
      fullModuleName.toLowerCase().includes(libraryName.toLowerCase()) ||
      fileName.toLowerCase().includes(libraryName.toLowerCase())
    );
  });

  if (!module) {
    console.warn(`Module "${libraryName}" not found`);
    return null;
  }

  // Search for the function in the symbol cache
  const symbolCache = useUIStore.getState().globalSymbolCache;
  const symbol = symbolCache.symbols.find((s) => {
    // Check if the symbol belongs to this module and matches the function name
    if (s.moduleBase !== module.base) return false;
    // Case-insensitive partial match for function name
    return (
      s.name.toLowerCase().includes(funcName.toLowerCase()) ||
      funcName.toLowerCase().includes(s.name.toLowerCase())
    );
  });

  if (symbol) {
    const address = symbol.address + offset;
    console.log(
      `Decoded library@function expression: "${expression}" -> ${symbol.name} @ 0x${symbol.address.toString(16)} + 0x${offset.toString(16)} = 0x${address.toString(16)}`
    );
    return address;
  }

  console.warn(`Function "${funcName}" not found in module "${libraryName}"`);
  return null;
}

/**
 * Converts a numeric address to a library+offset expression if the address is within a loaded module
 * @param address - The numeric address to encode
 * @param modules - Array of loaded modules with their base addresses
 * @param preferShortName - If true, use only the filename instead of full path (default: true)
 * @returns The library+offset expression or null if address is not within any module
 */
export function encodeAddressToLibraryExpression(
  address: number,
  modules: ModuleInfo[],
  preferShortName: boolean = true
): string | null {
  if (!modules || modules.length === 0 || isNaN(address)) {
    return null;
  }

  // Find the module that contains this address
  for (const module of modules) {
    const moduleBase = module.base;
    const moduleEnd = moduleBase + module.size;

    if (address >= moduleBase && address < moduleEnd) {
      const offset = address - moduleBase;
      const fullModuleName = module.modulename || module.name || "unknown";

      // Use short filename if preferred
      const displayName = preferShortName
        ? fullModuleName.split(/[\/\\]/).pop() || fullModuleName
        : fullModuleName;

      const expression = `${displayName} + 0x${offset.toString(16)}`;

      console.log(
        `Encoded address 0x${address.toString(16)} to library expression: "${expression}"`
      );

      return expression;
    }
  }

  // Address is not within any module
  return null;
}

/**
 * Normalizes an address string to a consistent hex format (0xABCDEF)
 * Supports both direct addresses and library+offset expressions
 * @param addressStr - The address string to normalize (hex address or library+offset)
 * @param modules - Array of loaded modules (required for library+offset expressions)
 * @returns Normalized hex address string or null if invalid
 */
export function normalizeAddressString(
  addressStr: string,
  modules?: ModuleInfo[]
): string | null {
  if (!addressStr) {
    return null;
  }

  const trimmed = addressStr.trim();

  // Check if it's a library+offset or library@function expression
  if (trimmed.includes("+") || trimmed.includes("@")) {
    if (!modules || modules.length === 0) {
      console.warn(
        "Cannot parse library expression without module information"
      );
      return null;
    }

    const decodedAddress = decodeLibraryExpression(trimmed, modules);
    if (decodedAddress === null) {
      return null;
    }

    return `0x${decodedAddress.toString(16)}`;
  }

  // Parse as direct address (hex or decimal)
  let address: number;
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    address = parseInt(trimmed, 16);
  } else if (/^\d+$/.test(trimmed)) {
    // All digits - treat as decimal
    address = parseInt(trimmed, 10);
  } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    // All hex digits without 0x prefix
    address = parseInt(trimmed, 16);
  } else {
    return null;
  }

  if (isNaN(address)) {
    return null;
  }

  return `0x${address.toString(16)}`;
}

/**
 * Checks if a string is a valid library+offset or library@function+offset expression
 * @param expression - The string to check
 * @returns true if the string matches a supported pattern
 */
export function isLibraryExpression(expression: string): boolean {
  if (!expression) {
    return false;
  }

  const trimmed = expression.trim();
  // Match patterns:
  // - "LibraryName + 0xOffset" or "LibraryName+0xOffset" (library + offset)
  // - "lib.so@func + 0x10" or "lib.so@func+0x10" (library@function + offset)
  // - "lib.so@func" (library@function without offset)
  return (
    /^.+?\s*\+\s*(0x[0-9a-fA-F]+|\d+)$/.test(trimmed) ||
    /^.+?@[^+\s]+(\s*\+\s*(0x[0-9a-fA-F]+|\d+))?$/.test(trimmed)
  );
}

/**
 * 非同期版: library@function+offset形式をパースしてアドレスに変換
 * シンボルがキャッシュにない場合はオンデマンドでロードする
 */
async function decodeLibraryFunctionExpressionAsync(
  expression: string,
  modules: ModuleInfo[],
  serverInfo: { ip: string; port: number }
): Promise<number | null> {
  const matchWithOffset = expression.match(
    /^(.+?)@(.+?)\s*\+\s*(0x[0-9a-fA-F]+|\d+)$/
  );
  const matchWithoutOffset = expression.match(/^(.+?)@([^+\s]+)$/);

  let libraryName: string;
  let funcName: string;
  let offset = 0;

  if (matchWithOffset) {
    libraryName = matchWithOffset[1].trim();
    funcName = matchWithOffset[2].trim();
    const offsetStr = matchWithOffset[3].trim();
    if (offsetStr.startsWith("0x") || offsetStr.startsWith("0X")) {
      offset = parseInt(offsetStr, 16);
    } else {
      offset = parseInt(offsetStr, 10);
    }
    if (isNaN(offset)) offset = 0;
  } else if (matchWithoutOffset) {
    libraryName = matchWithoutOffset[1].trim();
    funcName = matchWithoutOffset[2].trim();
  } else {
    return null;
  }

  // Find the module
  const module = modules.find((mod) => {
    const fullModuleName = mod.modulename || mod.name || "";
    const fileName = fullModuleName.split(/[\/\\]/).pop() || fullModuleName;
    return (
      fullModuleName.toLowerCase() === libraryName.toLowerCase() ||
      fileName.toLowerCase() === libraryName.toLowerCase() ||
      fullModuleName.toLowerCase().includes(libraryName.toLowerCase()) ||
      fileName.toLowerCase().includes(libraryName.toLowerCase())
    );
  });

  if (!module) {
    console.warn(`Module "${libraryName}" not found`);
    return null;
  }

  const globalSymbolCache = useUIStore.getState().globalSymbolCache;
  if (!globalSymbolCache.loadedModules.has(module.base)) {
    console.log(`[addressEncoder] Loading symbols for ${libraryName}...`);
    await loadModuleSymbolsOnDemand(serverInfo, module);
  }

  const updatedCache = useUIStore.getState().globalSymbolCache;
  const symbol = updatedCache.symbols.find((s) => {
    if (s.moduleBase !== module.base) return false;
    return (
      s.name.toLowerCase().includes(funcName.toLowerCase()) ||
      funcName.toLowerCase().includes(s.name.toLowerCase())
    );
  });

  if (symbol) {
    const address = symbol.address + offset;
    console.log(
      `Decoded library@function expression: "${expression}" -> ${symbol.name} @ 0x${symbol.address.toString(16)} + 0x${offset.toString(16)} = 0x${address.toString(16)}`
    );
    return address;
  }

  console.warn(`Function "${funcName}" not found in module "${libraryName}"`);
  return null;
}

export async function decodeLibraryExpressionAsync(
  expression: string,
  modules: ModuleInfo[],
  serverInfo: { ip: string; port: number }
): Promise<number | null> {
  if (!expression || !modules || modules.length === 0) {
    return null;
  }

  const trimmed = expression.trim();

  // Check if it's a library@function format
  const atIndex = trimmed.indexOf("@");
  const plusIndex = trimmed.indexOf("+");

  if (atIndex > 0 && (plusIndex === -1 || atIndex < plusIndex)) {
    return decodeLibraryFunctionExpressionAsync(trimmed, modules, serverInfo);
  }

  return decodeLibraryExpression(trimmed, modules);
}

/**
 * @param addressStr
 * @param modules
 * @param serverInfo
 * @returns
 */
export async function normalizeAddressStringAsync(
  addressStr: string,
  modules: ModuleInfo[],
  serverInfo: { ip: string; port: number }
): Promise<string | null> {
  if (!addressStr) {
    return null;
  }

  const trimmed = addressStr.trim();

  // Check if it's a library+offset or library@function expression
  if (trimmed.includes("+") || trimmed.includes("@")) {
    if (!modules || modules.length === 0) {
      console.warn(
        "Cannot parse library expression without module information"
      );
      return null;
    }

    const decodedAddress = await decodeLibraryExpressionAsync(
      trimmed,
      modules,
      serverInfo
    );
    if (decodedAddress === null) {
      return null;
    }

    return `0x${decodedAddress.toString(16)}`;
  }

  return normalizeAddressString(addressStr, modules);
}
