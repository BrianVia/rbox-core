// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "RboxBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "RboxBar", targets: ["RboxBar"])
    ],
    targets: [
        .executableTarget(
            name: "RboxBar",
            path: "Sources/RboxBar",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "RboxBarTests",
            dependencies: ["RboxBar"],
            path: "Tests/RboxBarTests"
        )
    ]
)
