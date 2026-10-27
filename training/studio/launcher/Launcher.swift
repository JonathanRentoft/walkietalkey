// WalkieTalkey Værksted: Værkstedet (`wt-train studio`) with one click in the Dock.
//
// A minimal AppKit app, no storyboard and no Xcode project. `wt-train studio --install-app`
// (training/wt_train/studio/launcher.py) compiles it with `xcrun swiftc -O` and puts it in a
// bundle with Contents/Resources/launch.json: {"uv": ..., "repo": ..., "bun": ... or null}.
//
// On launch it starts `<uv> run --project <repo>/training wt-train studio --parent-pid <pid>
// --no-browser` in its own process group, writes the server's output to
// ~/Library/Logs/WalkieTalkey Værksted/studio.log, and opens the URL of the server's ready line
// (`Værkstedet: http://127.0.0.1:<port>/`) in the default browser. Clicking the Dock icon again
// opens it again. Quitting (the menu, ⌘Q, or SIGTERM) sends SIGTERM to the server's group,
// waits up to 20 s, then SIGKILL. If the server stops by itself, an alert shows the end of the
// log and the launcher quits. The server also stops when this process is gone (--parent-pid).
//
// For tests: WT_STUDIO_NO_BROWSER=1 opens no browser; WT_STUDIO_LOG_DIR replaces the log folder.

import AppKit
import Darwin
import Foundation

// TODO(copy): every Danish string the launcher shows (this enum) is a draft.
enum Words {
    static let open = "Åbn Værkstedet"
    static let quit = "Afslut WalkieTalkey Værksted"
    static let stopped = "Værkstedet stoppede"
    static let notStarted = "Værkstedet kunne ikke starte"
    static let showLog = "Vis log"
    static let close = "Luk"
}

struct LaunchConfig: Decodable {
    let uv: String
    let repo: String
    let bun: String?
}

/// The URL in the server's ready line, `Værkstedet: http://127.0.0.1:<port>/`.
func readyURL(_ line: String) -> URL? {
    let marker = "Værkstedet: http://127.0.0.1:"
    guard let found = line.range(of: marker) else { return nil }
    let rest = line[found.upperBound...]
    let port = rest.prefix { $0.isASCII && $0.isNumber }
    guard !port.isEmpty, rest.dropFirst(port.count).hasPrefix("/") else { return nil }
    return URL(string: "http://127.0.0.1:\(port)/")
}

/// studio.log (the previous run's is kept as studio.previous.log) and its last lines.
final class Log {
    let url: URL
    private let handle: FileHandle?
    private let lock = NSLock()
    private var tail: [String] = []
    private var partial = Data()

    init() {
        let env = ProcessInfo.processInfo.environment
        let dir: URL
        if let custom = env["WT_STUDIO_LOG_DIR"], !custom.isEmpty {
            dir = URL(fileURLWithPath: custom, isDirectory: true)
        } else {
            dir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Logs/WalkieTalkey Værksted", isDirectory: true)
        }
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("studio.log")
        let previous = dir.appendingPathComponent("studio.previous.log")
        try? fm.removeItem(at: previous)
        try? fm.moveItem(at: url, to: previous)
        fm.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
    }

    /// The server's output as it comes; returns the complete lines in it.
    func output(_ data: Data) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.write(contentsOf: data)
        partial.append(data)
        var lines: [String] = []
        while let nl = partial.firstIndex(of: 0x0A) {
            let line = partial[partial.startIndex..<nl]
            partial.removeSubrange(partial.startIndex...nl)
            lines.append(String(decoding: line, as: UTF8.self))
        }
        remember(lines)
        return lines
    }

    /// A line of the launcher's own.
    func note(_ text: String) {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.write(contentsOf: Data("[launcher] \(text)\n".utf8))
        remember(["[launcher] \(text)"])
    }

    func last(_ n: Int) -> String {
        lock.lock()
        defer { lock.unlock() }
        var lines = tail
        if !partial.isEmpty { lines.append(String(decoding: partial, as: UTF8.self)) }
        return lines.suffix(n).joined(separator: "\n")
    }

    private func remember(_ lines: [String]) {
        tail.append(contentsOf: lines)
        if tail.count > 200 { tail.removeFirst(tail.count - 200) }
    }
}

enum LaunchError: Error, CustomStringConvertible {
    case config(String)
    case spawn(String)
    var description: String {
        switch self {
        case .config(let s), .spawn(let s): return s
        }
    }
}

/// The server process (the leader of its own process group) and what became of it.
final class Server {
    let pid: pid_t
    private let lock = NSLock()
    private var status: Int32?
    private let done = DispatchSemaphore(value: 0)

    init(pid: pid_t) { self.pid = pid }

    var exited: Bool {
        lock.lock()
        defer { lock.unlock() }
        return status != nil
    }

    /// Called once by the waiting thread.
    func finished(_ s: Int32) {
        lock.lock()
        status = s
        lock.unlock()
        done.signal()
    }

    /// Something in the server's process group is still alive.
    var groupAlive: Bool { kill(-pid, 0) == 0 || errno == EPERM }

    /// SIGTERM to the group, up to 20 s for it to go (the server stops its jobs and ends the
    /// recording session within about 10 s), then SIGKILL.
    func stop(log: Log) {
        guard groupAlive else { return }
        log.note("stopping the server (SIGTERM to process group \(pid))")
        kill(-pid, SIGTERM)
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if exited && !groupAlive { return }
            usleep(100_000)
        }
        if groupAlive {
            log.note("the server did not stop within 20 s; SIGKILL")
            kill(-pid, SIGKILL)
        }
        _ = done.wait(timeout: .now() + 2)
    }
}

func describe(status: Int32) -> String {
    let signal = status & 0x7f
    if signal == 0 { return "exit status \((status >> 8) & 0xff)" }
    return "signal \(signal)"
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let log = Log()
    private var server: Server?
    private var url: URL?
    private var openWhenReady = false
    private var stopping = false
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        catchSignals()
        do {
            server = try start(config: try loadConfig())
        } catch {
            log.note("could not start: \(error)")
            fail(title: Words.notStarted, detail: "\(error)")
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openStudio(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        server?.stop(log: log)
        log.note("quit")
    }

    @objc func openStudio(_ sender: Any?) {
        guard let url else {
            openWhenReady = true
            return
        }
        if ProcessInfo.processInfo.environment["WT_STUDIO_NO_BROWSER"] == "1" {
            log.note("not opening \(url) (WT_STUDIO_NO_BROWSER=1)")
            return
        }
        log.note("opening \(url)")
        NSWorkspace.shared.open(url)
    }

    // ---- setup

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let menu = NSMenu()
        let open = NSMenuItem(title: Words.open, action: #selector(openStudio(_:)), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        menu.addItem(
            NSMenuItem(title: Words.quit, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = menu
        NSApp.mainMenu = main
    }

    /// SIGTERM and SIGINT quit like ⌘Q, so the server is stopped too.
    private func catchSignals() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.log.note("signal \(sig): quitting")
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
        signal(SIGPIPE, SIG_IGN)
    }

    private func loadConfig() throws -> LaunchConfig {
        guard let file = Bundle.main.url(forResource: "launch", withExtension: "json") else {
            throw LaunchError.config("Contents/Resources/launch.json is missing")
        }
        do {
            return try JSONDecoder().decode(LaunchConfig.self, from: Data(contentsOf: file))
        } catch {
            throw LaunchError.config("\(file.path) could not be read: \(error)")
        }
    }

    // ---- the server

    private func start(config: LaunchConfig) throws -> Server {
        guard FileManager.default.isExecutableFile(atPath: config.uv) else {
            throw LaunchError.config("uv is not at \(config.uv); run wt-train studio --install-app again")
        }
        guard FileManager.default.changeCurrentDirectoryPath(config.repo) else {
            throw LaunchError.config("the repository is not at \(config.repo)")
        }
        var dirs = [(config.uv as NSString).deletingLastPathComponent]
        if let bun = config.bun { dirs.append((bun as NSString).deletingLastPathComponent) }
        dirs.append(contentsOf: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        var seen = Set<String>()
        let path = dirs.filter { seen.insert($0).inserted }.joined(separator: ":")
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["WT_BUN"] = config.bun
        let args = [
            config.uv, "run", "--project", config.repo + "/training", "wt-train", "studio",
            "--parent-pid", String(getpid()), "--no-browser",
        ]
        log.note("starting: \(args.joined(separator: " ")) (in \(config.repo), PATH=\(path))")

        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { throw LaunchError.spawn("pipe: \(String(cString: strerror(errno)))") }
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, fds[1], 1)
        posix_spawn_file_actions_adddup2(&actions, fds[1], 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Its own process group (so the whole tree can be stopped), default signal handling and
        // an empty mask (this process ignores SIGTERM, SIGINT and SIGPIPE), and no other file
        // descriptors of ours.
        posix_spawnattr_setpgroup(&attr, 0)
        var defaults = sigset_t()
        sigemptyset(&defaults)
        for sig in [SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGQUIT] { sigaddset(&defaults, sig) }
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var mask = sigset_t()
        sigemptyset(&mask)
        posix_spawnattr_setsigmask(&attr, &mask)
        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
            | POSIX_SPAWN_CLOEXEC_DEFAULT
        posix_spawnattr_setflags(&attr, Int16(truncatingIfNeeded: flags))

        let cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        let cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            cArgs.forEach { free($0) }
            cEnv.forEach { free($0) }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, config.uv, &actions, &attr, cArgs, cEnv)
        close(fds[1])
        guard rc == 0 else {
            close(fds[0])
            throw LaunchError.spawn("could not start \(config.uv): \(String(cString: strerror(rc)))")
        }
        let server = Server(pid: pid)
        let readFd = fds[0]
        Thread { [log] in
            var buffer = [UInt8](repeating: 0, count: 16384)
            while true {
                let n = read(readFd, &buffer, buffer.count)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                for line in log.output(Data(buffer[0..<n])) {
                    if let url = readyURL(line) {
                        DispatchQueue.main.async { [weak self] in self?.ready(url) }
                    }
                }
            }
            close(readFd)
        }.start()
        Thread { [weak self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            server.finished(status)
            DispatchQueue.main.async { self?.exited(status) }
        }.start()
        return server
    }

    private func ready(_ found: URL) {
        let first = url == nil
        url = found
        log.note("ready at \(found)")
        if first || openWhenReady {
            openWhenReady = false
            openStudio(nil)
        }
    }

    private func exited(_ status: Int32) {
        log.note("the server stopped (\(describe(status: status)))")
        if stopping { return }
        // A clean exit after the ready line: another Værkstedet was already running (the server
        // printed its address and left; the page is open) or it was stopped from elsewhere.
        if status == 0 && url != nil {
            stopping = true
            NSApp.terminate(nil)
            return
        }
        fail(title: Words.stopped, detail: log.last(12))
    }

    /// The alert: "Vis log" shows the log in Finder; either way the launcher quits.
    private func fail(title: String, detail: String) {
        stopping = true
        // Whatever is left of the server goes now. The main queue waits while the alert is up,
        // so SIGTERM and SIGINT get their default action meanwhile: nothing is left to stop.
        server?.stop(log: log)
        signalSources.forEach { $0.cancel() }
        signal(SIGTERM, SIG_DFL)
        signal(SIGINT, SIG_DFL)
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: Words.showLog)
        alert.addButton(withTitle: Words.close)
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([log.url])
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
