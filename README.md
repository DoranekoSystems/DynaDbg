# DynaDbg
Next-Generation Remote Analysis Suite for iOS

This project is not open source and remains under private development!

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
