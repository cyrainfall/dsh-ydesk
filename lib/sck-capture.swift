// dsh-ydesk screen capture helper for macOS.
//
// AVFoundation's AVCaptureScreenInput is unreliable on recent macOS releases
// (it can open the device and then deliver no frames at all). ScreenCaptureKit
// is the supported path and behaves the same as the system screenshot tools.
//
// Modes:
//   --probe            print "<width> <height>" of the main display, exit 0
//   --fps N            stream at N frames per second (default 30)
//   --cursor 0|1       include the pointer (default 1)
//   --width N          scale the capture down to N pixels wide (0 = native)
//   --height N         together with --width
//   (default)          print "READY" on stderr, then write raw NV12 frames
//                      (Y plane + interleaved UV, stride packed) to stdout.
import Foundation
import ScreenCaptureKit

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(("ERR " + message + "\n").data(using: .utf8)!)
    exit(code)
}

var probe = false
var fps = 30
var cursor = true
var outWidth = 0
var outHeight = 0
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    switch arg {
    case "--probe": probe = true
    case "--fps": fps = max(1, Int(args.next() ?? "30") ?? 30)
    case "--cursor": cursor = (args.next() ?? "1") != "0"
    case "--width": outWidth = max(0, Int(args.next() ?? "0") ?? 0)
    case "--height": outHeight = max(0, Int(args.next() ?? "0") ?? 0)
    default: break
    }
}

func displaySize() -> (SCDisplay?, Int, Int) {
    let sem = DispatchSemaphore(value: 0)
    var found: SCDisplay?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            found = content.displays.first
        } catch {
            fail("shareable content: \(error.localizedDescription)", 3)
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 10)
    guard let display = found else { fail("no display", 2) }
    return (display, display.width, display.height)
}

let (maybeDisplay, nativeWidth, nativeHeight) = displaySize()
guard let display = maybeDisplay else { fail("no display", 2) }
if probe {
    print("\(nativeWidth) \(nativeHeight)")
    exit(0)
}
// Even dimensions keep the encoder and the raw stride happy.
var width = outWidth > 0 ? outWidth : nativeWidth
var height = outHeight > 0 ? outHeight : nativeHeight
width -= width % 2
height -= height % 2

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
    let width: Int
    let height: Int
    let out = FileHandle.standardOutput
    let queue = DispatchQueue(label: "dsh-ydesk.frames")

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(buffer), CMSampleBufferGetNumSamples(buffer) > 0 else { return }
        guard let image = CMSampleBufferGetImageBuffer(buffer) else { return }
        CVPixelBufferLockBaseAddress(image, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(image, 0) else { return }
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
        let srcW = CVPixelBufferGetWidth(image)
        let srcH = CVPixelBufferGetHeight(image)
        let w = min(width, srcW)
        let h = min(height, srcH)
        var frame = Data(count: width * height * 3 / 2)
        frame.withUnsafeMutableBytes { raw in
            guard let dst = raw.baseAddress else { return }
            for y in 0..<h {
                memcpy(dst.advanced(by: y * width), yBase.advanced(by: y * yStride), w)
                if w < width { memset(dst.advanced(by: y * width + w), 16, width - w) }
            }
            // Interleaved CbCr plane, half resolution.
            if let uvBase = CVPixelBufferGetBaseAddressOfPlane(image, 1) {
                let uvStride = CVPixelBufferGetBytesPerRowOfPlane(image, 1)
                let uvW = min(width, srcW) // bytes; two samples per pixel pair
                let uvH = (h + 1) / 2
                for y in 0..<uvH {
                    memcpy(dst.advanced(by: width * height + y * width), uvBase.advanced(by: y * uvStride), uvW)
                    if uvW < width { memset(dst.advanced(by: width * height + y * width + uvW), 128, width - uvW) }
                }
            } else {
                memset(dst.advanced(by: width * height), 128, width * height / 2)
            }
            // Fill the remaining rows below h with neutral chroma.
            if h < height {
                memset(dst.advanced(by: h * width), 16, (height - h) * width)
            }
        }
        queue.async { [weak self] in
            guard let self else { return }
            try? self.out.write(contentsOf: frame)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("stream stopped: \(error.localizedDescription)", 5)
    }
}

let sink = Sink(width: width, height: height)
let sem = DispatchSemaphore(value: 0)
Task {
    do {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.scalesToFit = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.showsCursor = cursor
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.queueDepth = 3
        let stream = SCStream(filter: filter, configuration: config, delegate: sink)
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "dsh-ydesk.capture"))
        try await stream.startCapture()
        FileHandle.standardError.write("READY\n".data(using: .utf8)!)
        signal(SIGTERM) { _ in exit(0) }
        signal(SIGINT) { _ in exit(0) }
        sem.wait()
    } catch {
        fail("start: \(error.localizedDescription)", 4)
    }
}
sem.wait()
