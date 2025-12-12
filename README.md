# DynaDbg
Next-Generation Remote Analysis Suite for Reverse Engineering.  
This project is not open source and remains under private development!

# Support OS

## Host
- Windows(x86_64)
- Linux(x86_64)
- Mac(arm64)

## Remote
- iOS(arm64)  
- Android(arm64)
- Linux(x86_64)
  
# Usage

## iOS

### Run

#### with a Jailbroken iPhone

Place your PC and iphone in the same network.  
Place dbgsrv and Entitlements.plist in /usr/bin.

Connect to the iphone via ssh.

```sh
cd /usr/bin
ldid -SEntitlements.plist dbgsrv
./dbgsrv
```

The httpserver starts at port `3030`.

<img width="1512" height="1150" alt="" src="https://github.com/user-attachments/assets/114a05f5-b766-409b-98a9-4af003e64683" />

# Function

- Debugger
<img width="796" height="556" alt="" src="https://github.com/user-attachments/assets/12d5f41b-78e4-414a-a01c-ef1faec073da" />

- Memory Scan
<img width="756" height="556" alt="" src="https://github.com/user-attachments/assets/4b11a095-bda5-4cc3-a4e5-536058a7853b" />

- Hardware Watchpoint
<img width="556" height="356" alt="screenshot" src="https://github.com/user-attachments/assets/d4aa5a0a-4a71-4ed8-8160-801d6f92a265" />

- Code Tracing
<img width="556" height="406" alt="" src="https://github.com/user-attachments/assets/af605005-43b4-49f1-8ee2-76a21acb71e3" />
  
## Documentation

For detailed technical specifications and implementation details, please refer to:
- [Creating a GUI-based macOS&iOS ARM64 Debugger.pdf](doc/Creating%20a%20GUI-based%20macOS&iOS%20ARM64%20Debugger.pdf)

## Credits

This project uses the following open source libraries:

* [MachOKit](https://github.com/p-x9/MachOKit) by [p-x9](https://github.com/p-x9) - MIT License
