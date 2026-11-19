import Foundation
import CryptoKit
import Darwin
import CoreFoundation

// A strict projection of protocol facts, never a scrubbed copy of raw logs.
final class FeedbackDiagnostics {
    private(set) var events: [[String: Any]] = []
    private(set) var source = "local"
    private(set) var operation = "none"
    private(set) var lastCode = "NONE"
    private var contexts: [String:(String,String)] = [:]
    private var fault: (String,String,String)?
    private var sequence = 0
    private let clock = ISO8601DateFormatter()
    private var store: RuntimeLogStore?
    private var storageFailed=false
    private var anonymousKey=Data(UUID().uuidString.utf8)
    private var session=UUID().uuidString
    private var capturedRequests=Set<String>(), progressAt:[String:Date]=[:], starts:[String:Date]=[:]
    private var startupAt: Date?
    private var coalesced=0
    static let extraEvents:Set<String>=["request","appStarted","startupListReady","appExiting","quitRequested","library","localData","preparing","manualQueued","stopping","progress","source","phase","accountLoading","account",     "credits","localWriteState","recoveryFinished","exchangeProgress","userProfile", "taskFuturePreview","taskFutureCandidates","taskFutureChosen","taskFutureError","autoFrequency"]
    private static let storedEvents=extraEvents.union(["started","finished","summary","collection","autoSafety","error","localError","insightsError","exchangeError","localExported","searchOpened","engineStopped","transportFailed","engineStartFailed","browserOpenFailed","reportReadFailed","refreshWarning","accountError","followError","manageError","userNoteError","postNoteError","userDeleteError","postDeleteError","localInventoryError","pricingError","profileError","recoveryError"])
    static var architecture:String {
        #if arch(arm64)
        return "arm64"
        #else
        return "unknown"
        #endif
    }
    static let phases:Set<String>=["none","pending","prepare","preparing","running","collect","fetch","save","saving","saved","recover","recovery","finalize","finalizing","finished","cancelled","failed",  "waiting","checking","cancelling","identity","account","balance","query","parse","persist","request","response","account-initial","account-final","startup-list"]
    func enablePersistence(directory:URL) {
        do {let value=try RuntimeLogStore(directory:directory);store=value;anonymousKey=value.key}
        catch {storageFailed=true}
    }
    func finishSession(){observe(["type":"appExiting"]);store?.flush()}
    private func anonymous(_ kind:String,_ value:Any?)->String? {
        guard let raw=value as? String,!raw.isEmpty,raw.utf8.count<=4096 else{return nil}
        return kind+":"+HMAC<SHA256>.authenticationCode(for:Data((kind+":"+raw).utf8),using:SymmetricKey(data:anonymousKey)).prefix(12).map{String(format:"%02x",$0)}.joined()
    }
    private func contextKey(_ value:Any?)->String { anonymous("request",value) ?? "" }
    private func append(_ original:[String:Any]) {
        var item=original
        let version=Bundle.main.object(forInfoDictionaryKey:"WeiboAppVersion") as? String ?? "unknown",build=Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "unknown"
        item["appVersion"]=version;item["build"]=build
        guard let safe=Self.projectStored(item) else{return}
        events.append(safe)
        if events.count>128{events.removeFirst(events.count-128)}
        if let store=store,let data=Self.encode(safe){store.appendValidated(data,syncImmediately:Self.syncImmediately(safe))}
    }
    fileprivate static func encode(_ row:[String:Any])->Data? {
        try? JSONSerialization.data(withJSONObject:row,options:[.sortedKeys,.withoutEscapingSlashes])
    }
    fileprivate static func syncImmediately(_ row:[String:Any])->Bool {
        row["code"] as? String != "NONE" || ["appExiting","quitRequested"].contains(row["event"] as? String ?? "")
    }
    private func correlations(_ value:[String:Any],into item:inout [String:Any]) {
        for (field,kind) in [("requestId","request"),("taskId","task"),("workspace","workspace"),("scope","credential")] {if let id=anonymous(kind,value[field]){item[kind]=id}}
        let q=value["query"] as? [String:Any] ?? value
        let mode=q["mode"] as? String ?? "",kind=mode=="post-comments" || q["postId"] != nil ? "post" : "user"
        if let id=q["target"] as? String ?? q["postId"] as? String ?? q["uid"] as? String,id.range(of:"^[1-9][0-9]{4,19}$",options:.regularExpression) != nil {item["object"]=anonymous(kind,id)}
    }
    static func safeStored(_ data:Data)->Data? {
        guard let safe=decodeStored(data) else{return nil}
        return encode(safe)
    }
    fileprivate static func decodeStored(_ data:Data)->[String:Any]? {
        guard data.count<=16384,let row=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return nil}
        return projectStored(row)
    }
    private static func projectStored(_ row:[String:Any])->[String:Any]? {
        guard let type=row["event"] as? String,storedEvents.contains(type),let at=row["at"] as? String,at.range(of:"^[0-9TZ:.+-]{20,35}$",options:.regularExpression) != nil else{return nil}
        guard ISO8601DateFormatter().date(from:at) != nil else{return nil}
        var out:[String:Any]=["event":type,"at":at]
        for (k,pattern) in [("appVersion","^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}(?:-[A-Za-z0-9.]{1,20})?$"),("build","^[0-9]{1,8}$")] {if let v=row[k] as? String,v.range(of:pattern,options:.regularExpression) != nil {out[k]=v}}
        for k in ["request","task","workspace","credential","object"] {let prefix=k=="object" ? "(?:user|post)" : k;if let v=row[k] as? String,v.range(of:"^"+prefix+":[a-f0-9]{24}$",options:.regularExpression) != nil{out[k]=v}}
        if let v=row["session"] as? String,UUID(uuidString:v) != nil{out["session"]=v}
        if type=="autoFrequency" {
            guard let frequency=frequencyProjection(row["frequency"]),let source=row["source"] as? String,["cli"].contains(source),row["operation"] as? String=="subscription",let object=out["object"] as? String,out["task"] is String,out["workspace"] is String,!object.hasPrefix("post:") || frequency["trigger"] as? String=="any" else{return nil}
            if let sequence=count(row["sequence"]){out["sequence"]=sequence}
            out["frequency"]=frequency;out["source"]=source;out["operation"]="subscription";out["code"]="NONE"
            return out
        }
        for k in ["sequence","records","addedRecords","newRecords",    "fetchedRecords","returnedRecords","reusedRecords","durationMs","waitUntil","retryAt","status","httpStatus","page","attempts"] {if let n=row[k] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=((k=="waitUntil" || k=="retryAt") ? 9_000_000_000_000 : 1_000_000_000),n.doubleValue.rounded(.down)==n.doubleValue || k=="waitUntil" || k=="retryAt" {out[k]=Int64(n.doubleValue.rounded(.down))}}
        for k in ["incomplete","cancelled","coreSaved", "automatic","verified"] {if let n=row[k] as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID(){out[k]=n.boolValue}}
        let enums:[String:Set<String>]=["source":["local","cli"],"operation":operations,"code":codes,"phase":phases,"state":["waiting","checking","cancelling","preparing","verified","failed","cancelled"],"reason":["unknown","query-failed","invalid-json","schema-invalid","balance-missing","balance-invalid","ready"]]
        for (key,values) in enums {if let v=row[key] as? String,values.contains(v){out[key]=v}}
        if let kind=row["kind"] as? String,directionKinds.contains(kind){out["kind"]=kind}
        if let code=row["blockedCode"] as? String,codes.contains(code){out["blockedCode"]=code}
        if let list=row["blockedKinds"] as? [String]{out["blockedKinds"]=Array(list.prefix(8)).filter{directionKinds.contains($0)}}
        if let list=row["directions"] as? [[String:Any]]{
            var result:[[String:Any]]=[]
            for entry in list.prefix(8){guard let kind=entry["kind"] as? String,directionKinds.contains(kind),let outcome=entry["outcome"] as? String,directionOutcomes.contains(outcome) else{continue}
                var direction:[String:Any]=["kind":kind,"outcome":outcome]
                if let code=entry["code"] as? String,codes.contains(code){direction["code"]=code}
                for key in ["fetchedRecords","reusedRecords"]{if let n=count(entry[key]){direction[key]=n}}
                result.append(direction)
            };out["directions"]=result
        }
        return out
    }
    static let directionKinds:Set<String>=["sent","received","post-comments","user-posts","mentions-comments","mentions-posts"]
    static let frequencySteps:Set<Int>=[1,3,5,10,15,30]
    static let frequencyTriggers:Set<String>=["sent","received","any"]
    static let frequencyReasons:Set<String>=["activity","no-new","incomplete","unobserved","failed","baseline","replay","history"]
    static func frequencyProjection(_ value:Any?)->[String:Any]? {
        guard let value=value as? [String:Any],let before=count(value["beforeMinutes"]),frequencySteps.contains(before),let after=count(value["afterMinutes"]),frequencySteps.contains(after),let beforeQuiet=count(value["beforeQuiet"]),[0,1].contains(beforeQuiet),let afterQuiet=count(value["afterQuiet"]),[0,1].contains(afterQuiet),let trigger=value["trigger"] as? String,frequencyTriggers.contains(trigger),let reason=value["reason"] as? String,frequencyReasons.contains(reason) else{return nil}
        var out:[String:Any]=["beforeMinutes":before,"afterMinutes":after,"beforeQuiet":beforeQuiet,"afterQuiet":afterQuiet,"trigger":trigger,"reason":reason]
        if value["nextCheckAt"] is NSNull {out["nextCheckAt"]=NSNull()}
        else if let deadline=value["nextCheckAt"] as? String,deadline.range(of:"^[0-9TZ:.+-]{20,35}$",options:.regularExpression) != nil {
            let fractional=ISO8601DateFormatter();fractional.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            guard let date=fractional.date(from:deadline) ?? ISO8601DateFormatter().date(from:deadline),date.timeIntervalSince1970>=0,date.timeIntervalSince1970<=9_000_000_000 else{return nil};out["nextCheckAt"]=deadline
        }else{return nil}
        return out
    }
    static let directionOutcomes:Set<String>=["blocked","failed","service-rejected","caught-up","latest-checked","pending","saved","partial","unknown"]
    static func count(_ value:Any?)->Int? {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=100_000_000,n.doubleValue.rounded(.down)==n.doubleValue else{return nil};return n.intValue}
    static func directionProjection(_ value:[String:Any],blocked:Set<String>)->[String:Any]? {
        guard let kind=value["kind"] as? String,directionKinds.contains(kind) else{return nil}
        let state=value["dataStatus"] as? [String:Any] ?? [:],failure=value["requestFailure"] as? [String:Any] ?? state["requestFailure"] as? [String:Any] ?? [:],service=failure["serviceRejection"] as? [String:Any] ?? [:],update=value["update"] as? [String:Any] ?? [:],protection=update["protection"] as? [String:Any] ?? [:]
        let rawCode=service["code"] as? String ?? value["stopCode"] as? String ?? failure["code"] as? String ?? value["code"] as? String
        let code=rawCode.map{codes.contains($0) ? $0 : "UNKNOWN"} ?? ((value["failed"] as? Bool)==true ? "UNKNOWN" : "NONE")
        let outcome:String
        if code=="IP_GEO_DENIED"{outcome="service-rejected"}
        else if blocked.contains(kind)||["AUTO_OUTCOME_UNKNOWN","AUTO_BASELINE","AUTO_BODY_MISSING","AUTO_PRICE_UNKNOWN","AUTO_UNSUPPORTED","AUTO_BALANCE_UNKNOWN","AUTO_BALANCE","AUTO_IN_FLIGHT","AUTO_BOUNDARY","AUTO_FINALIZATION","AUTO_LEDGER_INVALID","AUTO_WORKER_BINDING"].contains(code){outcome="blocked"}
        else if ["AUTO_ROUND_LIMIT","AUTO_DAILY_BUDGET","AUTO_YIELD"].contains(code){outcome="pending"}
        else if value["failed"] as? Bool==true{outcome="failed"}
        else if update["caughtUp"] as? Bool==true{outcome="caught-up"}
        else if protection["latestSucceeded"] as? Bool==true{outcome="latest-checked"}
        else if state["pendingNew"] as? Bool==true || update["caughtUp"] as? Bool==false{outcome="pending"}
        else if state["incomplete"] as? Bool==true || value["partial"] as? Bool==true || value["coverageUnverified"] as? Bool==true{outcome="partial"}
        else if value["fetched"] != nil{outcome="saved"}else{outcome="unknown"}
        var out:[String:Any]=["kind":kind,"outcome":outcome,"code":code]
        if let n=count(value["fetched"]){out["fetchedRecords"]=n};if let n=count(value["reusedCount"]){out["reusedRecords"]=n}
        return out
    }
    static let operations: Set<String> = ["none", "post-comments", "comments-sent", "comments-received", "comments-both", "user-posts", "localExport", "searchOpen", "globalSearch", "coverageTimeline", "localData", "localInventory", "exchange", "account", "rank", "subscription", "note", "management", "profile", "recovery", "pricing"]
    static let codes: Set<String> = ["AUTO_BASELINE","AUTO_SINCE_IGNORED","AUTO_BODY_MISSING","AUTO_OUTCOME_UNKNOWN","AUTO_LEDGER_INVALID","AUTO_FINALIZATION","AUTO_SETTINGS_SAVE","AUTO_START_FAILED","AUTO_SETTLEMENT","AUTO_INTERRUPTED","AUTO_STATE_RECOVERY","AUTO_RETRY",      "AUTO_WORKER_BINDING","AUTO_BALANCE_UNKNOWN","AUTO_PRICE_UNKNOWN","AUTO_UNSUPPORTED","AUTO_DAILY_BUDGET","AUTO_BALANCE","AUTO_ROUND_LIMIT","AUTO_REQUEST_FAILED","AUTO_RESPONSE_INVALID","AUTO_REQUEST_RECORD","AUTO_IN_FLIGHT","AUTO_BOUNDARY","IP_GEO_DENIED","CLI_ACCOUNT_QUERY_FAILED","CLI_ACCOUNT_JSON","CLI_ACCOUNT_SCHEMA","CLI_ACCOUNT_BALANCE_MISSING","CLI_ACCOUNT_BALANCE_INVALID","NONE", "UNKNOWN", "ENGINE_START_FAILED", "ENGINE_STOPPED", "TRANSPORT_FAILED", "BROWSER_OPEN_FAILED", "USER_CANCELLED", "AUTO_YIELD",                "LOCAL_SNAPSHOT_BUSY", "LOCAL_SNAPSHOT_STALE", "LOCAL_SEARCH_LIMIT", "ERR_WORKER_OUT_OF_MEMORY", "LOCAL_SETTINGS_INVALID", "LOCAL_SOURCE_INVALID", "DATA_LOCK_BUSY", "EXCHANGE_INTERRUPTED", "REQUEST_EVIDENCE_INVALID","RESUME_EVIDENCE_INVALID", "POST_READING_EVIDENCE_CHANGED", "RECORD_ID_UNRELIABLE", "LOCAL_PROFILE_SOURCE_INVALID",  "EIO", "ENOSPC", "EACCES", "EPERM"]
    func capture(_ value: [String: Any]) {
        guard let action=value["action"] as? String,action.utf8.count<=64 else { return }
        let query=value["query"] as? [String:Any] ?? [:]
        var origin="local", op="none"
        if action=="run" { origin="cli"; let mode=query["mode"] as? String ?? "none"; op=query["operation"] as? String=="account" ? "account" : query["operation"] as? String=="rank" ? "rank" : Self.operations.contains(mode) ? mode : "none" }
        else if ["localExport","localData","localInventory","globalSearch","searchOpen","coverageTimeline"].contains(action) { op=action }
        else if action.hasPrefix("exchange") { op="exchange" }
        else if ["account","login","logout","loginCancel"].contains(action) { origin="cli"; op="account" }
        else if action.hasPrefix("follow") { origin="local"; op="subscription" }
        else if ["userNoteSave","postNoteSave"].contains(action) { op="note" }
        else if action.hasPrefix("manage") || action.hasPrefix("userDelete") || action.hasPrefix("postDelete") { op="management" }
        else if action=="profilesRefresh" || action=="userProfileRetry" { origin="cli"; op="profile" }
        else if ["recoveryRetry","taskGapIgnore","taskFuturePreview","taskFutureChoose"].contains(action) { op="recovery" }
        else if action=="pricing" { origin="cli"; op="pricing" }
        else { return }
        if let old=contexts[contextKey(value["requestId"])],["stop","loginCancel"].contains(action){origin=old.0;op=old.1}
        source=origin; operation=op
        let requestKey=contextKey(value["requestId"])
        if !requestKey.isEmpty { let id=requestKey; contexts[id]=(origin,op); if contexts.count>256,let first=contexts.keys.first { contexts.removeValue(forKey:first) } }
        let dedupe=requestKey+"|"+action
        if !requestKey.isEmpty {let id=requestKey;if capturedRequests.contains(dedupe){return};capturedRequests.insert(dedupe);if capturedRequests.count>512{capturedRequests.removeAll(keepingCapacity:true);capturedRequests.insert(dedupe)};starts[id]=Date();if starts.count>256,let first=starts.keys.first{starts.removeValue(forKey:first)}}
        sequence+=1;var item:[String:Any]=["sequence":sequence,"session":session,"at":clock.string(from:Date()),"event":"request","source":origin,"operation":op,"code":"NONE"]
        correlations(value,into:&item);append(item)
    }
    func observe(_ value: [String: Any]) {
        guard let type = value["type"] as? String, (Self.extraEvents.contains(type) || ["started", "finished", "summary", "collection", "autoSafety", "error", "localError", "insightsError", "exchangeError", "localExported", "searchOpened", "engineStopped", "transportFailed", "engineStartFailed", "browserOpenFailed", "reportReadFailed", "refreshWarning", "accountError", "followError", "manageError", "userNoteError", "postNoteError", "userDeleteError", "postDeleteError", "localInventoryError", "pricingError", "profileError", "recoveryError", "userProfile"].contains(type)) else { return }

        let frequency=type=="autoFrequency" ? Self.frequencyProjection(value["frequency"]) : nil
        if type=="autoFrequency" {
            guard frequency != nil,let origin=value["source"] as? String,["cli"].contains(origin),let kind=value["targetKind"] as? String,["user","post"].contains(kind),let uid=value["uid"] as? String,uid.range(of:"^[1-9][0-9]{4,19}$",options:.regularExpression) != nil,let workspace=value["workspace"] as? String,!workspace.isEmpty,workspace.utf8.count<=4096,let task=value["taskId"] as? String ?? value["roundId"] as? String ?? value["requestId"] as? String,!task.isEmpty,task.utf8.count<=4096 else{return}
            if kind=="post" && frequency?["trigger"] as? String != "any"{return}
        }
        if let q=value["query"] as? [String:Any],type=="started" { capture(["action":"run","requestId":value["requestId"] ?? value["taskId"] ?? "","query":q]) }
        let id=contextKey(value["requestId"] ?? value["taskId"])
        let context=contexts[id] ?? (id.isEmpty ? (source,operation) : ("local","none"))
        var eventSource=context.0, eventOperation=context.1
        let routes: [String:(String,String)] = ["accountError":("cli","account"), "userProfile":("cli","profile"), "userNoteError":("local","note"), "postNoteError":("local","note"), "manageError":("local","management"), "userDeleteError":("local","management"), "postDeleteError":("local","management"), "followError":("local","subscription"), "localInventoryError":("local","localInventory"), "pricingError":("cli","pricing"), "profileError":("cli","profile"), "recoveryError":("local","recovery")]
        if contexts[id]==nil,let action=value["action"] as? String,
           (type=="insightsError" && ["globalSearch","searchOpen","coverageTimeline"].contains(action) ||
            type=="localError" && ["localData","localExport"].contains(action)) { eventSource="local";eventOperation=action }
        if contexts[id]==nil,let route=routes[type] { eventSource=route.0;eventOperation=route.1 }
        if type=="refreshWarning" { eventSource="local";eventOperation="recovery" }
        if type=="autoFrequency" {eventSource=value["source"] as! String;eventOperation="subscription"}
        if type=="localExported" || type=="searchOpened" { eventSource="local"; eventOperation=type=="searchOpened" ? "searchOpen" : "localExport" }
        if type=="localData" {eventSource="local";eventOperation="localData"}
        let nativeCodes = ["engineStopped": "ENGINE_STOPPED", "transportFailed": "TRANSPORT_FAILED", "engineStartFailed": "ENGINE_START_FAILED", "browserOpenFailed": "BROWSER_OPEN_FAILED"]
        var ownCode="NONE"
        if type=="autoFrequency" {ownCode="NONE"}
        else if let code=nativeCodes[type] { ownCode=code }
        else if let code=value["code"] as? String { ownCode=Self.codes.contains(code) ? code : "UNKNOWN" }
        else if (type.hasSuffix("Error") || ["error","autoSafety","reportReadFailed","refreshWarning"].contains(type) || type=="userProfile" && value["profileStatus"] as? String=="error") { ownCode="UNKNOWN" }
        else if type=="finished",let exit=value["code"] as? Int,exit != 0 { ownCode="UNKNOWN" }
        let blocked=Set((value["blockedKinds"] as? [String] ?? []).prefix(8).filter{Self.directionKinds.contains($0)})
        let directions=type=="summary" ? ((value["sources"] as? [[String:Any]] ?? []).prefix(8).compactMap{Self.directionProjection($0,blocked:blocked)}) : []
        if ownCode=="NONE",let issue=directions.first(where:{["blocked","failed","service-rejected"].contains($0["outcome"] as? String ?? "") && $0["code"] as? String != "NONE"})?["code"] as? String{ownCode=issue}
        if ownCode != "NONE" { lastCode=ownCode;fault=(ownCode,eventSource,eventOperation) }
        source=eventSource;operation=eventOperation
        if type=="progress" || type=="collection" {let phase=value["phase"] as? String ?? "none",state=value["accountCheckState"] as? String ?? "none",kind=value["kind"] as? String ?? "none";let key=id+":"+type+":"+(kind.utf8.count<48 && Self.directionKinds.contains(kind) ? kind : "none")+":"+(phase.utf8.count<48 && Self.phases.contains(phase) ? phase : "none")+":"+(["waiting","checking","cancelling"].contains(state) ? state : "none");if let at=progressAt[key],Date().timeIntervalSince(at)<2{coalesced+=1;return};progressAt[key]=Date();if progressAt.count>256{progressAt.removeAll(keepingCapacity:true)}}
        sequence += 1
        var item: [String: Any] = ["sequence": sequence, "session":session, "at": clock.string(from: Date()), "event": type, "source": eventSource, "operation": eventOperation, "code": ownCode]
        if type=="autoFrequency" {
            var owner:[String:Any]=["uid":value["uid"]!,"workspace":value["workspace"]!,"taskId":(value["taskId"] as? String ?? value["roundId"] as? String ?? value["requestId"] as? String)!]
            if value["targetKind"] as? String=="post"{owner["postId"]=value["uid"]!}
            if let request=value["requestId"]{owner["requestId"]=request}
            correlations(owner,into:&item);item["frequency"]=frequency!
            append(item)
            return
        }
        for key in ["records", "addedRecords", "newRecords"] {
            if let n=value[key] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=100_000_000,n.doubleValue.rounded(.down)==n.doubleValue {item[key]=n.intValue}
        }
        if let incomplete = value["incomplete"] as? Bool { item["incomplete"] = incomplete }
        correlations(value,into:&item)
        for (from,to) in [("phase","phase"),("accountCheckState","state"),("accountCheckReason","reason"),("waitReason","reason"),("waitUntil","waitUntil"),("retryAt","retryAt"),("entry","entry"),("status","status"),("httpStatus","httpStatus"),("reason","reason"),("format","format"),("fields","fields"),("structure","structure"),("cancelled","cancelled"),("automatic","automatic"),("state","state"),("verified","verified"),("durationMs","durationMs")] {if let v=value[from] {
            if let string=v as? String {if string.utf8.count<=100{item[to]=string}}
            else if let n=v as? NSNumber{item[to]=n}
        }}
        if let kind=value["kind"] as? String,Self.directionKinds.contains(kind){item["kind"]=kind}
        if let n=Self.count(value["fetched"]){item["fetchedRecords"]=n};if let n=Self.count(value["newReturned"]){item["returnedRecords"]=n}
        if !blocked.isEmpty{item["blockedKinds"]=blocked.sorted()}
        if !directions.isEmpty{item["directions"]=directions}
        if let code=value["blockedCode"] as? String,Self.codes.contains(code){item["blockedCode"]=code}
        if let p=value["persistence"] as? [String:Any],let b=p["coreSaved"] as? Bool{item["coreSaved"]=b}
        if type=="appStarted"{startupAt=Date()}
        if type=="startupListReady" {
            guard let at=startupAt else{return}
            startupAt=nil
            item["phase"]="startup-list";item["durationMs"]=Self.elapsed(since:at)
        }
        if ["finished","localData","localExported","localError"].contains(type),let at=starts.removeValue(forKey:id){item["durationMs"]=Self.elapsed(since:at)}
        append(item)
    }
    private static func elapsed(since at:Date)->Int {max(0,min(604800000,Int(Date().timeIntervalSince(at)*1000)))}
    func snapshot(version:String,build:String) throws -> (Data,String) {let value=runtimeSnapshot(version:version,build:build);return(value.0,value.1)}
    func runtimeSnapshot(version:String,build:String,frozen:(Data,[String:Any])?=nil) -> (Data,String,[String:Any]) {
        var rows=Data(),summary:[String:Any]
        if let frozen=frozen {(rows,summary)=frozen} else if let store=store {(rows,summary)=store.snapshot(validate:Self.safeStored)} else {for row in events {if let raw=try? JSONSerialization.data(withJSONObject:row),let safe=Self.safeStored(raw){rows.append(safe);rows.append(10)}};summary=["rows":events.count,"bytes":rows.count,"startedAt":events.first?["at"] ?? "","endedAt":events.last?["at"] ?? "","dropped":0,"rotated":0,"invalidRows":0,"writeFailed":storageFailed,"retentionDays":7,"maxBytes":20*1024*1024]}
        summary["coalescedProgress"]=coalesced
        let validVersion=version.range(of:"^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}(?:-[A-Za-z0-9.]{1,20})?$",options:.regularExpression) != nil ? version : "unknown"
        let validBuild=build.range(of:"^[0-9]{1,8}$",options:.regularExpression) != nil ? build : "unknown",os=ProcessInfo.processInfo.operatingSystemVersion
        var latest=fault,builds:[String:Int]=[:],unknownBuildRows=0
        for line in rows.split(separator:10){
            guard let row=try? JSONSerialization.jsonObject(with:Data(line)) as? [String:Any] else{continue}
            if let version=row["appVersion"] as? String,let build=row["build"] as? String{builds[version+" ("+build+")",default:0]+=1}
            else{unknownBuildRows+=1}
            if fault==nil,let code=row["code"] as? String,Self.codes.contains(code),code != "NONE",let origin=row["source"] as? String,let action=row["operation"] as? String{latest=(code,origin,action)}
        }
        let covered=builds.keys.sorted()
        summary["builds"]=Dictionary(uniqueKeysWithValues:covered.prefix(32).map{($0,builds[$0]!)});summary["buildCount"]=covered.count;summary["unknownBuildRows"]=unknownBuildRows
        let displayedBuilds=Array(covered.prefix(8))+(builds.count>8 ? ["另有 \(builds.count-8) 个构建"] : [])+(unknownBuildRows>0 ? ["构建未知 \(unknownBuildRows) 条"] : [])
        let buildCoverage=displayedBuilds.isEmpty ? "暂无记录" : displayedBuilds.joined(separator:"、")
        let contextSource=latest?.1 ?? source,contextOperation=latest?.2 ?? operation,contextCode=latest?.0 ?? lastCode
        let generatedAt=Date()
        let metadata:[String:Any]=["appVersion":validVersion,"build":validBuild,"system":"macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)","architecture":Self.architecture,"generatedAt":ISO8601DateFormatter().string(from:generatedAt),"session":session,"source":contextSource,"operation":contextOperation,"errorCode":contextCode]
        var bytes=(try? JSONSerialization.data(withJSONObject:["format":"weibo-reader-runtime-log","schema":1,"metadata":metadata,"retention":summary],options:[.sortedKeys,.withoutEscapingSlashes])) ?? Data();bytes.append(10);bytes.append(rows)
        let dateFormatter=DateFormatter()
        dateFormatter.locale=Locale(identifier:"en_US_POSIX")
        dateFormatter.calendar=Calendar(identifier:.gregorian)
        dateFormatter.timeZone=TimeZone(secondsFromGMT:8*3600)
        dateFormatter.dateFormat="yyyy-MM-dd HH:mm:ss"
        let fractional=ISO8601DateFormatter()
        fractional.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        func display(_ value:Any?)->String? {
            guard let stamp=value as? String,let instant=fractional.date(from:stamp) ?? clock.date(from:stamp) else{return nil}
            return dateFormatter.string(from:instant)
        }
        let range=display(summary["startedAt"]).flatMap { first in display(summary["endedAt"]).map { first+" — "+$0 } } ?? "暂无时间记录"
        let text="Weibo Reader 问题反馈\n当前导出版本：\(validVersion)（build \(validBuild)）\n系统：macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion) / \(Self.architecture)\n生成时间：\(dateFormatter.string(from:generatedAt))\n来源：\(contextSource)\n操作：\(contextOperation)\n错误码：\(contextCode)\n运行日志：\(summary["rows"] ?? 0) 条，保留区间 \(range)\n日志覆盖构建：\(buildCoverage)\n\n复现步骤：\n1. \n\n预期表现：\n\n实际表现：\n\n运行日志只包含安全结构化时间线，不含正文、昵称、原始输出或个人路径；请由你选择发送。"
        return(bytes,text,summary)
    }
    func makeSnapshot(version:String,build:String,completion:@escaping (Data,String,[String:Any])->Void) {
        // Copy the bounded memory view on its owner thread before background IO.
        let copy=FeedbackDiagnostics();copy.events=events;copy.store=store;copy.storageFailed=storageFailed;copy.source=source;copy.operation=operation;copy.lastCode=lastCode;copy.fault=fault;copy.coalesced=coalesced;copy.session=session
        let finish:((Data,[String:Any])?)->Void={frozen in let value=copy.runtimeSnapshot(version:version,build:build,frozen:frozen);DispatchQueue.main.async{completion(value.0,value.1,value.2)}}
        // Enqueue the freeze here, before later owner-thread events can append.
        if let store=store {store.snapshotAsync{finish($0)}} else {DispatchQueue.global(qos:.utility).async{finish(nil)}}
    }

}

// Private derived logs, never acquisition evidence. All IO is serial and bounded;
// unknown/unsafe fields are discarded before enqueue and again on export.
final class RuntimeLogStore {
    let directory: URL, key: Data
    private let queue=DispatchQueue(label:"selnokk.weibo.reader.runtime-log",qos:.utility),lock=NSLock()
    private let now:()->Date,segmentLimit:Int,totalLimit:Int,retention:TimeInterval
    private var root:Int32 = -1,descriptor:Int32 = -1,segmentBytes=0,queued=0
    private var segmentName:String?,diskBytes=0,oldestSegment:TimeInterval=0
    private var failures=0,dropped=0,rotated=0,invalid=0
    private var ordinal:UInt64=0,opened=false,syncScheduled=false,dirty=false
    var failWriteForTest:(()->Bool)?
    var partialWriteForTest:(()->Int?)?
    init(directory:URL,now:@escaping()->Date=Date.init,segmentLimit:Int=1024*1024,totalLimit:Int=20*1024*1024,retention:TimeInterval=7*86400) throws {
        self.directory=directory;self.now=now;self.segmentLimit=max(512,segmentLimit);self.totalLimit=max(1024,totalLimit);self.retention=retention
        let fm=FileManager.default,parent=directory.deletingLastPathComponent()
        try Self.checkAncestors(parent)
        if !fm.fileExists(atPath:parent.path){try fm.createDirectory(at:parent,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
        if !fm.fileExists(atPath:directory.path){try fm.createDirectory(at:directory,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
        var s=stat();guard lstat(directory.path,&s)==0,(s.st_mode&S_IFMT)==S_IFDIR,s.st_uid==getuid(),s.st_mode&0o077==0 else{throw Self.failure()}
        root=Darwin.open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK)
        guard root>=0 else{throw Self.failure()}
        do {
            guard flock(root,LOCK_EX|LOCK_NB)==0 else{throw Self.failure()}
            if let existing=try Self.read(root,"identity.key",limit:32){guard existing.count==32 else{throw Self.failure()};key=existing}
            else{let generated=Data((0..<32).map{_ in UInt8.random(in:0...255)});try Self.atomic(root,"identity.key",generated);key=generated}
            if let data=try Self.read(root,"status.json",limit:4096){
                guard let v=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw Self.failure()}
                func count(_ name:String)->Int{guard let n=v[name] as? Int,n>=0,n<1_000_000_000 else{return 0};return n}
                failures=count("writeFailures");dropped=count("dropped");rotated=count("rotated");invalid=count("invalid")
            }
        }catch{Darwin.close(root);root = -1;throw error}
    }
    deinit{if descriptor>=0{Darwin.close(descriptor)};if root>=0{Darwin.close(root)}}
    static func failure()->NSError{NSError(domain:"RuntimeLog",code:1)}
    private static func checkAncestors(_ path:URL)throws{
        var ancestor=path
        while ancestor.path != "/"{
            var s=stat()
            if lstat(ancestor.path,&s)==0{
                if (s.st_mode&S_IFMT) != S_IFDIR {
                    // macOS system aliases only; user-controlled ancestors must be real directories.
                    guard ["/var","/tmp"].contains(ancestor.path),(s.st_mode&S_IFMT)==S_IFLNK else{throw failure()}
                }
            }else if errno != ENOENT{throw failure()}
            ancestor=ancestor.deletingLastPathComponent()
        }
    }
    private static func regular(_ fd:Int32,limit:Int)throws->stat{
        var s=stat();guard fstat(fd,&s)==0,(s.st_mode&S_IFMT)==S_IFREG,s.st_uid==getuid(),s.st_mode&0o077==0,s.st_size>=0,s.st_size<=limit else{throw failure()};return s
    }
    private static func read(_ root:Int32,_ name:String,limit:Int)throws->Data?{
        let fd=openat(root,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if fd<0{if errno==ENOENT{return nil};throw failure()};defer{Darwin.close(fd)}
        let s=try regular(fd,limit:limit);var result=Data(),buffer=[UInt8](repeating:0,count:8192)
        while result.count<=limit{let n=Darwin.read(fd,&buffer,min(buffer.count,limit+1-result.count));if n==0{break};guard n>0 else{throw failure()};result.append(contentsOf:buffer.prefix(n))}
        let end=try regular(fd,limit:limit);guard result.count<=limit,s.st_ino==end.st_ino,s.st_size==end.st_size,s.st_mtimespec.tv_sec==end.st_mtimespec.tv_sec,s.st_mtimespec.tv_nsec==end.st_mtimespec.tv_nsec else{throw failure()};return result
    }
    private static func atomic(_ root:Int32,_ name:String,_ data:Data)throws{
        var old=stat();if fstatat(root,name,&old,AT_SYMLINK_NOFOLLOW)==0{guard(old.st_mode&S_IFMT)==S_IFREG,old.st_uid==getuid(),old.st_mode&0o077==0 else{throw failure()}}else if errno != ENOENT{throw failure()}
        let temp=".write-"+UUID().uuidString,fd=openat(root,temp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK,0o600)
        guard fd>=0 else{throw failure()};defer{Darwin.close(fd);unlinkat(root,temp,0)}
        try writeAll(fd,data);guard fsync(fd)==0,renameat(root,temp,root,name)==0,fsync(root)==0 else{throw failure()}
    }
    private static func writeAll(_ fd:Int32,_ data:Data)throws{try data.withUnsafeBytes{buffer in var offset=0;while offset<buffer.count{let n=Darwin.write(fd,buffer.baseAddress!.advanced(by:offset),buffer.count-offset);guard n>0 else{throw failure()};offset+=n}}}
    private func checkRoot()throws{
        try Self.checkAncestors(directory.deletingLastPathComponent())
        var a=stat(),b=stat();guard fstat(root,&a)==0,lstat(directory.path,&b)==0,(b.st_mode&S_IFMT)==S_IFDIR,b.st_mode&0o077==0,a.st_dev==b.st_dev,a.st_ino==b.st_ino else{throw Self.failure()}
    }
    private func files()throws->[(String,Int,TimeInterval)]{
        try checkRoot();var result:[(String,Int,TimeInterval)]=[],count=0
        guard let names=FileManager.default.enumerator(atPath:directory.path) else{throw Self.failure()}
        while let name=names.nextObject() as? String{
            names.skipDescendants();count+=1;guard count<=4096 else{throw Self.failure()}
            guard name.range(of:"^run-[0-9]{20}-[0-9]{13}-[A-Fa-f0-9-]{36}\\.jsonl$",options:.regularExpression) != nil else{continue}
            var s=stat();guard fstatat(root,name,&s,AT_SYMLINK_NOFOLLOW)==0,(s.st_mode&S_IFMT)==S_IFREG,s.st_uid==getuid(),s.st_mode&0o077==0,s.st_size>=0,s.st_size<=segmentLimit+16384 else{throw Self.failure()}
            let parts=name.split(separator:"-");guard let serial=UInt64(parts[1]),let millis=Double(parts[2]) else{throw Self.failure()}
            ordinal=max(ordinal,serial);result.append((name,Int(s.st_size),millis/1000))
        }
        return result.sorted{$0.0<$1.0}
    }
    private var dataLimit:Int{totalLimit-min(8192,totalLimit/8)}
    private func closeSegment(){if descriptor>=0{Darwin.close(descriptor);descriptor = -1};segmentName=nil;segmentBytes=0;dirty=false}
    private func prepareAppend(_ incoming:Int)throws{
        if let name=segmentName,segmentBytes+incoming<=segmentLimit,diskBytes+incoming<=dataLimit,
           oldestSegment>=now().timeIntervalSince1970-retention {
            try checkRoot()
            let current=try Self.regular(descriptor,limit:segmentLimit)
            var named=stat()
            guard fstatat(root,name,&named,AT_SYMLINK_NOFOLLOW)==0,current.st_ino==named.st_ino,
                  current.st_dev==named.st_dev,current.st_size==segmentBytes else{throw Self.failure()}
            return
        }
        try rotate(incoming)
    }
    private func rotate(_ incoming:Int)throws{
        var rows=try files(),total=rows.reduce(0){$0+$1.1}
        while let first=rows.first,first.2<now().timeIntervalSince1970-retention || total+incoming>dataLimit || rows.count>=64{
            if descriptor>=0{guard fsync(descriptor)==0 else{throw Self.failure()};closeSegment()}
            guard unlinkat(root,first.0,0)==0 else{throw Self.failure()};total-=first.1;rows.removeFirst();rotated+=1
        }
        if !opened {
            opened=true
            if let last=rows.last,last.1+incoming<=segmentLimit,last.1>0{
                let fd=openat(root,last.0,O_RDWR|O_APPEND|O_NOFOLLOW|O_NONBLOCK)
                if fd>=0{do{let s=try Self.regular(fd,limit:segmentLimit);var byte:UInt8=0
                    if s.st_size==last.1,pread(fd,&byte,1,s.st_size-1)==1,byte==10{descriptor=fd;segmentName=last.0;segmentBytes=last.1}else{Darwin.close(fd)}
                }catch{Darwin.close(fd);throw error}}
            }
        }
        var first=rows.first?.2
        if descriptor<0 || segmentBytes+incoming>segmentLimit{
            if descriptor>=0{guard fsync(descriptor)==0 else{throw Self.failure()};closeSegment()}
            guard ordinal<UInt64.max else{throw Self.failure()};ordinal+=1
            let millis=max(Int64(1_000_000_000_000),min(Int64(9_999_999_999_999),Int64(now().timeIntervalSince1970*1000)))
            let name="run-"+String(format:"%020llu",ordinal)+"-"+String(millis)+"-"+UUID().uuidString+".jsonl"
            descriptor=openat(root,name,O_WRONLY|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK,0o600);segmentName=name;segmentBytes=0
            guard descriptor>=0,fsync(root)==0 else{throw Self.failure()}
            if first==nil{first=Double(millis)/1000}
        }
        diskBytes=total;oldestSegment=first ?? now().timeIntervalSince1970
    }
    func append(_ row:Data){
        guard let safe=FeedbackDiagnostics.decodeStored(row),let data=FeedbackDiagnostics.encode(safe) else{lock.lock();dropped+=1;lock.unlock();return}
        appendValidated(data,syncImmediately:FeedbackDiagnostics.syncImmediately(safe))
    }
    fileprivate func appendValidated(_ safe:Data,syncImmediately:Bool){
        guard safe.count<=16384,safe.count+1<=dataLimit else{lock.lock();dropped+=1;lock.unlock();return}
        lock.lock();if queued>=512{dropped+=1;lock.unlock();return};queued+=1;lock.unlock()
        queue.async{
            defer{self.lock.lock();self.queued-=1;self.lock.unlock()}
            do{
                if self.failWriteForTest?()==true{throw Self.failure()}
                try self.prepareAppend(safe.count+1)
                if let limit=self.partialWriteForTest?(){try Self.writeAll(self.descriptor,safe.prefix(max(0,limit)));throw Self.failure()}
                try Self.writeAll(self.descriptor,safe+Data([10]));self.segmentBytes+=safe.count+1;self.diskBytes+=safe.count+1;self.dirty=true
                if syncImmediately{try self.sync()}
                self.scheduleSync()
            }catch{self.closeSegment();self.lock.lock();self.failures+=1;self.lock.unlock()}
        }
    }
    private func scheduleSync(){guard !syncScheduled else{return};syncScheduled=true
        queue.asyncAfter(deadline:.now()+2){[weak self] in guard let self=self else{return};self.syncScheduled=false;do{try self.checkRoot();try self.sync();self.saveStatus()}catch{self.lock.lock();self.failures+=1;self.lock.unlock()}}
    }
    private func sync()throws{if descriptor>=0 && dirty{guard fsync(descriptor)==0 else{throw Self.failure()};dirty=false}}
    func flush(timeout:TimeInterval=0.3){
        let group=DispatchGroup();group.enter()
        queue.async{[weak self] in self?.flushPending();group.leave()}
        _ = group.wait(timeout:.now()+timeout)
    }
    private func flushPending(){
        do{try checkRoot();try sync()}catch{lock.lock();failures+=1;lock.unlock()}
        saveStatus()
    }
    private func saveStatus(){lock.lock();let values=["writeFailures":failures,"dropped":dropped,"rotated":rotated,"invalid":invalid];lock.unlock()
        if let data=try? JSONSerialization.data(withJSONObject:values,options:.sortedKeys){do{try Self.atomic(root,"status.json",data)}catch{lock.lock();failures+=1;lock.unlock()}}
    }
    private func snapshotLocked()->(Data,[String:Any]){
        var output=Data(),rows=0,first="",last=""
        do{try sync();let all=try files()
            for(name,_,at) in all where at>=now().timeIntervalSince1970-retention{
                guard let data=try Self.read(root,name,limit:segmentLimit+16384) else{continue}
                let parts=data.split(separator:10,omittingEmptySubsequences:false)
                for(index,line) in parts.enumerated() where !line.isEmpty{
                    guard index<parts.count-1,let row=FeedbackDiagnostics.decodeStored(Data(line)),let safe=FeedbackDiagnostics.encode(row) else{invalid+=1;continue}
                    guard output.count+safe.count+1<=dataLimit else{lock.lock();dropped+=1;lock.unlock();continue}
                    output.append(safe);output.append(10);rows+=1
                    if let date=row["at"] as? String{if first.isEmpty{first=date};last=date}
                }
            }
        }catch{lock.lock();failures+=1;lock.unlock()}
        saveStatus();lock.lock();let failureCount=failures,dropCount=dropped;lock.unlock()
        return(output,["rows":rows,"bytes":output.count,"startedAt":first,"endedAt":last,"dropped":dropCount,"rotated":rotated,"invalidRows":invalid,"writeFailed":failureCount>0,"writeFailures":failureCount,"retentionDays":Int(retention/86400),"maxBytes":totalLimit])
    }
    func snapshot(validate:(Data)->Data?)->(Data,[String:Any]){queue.sync{snapshotLocked()}}
    func snapshotAsync(completion:@escaping((Data,[String:Any]))->Void){queue.async{completion(self.snapshotLocked())}}
}
