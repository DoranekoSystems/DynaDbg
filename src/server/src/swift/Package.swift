// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "MachOBridge",
    platforms: [
        .macOS(.v10_15),
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "MachOBridge",
            type: .static,
            targets: ["MachOBridge"]
        ),
    ],
    dependencies: [
        .package(path: "../../../MachOKit")
    ],
    targets: [
        .target(
            name: "MachOBridge",
            dependencies: [
                .product(name: "MachOKit", package: "MachOKit")
            ],
            path: "Sources"
        ),
    ]
)
