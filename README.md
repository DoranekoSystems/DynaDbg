# DynaDbg

Next-Generation Remote Analysis Suite for Reverse Engineering.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

> 🎉 **Open Source Announcement**  
> This project is open source!  
> ⚠️ **Note:** I am currently not accepting pull requests while I work on code reorganization. Please also refrain from posting code suggestions in Issues. Thank you for your understanding.

> **Motivation**
> Curiosity — nothing more.
> _This project is driven purely by a desire to explore and understand how low-level execution behaves across different systems._
>
> **Goal**
> To visualize low-level execution across multiple operating systems and architectures, assisting reverse engineering analysis and deepening technical understanding.

# Support OS

## Host

- Windows(x86_64)
- Linux(x86_64)
- Mac(arm64)

## Remote

- macOS(arm64)
- Linux(x86_64)
- iOS(arm64)
- Android(arm64)

# Usage

Please refer to the [Wiki](https://github.com/DoranekoSystems/DynaDbg/wiki/Using-DynaDbg) for detailed usage instructions.

# Building

Fork this repository and run the **Build DynaDbg** workflow from the Actions tab to build the application.  
See [Wiki](https://github.com/DoranekoSystems/DynaDbg/wiki/GitHub-Actions) for detailed build options.

# Developing

Please refer to the [Wiki](https://github.com/DoranekoSystems/DynaDbg/wiki/Developing-DynaDbg) for development setup and guidelines.

# Screenshot

<img width="1512" height="1150" alt="" src="https://github.com/user-attachments/assets/114a05f5-b766-409b-98a9-4af003e64683" />

# Function

- Debugger
  <img width="800" height="520" alt="" src="https://github.com/user-attachments/assets/9e2c9953-80e8-4dec-b75a-47f5c9d75d03" />

- Memory Scan
  <img width="756" height="556" alt="" src="https://github.com/user-attachments/assets/4b11a095-bda5-4cc3-a4e5-536058a7853b" />

- Hardware Watchpoint
  <img width="556" height="356" alt="screenshot" src="https://github.com/user-attachments/assets/d4aa5a0a-4a71-4ed8-8160-801d6f92a265" />

- Code Tracing
  <img width="800" height="600" alt="" src="https://github.com/user-attachments/assets/2ee34e74-2b39-4130-908d-3283d0063a6d" />

## Documentation

For detailed technical specifications and implementation details, please refer to:

- [Creating a GUI-based macOS&iOS ARM64 Debugger.pdf](doc/Creating%20a%20GUI-based%20macOS&iOS%20ARM64%20Debugger.pdf)

## Credits

For a full list of dependencies, see [CREDITS.md](CREDITS.md).

### Special Thanks

- [MachOKit](https://github.com/p-x9/MachOKit) by [p-x9](https://github.com/p-x9) - MIT License
