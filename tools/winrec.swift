// Records one window to an .mov with ScreenCaptureKit (macOS 15+), until SIGINT/SIGTERM.
// Usage: winrec <window-id> <out-base> [fps]   (writes <out-base>.0.mov, .1.mov, ...)
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation

@available(macOS 15.0, *)
final class Recorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
  // The system can stop a capture on its own (SCStreamErrorDomain -3821). When it does, a new
  // segment starts at once; each segment's start time goes to stderr so the pieces can be laid
  // back on one timeline (scripts/assemble-rec.py).
  var stream: SCStream?
  var output: SCRecordingOutput?
  let done = DispatchSemaphore(value: 0)
  var stopping = false
  var segment = 0
  var windowID: CGWindowID = 0
  var base = ""
  var fps = 30

  func start(windowID: CGWindowID, base: String, fps: Int) async throws {
    self.windowID = windowID; self.base = base; self.fps = fps
    try await startSegment()
  }

  func startSegment() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    // windowID 0 means: the largest window whose title contains WINREC_TITLE.
    let wanted = ProcessInfo.processInfo.environment["WINREC_TITLE"] ?? ""
    let match: SCWindow? = windowID != 0
      ? content.windows.first(where: { $0.windowID == windowID })
      : content.windows.filter { ($0.title ?? "").contains(wanted) && $0.frame.width > 400 }.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
    guard let window = match else {
      throw NSError(domain: "winrec", code: 1, userInfo: [NSLocalizedDescriptionKey: "window \(windowID) not found"])
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let cfg = SCStreamConfiguration()
    let scale = Double(SCShareableContent.info(for: filter).pointPixelScale)
    cfg.width = Int(window.frame.width * scale)
    cfg.height = Int(window.frame.height * scale)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.showsCursor = false
    cfg.capturesAudio = false
    let path = "\(base).\(segment).mov"
    let recCfg = SCRecordingOutputConfiguration()
    recCfg.outputURL = URL(fileURLWithPath: path)
    recCfg.outputFileType = .mov
    recCfg.videoCodecType = .h264
    let rec = SCRecordingOutput(configuration: recCfg, delegate: self)
    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
    try s.addRecordingOutput(rec)
    try await s.startCapture()
    stream = s
    output = rec
    FileHandle.standardError.write("segment \(path) \(Date().timeIntervalSince1970) \(cfg.width)x\(cfg.height)\n".data(using: .utf8)!)
    segment += 1
  }

  func stop() async {
    stopping = true
    if stream == nil { done.signal(); return }
    try? await stream?.stopCapture()
  }

  func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
    if stopping { done.signal() }
  }
  func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
    FileHandle.standardError.write("recording failed: \(error)\n".data(using: .utf8)!)
    if stopping { done.signal() }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("stream stopped: \(error)\n".data(using: .utf8)!)
    self.stream = nil
    if stopping { done.signal(); return }
    Task {
      for attempt in 1...40 {
        if self.stopping { return }
        do { try await self.startSegment(); return } catch {
          FileHandle.standardError.write("restart \(attempt) failed: \(error)\n".data(using: .utf8)!)
          try? await Task.sleep(nanoseconds: 250_000_000)
        }
      }
    }
  }
}

let args = CommandLine.arguments
guard args.count >= 3, let wid = UInt32(args[1]) else {
  print("usage: winrec <window-id> <out-base> [fps]"); exit(2)
}
let fps = args.count > 3 ? Int(args[3]) ?? 30 : 30
let base = args[2]
_ = NSApplication.shared  // ScreenCaptureKit needs a CoreGraphics session
if #available(macOS 15.0, *) {
  let r = Recorder()
  let started = DispatchSemaphore(value: 0)
  var failed = false
  Task {
    do { try await r.start(windowID: wid, base: base, fps: fps) } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); failed = true }
    started.signal()
  }
  started.wait()
  if failed { exit(1) }
  let stopper: @convention(c) (Int32) -> Void = { _ in }
  signal(SIGINT, stopper); signal(SIGTERM, stopper)
  let src = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
  let src2 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
  let handler: () -> Void = { Task { await r.stop() } }
  src.setEventHandler(handler: handler); src2.setEventHandler(handler: handler)
  src.resume(); src2.resume()
  r.done.wait()
  FileHandle.standardError.write("saved \(r.segment) segment(s) to \(base).*.mov\n".data(using: .utf8)!)
  exit(0)
} else {
  print("needs macOS 15"); exit(2)
}
