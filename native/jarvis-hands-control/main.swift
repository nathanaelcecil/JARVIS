// jarvis-hands-control — macOS CONTROL helper for JARVIS (Hands v2).
//
// This binary CAN act on the computer: click, type, press keys, scroll, drag,
// activate menus, move/resize windows. It is deliberately a SEPARATE binary
// from `jarvis-hands` (observation), and installed separately, so that:
//
//   • the observation helper stays provably read-only (its own test asserts it
//     contains no control API), and
//   • macOS grants those two capabilities independently — revoking control in
//     System Settings → Accessibility does not blind JARVIS, and granting
//     observation does not silently grant control.
//
// Every subcommand prints exactly one JSON object on stdout.
// Exit codes: 0 ok, 1 usage error, 2 refused / failed / no permission.
//
// Safety properties enforced HERE (not only in the TypeScript caller):
//   • refuses everything unless Accessibility is granted (accessibility_denied)
//   • never types into an AXSecureTextField (secure_field_refused)
//   • refuses to guess when a label matches several controls (ambiguous)
//   • key chords and menu paths are parsed against a fixed grammar; unknown
//     key names are rejected rather than passed through
//   • text is capped, coordinates are sanity-checked against real screen
//     bounds, menu depth is capped
//   • no shell, no Process/NSTask, no file writes, no network
//
// Privacy: AXSecureTextField values are never read, matched or echoed.

import Foundation
import ApplicationServices
import AppKit
import CoreGraphics

// ── Limits ────────────────────────────────────────────────────────────────
let maxTextChars = 4000
let maxDepth = 12
let maxNodes = 3000
let maxMenuDepth = 6
let maxRepeat = 10

// ── Output ────────────────────────────────────────────────────────────────
func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  {
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
    exit(exitCode)
  }
  FileHandle.standardOutput.write(
    Data(#"{"ok":false,"code":"encode_failed","error":"could not encode result"}"#.utf8))
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(2)
}

func fail(_ code: String, _ message: String, extra: [String: Any] = [:]) -> Never {
  var payload: [String: Any] = ["ok": false, "code": code, "error": message]
  for (key, value) in extra { payload[key] = value }
  emit(payload, exitCode: code == "usage" ? 1 : 2)
}

// ── Argument parsing (argv only; never a shell) ───────────────────────────
func flagValue(_ args: [String], _ flag: String) -> String? {
  guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func hasFlag(_ args: [String], _ flag: String) -> Bool { args.contains(flag) }

func intFlag(_ args: [String], _ flag: String) -> Int? {
  guard let raw = flagValue(args, flag) else { return nil }
  guard let value = Int(raw) else { fail("usage", "\(flag) requires an integer") }
  return value
}

func requirePid(_ args: [String]) -> pid_t {
  guard let raw = flagValue(args, "--pid"), let value = Int32(raw), value > 0 else {
    fail("usage", "a positive --pid is required")
  }
  guard NSRunningApplication(processIdentifier: value) != nil else {
    fail("no_such_app", "no process with pid \(value) is running")
  }
  return pid_t(value)
}

// ── Permission ────────────────────────────────────────────────────────────
func requireAccessibility() {
  guard AXIsProcessTrusted() else {
    fail(
      "accessibility_denied",
      "macOS has not granted Accessibility permission to jarvis-hands-control; JARVIS cannot control apps. Grant it in System Settings → Privacy & Security → Accessibility."
    )
  }
}

// ── AX primitives ─────────────────────────────────────────────────────────
func axAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}

func describe(_ value: CFTypeRef?) -> String? {
  guard let value else { return nil }
  if let text = value as? String { return text.isEmpty ? nil : text }
  if let number = value as? NSNumber { return number.stringValue }
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

let secretRoles: Set<String> = ["AXSecureTextField"]

func frame(of element: AXUIElement) -> CGRect? {
  guard let positionRaw = axAttribute(element, "AXPosition"),
    let sizeRaw = axAttribute(element, "AXSize")
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionRaw as! AXValue, .cgPoint, &point),
    AXValueGetValue(sizeRaw as! AXValue, .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String]
  else { return [] }
  return list
}

func windows(ofPid pid: pid_t) -> [AXUIElement] {
  elementsAttribute(AXUIElementCreateApplication(pid), "AXWindows")
}

/// A control we can address by name.
struct Candidate {
  let element: AXUIElement
  let role: String
  let label: String
  let frame: CGRect?
  var score: Int
}

func candidateLabels(_ element: AXUIElement, role: String) -> [String] {
  var raw: [String] = []
  for attribute in ["AXTitle", "AXDescription", "AXHelp", "AXIdentifier"] {
    if let text = stringAttribute(element, attribute) { raw.append(text) }
  }
  // Secure fields: match by title/description only, never by value.
  if !secretRoles.contains(role), let value = stringAttribute(element, "AXValue") {
    raw.append(value)
  }
  return raw
}

func collectCandidates(
  _ element: AXUIElement, query: [String], role wanted: String?, depth: Int,
  budget: inout Int, out: inout [Candidate]
) {
  if depth > maxDepth || budget <= 0 { return }
  budget -= 1

  let role = stringAttribute(element, "AXRole") ?? "AXUnknown"
  let labels = candidateLabels(element, role: role)
  if !labels.isEmpty {
    let lowered = labels.map { $0.lowercased() }
    var score = 0
    if query.allSatisfy({ term in lowered.contains { $0.trimmingCharacters(in: .whitespaces) == term } })
      && query.count == 1
    {
      score = 3 // exact
    } else if query.allSatisfy({ term in lowered.contains { $0.contains(term) } }) {
      score = 2 // every word appears
    }
    if score > 0, wanted == nil || wanted == role {
      out.append(
        Candidate(
          element: element, role: role,
          label: labels.first ?? "", frame: frame(of: element), score: score))
    }
  }

  for child in elementsAttribute(element, "AXChildren") {
    if budget <= 0 { break }
    collectCandidates(
      child, query: query, role: wanted, depth: depth + 1, budget: &budget, out: &out)
  }
}

func normalize(_ text: String) -> [String] {
  text.lowercased().split(whereSeparator: { $0 == " " || $0 == "\t" })
    .map { String($0) }.filter { !$0.isEmpty }
}

/// Resolve a label to exactly one control, or fail loudly. Never guesses.
func resolveTarget(
  pid: pid_t, label: String, role: String?, near: String?, windowIndex: Int
) -> Candidate {
  let allWindows = windows(ofPid: pid)
  guard !allWindows.isEmpty else {
    fail("no_windows", "process \(pid) exposes no accessibility windows")
  }
  guard windowIndex >= 0 && windowIndex < allWindows.count else {
    fail("bad_index", "window index \(windowIndex) is out of range (process \(pid) has \(allWindows.count))")
  }

  var budget = maxNodes
  var candidates: [Candidate] = []
  collectCandidates(
    allWindows[windowIndex], query: normalize(label), role: role, depth: 0, budget: &budget,
    out: &candidates)

  guard !candidates.isEmpty else {
    fail(
      "not_found",
      "no control matching \"\(label)\"\(role.map { " with role \($0)" } ?? "") in that window. Use control_map to see addressable controls, or click by coordinates."
    )
  }

  // Rank: exact beats partial; then prefer the smallest (most specific) frame.
  let best = candidates.map { $0.score }.max() ?? 0
  var top = candidates.filter { $0.score == best }
  top.sort { lhs, rhs in
    let la = lhs.frame.map { $0.width * $0.height } ?? .greatestFiniteMagnitude
    let ra = rhs.frame.map { $0.width * $0.height } ?? .greatestFiniteMagnitude
    return la < ra
  }

  if top.count > 1, let near, best < 3 {
    // Disambiguate by proximity to another named control.
    var nearBudget = maxNodes
    var anchors: [Candidate] = []
    collectCandidates(
      allWindows[windowIndex], query: normalize(near), role: nil, depth: 0, budget: &nearBudget,
      out: &anchors)
    if let anchor = anchors.first, let anchorFrame = anchor.frame {
      top.sort { lhs, rhs in
        let dl = lhs.frame.map { hypot($0.midX - anchorFrame.midX, $0.midY - anchorFrame.midY) }
        let dr = rhs.frame.map { hypot($0.midX - anchorFrame.midX, $0.midY - anchorFrame.midY) }
        return (dl ?? .greatestFiniteMagnitude) < (dr ?? .greatestFiniteMagnitude)
      }
      if top.count > 1, let firstDistance = top[0].frame.map({ hypot($0.midX - anchorFrame.midX, $0.midY - anchorFrame.midY) }),
        let secondDistance = top[1].frame.map({ hypot($0.midX - anchorFrame.midX, $0.midY - anchorFrame.midY) }),
        abs(firstDistance - secondDistance) < 40
      {
        failAmbiguous(label, top)
      }
      return top[0]
    }
  }

  if top.count > 1 { failAmbiguous(label, top) }
  return top[0]
}

func failAmbiguous(_ label: String, _ candidates: [Candidate]) -> Never {
  let options: [[String: Any]] = candidates.prefix(5).map { candidate in
    var entry: [String: Any] = [
      "role": candidate.role,
      "label": String(candidate.label.prefix(80)),
    ]
    if let frame = candidate.frame {
      entry["x"] = Int(frame.midX)
      entry["y"] = Int(frame.midY)
    }
    return entry
  }
  fail(
    "ambiguous",
    "\(candidates.count) controls match \"\(label)\". Ask the user which one, narrow the label, or click exact coordinates from candidates.",
    extra: ["candidates": options])
}

// ── Synthetic input ───────────────────────────────────────────────────────
func post(_ event: CGEvent?, to pid: pid_t?, global: Bool) {
  guard let event else { return }
  if let pid, !global {
    event.postToPid(pid)
  } else {
    event.post(tap: .cghidEventTap)
  }
}

/// Screen bounds union, used to reject nonsensical coordinates.
func screensUnion() -> CGRect {
  var rect = CGRect.null
  for screen in NSScreen.screens { rect = rect.union(screen.frame) }
  return rect.isNull ? CGRect(x: 0, y: 0, width: 4096, height: 4096) : rect
}

func checkPoint(_ x: Int, _ y: Int) {
  let bounds = screensUnion().insetBy(dx: -4, dy: -4)
  guard bounds.contains(CGPoint(x: x, y: y)) else {
    fail(
      "bad_coordinates",
      "(\(x),\(y)) is outside every display (screen space is \(Int(bounds.width))×\(Int(bounds.height)) at \(Int(bounds.minX)),\(Int(bounds.minY)))"
    )
  }
}

func clickAt(_ point: CGPoint, button: CGMouseButton, count: Int, pid: pid_t?, global: Bool) {
  let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
  let source = CGEventSource(stateID: .hidSystemState)
  for click in 1...max(1, count) {
    let downEvent = CGEvent(
      mouseEventSource: source, mouseType: down, mouseCursorPosition: point, mouseButton: button)
    downEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    post(downEvent, to: pid, global: global)
    usleep(15_000)
    let upEvent = CGEvent(
      mouseEventSource: source, mouseType: up, mouseCursorPosition: point, mouseButton: button)
    upEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    post(upEvent, to: pid, global: global)
    usleep(60_000)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
  "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
  "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51,
  "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125,
  "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "forwarddelete": 117, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
  "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
  "shift": .maskShift, "alt": .maskAlternate, "opt": .maskAlternate,
  "option": .maskAlternate, "ctrl": .maskControl, "control": .maskControl,
  "fn": .maskSecondaryFn,
]

func parseChord(_ chord: String) -> (CGKeyCode, CGEventFlags) {
  let parts = chord.lowercased().split(separator: "+").map {
    $0.trimmingCharacters(in: .whitespaces)
  }
  guard let keyName = parts.last, !keyName.isEmpty else {
    fail("usage", "key chord is empty")
  }
  guard let code = keyCodes[keyName] else {
    fail(
      "unknown_key",
      "unknown key \"\(keyName)\". Known keys: letters, digits, return, tab, space, delete, escape, arrows, home/end, pageup/pagedown, f1-f12 and common punctuation."
    )
  }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    guard let flag = modifierFlags[modifier] else {
      fail(
        "unknown_modifier",
        "unknown modifier \"\(modifier)\". Use cmd, shift, alt/opt, ctrl or fn.")
    }
    flags.insert(flag)
  }
  return (code, flags)
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t?, global: Bool) {
  let source = CGEventSource(stateID: .hidSystemState)
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  down?.flags = flags
  post(down, to: pid, global: global)
  usleep(12_000)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  up?.flags = flags
  post(up, to: pid, global: global)
}

/// Type literal text. Unicode travels in one event per short run, newlines as
/// real Return key presses so multi-line fields behave.
func typeText(_ text: String, pid: pid_t?, global: Bool) {
  guard text.count <= maxTextChars else {
    fail("text_too_long", "text is \(text.count) characters; the limit is \(maxTextChars)")
  }
  let source = CGEventSource(stateID: .hidSystemState)
  let lines = text.components(separatedBy: "\n")
  for (index, line) in lines.enumerated() {
    if !line.isEmpty {
      // Split into small runs: some apps drop very large unicode payloads.
      var remaining = Array(line.utf16)
      while !remaining.isEmpty {
        let chunk = Array(remaining.prefix(20))
        remaining.removeFirst(chunk.count)
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(event, to: pid, global: global)
        usleep(8_000)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(up, to: pid, global: global)
        usleep(4_000)
      }
    }
    if index < lines.count - 1 {
      postKey(36, flags: [], pid: pid, global: global)
      usleep(10_000)
    }
  }
}

// ── Subcommands ───────────────────────────────────────────────────────────

func clickCommand(_ args: [String]) -> Never {
  let pid = requirePid(args)
  let pidValue = pid_t(pid)
  let global = hasFlag(args, "--global")
  let double = hasFlag(args, "--double")
  let right = hasFlag(args, "--right")
  let count = double ? 2 : 1
  let button: CGMouseButton = right ? .right : .left

  if let x = intFlag(args, "--x"), let y = intFlag(args, "--y") {
    checkPoint(x, y)
    requireAccessibility()
    let point = CGPoint(x: x, y: y)
    clickAt(point, button: button, count: count, pid: pidValue, global: global)
    return emit([
      "ok": true, "tool": "click", "mode": "coordinates", "x": x, "y": y,
      "button": right ? "right" : "left", "clicks": count,
      "delivery": global ? "pointer" : "background",
      "note": "A click is not success: read the window again to confirm it did what was asked.",
    ])
  }

  guard let label = flagValue(args, "--label") else {
    fail("usage", "click needs either --label <text> or --x and --y")
  }
  requireAccessibility()
  let target = resolveTarget(
    pid: pidValue, label: label, role: flagValue(args, "--role"),
    near: flagValue(args, "--near"), windowIndex: intFlag(args, "--window-index") ?? 0)

  var method = "event"
  if !double && !right && actionNames(target.element).contains(kAXPressAction as String) {
    // AXPress is the most reliable path and needs no pointer movement.
    if AXUIElementPerformAction(target.element, kAXPressAction as CFString) == .success {
      method = "axpress"
    }
  }
  if method == "event" {
    guard let frame = target.frame else {
      fail("no_frame", "\"\(label)\" has no on-screen frame; click it by coordinates or use a different label.")
    }
    clickAt(CGPoint(x: frame.midX, y: frame.midY), button: button, count: count, pid: pidValue, global: global)
  }

  var result: [String: Any] = [
    "ok": true, "tool": "click", "mode": "label", "label": label,
    "role": target.role, "method": method, "clicks": count,
    "button": right ? "right" : "left",
    "note": "A click is not success: read the window again to confirm it did what was asked.",
  ]
  if let frame = target.frame {
    result["frame"] = [
      "x": Int(frame.minX), "y": Int(frame.minY),
      "width": Int(frame.width), "height": Int(frame.height),
    ]
  }
  emit(result)
}

func typeCommand(_ args: [String]) -> Never {
  guard let text = flagValue(args, "--text") else { fail("usage", "type requires --text") }
  guard text.count <= maxTextChars else {
    fail("text_too_long", "text is \(text.count) characters; the limit is \(maxTextChars)")
  }
  requireAccessibility()
  let global = hasFlag(args, "--global")

  var pid: pid_t? = nil
  var target: Candidate? = nil
  if let raw = flagValue(args, "--pid") {
    guard let value = Int32(raw), value > 0 else { fail("usage", "--pid requires a positive integer") }
    pid = pid_t(value)
    if let label = flagValue(args, "--label") {
      target = resolveTarget(
        pid: pid!, label: label, role: flagValue(args, "--role"),
        near: nil, windowIndex: intFlag(args, "--window-index") ?? 0)
      if secretRoles.contains(target!.role) {
        fail("secure_field_refused", "refusing to type into a secure password field")
      }
      // Focus the field so keystrokes land in it.
      AXUIElementSetAttributeValue(target!.element, "AXFocusedAttribute" as CFString, kCFBooleanTrue)
      usleep(80_000)
    }
  }

  typeText(text, pid: pid, global: global)
  if hasFlag(args, "--submit") {
    usleep(60_000)
    postKey(36, flags: [], pid: pid, global: global)
  }
  emit([
    "ok": true, "tool": "type", "characters": text.count,
    "label": flagValue(args, "--label") ?? NSNull(),
    "role": target?.role ?? NSNull(),
    "submitted": hasFlag(args, "--submit"),
    "note": "Typing is not success: read the field or window back to confirm the text arrived.",
  ])
}

func keyCommand(_ args: [String]) -> Never {
  guard let chord = flagValue(args, "--combo") else { fail("usage", "key requires --combo") }
  let (code, flags) = parseChord(chord)
  let times = intFlag(args, "--times") ?? 1
  guard times >= 1 && times <= maxRepeat else {
    fail("usage", "--times must be between 1 and \(maxRepeat)")
  }
  requireAccessibility()
  let pid = flagValue(args, "--pid").flatMap { Int32($0) }.map { pid_t($0) }
  let global = hasFlag(args, "--global")
  for _ in 1...times {
    postKey(code, flags: flags, pid: pid, global: global)
    usleep(40_000)
  }
  emit([
    "ok": true, "tool": "key", "combo": chord, "times": times,
    "delivery": pid != nil && !global ? "background" : "pointer",
  ])
}

func scrollCommand(_ args: [String]) -> Never {
  guard let dy = intFlag(args, "--dy") ?? intFlag(args, "--dx") else {
    fail("usage", "scroll requires --dy (and optionally --dx)")
  }
  let dx = intFlag(args, "--dx") ?? 0
  let pid = flagValue(args, "--pid").flatMap { Int32($0) }.map { pid_t($0) }
  let global = hasFlag(args, "--global")
  requireAccessibility()
  let source = CGEventSource(stateID: .hidSystemState)

  if let x = intFlag(args, "--x"), let y = intFlag(args, "--y") {
    checkPoint(x, y)
    // Park the pointer over the target when scrolling a specific spot.
    let move = CGEvent(
      mouseEventSource: source, mouseType: .mouseMoved,
      mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    post(move, to: pid, global: true)
    usleep(30_000)
  }

  // Pixel units: the same sign convention as a trackpad (positive = up).
  let wheel = CGEvent(
    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy),
    wheel2: Int32(dx), wheel3: 0)
  post(wheel, to: pid, global: global)
  emit([
    "ok": true, "tool": "scroll", "dx": dx, "dy": dy,
    "note": "Scrolling is not success: read the window to confirm the right part is visible.",
  ])
}

func dragCommand(_ args: [String]) -> Never {
  guard let from = flagValue(args, "--from"), let to = flagValue(args, "--to") else {
    fail("usage", "drag requires --from x,y and --to x,y")
  }
  func point(_ raw: String) -> CGPoint {
    let parts = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    guard parts.count == 2, let x = Int(parts[0]), let y = Int(parts[1]) else {
      fail("usage", "coordinates must look like x,y (got \"\(raw)\")")
    }
    checkPoint(x, y)
    return CGPoint(x: x, y: y)
  }
  let start = point(from)
  let end = point(to)
  requireAccessibility()
  let pid = flagValue(args, "--pid").flatMap { Int32($0) }.map { pid_t($0) }
  let global = hasFlag(args, "--global") || pid == nil
  let source = CGEventSource(stateID: .hidSystemState)

  post(
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left),
    to: pid, global: global)
  usleep(60_000)
  for step in 1...10 {
    let fraction = CGFloat(step) / 10
    let point = CGPoint(
      x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
    post(
      CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left),
      to: pid, global: global)
    usleep(25_000)
  }
  post(
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left),
    to: pid, global: global)
  emit([
    "ok": true, "tool": "drag",
    "from": ["x": Int(start.x), "y": Int(start.y)],
    "to": ["x": Int(end.x), "y": Int(end.y)],
  ])
}

func menuCommand(_ args: [String]) -> Never {
  guard let path = flagValue(args, "--path") else {
    fail("usage", "menu requires --path \"File>Export>PDF\"")
  }
  let segments = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
  guard !segments.isEmpty && segments.count <= maxMenuDepth else {
    fail("usage", "menu path must have 1–\(maxMenuDepth) segments separated by >")
  }
  let pid = requirePid(args)
  requireAccessibility()

  let app = AXUIElementCreateApplication(pid)
  guard let menuBarRaw = axAttribute(app, "AXMenuBar") else {
    fail("no_menu_bar", "process \(pid) exposes no menu bar (it may be a background-only app)")
  }
  let menuBar = menuBarRaw as! AXUIElement

  var container = menuBar
  var trail: [String] = []
  for (index, segment) in segments.enumerated() {
    let isLast = index == segments.count - 1
    var budget = 400
    var matches: [Candidate] = []
    collectCandidates(
      container, query: normalize(segment), role: isLast ? "AXMenuItem" : "AXMenuBarItem",
      depth: 0, budget: &budget, out: &matches)
    if matches.isEmpty {
      var available: [String] = []
      for child in elementsAttribute(container, "AXChildren") {
        if let title = stringAttribute(child, "AXTitle") { available.append(title) }
      }
      fail(
        "menu_path_not_found",
        "no menu item \"\(segment)\" at this level",
        extra: ["level": index, "trail": trail, "available": Array(available.prefix(20))])
    }
    let target = matches[0]
    trail.append(target.label)
    if AXUIElementPerformAction(target.element, kAXPressAction as CFString) != .success {
      fail("menu_press_failed", "could not activate \"\(target.label)\"", extra: ["trail": trail])
    }
    usleep(120_000)
    // The submenu lives in the first AXMenu child of the item.
    if !isLast {
      guard let menu = elementsAttribute(target.element, "AXChildren").first else {
        fail("menu_path_not_found", "\"\(target.label)\" opened no submenu", extra: ["trail": trail])
      }
      container = menu
    }
  }
  emit([
    "ok": true, "tool": "menu", "path": trail,
    "note": "A menu activation is not success on its own: read the window again to confirm the effect.",
  ])
}

func placeCommand(_ args: [String]) -> Never {
  let pid = requirePid(args)
  let where_ = (flagValue(args, "--where") ?? "center").lowercased()
  guard ["left", "right", "full", "fullscreen", "center"].contains(where_) else {
    fail("usage", "--where must be left, right, full, fullscreen or center")
  }
  requireAccessibility()
  let screenIndex = intFlag(args, "--screen") ?? 0
  guard screenIndex >= 0 && screenIndex < NSScreen.screens.count else {
    fail("bad_screen", "screen \(screenIndex) does not exist (\(NSScreen.screens.count) displays)")
  }
  let screen = NSScreen.screens[screenIndex]
  let visible = screen.visibleFrame
  // AppKit's origin is bottom-left; AX and CGEvent use top-left. Convert.
  let primaryHeight = NSScreen.screens[0].frame.height
  func flip(_ rect: NSRect) -> CGRect {
    CGRect(
      x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
  }
  let area = flip(visible)
  let full = flip(screen.frame)

  let allWindows = windows(ofPid: pid)
  guard !allWindows.isEmpty else { fail("no_windows", "process \(pid) exposes no windows") }
  let windowIndex = intFlag(args, "--window-index") ?? 0
  guard windowIndex >= 0 && windowIndex < allWindows.count else {
    fail("bad_index", "window index \(windowIndex) is out of range")
  }
  let window = allWindows[windowIndex]

  var target = area
  switch where_ {
  case "left":
    target = CGRect(x: area.minX, y: area.minY, width: area.width / 2, height: area.height)
  case "right":
    target = CGRect(
      x: area.minX + area.width / 2, y: area.minY, width: area.width / 2, height: area.height)
  case "full":
    target = area
  case "fullscreen":
    target = full
  case "center":
    let current = frame(of: window) ?? CGRect(x: area.minX, y: area.minY, width: area.width / 2, height: area.height / 2)
    let width = min(current.width, area.width)
    let height = min(current.height, area.height)
    target = CGRect(
      x: area.midX - width / 2, y: area.midY - height / 2, width: width, height: height)
  default:
    fail("usage", "--where must be left, right, full, fullscreen or center")
  }

  var point = target.origin
  var size = target.size
  guard let positionValue = AXValueCreate(.cgPoint, &point),
    let sizeValue = AXValueCreate(.cgSize, &size)
  else { fail("internal", "could not encode the target frame") }
  let positionStatus = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, positionValue)
  let sizeStatus = AXUIElementSetAttributeValue(window, "AXSize" as CFString, sizeValue)
  guard positionStatus == .success || sizeStatus == .success else {
    fail(
      "place_refused",
      "the app refused the window geometry (it may be fullscreen or a panel)")
  }
  let after = frame(of: window)
  emit([
    "ok": true, "tool": "place", "where": where_,
    "requested": [
      "x": Int(target.minX), "y": Int(target.minY),
      "width": Int(target.width), "height": Int(target.height),
    ],
    "actual": after.map {
      ["x": Int($0.minX), "y": Int($0.minY), "width": Int($0.width), "height": Int($0.height)]
    } ?? NSNull(),
  ])
}

func focusCommand(_ args: [String]) -> Never {
  let pid = requirePid(args)
  guard let app = NSRunningApplication(processIdentifier: pid) else {
    fail("no_such_app", "process \(pid) is not a running application")
  }
  let words = flagValue(args, "--title")
  var raised = false
  if let words {
    let allWindows = windows(ofPid: pid)
    var budget = 600
    var matches: [Candidate] = []
    for window in allWindows {
      collectCandidates(
        window, query: normalize(words), role: nil, depth: 2, budget: &budget, out: &matches)
    }
    // Prefer the window itself: match its title directly.
    let byTitle = allWindows.first { window in
      (stringAttribute(window, "AXTitle") ?? "").lowercased().contains(words.lowercased())
    }
    if let window = byTitle ?? matches.first?.element {
      raised = AXUIElementPerformAction(window, "AXRaise" as CFString) == .success
    }
  }
  app.activate(options: [.activateAllWindows])
  emit([
    "ok": true, "tool": "focus", "app": app.localizedName ?? "unknown", "raised": raised,
  ])
}

func mapCommand(_ args: [String]) -> Never {
  let pid = requirePid(args)
  let windowIndex = intFlag(args, "--window-index") ?? 0
  requireAccessibility()
  let allWindows = windows(ofPid: pid)
  guard !allWindows.isEmpty else { fail("no_windows", "process \(pid) exposes no windows") }
  guard windowIndex >= 0 && windowIndex < allWindows.count else {
    fail("bad_index", "window index \(windowIndex) is out of range (\(allWindows.count) windows)")
  }

  var controls: [[String: Any]] = []
  var budget = maxNodes
  let actionable: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXMenuItem", "AXLink", "AXTab", "AXComboBox", "AXSearchField", "AXToggle",
    "AXIncrementor", "AXSlider", "AXDisclosureTriangle",
  ]

  func walk(_ element: AXUIElement, depth: Int) {
    if depth > 10 || budget <= 0 || controls.count >= 80 { return }
    budget -= 1
    let role = stringAttribute(element, "AXRole") ?? ""
    if actionable.contains(role) {
      var entry: [String: Any] = ["role": role]
      let label =
        stringAttribute(element, "AXTitle") ?? stringAttribute(element, "AXDescription")
        ?? (secretRoles.contains(role) ? nil : stringAttribute(element, "AXValue"))
      if let label, !label.isEmpty { entry["label"] = String(label.prefix(80)) }
      if let frame = frame(of: element) {
        entry["x"] = Int(frame.midX)
        entry["y"] = Int(frame.midY)
      }
      if let enabled = axAttribute(element, "AXEnabled") as? NSNumber {
        entry["enabled"] = enabled.boolValue
      }
      entry["pressable"] = actionNames(element).contains(kAXPressAction as String)
      controls.append(entry)
    }
    for child in elementsAttribute(element, "AXChildren") { walk(child, depth: depth + 1) }
  }
  walk(allWindows[windowIndex], depth: 0)

  var result: [String: Any] = [
    "ok": true, "tool": "map", "pid": Int(pid), "windowIndex": windowIndex,
    "count": controls.count, "controls": controls,
  ]
  if let title = stringAttribute(allWindows[windowIndex], "AXTitle") { result["title"] = title }
  if controls.isEmpty {
    result["note"] =
      "No addressable controls in that window: use control_click with coordinates from hands_look, or type at the current focus."
  }
  emit(result)
}

func permissions() -> Never {
  emit([
    "ok": true,
    "tool": "permissions",
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "note": AXIsProcessTrusted()
      ? "Accessibility is granted to jarvis-hands-control; clicks, typing and keys are possible."
      : "Accessibility is NOT granted to jarvis-hands-control: every control command will refuse. System Settings → Privacy & Security → Accessibility.",
  ])
}

/// Show the macOS Accessibility prompt for THIS binary. Granting it here does
/// not grant it to jarvis-hands (observation) — they are separate on purpose.
func requestPermission() -> Never {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(options)
  emit([
    "ok": true,
    "tool": "request-permission",
    "accessibility": accessibility,
    "note": accessibility
      ? "Accessibility is already granted to jarvis-hands-control."
      : "macOS is showing (or has shown) the prompt. If none appeared, enable jarvis-hands-control in System Settings → Privacy & Security → Accessibility.",
  ])
}

func usage() -> Never {
  let text = """
  jarvis-hands-control — JARVIS computer control (can act on your Mac)

  Usage:
    jarvis-hands-control click --pid N --label "Save" [--role AXButton] [--near "text"]
                              [--double] [--right] [--window-index I] [--global]
    jarvis-hands-control click --pid N --x 640 --y 380 [--double] [--right] [--global]
    jarvis-hands-control type  --pid N [--label "Search"] --text "hello" [--submit] [--global]
    jarvis-hands-control key   --combo "cmd+shift+t" [--times N] [--pid N] [--global]
    jarvis-hands-control scroll (--dy N | --dx N) [--x X --y Y] [--pid N] [--global]
    jarvis-hands-control drag  --from X,Y --to X,Y [--pid N] [--global]
    jarvis-hands-control menu  --pid N --path "File>Export>PDF"
    jarvis-hands-control place --pid N --where left|right|full|fullscreen|center [--screen N]
    jarvis-hands-control focus --pid N [--title "words"]
    jarvis-hands-control map   --pid N [--window-index I]
    jarvis-hands-control permissions
    jarvis-hands-control request-permission
    jarvis-hands-control help

  Print one JSON object on stdout. Exit 0 ok, 1 usage, 2 refused or failed.
  """
  FileHandle.standardOutput.write(Data((text + "\n").utf8))
  exit(0)
}

// ── Entry point ───────────────────────────────────────────────────────────
let arguments = CommandLine.arguments
guard arguments.count >= 2 else { usage() }
let command = arguments[1]
let rest = Array(arguments.dropFirst(2))

switch command {
case "click": clickCommand(rest)
case "type": typeCommand(rest)
case "key": keyCommand(rest)
case "scroll": scrollCommand(rest)
case "drag": dragCommand(rest)
case "menu": menuCommand(rest)
case "place": placeCommand(rest)
case "focus": focusCommand(rest)
case "map": mapCommand(rest)
case "permissions": permissions()
case "request-permission", "request-permissions": requestPermission()
case "help", "--help", "-h": usage()
default:
  fail("unknown_command", "unknown command: \(command) — run jarvis-hands-control help")
}
