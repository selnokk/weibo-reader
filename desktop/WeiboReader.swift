import AppKit
import WebKit
import Foundation
import Darwin

class ReaderController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var ownedAccountPID: Int32 = 0
    var engine: Process?
    var engineInput: FileHandle?
    var outputBuffer = Data()
    var stderrBuffer = Data()
    var queued: [[String: Any]] = []
    var queuedBytes = 0
    let queuedEventLimit = 32 * 1024
    let queuedByteLimit = 128 * 1024
    let queuedCountLimit = 32
    var uiReady = false
    var documentEpoch = 1
    var startupBootstrapSent = false
    var startupWriter: (requestId: String, workspace: String)?
    var acceptedLibraryAcknowledgment: [String]?
    var busy = false
    // Resource ownership still protects Quit. Automatic work alone must not
    // prevent opening a foreground directory choice, which the engine queues.
    var automaticCollection = false
    struct WorkspaceSelection {
        let token: UUID
        let workspace: String
        let requestId: String
    }
    var workspaceSelection: WorkspaceSelection?
    var ownedPID: Int32 = 0
    var savingData = false
    var localWriters: Set<String> = []
    var exchangeWriter: (workspace: String, requestId: String)?
    var acceptedWorkspace: String?
    var persistWorkspace: (String) -> Void = { UserDefaults.standard.set($0, forKey: "workspace") }
    let feedback = FeedbackDiagnostics()
    var feedbackPreview: (id: String, bytes: Data, text: String)?
    var feedbackRequest = ""
    var feedbackCopy: (String) -> Bool = { text in NSPasteboard.general.clearContents(); return NSPasteboard.general.setString(text, forType: .string) }
    var feedbackSave: ((Data, @escaping (String) -> Void) -> Void)?
    var transportFailed = false
    var quitting = false
    var quitAnswered = false
    var quitSignalSent = false
    var quitReply: () -> Void = { NSApp.reply(toApplicationShouldTerminate: true) }
    var smokeStage = 0
    var smokeActions: [[String: String]] = []
    var smokeFeatures: Set<String> = []
    var args = CommandLine.arguments
    var smoke: Bool { args.contains("--smoke-test") }
    var resources: URL { Bundle.main.resourceURL! }
    var engineRoot: URL { resources.appendingPathComponent("engine") }
    func argument(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
    var workspace: String {
        if let accepted = acceptedWorkspace { return accepted }
        if let explicit = argument("--workspace") { return explicit }
        if let saved = UserDefaults.standard.string(forKey: "workspace") { return saved }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("selnokk.weibo.reader").path
    }
    func applicationWillTerminate(_ notification:Notification) {feedback.finishSession()}
    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        #if !WEIBO_NATIVE_TEST
        if !smoke {feedback.enablePersistence(directory:FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/selnokk.weibo.reader/private/runtime-logs"))}
        #endif
        feedback.observe(["type":"appStarted"])
        buildMenu()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(computerDidWake), name: NSWorkspace.didWakeNotification, object: nil)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "weibo")
        if smoke { config.websiteDataStore = .nonPersistent() }
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let instrumentation = "window.weiboErrors=[];window.addEventListener('error',e=>window.weiboErrors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.weiboErrors.push(String(e.reason)));"
        config.userContentController.addUserScript(WKUserScript(source: instrumentation, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Bundle metadata is available before the engine/library handshake.
        let appInfo = ["version": Bundle.main.object(forInfoDictionaryKey: "WeiboAppVersion") as? String ?? ""]
        if let bytes = try? JSONSerialization.data(withJSONObject: appInfo), let json = String(data: bytes, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: "window.weiboAppInfo=" + json + ";", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if smoke { config.userContentController.addUserScript(WKUserScript(source: "window.weiboSmoke=true", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Weibo Reader"
        window.minSize = NSSize(width: 980, height: 700)
        let container = NSView(frame: window.contentView!.bounds)
        web.frame = container.bounds; container.addSubview(web)
        window.contentView = container
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startEngine()
        let ui = engineRoot.appendingPathComponent("desktop/ui")
        // Shared pure UI helpers also live in engine/lib. Grant this bundled
        // resource tree, never the selected data workspace.
        web.loadFileURL(ui.appendingPathComponent("index.html"), allowingReadAccessTo: engineRoot)
    }
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        let show = appMenu.addItem(withTitle: "显示主窗口", action: #selector(showMainWindow), keyEquivalent: ""); show.target = self
        appMenu.addItem(withTitle: "关于 Weibo Reader", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Weibo Reader", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Weibo Reader", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenuItem(); main.addItem(file); let fileMenu = NSMenu(title: "文件"); file.submenu = fileMenu
        let create = fileMenu.addItem(withTitle: "用户列表", action: #selector(newReport), keyEquivalent: "n"); create.target = self
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenuItem(); main.addItem(edit); let editMenu = NSMenu(title: "编辑"); edit.submenu = editMenu
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let windows = NSMenuItem(); main.addItem(windows); let windowsMenu = NSMenu(title: "窗口"); windows.submenu = windowsMenu
        windowsMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowsMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowsMenu
        NSApp.mainMenu = main
    }
    @objc func showMainWindow() { guard !quitting else { return }; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func newReport() { window.makeKeyAndOrderFront(nil); web.evaluateJavaScript("window.userSearch?.()", completionHandler: nil) }
    func startEngine() {
        guard engine?.isRunning != true else { return }
        let startupWorkspace = workspace
        let process = Process()
        process.executableURL = resources.appendingPathComponent("runtime/bin/node")
        process.arguments = [engineRoot.appendingPathComponent("desktop/bridge.js").path, "--workspace", startupWorkspace, "--wait-for-ready", "--native-startup"]
        process.currentDirectoryURL = engineRoot
        var env = ProcessInfo.processInfo.environment
        // The installed application always verifies service certificates, even
        // when launched from a terminal configured for local development.
        env["NODE_ENV"] = "production"
        env["NODE_TLS_REJECT_UNAUTHORIZED"] = "1"
        env["PATH"] = resources.appendingPathComponent("runtime/bin").path + ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = env
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        engineInput = input.fileHandleForWriting
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            if let text = String(data: data, encoding: .utf8), !text.isEmpty { DispatchQueue.main.async { self?.deliver(["type": "log", "message": text, "level": "error"]) } }
        }
        monitorEngineTermination(process)
        do {
            try process.run(); engine = process
            // Existing background intent belongs to this owned engine, not to
            // whether WebKit can finish rendering while the desktop is locked.
            if !startupBootstrapSent {
                startupBootstrapSent = true
                let requestId = "native-startup:" + UUID().uuidString
                startupWriter = (requestId, startupWorkspace)
                localWriters.insert(requestId)
                send(["action": "bootstrap", "workspace": startupWorkspace, "requestId": requestId])
            }
        }
        catch { feedback.observe(["type":"engineStartFailed"]); deliver(["type": "engineStopped", "message": "无法启动内置运行环境：\(error.localizedDescription)"]) }
    }
    func monitorEngineTermination(_ process: Process) {
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self = self else { return }
            if self.ownedPID > 0 { kill(-self.ownedPID, SIGKILL); self.ownedPID = 0 }
            if self.quitting { self.replyAfterEngineExit() }
            else { self.feedback.observe(["type":"engineStopped"]); self.deliver(["type":"engineStopped", "message":"运行引擎已结束，请重新打开应用。"]) }
        } }
    }
    func consume(_ data: Data) {
        outputBuffer.append(data)
        smokeTrace(["stage": "receive-chunk", "bytes": data.count, "buffer": outputBuffer.count])
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = Data(outputBuffer.prefix(upTo: newline))
            outputBuffer.removeSubrange(...newline)
            if line.count > 4 * 1024 * 1024 {
                failTransport("运行引擎消息超过安全长度。已停止后续请求；已有数据保留，请重新打开应用。")
                continue
            }
            if transportFailed { continue }
            let event: [String: Any]
            do {
                guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw NSError(domain: "WeiboReaderTransport", code: 1, userInfo: [NSLocalizedDescriptionKey: "运行引擎消息不是 JSON 对象"]) }
                event = object
            } catch {
                smokeTrace(["stage": "invalid-json-line", "bytes": line.count, "error": error.localizedDescription])
                if smoke { try? line.write(to: URL(fileURLWithPath: (argument("--snapshot") ?? "/private/tmp/weibo-reader-desktop.png") + ".bad-response.json")) }
                failTransport("运行引擎返回了无法读取的消息。已停止后续请求；已有数据保留，请重新打开应用。")
                continue
            }
            let type = event["type"] as? String ?? ""
            smokeTrace(["stage": "consume", "type": type, "bytes": line.count, "smokeStage": smokeStage, "requestId": event["requestId"] ?? NSNull(), "files": event["files"] ?? NSNull()])
            if type == "presentationSnapshotPart" {
                guard uiReady, event["workspace"] as? String == workspace,
                      event["documentEpoch"] as? Int == documentEpoch else { continue }
                deliver(event)
                continue
            }
            if smoke && ["followState", "updateHistory", "retentionSaved"].contains(type) { smokeFeatures.insert(type) }
            if smoke && type == "followState", let entries = event["entries"] as? [[String: Any]], entries.contains(where: { $0["uid"] as? String == "1234567890" && $0["enabled"] as? Bool == false }) { smokeFeatures.insert("pausedFollowSettings") }
            if type == "frontendState" {
                // Catch-up is presentation of facts already consumed from the
                // owned engine, never a second start/save/lifecycle transition.
                guard event["workspace"] as? String == workspace,
                      (event["documentEpoch"] as? Int ?? documentEpoch) == documentEpoch else { continue }
                if let active = event["active"] as? [String: Any], active["type"] as? String == "started", active["workspace"] as? String == workspace {
                    deliver(active)
                } else if let preparing = event["preparing"] as? [String: Any], preparing["type"] as? String == "preparing", preparing["workspace"] as? String == workspace {
                    deliver(preparing)
                }
                if let credits = event["credits"] as? [String: Any], credits["type"] as? String == "credits", credits["workspace"] as? String == workspace { deliver(credits) }
                continue
            }
            feedback.observe(event)
            if type == "started" { busy = true; automaticCollection = event["automatic"] as? Bool == true; ownedPID = Int32(event["pid"] as? Int ?? 0); savingData = (event["query"] as? [String: Any])?["syncOnly"] as? Bool == true }
            if type == "library", let accepted = event["workspace"] as? String, accepted.hasPrefix("/") {
                acceptedWorkspace = accepted
                if !smoke { persistWorkspace(accepted) }
                if let authorization = event["nativeWorkspaceId"] as? String ?? event["bootstrapId"] as? String,
                   !authorization.isEmpty, authorization.utf8.count <= 256 {
                    let acknowledgment = [accepted, authorization]
                    if acceptedLibraryAcknowledgment != acknowledgment {
                        acceptedLibraryAcknowledgment = acknowledgment
                        send(["action": "nativeWorkspaceAccepted", "workspace": accepted, "bootstrapId": authorization])
                    }
                }
            }
            if type == "localWriteState", let id = event["requestId"] as? String {
                if let writer = startupWriter, id == writer.requestId {
                    // The library may be accepted before local recovery and
                    // migration finish. Only this writer's settlement releases Quit.
                    if event["workspace"] as? String == writer.workspace, event["busy"] as? Bool == false {
                        localWriters.remove(id)
                        startupWriter = nil
                    }
                } else if event["busy"] as? Bool == true { localWriters.insert(id) }
                else { localWriters.remove(id) }
            }
            if ["foregroundQueued", "manualQueued"].contains(type), let id = event["id"] as? String { localWriters.insert("foreground:" + id) }
            if type == "foregroundDequeued", let id = event["id"] as? String { localWriters.remove("foreground:" + id) }
            if type == "exchangeBusy", let id = event["requestId"] as? String, event["workspace"] as? String == workspace {
                if event["busy"] as? Bool == true, exchangeWriter == nil {
                    exchangeWriter = (workspace, id)
                } else if event["busy"] as? Bool == false, exchangeWriter?.requestId == id, exchangeWriter?.workspace == workspace {
                    exchangeWriter = nil
                }
            }
            if type == "accountLoading" { ownedAccountPID = Int32(event["pid"] as? Int ?? 0) }
            if type == "preparing" || type == "merging" { busy = true; automaticCollection = type == "preparing" && event["automatic"] as? Bool == true }
            if type == "merged" || (type == "error" && ownedPID == 0) { busy = false; automaticCollection = false }
            if type == "finished" && event["kind"] as? String != "account" { busy = false; automaticCollection = false; ownedPID = 0; savingData = false }
            if smoke && type == "localExported", smokeStage == 1, let files = event["files"] as? [String], !files.isEmpty {
                smokeFeatures.insert("localExport"); smokeStage = 3
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.snapshotSmoke() }
            }
            if type == "open", let path = event["path"] as? String {
                if smoke { smokeActions.append(["kind": event["kind"] as? String ?? "", "path": path]); if event["kind"] as? String != "folder" { completeBrowserOpen(event) } }
                else {
                    open(path: path, kind: event["kind"] as? String ?? "report", onOpened: { self.completeBrowserOpen(event) }, onFailed: { message in self.completeBrowserOpen(event, error: message) })
                }
            } else { deliver(event) }
        }
        if outputBuffer.count > 4 * 1024 * 1024 { outputBuffer.removeAll(); failTransport("运行引擎消息超过安全长度。已停止后续请求；已有数据保留，请重新打开应用。") }
    }
    // The engine's original account request owns this reply. Never relabel a
    // delayed identity as belonging to whichever workspace is now selected.
    func completeBrowserOpen(_ event: [String: Any], error: String? = nil) {
        if error != nil { feedback.observe(["type":"browserOpenFailed"]) }
        var reply: [String: Any] = ["type": error == nil ? "browserOpened" : "browserOpenFailed", "id": event["id"] as? String ?? "", "workspace": event["workspace"] as? String ?? workspace]
        if let request = event["requestId"] { reply["requestId"] = request }
        if let error = error { reply["message"] = error }
        deliver(reply)
        if let ticket=event["handoffTicket"] as? String { localWriters.insert(ticket);send(["action":"reportHandoff","token":ticket,"success":error == nil,"requestId":ticket,"workspace":reply["workspace"]!]) }
        else if error == nil, let ticket = event["unreadTicket"] as? String { send(["action": "reportOpened", "token": ticket, "workspace": reply["workspace"]!]) }
    }
    func deliver(_ event: [String: Any]) {
        if !uiReady { queueBeforeFrontend(event); return }
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.weiboReceive(\(json));", completionHandler: nil)
    }
    // This is a small presentation fallback, never the owner of running work.
    // Native resource ownership, accepted workspaces and private diagnostics are
    // updated by consume even when ordinary home/progress payloads are dropped.
    func queueBeforeFrontend(_ original: [String: Any]) {
        let type = original["type"] as? String ?? ""
        var event = original
        if type == "library" {
            event = ["type": "library", "partial": true, "accounts": [], "favorites": [], "postFavorites": [], "reportKeep": 1]
            for key in ["workspace", "version", "bootstrapId"] { if let value = original[key] as? String { event[key] = value } }
            if original["homeBlocked"] as? Bool == true { event["homeBlocked"] = true }
        } else {
            let controls: Set<String> = ["engineStopped", "engineTransportError", "quitting", "refreshWarning", "error", "taskFutureError", "browserOpened", "browserOpenFailed", "feedbackPreview", "feedbackResult", "localError", "accountError", "recoveryError"]
            guard controls.contains(type) else { return }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: event), data.count <= queuedEventLimit else { return }
        func key(_ value: [String: Any]) -> [String] { ["type", "workspace", "requestId", "taskId", "scope"].map { value[$0] as? String ?? "" } }
        let identity = key(event)
        queued.removeAll { key($0) == identity }
        queuedBytes = queued.reduce(0) { $0 + ((try? JSONSerialization.data(withJSONObject: $1).count) ?? 0) }
        while !queued.isEmpty && (queued.count >= queuedCountLimit || queuedBytes + data.count > queuedByteLimit) {
            let removed = queued.removeFirst()
            queuedBytes -= (try? JSONSerialization.data(withJSONObject: removed).count) ?? 0
        }
        queued.append(event); queuedBytes += data.count
    }
    @discardableResult func frontendDidBecomeReady() -> Bool {
        guard !uiReady else { return false }
        uiReady = true
        let events = queued.filter { event in
            guard let origin = event["workspace"] as? String else { return true }
            return origin == workspace
        }
        queued.removeAll(); queuedBytes = 0
        for event in events { deliver(event) }
        // A late real frontend catches up from the same engine. It must not
        // recreate its scheduler, replay old task events or start another wire.
        send(["action": "frontendAttach", "workspace": workspace, "documentEpoch": documentEpoch])
        return true
    }
    func failTransport(_ message: String) {
        guard !transportFailed else { return }; transportFailed = true
        feedback.observe(["type":"transportFailed"])
        deliver(["type": "engineTransportError", "message": message]); send(["action": "shutdown"])
    }
    func handleFeedbackRequest(_ body: [String: Any]) -> Bool {
        guard let action = body["action"] as? String, ["feedbackPreview", "feedbackCopy", "feedbackExport"].contains(action) else { return false }
        let request = body["requestId"] as? String ?? ""
        if action == "feedbackPreview" || action == "feedbackExport" {
            feedbackRequest=request
            feedback.makeSnapshot(version:Bundle.main.object(forInfoDictionaryKey:"WeiboAppVersion") as? String ?? "unknown",build:Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "unknown") { bytes,text,summary in
                guard self.feedbackRequest==request else{return}
                if action == "feedbackExport" {self.saveRuntimeLog(bytes,request:request);return}
                let id=UUID().uuidString;self.feedbackPreview=(id,bytes,text)
                let preview=String(decoding:bytes.prefix(24*1024),as:UTF8.self)
                self.deliver(["type":"feedbackPreview","requestId":request,"snapshotId":id,"text":text,"preview":preview,"json":preview,"truncated":bytes.count>24*1024,"summary":summary])
            }
            return true
        }
        guard let preview=feedbackPreview,preview.id==body["snapshotId"] as? String else{deliver(["type":"feedbackResult","requestId":request,"status":"preview-required"]);return true}
        deliver(["type":"feedbackResult","requestId":request,"status":feedbackCopy(preview.text) ? "copied" : "failed"])
        return true
    }
    func saveRuntimeLog(_ bytes:Data,request:String) {
        let completed:(String)->Void={status in self.deliver(["type":"feedbackResult","requestId":request,"status":["saved","cancelled"].contains(status) ? status : "failed"])}
        if let save=feedbackSave {save(bytes,completed)}
        else {
            let panel=NSSavePanel();panel.nameFieldStringValue="Weibo-Reader-Runtime.log";panel.allowedFileTypes=["log","txt"];panel.canCreateDirectories=true
            panel.begin {response in
                guard response == .OK,let url=panel.url else{completed("cancelled");return}
                DispatchQueue.global(qos:.utility).async{let status:String;do{try bytes.write(to:url,options:.atomic);status="saved"}catch{status="failed"};DispatchQueue.main.async{completed(status)}}
            }
        }
    }
    func send(_ original: [String: Any]) {
        feedback.capture(original)
        guard !transportFailed || ["stop", "shutdown"].contains(original["action"] as? String ?? "") else { return }
        guard let handle = engineInput, var data = try? JSONSerialization.data(withJSONObject: original) else { return }
        data.append(10)
        do { try handle.write(contentsOf: data) }
        catch {
            if (original["action"] as? String)?.hasPrefix("exchange") == true {
                failTransport("无法连接运行引擎，请重新打开应用。")
            } else {
                deliver(["type": "error", "message": "无法连接运行引擎，请重新打开应用。"])
            }
        }
    }
    func forwardExchange(_ body: [String: Any]) {
        guard let origin = body["workspace"] as? String, origin == workspace,
              let id = body["requestId"] as? String, !id.isEmpty else { return }
        guard !quitting, !transportFailed, engineInput != nil, engine?.isRunning != false else {
            deliver(["type": "exchangeUnavailable", "workspace": origin, "requestId": id])
            return
        }
        send(body)
    }
    // Invoked only after the trusted main-frame check below. Keep one local
    // message route so local reads and explicit recovery decisions cannot silently
    // disappear in a second list. These still pass the engine’s identity/lock checks.
    func forwardLocalDataRequest(_ body: [String: Any]) -> Bool {
        guard let action = body["action"] as? String,
              ["localInventory", "localData", "localExport", "globalSearch", "searchPage", "searchOpen", "searchObjects", "coverageTimeline", "insightsCancel", "taskGapIgnore", "taskNoticeDismiss", "followMissingDismiss", "recoveryRetry", "taskFuturePreview", "taskFutureChoose", "postAuthorAvatar"].contains(action) else { return false }
        if action == "postAuthorAvatar" {
            guard body["workspace"] as? String == workspace, let id=body["requestId"] as? String, UUID(uuidString:id) != nil else { return true }
            if transportFailed || engineInput == nil || (engine.map{!$0.isRunning} ?? false) {
                var reply:[String:Any]=["type":"postAuthorAvatarResult","updated":false,"code":"ENGINE_STOPPED","message":"运行引擎未连接，请重新打开应用后重试。"]
                for key in ["requestId","workspace","postId","authorUid"]{if let value=body[key]{reply[key]=value}}
                deliver(reply);return true
            }
            localWriters.insert(id);send(body);return true
        }
        if ["taskFuturePreview","taskFutureChoose"].contains(action),transportFailed || engineInput==nil || (engine.map{!$0.isRunning} ?? false) {
            var reply:[String:Any]=["type":"taskFutureError","code":"ENGINE_STOPPED","message":"运行引擎未连接；请重新打开应用后核对恢复起点。已有数据保留。"]
            for key in ["requestId","workspace","uid","kind","taskId"]{if let value=body[key]{reply[key]=value}}
            feedback.capture(body);feedback.observe(reply);deliver(reply);return true
        }
        if ["localExport", "searchOpen", "taskGapIgnore", "taskNoticeDismiss", "followMissingDismiss", "recoveryRetry", "taskFutureChoose"].contains(action), let id = body["requestId"] as? String { localWriters.insert(id) }
        send(body)
        return true
    }
    func forwardAccountTaskRequest(_ body: [String: Any]) -> Bool {
        guard let action = body["action"] as? String,
              action == "loginCancel" else { return false }
        guard body["workspace"] as? String == workspace else { return true }
        send(body); return true
    }
    // Keep the captured origin even if another accepted library arrives while
    // the OS panel is open. The bridge revalidates it before any queued switch.
    func beginWorkspaceSelection(_ body: [String: Any]) -> WorkspaceSelection? {
        guard !quitting, !transportFailed, exchangeWriter == nil, workspaceSelection == nil, !busy || automaticCollection else { return nil }
        let origin = body["workspace"] as? String ?? workspace
        guard origin == workspace else { return nil }
        let requestId = body["requestId"] as? String ?? UUID().uuidString
        guard !requestId.isEmpty, requestId.utf8.count <= 4096 else { return nil }
        let selection = WorkspaceSelection(token: UUID(), workspace: origin, requestId: requestId)
        workspaceSelection = selection
        return selection
    }
    func completeWorkspaceSelection(_ selection: WorkspaceSelection, url: URL?) {
        guard workspaceSelection?.token == selection.token else { return }
        workspaceSelection = nil
        guard !quitting, let url = url, url.isFileURL else { return }
        send(["action": "workspace", "workspace": selection.workspace, "originWorkspace": selection.workspace, "requestId": selection.requestId, "path": url.path])
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.isFileURL == true,
              message.frameInfo.request.url?.standardizedFileURL.path == engineRoot.appendingPathComponent("desktop/ui/index.html").standardizedFileURL.path,
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if handleFeedbackRequest(body) { return }
        feedback.capture(body)
        guard !transportFailed || action.hasPrefix("exchange") || ["chooseDataExport", "chooseDataImport", "ready", "stop", "shutdown", "copy", "external", "taskFuturePreview", "taskFutureChoose"].contains(action) else { return }
        if forwardLocalDataRequest(body) { return }
        if forwardAccountTaskRequest(body) { return }
        switch action {
        case "ready":
            guard frontendDidBecomeReady() else { return }
            if smoke { DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.beginSmoke() } }
        case "startupListReady":
            guard let accepted=acceptedWorkspace,body["workspace"] as? String==accepted else{return}
            feedback.observe(["type":"startupListReady"])
            smokeTrace(["stage":"startup-list-ready"])
        case "chooseWorkspace":
            guard let selection = beginWorkspaceSelection(body) else { return }
            let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true; panel.prompt = "选择资料目录"
            panel.beginSheetModal(for: window) { result in
                self.completeWorkspaceSelection(selection, url: result == .OK ? panel.url : nil)
            }
        case "chooseDataExport":
            guard let origin = body["workspace"] as? String, origin == workspace, let id = body["requestId"] as? String else { return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = "WeiboReader-数据-" + String(Int(Date().timeIntervalSince1970)) + ".wrdpack"; panel.canCreateDirectories = true; panel.prompt = "导出数据包"
            panel.beginSheetModal(for: window) { result in
                guard origin == self.workspace else { return }
                guard result == .OK, let url = panel.url else { self.deliver(["type": "exchangeCancelled", "workspace": origin, "requestId": id]); return }
                self.forwardExchange(["action": "exchangeExport", "workspace": origin, "path": url.path, "selection": body["selection"] ?? "all", "requestId": id])
            }
        case "chooseDataImport":
            guard let origin = body["workspace"] as? String, origin == workspace, let id = body["requestId"] as? String else { return }
            let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.allowedFileTypes = ["wrdpack"]; panel.prompt = "检查数据包"
            panel.beginSheetModal(for: window) { result in
                guard origin == self.workspace else { return }
                guard result == .OK, let url = panel.url else { self.deliver(["type": "exchangeCancelled", "workspace": origin, "requestId": id]); return }
                self.forwardExchange(["action": "exchangeInspect", "workspace": origin, "path": url.path, "requestId": id])
            }
        case "exchangeObjects", "exchangeCommit", "exchangeDiscard": forwardExchange(body)
        case "copy":
            if let text = body["text"] as? String, text.utf8.count < 4 * 1024 * 1024 {
                NSPasteboard.general.clearContents()
                let copied = NSPasteboard.general.setString(text, forType: .string)
                deliver(["type": "copied", "success": copied])
            } else { deliver(["type": "copied", "success": false]) }
        case "external":
            guard let raw = body["url"] as? String, let url = managementExternalURL(raw) else { return }
            if smoke { smokeActions.append(["kind": "external", "url": url.absoluteString]) }
            else { openInBrowser(url, failureMessage: "无法打开微博链接") }
        case "userNoteSave", "postNoteSave", "postAdd", "postFavorite", "userAdd", "userViewed", "userProfileRetry", "userProfileDismiss", "userDeletePlan", "userDeleteConfirm", "resumeTaskPreview", "resumeTask": send(body)
        case "pricingReference", "pricingRefresh", "manageBatch", "manageDeletePlan", "manageDeleteConfirm", "profilesRefresh", "library", "run", "stop", "login", "logout", "account", "open", "output", "favorite", "merge", "updateHistory", "retention", "cleanup", "followList", "followSave", "followConfigure", "followResume", "followPause", "followRemove", "followWake": send(body)
        default: break
        }
    }
    func open(path: String, kind: String, onOpened: @escaping () -> Void = {}, onFailed: ((String) -> Void)? = nil) {
        let url = URL(fileURLWithPath: path)
        if kind == "folder" {
            let finder = URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app")
            openSystemURL(url, withApplicationAt: finder, failureMessage: "无法打开 Finder", onFailed: onFailed)
        } else {
            openInBrowser(url, failureMessage: "无法打开报告", onOpened: onOpened, onFailed: onFailed)
        }
    }
    func openInBrowser(_ url: URL, failureMessage: String, onOpened: @escaping () -> Void = {}, onFailed: ((String) -> Void)? = nil) {
        let browser = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://weibo.cn")!) ?? URL(fileURLWithPath: "/Applications/Safari.app")
        openSystemURL(url, withApplicationAt: browser, failureMessage: failureMessage, onOpened: onOpened, onFailed: onFailed)
    }
    // Keep the OS boundary separate from validation and routing. Success is only
    // acknowledged after macOS accepts the open, so failed opens stay unread.
    func openSystemURL(_ url: URL, withApplicationAt application: URL, failureMessage: String, onOpened: @escaping () -> Void = {}, onFailed: ((String) -> Void)? = nil) {
        NSWorkspace.shared.open([url], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            DispatchQueue.main.async {
                if let error = error { let message = "\(failureMessage)：\(error.localizedDescription)"; if let failed = onFailed { failed(message) } else { self.deliver(["type": "error", "message": message]) } }
                else { onOpened() }
            }
        }
    }
    func beginFrontendNavigation() {
        uiReady = false
        documentEpoch = min(documentEpoch + 1, 9_007_199_254_740_991)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { beginFrontendNavigation() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let target = navigationAction.request.url
        if target?.isFileURL == true && target?.standardizedFileURL.path == engineRoot.appendingPathComponent("desktop/ui/index.html").standardizedFileURL.path { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if engine?.isRunning != true { return .terminateNow }
        requestOwnedEngineQuit()
        return .terminateLater
    }
    // The actual Quit path is also exercised without creating an application UI.
    func requestOwnedEngineQuit() {
        if !quitting {
            feedback.observe(["type":"quitRequested"]); quitting = true; send(["action": "shutdown"])
            if ownedAccountPID > 0 { kill(-ownedAccountPID, SIGTERM) }
            if ownedPID > 0 && !savingData { kill(-ownedPID, SIGINT) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.pollOwnedEngineExit() }
        }
    }
    // Do not leave a blocked idle engine orphaned after acknowledging application
    // quit. Active saving is allowed to finish; a deadline never kills its writer.
    func replyAfterEngineExit() {
        guard quitting, !quitAnswered, engine?.isRunning != true else { return }
        quitAnswered = true; quitReply()
    }
    @discardableResult func stopOwnedIdleEngine(force: Bool) -> Bool {
        guard quitting, let process = engine, process.isRunning else { replyAfterEngineExit(); return true }
        guard !savingData, ownedPID == 0, exchangeWriter == nil, localWriters.isEmpty else { return false }
        if force { kill(process.processIdentifier, SIGKILL) }
        else { process.terminate() }
        return false
    }
    func pollOwnedEngineExit() {
        guard quitting, !quitAnswered else { return }
        if engine?.isRunning != true { replyAfterEngineExit(); return }
        if !savingData && ownedPID == 0 && exchangeWriter == nil && localWriters.isEmpty {
            stopOwnedIdleEngine(force: quitSignalSent); quitSignalSent = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.pollOwnedEngineExit() }
    }
    @objc func computerDidWake(_ notification: Notification) { if !quitting { send(["action": "followWake"]) } }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showMainWindow(); return true }
    func beginSmoke() {
        smokeStage = 1
        let target = argument("--smoke-target") ?? "1234567890"
        guard target.range(of: "^[0-9]{5,20}$", options: .regularExpression) != nil else { smokeFail("Invalid isolated smoke UID"); return }
        let limit = Int(argument("--smoke-limit") ?? "2") ?? 2
        guard limit > 0 else { smokeFail("Invalid smoke report limit"); return }
        let js = "send({action:'followSave',settings:{uid:'1234567890',mode:'both',interval:15,roundLimit:10,dailyBudget:30,enabled:false}});send({action:'followList'});send({action:'updateHistory',target:'\(target)',mode:'comments-both'});send({action:'retention',keep:3});openUser('\(target)');setTask('report');document.getElementById('limit').value='\(limit)';exportLocal();"
        web.evaluateJavaScript(js) { _, error in if let error = error { self.smokeFail(error.localizedDescription) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { if self.smokeStage < 3 { self.smokeFail("UI / engine smoke test timed out") } }
    }
    func snapshotSmoke() {
        let file = argument("--snapshot") ?? "/private/tmp/weibo-reader-desktop.png"
        let config = WKSnapshotConfiguration(); config.rect = web.bounds
        web.takeSnapshot(with: config) { image, error in
            if let image = image, let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: file)) }
            let js = "JSON.stringify({status:document.getElementById('status-pill').textContent,reports:document.querySelectorAll('#context-report-list .version-row').length,cost:document.getElementById('cost').textContent,overflow:document.documentElement.scrollWidth>innerWidth,errors:window.weiboErrors})"
            self.web.evaluateJavaScript(js) { value, jsError in
                var result: [String: Any] = ["success": error == nil && jsError == nil, "featureActions": Array(self.smokeFeatures), "ui": value as? String ?? "", "openActions": self.smokeActions, "mainWebViewOnly": self.window.contentView?.subviews.filter { $0 is WKWebView }.count == 1]
                if let error = error { result["error"] = error.localizedDescription }
                if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted) { try? data.write(to: URL(fileURLWithPath: file + ".json")) }
                NSApp.terminate(nil)
            }
        }
    }
    func smokeTrace(_ fields: [String: Any]) {
        guard smoke else { return }
        let path = argument("--smoke-trace") ?? (argument("--snapshot") ?? "/private/tmp/weibo-reader-desktop.png") + ".trace.jsonl"
        var event = fields; event["at"] = Date().timeIntervalSince1970
        guard var data = try? JSONSerialization.data(withJSONObject: event) else { return }; data.append(10)
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        if let handle = FileHandle(forWritingAtPath: path) { defer { try? handle.close() }; handle.seekToEndOfFile(); try? handle.write(contentsOf: data) }
    }
    func smokeFail(_ text: String) {
        guard smokeStage != 9 else { return }; smokeStage = 9
        let file = argument("--snapshot") ?? "/private/tmp/weibo-reader-desktop.png"
        smokeTrace(["stage": "failed", "message": text, "buffer": outputBuffer.count])
        let fallback: [String: Any] = ["success": false, "error": text]
        if let data = try? JSONSerialization.data(withJSONObject: fallback) { try? data.write(to: URL(fileURLWithPath: file + ".json")) }
        let js = "JSON.stringify({errors:window.weiboErrors,state:{view:state.view,task:state.task,localRequest:state.localRequest,localGenerating:state.localGenerating,localResult:state.localResult?.summary},counts:document.getElementById('local-counts')?.textContent,progress:document.getElementById('progress-message')?.textContent})"
        web.evaluateJavaScript(js) { value, error in
            var result = fallback; result["ui"] = value as? String ?? ""; result["buffer"] = self.outputBuffer.count; result["openActions"] = self.smokeActions
            if let error = error { result["jsError"] = error.localizedDescription }
            if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted) { try? data.write(to: URL(fileURLWithPath: file + ".json")) }
            NSApp.terminate(nil)
        }
    }
}

#if !WEIBO_NATIVE_TEST
@main
struct WeiboReaderMain {
 static var controller: ReaderController!
 static func main() {
  let application = NSApplication.shared
  application.setActivationPolicy(.regular)
  controller = ReaderController()
  application.delegate = controller
  application.run()
 }
}

#endif
