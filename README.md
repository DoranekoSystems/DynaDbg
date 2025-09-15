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

<img width="1512" height="1112" alt="screenshot" src="https://github.com/user-attachments/assets/35b2d9ae-4102-49f9-af44-ba2859334cda" />

# Function

- Debugger(Coming Soon)
<img width="772" height="556" alt="screenshot" src="https://github.com/user-attachments/assets/84fe1dae-7471-48e9-be53-f0b9a35c8161" />

- Memory Scan
<img width="661" height="548" alt="screenshot" src="https://github.com/user-attachments/assets/10de5089-7496-44e6-b681-de943e711d0b" />

- Hardware Watchpoint
<img width="500" height="356" alt="screenshot" src="https://github.com/user-attachments/assets/15a068cb-e77b-408e-a9e5-2d5482c5adbf" />

## Documentation

For detailed technical specifications and implementation details, please refer to:
- [Creating a GUI-based macOS&iOS ARM64 Debugger.pdf](doc/Creating%20a%20GUI-based%20macOS&iOS%20ARM64%20Debugger.pdf)
