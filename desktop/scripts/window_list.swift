import AppKit
import Foundation
import CoreGraphics
import ApplicationServices

struct WindowInfo: Codable {
    let id: Int
    let owner: String
    let name: String?
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WindowList: Codable {
    let windows: [WindowInfo]
    let requires_accessibility: Bool?
    let requires_screen_recording: Bool?
}

func listCGWindows() -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var windows: [WindowInfo] = []
    for info in infoList {
        let layer = info[kCGWindowLayer as String] as? Int ?? 0
        if layer != 0 {
            continue
        }
        let isOnscreen = info[kCGWindowIsOnscreen as String] as? Bool ?? true
        if !isOnscreen {
            continue
        }
        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
        if owner == "OpenTranslate" {
            continue
        }
        guard let bounds = info[kCGWindowBounds as String] as? [String: Any] else {
            continue
        }
        let x = (bounds["X"] as? Double) ?? 0
        let y = (bounds["Y"] as? Double) ?? 0
        let width = (bounds["Width"] as? Double) ?? 0
        let height = (bounds["Height"] as? Double) ?? 0
        if width < 40 || height < 40 {
            continue
        }
        let windowId = info[kCGWindowNumber as String] as? Int ?? 0
        let name = info[kCGWindowName as String] as? String
        windows.append(
            WindowInfo(
                id: windowId,
                owner: owner,
                name: name,
                x: x,
                y: y,
                width: width,
                height: height
            )
        )
    }
    return windows
}

func listAXWindows() -> [WindowInfo] {
    let trusted = AXIsProcessTrusted()
    if !trusted {
        return []
    }
    var windows: [WindowInfo] = []
    let apps = NSWorkspace.shared.runningApplications
    var counter = 0
    for app in apps {
        if app.activationPolicy != .regular {
            continue
        }
        if app.localizedName == "OpenTranslate" {
            continue
        }
        let pid = app.processIdentifier
        let appElem = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &value)
        if err != .success {
            continue
        }
        guard let windowList = value as? [AXUIElement] else {
            continue
        }
        for window in windowList {
            var posRef: CFTypeRef?
            var sizeRef: CFTypeRef?
            let posErr = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef)
            let sizeErr = AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
            if posErr != .success || sizeErr != .success {
                continue
            }
            guard
                let posRefUnwrapped = posRef,
                let sizeRefUnwrapped = sizeRef,
                CFGetTypeID(posRefUnwrapped) == AXValueGetTypeID(),
                CFGetTypeID(sizeRefUnwrapped) == AXValueGetTypeID()
            else {
                continue
            }
            let posVal = (posRefUnwrapped as! AXValue)
            let sizeVal = (sizeRefUnwrapped as! AXValue)
            var point = CGPoint.zero
            var size = CGSize.zero
            AXValueGetValue(posVal, .cgPoint, &point)
            AXValueGetValue(sizeVal, .cgSize, &size)
            if size.width < 40 || size.height < 40 {
                continue
            }
            counter += 1
            windows.append(
                WindowInfo(
                    id: counter,
                    owner: app.localizedName ?? "",
                    name: nil,
                    x: Double(point.x),
                    y: Double(point.y),
                    width: Double(size.width),
                    height: Double(size.height)
                )
            )
        }
    }
    return windows
}

let screenAllowed = CGPreflightScreenCaptureAccess()
var windows = listCGWindows()
var requiresAccessibility: Bool? = nil
var requiresScreenRecording: Bool? = nil

if !screenAllowed {
    requiresScreenRecording = true
}

if windows.isEmpty && AXIsProcessTrusted() {
    let axWindows = listAXWindows()
    if !axWindows.isEmpty {
        windows = axWindows
    }
}

let output = WindowList(
    windows: windows,
    requires_accessibility: requiresAccessibility,
    requires_screen_recording: requiresScreenRecording
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(output), let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    print("{\"windows\":[]}")
}
