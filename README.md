# DynaDbg
Next-Generation Remote Analysis Suite for iOS.  
This project is not open source and remains under private development!

# Support OS

## Host
- Windows(x86_64)
- Mac(arm64)

## Remote
- iOS(arm64)
  
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

<img width="1512" height="1112" alt="screenshot" src="https://github.com/user-attachments/assets/52e88782-35f7-4294-b0d7-48b3f2b8b6cb" />

# Function

- Debugger
<img width="906" height="556" alt="screenshot" src="https://github.com/user-attachments/assets/75aef088-e588-4128-ae21-5401cd3a8610" />

- Memory Scan
<img width="756" height="556" alt="screenshot" src="https://github.com/user-attachments/assets/a1a08b57-2cc6-43c4-b7d1-c17d1b176bc3" />

- Hardware Watchpoint
<img width="556" height="356" alt="screenshot" src="https://github.com/user-attachments/assets/d4aa5a0a-4a71-4ed8-8160-801d6f92a265" />

## Documentation

For detailed technical specifications and implementation details, please refer to:
- [Creating a GUI-based macOS&iOS ARM64 Debugger.pdf](doc/Creating%20a%20GUI-based%20macOS&iOS%20ARM64%20Debugger.pdf)
