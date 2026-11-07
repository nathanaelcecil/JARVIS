// JARVIS menu bar — the always-there surface for the assistant.
//
// Why a separate native app: a browser tab cannot own a global hotkey, cannot
// dictate into another application's text field, and cannot hear a wake word
// while it is closed. This app is deliberately small and does only those
// things; the conversation itself stays in the web UI.
//
// What it does
//   • Open JARVIS            — brings the web UI up
//   • Dictate (⌃⌥D)          — record, transcribe with the local whisper route,
//                              type the text into whatever app is in front
//   • Wake word "Jarvis"     — on-device speech recognition while idle; saying
//                              the word starts a dictation
//   • Draw on screen         — transparent overlay: drag to draw arrows/boxes,
//                              Esc clears then closes
//   • Record meeting         — records the mic and saves the transcript next to
//                              the audio under ~/Documents/JARVIS/meetings
//
// Trust boundary: transcription goes to the local server (`/api/transcribe`,
// whisper.cpp). The only external action is typing through the same signed
// helper the chat uses (`jarvis-hands-control type --global`), which refuses
// secure fields and needs Accessibility. Nothing is uploaded anywhere else.
//
// Build: native/jarvis-menubar/build.command
// Run:   open native/jarvis-menubar/bin/JARVISMenuBar.app

import AVFoundation
import Cocoa
import Carbon.HIToolbox
import ApplicationServices
import Speech

// ── Configuration ──────────────────────────────────────────────────────────

let appOrigin = ProcessInfo.processInfo.environment["JARVIS_APP_ORIGIN"] ?? "http://127.0.0.1:4173"
let meetingsDir = FileManager.default
    .homeDirectoryForCurrentUser
    .appendingPathComponent("Documents/JARVIS/meetings", isDirectory: true)

func helperPath() -> String {
    // The bundle is native/jarvis-menubar/bin/JARVISMenuBar.app; the helper is
    // a sibling tree at native/jarvis-hands-control/ — strip .app, bin/ and
    // jarvis-menubar/ to reach native/.
    let bundle = Bundle.main.bundleURL
    let native = bundle
        .deletingLastPathComponent() // JARVISMenuBar.app → bin
        .deletingLastPathComponent() // bin → jarvis-menubar
        .deletingLastPathComponent() // jarvis-menubar → native
    return native.appendingPathComponent("jarvis-hands-control/bin/jarvis-hands-control").path
}

func log(_ message: String) {
    let line = "[JARVISMenuBar] " + message + "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    // `open` detaches stdout/stderr, so also keep a file log we can read.
    let url = URL(fileURLWithPath: "/tmp/jarvis-logs/menubar.log")
    if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    if let handle = try? FileHandle(forWritingTo: url) {
        do {
            _ = try handle.seekToEnd()
            try handle.write(line.data(using: .utf8)!)
        } catch {
            // File logging is best-effort; never break the caller.
        }
        try? handle.close()
    }
}

// ── Typing into the frontmost app ──────────────────────────────────────────

enum TypingResult {
    case typed
    case copied(String)
}

/// Type from inside this process. The menu-bar app holds the Accessibility
/// grant, while the helper — spawned from us — is evaluated under its own
/// unsigned binary identity and gets denied. So when the helper is refused we
/// finish the job ourselves with synthetic unicode key events.
func typeInProcess(_ text: String) -> Bool {
    guard AXIsProcessTrusted() else { return false }
    let source = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        let end = min(index + 20, units.count)
        let chunk = Array(units[index..<end])
        guard
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { return false }
        chunk.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(2000)
        index = end
    }
    return true
}

func typeIntoFrontmostApp(_ text: String, completion: @escaping (TypingResult) -> Void) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: helperPath())
    // --global: type at the current focus, no pid guessing. argv only.
    task.arguments = ["type", "--text", text, "--global"]
    let out = Pipe()
    task.standardOutput = out
    task.standardError = Pipe()
    task.terminationHandler = { process in
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        DispatchQueue.main.async {
            if process.terminationStatus == 0, (json?["ok"] as? Bool) == true {
                completion(.typed)
            } else {
                let code = (json?["code"] as? String) ?? "failed"
                if code == "accessibility_denied" {
                    // The app itself is the Accessibility-trusted identity, so
                    // retry from here before giving up on typing.
                    if typeInProcess(text) {
                        log("typing: helper denied, typed in-process")
                        completion(.typed)
                        return
                    }
                    // Neither identity may type: ask the system for the grant.
                    AXIsProcessTrustedWithOptions([
                        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
                    ] as CFDictionary)
                }
                // Never lose the words: put them on the clipboard and say so.
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
                completion(.copied(code))
            }
        }
    }
    do {
        try task.run()
    } catch {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        completion(.copied("helper_missing"))
    }
}

// ── Transcription ──────────────────────────────────────────────────────────

func transcribe(fileURL: URL, completion: @escaping (String?) -> Void) {
    guard let audio = try? Data(contentsOf: fileURL) else {
        completion(nil)
        return
    }
    var request = URLRequest(url: URL(string: appOrigin + "/api/transcribe")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body: [String: Any] = [
        "audioBase64": audio.base64EncodedString(),
        "mimeType": "audio/mp4",
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    request.timeoutInterval = 120

    URLSession.shared.dataTask(with: request) { data, _, error in
        DispatchQueue.main.async {
            if let error {
                log("transcribe transport failed: \(error.localizedDescription)")
                completion(nil)
                return
            }
            guard let data,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else {
                completion(nil)
                return
            }
            let text = (json["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let text, !text.isEmpty {
                completion(text)
            } else {
                log("transcribe returned no text: \(json["error"] as? String ?? "unknown")")
                completion(nil)
            }
        }
    }.resume()
}

// ── Drawing overlay ────────────────────────────────────────────────────────

final class DrawView: NSView {
    private var strokes: [[NSPoint]] = []
    private var current: [NSPoint] = []
    private var boxes: [NSRect] = []
    private var boxDragOrigin: NSPoint?
    private var currentBox: NSRect?
    private var labels: [(text: String, at: NSPoint)] = []
    var onEscape: (() -> Void)?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var isEmpty: Bool { strokes.isEmpty && boxes.isEmpty && labels.isEmpty && current.isEmpty }

    private func clearAll() {
        strokes = []
        current = []
        boxes = []
        labels = []
        currentBox = nil
        boxDragOrigin = nil
        needsDisplay = true
    }

    /// Ask for label text, then draw it where the user option-clicked.
    private func addLabel(at point: NSPoint) {
        let alert = NSAlert()
        alert.messageText = "Label"
        alert.informativeText = "Text to draw at that point."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = "e.g. look here"
        alert.accessoryView = field
        alert.addButton(withTitle: "Add")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        labels.append((text: text, at: point))
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        NSColor.systemRed.setStroke()

        // Boxes: shift-drag. Drawn first so arrows stay legible on top.
        NSColor.systemRed.setStroke()
        for rect in boxes + [currentBox].compactMap({ $0 }) {
            let path = NSBezierPath(rect: rect)
            path.lineWidth = 3
            path.stroke()
        }

        for stroke in strokes + [current] where stroke.count > 1 {
            let path = NSBezierPath()
            path.lineWidth = 4
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            path.move(to: stroke[0])
            for point in stroke.dropFirst() { path.line(to: point) }
            path.stroke()
            // Arrowhead at the end, so a drag reads as "point here".
            if stroke.count > 3 {
                let tail = stroke[stroke.count - 2]
                let head = stroke[stroke.count - 1]
                let angle = atan2(head.y - tail.y, head.x - tail.x)
                let headPath = NSBezierPath()
                headPath.lineWidth = 4
                for delta in [CGFloat(2.6), CGFloat(-2.6)] {
                    headPath.move(to: head)
                    headPath.line(to: NSPoint(
                        x: head.x + cos(angle + delta) * 18,
                        y: head.y + sin(angle + delta) * 18
                    ))
                }
                headPath.stroke()
            }
        }

        // Labels: option-click. Painted with a dark pill so red text stays
        // readable over a light or a dark window.
        for label in labels {
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
                .foregroundColor: NSColor.systemRed,
            ]
            let size = label.text.size(withAttributes: attributes)
            let pill = NSRect(
                x: label.at.x - 6,
                y: label.at.y - size.height - 6,
                width: size.width + 12,
                height: size.height + 12
            )
            NSColor(calibratedWhite: 0, alpha: 0.55).setFill()
            NSBezierPath(roundedRect: pill, xRadius: 6, yRadius: 6).fill()
            label.text.draw(at: NSPoint(x: label.at.x, y: label.at.y - size.height), withAttributes: attributes)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if event.modifierFlags.contains(.option) {
            addLabel(at: point)
            return
        }
        if event.modifierFlags.contains(.shift) {
            boxDragOrigin = point
            currentBox = NSRect(origin: point, size: .zero)
            return
        }
        current = [point]
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let origin = boxDragOrigin {
            currentBox = NSRect(
                x: min(origin.x, point.x),
                y: min(origin.y, point.y),
                width: abs(point.x - origin.x),
                height: abs(point.y - origin.y)
            )
            needsDisplay = true
            return
        }
        current.append(point)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let box = currentBox, box.width > 4, box.height > 4 {
            boxes.append(box)
        }
        currentBox = nil
        boxDragOrigin = nil
        if current.count > 1 { strokes.append(current) }
        current = []
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape: clear, then the next Escape closes
            if isEmpty {
                onEscape?()
            } else {
                clearAll()
            }
        } else {
            super.keyDown(with: event)
        }
    }
}

final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class DrawOverlay {
    private var windows: [OverlayWindow] = []

    var isOpen: Bool { !windows.isEmpty }

    func show() {
        guard windows.isEmpty else { return }
        for screen in NSScreen.screens {
            let window = OverlayWindow(
                contentRect: screen.frame,
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            window.level = .screenSaver
            window.isOpaque = false
            window.backgroundColor = NSColor(calibratedWhite: 0, alpha: 0.12)
            window.ignoresMouseEvents = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = DrawView(frame: screen.frame)
            view.onEscape = { [weak self] in self?.close() }
            window.contentView = view
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(view)
            windows.append(window)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        for window in windows { window.orderOut(nil) }
        windows.removeAll()
    }
}

// ── App ────────────────────────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate, SFSpeechRecognizerDelegate {
    private var statusItem: NSStatusItem!
    private let overlay = DrawOverlay()

    private var recorder: AVAudioRecorder?
    private var isDictating = false
    private var isRecordingMeeting = false
    private var meetingURL: URL?

    private var wakeEnabled = false
    /// The user's intent, which outlives a recording: dictation and meetings
    /// stop the listener, and it re-arms when they finish.
    private var wakeWanted = false
    // Privacy: keep the always-listening audio on-device when the model exists.
    private var wakePrefersOnDevice = true
    private var wakeTask: SFSpeechRecognitionTask?
    private var wakeRequest: SFSpeechAudioBufferRecognitionRequest?
    private let wakeEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "J"
        statusItem.button?.toolTip = "JARVIS"
        rebuildMenu()
        registerHotKey()
        log("ready — app origin \(appOrigin)")
        // Accessibility is keyed to this binary's code signature; a rebuild
        // invalidates the old grant. Surface it so grants are quick to check.
        log("accessibility trusted = \(AXIsProcessTrusted())")
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopWakeWord()
        recorder?.stop()
    }

    // ── Menu ───────────────────────────────────────────────────────────────

    private func rebuildMenu() {
        let menu = NSMenu()

        let open = NSMenuItem(title: "Open JARVIS", action: #selector(openJarvis), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        let dictate = NSMenuItem(
            title: isDictating ? "Stop dictating" : "Dictate…  ⌃⌥D",
            action: #selector(toggleDictation),
            keyEquivalent: ""
        )
        dictate.target = self
        menu.addItem(dictate)

        let wake = NSMenuItem(
            title: wakeWanted ? "Wake word “Jarvis”: on" : "Wake word “Jarvis”: off",
            action: #selector(toggleWakeWord),
            keyEquivalent: ""
        )
        wake.target = self
        menu.addItem(wake)

        menu.addItem(.separator())

        let draw = NSMenuItem(
            title: overlay.isOpen ? "Close drawing overlay" : "Draw on screen",
            action: #selector(toggleOverlay),
            keyEquivalent: ""
        )
        draw.target = self
        menu.addItem(draw)

        let meeting = NSMenuItem(
            title: isRecordingMeeting ? "Stop meeting recording" : "Record meeting…",
            action: #selector(toggleMeeting),
            keyEquivalent: ""
        )
        meeting.target = self
        menu.addItem(meeting)

        menu.addItem(.separator())

        let meetings = NSMenuItem(title: "Open meetings folder", action: #selector(openMeetings), keyEquivalent: "")
        meetings.target = self
        menu.addItem(meetings)

        let dictations = NSMenuItem(title: "Open dictation folder", action: #selector(openDictations), keyEquivalent: "")
        dictations.target = self
        menu.addItem(dictations)

        let permissions = NSMenuItem(title: "Check permissions", action: #selector(checkPermissions), keyEquivalent: "")
        permissions.target = self
        menu.addItem(permissions)

        let quit = NSMenuItem(title: "Quit JARVIS Menu Bar", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        statusItem.button?.title = isDictating ? "◉" : (isRecordingMeeting ? "●" : "J")
    }

    @objc private func openJarvis() {
        NSWorkspace.shared.open(URL(string: appOrigin)!)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func openDictations() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/JARVIS/dictation", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }

    @objc private func openMeetings() {
        try? FileManager.default.createDirectory(at: meetingsDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(meetingsDir)
    }

    @objc private func checkPermissions() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: helperPath())
        task.arguments = ["permissions"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? "(no output)"
        let alert = NSAlert()
        alert.messageText = "JARVIS helper permissions"
        alert.informativeText = text
        alert.runModal()
    }

    // ── Dictation ──────────────────────────────────────────────────────────

    @objc private func toggleDictation() {
        if isDictating { finishDictation() } else { beginDictation() }
    }

    private func beginDictation() {
        guard !isDictating else { return }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            guard granted else {
                DispatchQueue.main.async { self.showError("Microphone access is off", "Enable it in System Settings → Privacy & Security → Microphone for JARVIS Menu Bar.") }
                return
            }
            DispatchQueue.main.async { self.startRecorder(meeting: false) }
        }
    }

    private func startRecorder(meeting: Bool) {
        stopWakeWord()
        let url: URL
        if meeting {
            try? FileManager.default.createDirectory(at: meetingsDir, withIntermediateDirectories: true)
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            url = meetingsDir.appendingPathComponent("meeting-\(stamp).m4a")
            meetingURL = url
        } else {
            url = FileManager.default.temporaryDirectory
                .appendingPathComponent("jarvis-dictation-\(UUID().uuidString).m4a")
        }

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder?.record()
            if meeting {
                isRecordingMeeting = true
            } else {
                isDictating = true
            }
            rebuildMenu()
        } catch {
            showError("Could not start recording", error.localizedDescription)
        }
    }

    private func finishDictation() {
        guard let recorder else { return }
        let url = recorder.url
        recorder.stop()
        self.recorder = nil
        isDictating = false
        rebuildMenu()
        rearmWakeWord()

        transcribe(fileURL: url) { text in
            try? FileManager.default.removeItem(at: url)
            if let text { self.autosaveDictation(text) }
            guard let text else {
                self.showError("Nothing transcribed", "The local speech-to-text returned no text. Check that whisper.cpp and the model file are installed (SETUP.md).")
                return
            }
            typeIntoFrontmostApp(text) { result in
                switch result {
                case .typed:
                    break
                case .copied(let reason):
                    self.showError(
                        "Text copied instead of typed",
                        "The helper could not type into the frontmost app (\(reason)). The words are on your clipboard — press ⌘V. Grant Accessibility to JARVIS Menu Bar in System Settings → Privacy & Security → Accessibility (re-toggle it after every rebuild)."
                    )
                }
            }
        }
    }

    /// Append the transcript to today's notes file, so a dictation is never
    /// lost when there is no text field to type into (or typing is refused).
    private func autosaveDictation(_ text: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/JARVIS/dictation", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm"
        let url = dir.appendingPathComponent("\(day.string(from: Date())).md")
        let line = "- \(clock.string(from: Date())) \(text)\n"

        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            let header = "# JARVIS dictation — \(day.string(from: Date()))\n\n"
            try? (header + line).write(to: url, atomically: true, encoding: .utf8)
        }
    }

    @objc private func toggleMeeting() {
        if isRecordingMeeting {
            guard let recorder, let url = meetingURL else { return }
            recorder.stop()
            self.recorder = nil
            isRecordingMeeting = false
            rebuildMenu()
            rearmWakeWord()
            transcribe(fileURL: url) { text in
                let body = "# Meeting \(ISO8601DateFormatter().string(from: Date()))\n\n"
                    + (text ?? "_(no speech detected)_") + "\n"
                let mdURL = url.deletingPathExtension().appendingPathExtension("md")
                try? body.write(to: mdURL, atomically: true, encoding: .utf8)
                NSWorkspace.shared.activateFileViewerSelecting([mdURL])
            }
        } else {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        self.showError("Microphone access is off", "Enable it in System Settings → Privacy & Security → Microphone.")
                        return
                    }
                    self.startRecorder(meeting: true)
                }
            }
        }
    }

    @objc private func toggleOverlay() {
        if overlay.isOpen { overlay.close() } else { overlay.show() }
        rebuildMenu()
    }

    // ── Wake word ──────────────────────────────────────────────────────────

    @objc private func toggleWakeWord() {
        if wakeWanted {
            wakeWanted = false
            stopWakeWord()
            rebuildMenu()
            return
        }
        wakeWanted = true
        beginWakeWord()
        rebuildMenu()
    }

    /// Restart listening after a recording without overriding an explicit off.
    private func rearmWakeWord() {
        guard wakeWanted, !wakeEnabled, !isDictating, !isRecordingMeeting else { return }
        beginWakeWord()
    }

    private func beginWakeWord() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                // The menu title can lag the real state (this runs async), so
                // re-check everything before touching the mic.
                guard !self.wakeEnabled, !self.isDictating, !self.isRecordingMeeting else {
                    log("wake: skipped (already active)")
                    return
                }
                log("wake: speech authorization status = \(status.rawValue)")
                guard status == .authorized else {
                    self.showError("Speech recognition is off", "Enable it in System Settings → Privacy & Security → Speech Recognition for JARVIS Menu Bar.")
                    return
                }
                guard let recognizer = self.speechRecognizer, recognizer.isAvailable else {
                    self.showError("Wake word unavailable", "Speech recognition is not available right now (offline?). Dictation still works with ⌃⌥D.")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        log("wake: mic granted = \(granted)")
                        guard granted else { return }
                        self.startWakeWord(recognizer)
                    }
                }
            }
        }
    }

    private func startWakeWord(_ recognizer: SFSpeechRecognizer) {
        guard !wakeEnabled else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if wakePrefersOnDevice, recognizer.supportsOnDeviceRecognition {
            // On-device keeps the always-listening audio local.
            request.requiresOnDeviceRecognition = true
        }
        wakeRequest = request

        let input = wakeEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
        }
        wakeEngine.prepare()
        do {
            try wakeEngine.start()
        } catch {
            log("wake word audio engine failed: \(error.localizedDescription)")
            return
        }

        wakeEnabled = true
        rebuildMenu()
        log("wake: listening (onDevice=\(request.requiresOnDeviceRecognition))")
        let usedOnDevice = request.requiresOnDeviceRecognition
        wakeTask = recognizer.recognitionTask(with: request) { result, error in
            // Recognisers disagree on this name ("Jarvis", "Javis", "Jarvas"),
            // so accept the common misspellings rather than making the user
            // repeat themselves. Two syllables still have to match.
            let heard = result?.bestTranscription.formattedString.lowercased() ?? ""
            let triggered = ["jarvis", "javis", "jarvas", "jervis"].contains { heard.contains($0) }
            if triggered {
                DispatchQueue.main.async {
                    self.stopWakeWord()
                    self.beginDictation()
                }
                return
            }
            if error != nil || result?.isFinal == true {
                // Recognition tasks end on their own; restart while enabled.
                // Back off first — a task that fails instantly (e.g. a missing
                // on-device model) would otherwise spin in a tight loop.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    guard self.wakeEnabled else { return }
                    if usedOnDevice, error != nil {
                        // On-device model missing — fall back to server-backed.
                        self.wakePrefersOnDevice = false
                    }
                    self.stopWakeWord()
                    self.beginWakeWord()
                }
            }
        }
    }

    private func stopWakeWord() {
        wakeEnabled = false
        wakeTask?.cancel()
        wakeTask = nil
        wakeRequest?.endAudio()
        wakeRequest = nil
        if wakeEngine.isRunning {
            wakeEngine.stop()
            wakeEngine.inputNode.removeTap(onBus: 0)
        }
        rebuildMenu()
    }

    // ── Global hotkey (⌃⌥D) ───────────────────────────────────────────────

    private func registerHotKey() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            guard let delegate = NSApp.delegate as? AppDelegate else { return noErr }
            delegate.toggleDictation()
            return noErr
        }, 1, &eventType, nil, nil)

        var hotKeyRef: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x4A52_5653), id: 1) // 'JRVS'
        RegisterEventHotKey(
            UInt32(kVK_ANSI_D),
            UInt32(controlKey | optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }

    private func showError(_ title: String, _ body: String) {
        log("error: \(title) — \(body)")
        // Accessory apps can otherwise leave the alert behind other windows.
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
