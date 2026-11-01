// jarvis-hands — READ-ONLY macOS observation helper for JARVIS.
//
// This binary can only LOOK. It deliberately contains no way to act on the
// computer: no AXUIElementPerformAction, no AXUIElementSetAttributeValue, no
// CGEvent posting, no NSWorkspace launch/open, no keystrokes, no clicks, no
// menu activation, no file writes. Adding any of those would turn an
// observation tool into remote control, which is a separate, separately
// authorized feature (Hands v2) and MUST NOT be smuggled in here.
//
// Subcommands (all read-only, all print one JSON object on stdout):
//   list-windows              on-screen normal windows, with AX window index
//   read-window <pid> [index] text contents of that window (AX tree walk)
//   read-focused              text contents of the frontmost window
//   window-info <pid> [index]  title + bounds of one window (for OCR crops)
//   ocr <image-path>          Vision OCR of an image the caller captured
//   permissions               whether macOS has granted AX / screen-recording
//   help                      usage
//
// The AX tree is the first source of text; OCR is the fallback for windows
// whose text is not in the accessibility tree (canvas, PDF readers, images) —
// the same AX-then-OCR ladder Atticus uses. OCR reads a file that the caller
// already captured, so it still cannot act on anything.
//
// Exit codes: 0 ok, 1 usage error, 2 observation refused/failed.
//
// Privacy: AXSecureTextField values (passwords) are skipped entirely, so a
// secure field can never be read out of the accessibility tree.

import Foundation
import ApplicationServices
import CoreGraphics
import AppKit
import Vision

// ── Limits (kept small so a huge window cannot blow up the model context) ──
let maxDepth = 8
let maxNodes = 600
let maxTextChars = 12_000

func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
  let payload: [String: Any] = object
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  {
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
    exit(exitCode)
  }
  FileHandle.standardOutput.write(Data(#"{"ok":false,"code":"encode_failed","error":"could not encode result"}"#.utf8))
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(2)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "code": code, "error": message], exitCode: 2)
}

// ── Accessibility helpers ──────────────────────────────────────────────────

func axAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard status == .success else { return nil }
  return value
}

func describe(_ value: CFTypeRef?) -> String? {
  guard let value else { return nil }
  if let text = value as? String {
    return text.isEmpty ? nil : text
  }
  if let number = value as? NSNumber {
    return number.stringValue
  }
  return nil
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  describe(axAttribute(element, attribute))
}

func elementsAttribute(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
  guard let raw = axAttribute(element, attribute), let array = raw as? [AXUIElement] else {
    return []
  }
  return array
}

/// Roles whose VALUE we must never read or report.
let secretRoles: Set<String> = ["AXSecureTextField"]

/// Roles that usually carry user-visible text worth reporting.
let textRoles: Set<String> = [
  "AXStaticText", "AXTextField", "AXTextArea", "AXHeading", "AXButton", "AXCheckBox",
  "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXLink", "AXCell", "AXRow", "AXTab",
  "AXComboBox", "AXSearchField", "AXToggle", "AXIncrementor",
]

struct TextNode {
  let role: String
  let text: String
}

/// Walk the accessibility tree collecting text. Read-only: only
/// CopyAttributeValue is ever used, never PerformAction/SetAttributeValue.
func collectText(
  _ element: AXUIElement,
  depth: Int,
  nodes: inout [TextNode],
  budget: inout Int
) {
  if depth > maxDepth || budget <= 0 { return }

  let role = stringAttribute(element, "AXRole") ?? "AXUnknown"
  if secretRoles.contains(role) { return } // never read secure fields

  budget -= 1

  var pieces: [String] = []
  for attribute in ["AXValue", "AXTitle", "AXDescription", "AXPlaceholderValue"] {
    if let text = stringAttribute(element, attribute), !text.isEmpty {
      pieces.append(text)
    }
  }
  let joined = pieces.joined(separator: " | ")
  if !joined.isEmpty {
    if textRoles.contains(role) || role == "AXUnknown" || joined.count > 1 {
      nodes.append(TextNode(role: role, text: joined))
    }
  }

  for child in elementsAttribute(element, "AXChildren") {
    if budget <= 0 { break }
    collectText(child, depth: depth + 1, nodes: &nodes, budget: &budget)
  }
}

func windowInfo(_ window: AXUIElement, pid: pid_t, index: Int, app: String) -> [String: Any] {
  var info: [String: Any] = [
    "pid": Int(pid),
    "index": index,
    "app": app,
  ]
  if let title = stringAttribute(window, "AXTitle") { info["title"] = title }
  if let subrole = stringAttribute(window, "AXSubrole") { info["subrole"] = subrole }
  if let focused = axAttribute(window, "AXFocused") as? NSNumber {
    info["focused"] = focused.boolValue
  }
  if let position = axAttribute(window, "AXPosition") {
    var point = CGPoint.zero
    if AXValueGetValue(position as! AXValue, .cgPoint, &point) {
      var sizePoint = CGSize.zero
      if let size = axAttribute(window, "AXSize"), AXValueGetValue(size as! AXValue, .cgSize, &sizePoint) {
        info["bounds"] = [
          "x": Int(point.x.rounded()), "y": Int(point.y.rounded()),
          "width": Int(sizePoint.width.rounded()), "height": Int(sizePoint.height.rounded()),
        ]
      }
    }
  }
  return info
}

/// On-screen normal windows from CoreGraphics (pids + app names only; window
/// titles there need Screen Recording, so titles come from AX below).
func onScreenApps() -> [(pid: pid_t, app: String)] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  var seen = Set<pid_t>()
  var apps: [(pid_t, String)] = []
  for entry in raw {
    guard let layer = entry[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0 else { continue }
    guard let pidNumber = entry[kCGWindowOwnerPID as String] as? NSNumber else { continue }
    let pid = pid_t(pidNumber.int32Value)
    if seen.contains(pid) { continue }
    seen.insert(pid)
    let app = (entry[kCGWindowOwnerName as String] as? String) ?? "unknown"
    apps.append((pid, app))
  }
  return apps
}

func axWindows(pid: pid_t) -> [AXUIElement] {
  let app = AXUIElementCreateApplication(pid)
  return elementsAttribute(app, "AXWindows")
}

func listWindows() -> Never {
  let trusted = AXIsProcessTrusted()
  var windows: [[String: Any]] = []
  for (pid, app) in onScreenApps() {
    let list = axWindows(pid: pid)
    if list.isEmpty {
      // No AX access (permission not granted, or the app exposes no windows).
      windows.append(["pid": Int(pid), "app": app, "index": NSNull(), "ax": false])
      continue
    }
    for (index, window) in list.enumerated() {
      var info = windowInfo(window, pid: pid, index: index, app: app)
      info["ax"] = true
      windows.append(info)
    }
  }
  var result: [String: Any] = [
    "ok": true,
    "tool": "list-windows",
    "count": windows.count,
    "accessibility": trusted,
    "windows": windows,
  ]
  if !trusted {
    result["note"] =
      "Accessibility permission is not granted to jarvis-hands: window titles and text are unavailable. Grant it in System Settings → Privacy & Security → Accessibility."
  }
  emit(result)
}

func textResult(tool: String, window: AXUIElement, header: [String: Any]) -> Never {
  var nodes: [TextNode] = []
  var budget = maxNodes
  collectText(window, depth: 0, nodes: &nodes, budget: &budget)

  var text = nodes.map { $0.text }.joined(separator: "\n")
  var truncated = false
  if text.count > maxTextChars {
    text = String(text.prefix(maxTextChars))
    truncated = true
  }
  var result: [String: Any] = header
  result["ok"] = true
  result["tool"] = tool
  result["nodeCount"] = nodes.count
  result["truncated"] = truncated
  result["text"] = text
  emit(result)
}

func readWindow(pid: pid_t, index: Int) -> Never {
  guard AXIsProcessTrusted() else {
    fail(
      "accessibility_denied",
      "macOS has not granted Accessibility permission to jarvis-hands; window contents cannot be read. Grant it in System Settings → Privacy & Security → Accessibility."
    )
  }
  let windows = axWindows(pid: pid)
  guard !windows.isEmpty else {
    fail("no_windows", "process \(pid) exposes no accessibility windows (or is not running)")
  }
  guard index >= 0 && index < windows.count else {
    fail("bad_index", "window index \(index) is out of range (process \(pid) has \(windows.count))")
  }
  let window = windows[index]
  var header: [String: Any] = ["pid": Int(pid), "index": index]
  if let title = stringAttribute(window, "AXTitle") { header["title"] = title }
  textResult(tool: "read-window", window: window, header: header)
}

func readFocused() -> Never {
  guard AXIsProcessTrusted() else {
    fail(
      "accessibility_denied",
      "macOS has not granted Accessibility permission to jarvis-hands; window contents cannot be read. Grant it in System Settings → Privacy & Security → Accessibility."
    )
  }
  let systemWide = AXUIElementCreateSystemWide()
  guard let focusedAppRaw = axAttribute(systemWide, "AXFocusedApplication") else {
    fail("no_focused_app", "no application currently has focus (or it is not observable)")
  }
  let focusedApp = focusedAppRaw as! AXUIElement
  guard let focusedWindowRaw = axAttribute(focusedApp, "AXFocusedWindow") else {
    fail("no_focused_window", "the focused application has no focused window")
  }
  let window = focusedWindowRaw as! AXUIElement
  var header: [String: Any] = [:]
  if let title = stringAttribute(window, "AXTitle") { header["title"] = title }
  if let appName = stringAttribute(focusedApp, "AXTitle") { header["app"] = appName }
  // The focused element is reported by role and text only (secure fields are
  // skipped inside collectText, and the focused element itself is checked here).
  if let focusedElementRaw = axAttribute(focusedApp, "AXFocusedUIElement") {
    let element = focusedElementRaw as! AXUIElement
    let role = stringAttribute(element, "AXRole") ?? ""
    if !secretRoles.contains(role) {
      header["focusedRole"] = role
      if let value = stringAttribute(element, "AXValue"), !value.isEmpty {
        header["focusedValue"] = String(value.prefix(500))
      }
    }
  }
  textResult(tool: "read-focused", window: window, header: header)
}

/// Title/bounds of one window. Used by the caller to crop a screenshot for OCR
/// without a second list-windows round trip.
func windowInfoFor(pid: pid_t, index: Int) -> Never {
  guard AXIsProcessTrusted() else {
    fail(
      "accessibility_denied",
      "macOS has not granted Accessibility permission to jarvis-hands; window geometry cannot be read. Grant it in System Settings → Privacy & Security → Accessibility."
    )
  }
  let windows = axWindows(pid: pid)
  guard !windows.isEmpty else { fail("no_windows", "process \(pid) exposes no accessibility windows") }
  guard index >= 0 && index < windows.count else {
    fail("bad_index", "window index \(index) is out of range (process \(pid) has \(windows.count))")
  }
  let app = AXUIElementCreateApplication(pid)
  let appName = stringAttribute(app, "AXTitle") ?? "unknown"
  var info = windowInfo(windows[index], pid: pid, index: index, app: appName)
  info["ok"] = true
  info["tool"] = "window-info"
  emit(info)
}

/// OCR an image file with Apple's Vision framework.
///
/// This is still observation: it reads pixels from a file that the caller
/// captured. It cannot click, type or write anything.
func ocr(path: String) -> Never {
  guard let image = NSImage(contentsOfFile: path) else {
    fail("ocr_failed", "could not open \(path) as an image")
  }
  var rect = CGRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fail("ocr_failed", "could not decode \(path)")
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  // Bounded so a huge image cannot stall the turn.
  request.recognitionLanguages = ["en-US"]

  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request])
  } catch {
    fail("ocr_failed", "text recognition failed: \(error.localizedDescription)")
  }

  var lines: [String] = []
  for observation in request.results ?? [] {
    if let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty {
      lines.append(candidate.string)
    }
  }
  var text = lines.joined(separator: "\n")
  var truncated = false
  if text.count > maxTextChars {
    text = String(text.prefix(maxTextChars))
    truncated = true
  }
  var result: [String: Any] = [
    "ok": true,
    "tool": "ocr",
    "lines": lines.count,
    "truncated": truncated,
    "text": text,
    "source": "ocr",
  ]
  if lines.isEmpty {
    result["note"] = "No text was recognized in that image (it may be a picture, chart or video)."
  }
  emit(result)
}

/// Ask macOS to show the permission prompts for this binary.
/// Prompts are attributable to jarvis-hands, not to the app that launched it,
/// because TCC tracks the binary that calls the API.
func requestPermission() -> Never {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(options)
  let screen = CGRequestScreenCaptureAccess()
  emit([
    "ok": true,
    "tool": "request-permission",
    "accessibility": accessibility,
    "screenRecording": screen,
    "note": accessibility && screen
      ? "Both permissions are already granted."
      : "macOS is showing (or has shown) the prompts. If no dialog appeared, open System Settings → Privacy & Security and enable jarvis-hands under Accessibility and Screen Recording.",
  ])
}

func permissions() -> Never {
  let accessibility = AXIsProcessTrusted()
  let screenRecording = CGPreflightScreenCaptureAccess()
  emit([
    "ok": true,
    "tool": "permissions",
    "accessibility": accessibility,
    "screenRecording": screenRecording,
    "note": accessibility
      ? "Accessibility is granted; window titles and text are readable."
      : "Accessibility is NOT granted; window contents cannot be read. System Settings → Privacy & Security → Accessibility → enable jarvis-hands.",
  ])
}

func usage() -> Never {
  let text = """
  jarvis-hands — read-only observation helper (no control of any kind)

  Usage:
    jarvis-hands list-windows
    jarvis-hands read-window <pid> [index]
    jarvis-hands read-focused
    jarvis-hands window-info <pid> [index]
    jarvis-hands ocr <image-path>
    jarvis-hands permissions
    jarvis-hands request-permission
    jarvis-hands help

  Print all results as a single JSON object on stdout.
  """
  FileHandle.standardOutput.write(Data((text + "\n").utf8))
  exit(0)
}

// ── Entry point ────────────────────────────────────────────────────────────
let arguments = CommandLine.arguments
guard arguments.count >= 2 else { usage() }

switch arguments[1] {
case "list-windows":
  listWindows()
case "read-window":
  guard arguments.count >= 3, let pid = pid_t(arguments[2]) else {
    fail("usage", "read-window requires a numeric process id")
  }
  // (usage errors are reported with the same JSON shape; unknown commands
  //  and refused observations also exit non-zero so callers can branch)
  var index = 0
  if arguments.count >= 4 {
    guard let parsed = Int(arguments[3]), parsed >= 0 else {
      fail("usage", "window index must be a non-negative integer")
    }
    index = parsed
  }
  readWindow(pid: pid, index: index)
case "read-focused":
  readFocused()
case "window-info":
  guard arguments.count >= 3, let pid = pid_t(arguments[2]) else {
    fail("usage", "window-info requires a numeric process id")
  }
  var infoIndex = 0
  if arguments.count >= 4 {
    guard let parsed = Int(arguments[3]), parsed >= 0 else {
      fail("usage", "window index must be a non-negative integer")
    }
    infoIndex = parsed
  }
  windowInfoFor(pid: pid, index: infoIndex)
case "ocr":
  guard arguments.count >= 3 else { fail("usage", "ocr requires an image path") }
  ocr(path: arguments[2])

case "permissions":
  permissions()
case "request-permission", "request-permissions":
  requestPermission()
case "help", "--help", "-h":
  usage()
default:
  fail("unknown_command", "unknown command: \(arguments[1]) — run jarvis-hands help")
}
