// Sample data for debugger sidebar

export const functionsData = [
  {
    name: 'main',
    address: '0x401000',
    size: 256,
    scope: 'Global',
    type: 'Function'
  },
  {
    name: 'init',
    address: '0x401200',
    size: 128,
    scope: 'Global',
    type: 'Function'
  },
  {
    name: 'cleanup',
    address: '0x401400',
    size: 64,
    scope: 'Local',
    type: 'Function'
  },
  {
    name: 'process_data',
    address: '0x401600',
    size: 512,
    scope: 'Global',
    type: 'Function'
  }
];

export const namesData = [
  {
    name: 'global_var',
    address: '0x402000',
    size: 4,
    type: 'Variable',
    flags: ['Global', 'RW']
  },
  {
    name: 'buffer',
    address: '0x402100',
    size: 1024,
    type: 'Variable',
    flags: ['Local', 'RW']
  },
  {
    name: 'counter',
    address: '0x402200',
    size: 4,
    type: 'Variable',
    flags: ['Static', 'RW']
  }
];

export const importsData = [
  {
    name: 'printf',
    module: 'libc.so.6',
    address: '0x403000',
    type: 'Import'
  },
  {
    name: 'malloc',
    module: 'libc.so.6',
    address: '0x403100',
    type: 'Import'
  },
  {
    name: 'free',
    module: 'libc.so.6',
    address: '0x403200',
    type: 'Import'
  }
];

export const structuresData = [
  {
    name: 'ProcessInfo',
    size: '32 bytes',
    fields: ['pid', 'name', 'status']
  },
  {
    name: 'ModuleInfo',
    size: '48 bytes',
    fields: ['base', 'size', 'name', 'path']
  },
  {
    name: 'MemoryRegion',
    size: '24 bytes',
    fields: ['start', 'end', 'protection']
  }
];
