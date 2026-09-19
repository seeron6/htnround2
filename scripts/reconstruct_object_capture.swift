// Independent, local geometry experiment using the macOS SDK. No cloud service.
// xcrun swiftc -parse-as-library scripts/reconstruct_object_capture.swift -o .local/object-capture
// .local/object-capture INPUT_RGBA_DIRECTORY NEW_OUTPUT_DIRECTORY
import Foundation
import RealityKit
import CoreImage
import CoreVideo
import ImageIO

enum ReconstructionError: Error { case unsupported, arguments, image(String), outputExists }

@main struct LocalHeadReconstruction {
    static func main() async throws {
        setbuf(stdout, nil)
        guard (3...4).contains(CommandLine.arguments.count) else { throw ReconstructionError.arguments }
        guard PhotogrammetrySession.isSupported else { throw ReconstructionError.unsupported }
        let input = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        guard !FileManager.default.fileExists(atPath: output.path) else { throw ReconstructionError.outputExists }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let files = try FileManager.default.contentsOfDirectory(at: input, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.lowercased() == "png" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        let context = CIContext()
        let rgb = CGColorSpace(name: CGColorSpace.sRGB)!
        var names: [Int: String] = [:]
        let samples = try files.enumerated().map { index, file -> PhotogrammetrySample in
            guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw ReconstructionError.image(file.path) }
            let width = cg.width, height = cg.height
            var image: CVPixelBuffer?
            var mask: CVPixelBuffer?
            let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
            guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &image) == kCVReturnSuccess,
                  CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_OneComponent8, nil, &mask) == kCVReturnSuccess,
                  let image, let mask else { throw ReconstructionError.image(file.path) }
            context.render(CIImage(cgImage: cg), to: image, bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: rgb)
            CVPixelBufferLockBaseAddress(image, .readOnly)
            CVPixelBufferLockBaseAddress(mask, [])
            let pixels = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
            let maskPixels = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
            let imageStride = CVPixelBufferGetBytesPerRow(image), maskStride = CVPixelBufferGetBytesPerRow(mask)
            for y in 0..<height {
                for x in 0..<width { maskPixels[y * maskStride + x] = pixels[y * imageStride + x * 4 + 3] > 127 ? 255 : 0 }
            }
            CVPixelBufferUnlockBaseAddress(mask, [])
            CVPixelBufferUnlockBaseAddress(image, .readOnly)
            var sample = PhotogrammetrySample(id: index, image: image)
            sample.objectMask = mask
            names[index] = file.lastPathComponent
            return sample
        }
        var config = PhotogrammetrySession.Configuration()
        config.isObjectMaskingEnabled = true
        config.sampleOrdering = .sequential
        config.featureSensitivity = .high
        config.checkpointDirectory = output.appendingPathComponent("checkpoint", isDirectory: true)
        config.customDetailSpecification.maximumPolygonCount = 200_000
        config.customDetailSpecification.maximumTextureDimension = .fourK
        config.customDetailSpecification.outputTextureMaps = [.diffuseColor, .normal]
        config.customDetailSpecification.textureFormat = .png
        let session = try PhotogrammetrySession(input: samples, configuration: config)
        print("Loaded \(samples.count) masked source photographs; processing locally.")
        let model = output.appendingPathComponent("model", isDirectory: true)
        let detail: PhotogrammetrySession.Request.Detail = CommandLine.arguments.last == "raw" ? .raw : .custom
        try session.process(requests: [.modelFile(url: model, detail: detail), .poses])
        var lastPercent = -1
        var failed = false
        for try await event in session.outputs {
            switch event {
            case .requestProgress(_, let value):
                let percent = Int(value * 100)
                if percent != lastPercent { print("Progress \(percent)%"); lastPercent = percent }
            case .requestProgressInfo(_, let info):
                if let stage = info.processingStage { print("Stage \(stage)") }
            case .requestComplete(_, let result):
                switch result {
                case .poses(let poses):
                    let rows: [[String: Any]] = poses.posesBySample.sorted { $0.key < $1.key }.map { id, pose in
                        let q = pose.rotation.vector
                        var row: [String: Any] = ["id": id, "filename": names[id] ?? "unknown", "translation": [pose.translation.x, pose.translation.y, pose.translation.z], "quaternion": [q.x, q.y, q.z, q.w]]
                        if let k = pose.intrinsics { row["intrinsicsColumns"] = [Array([k[0].x,k[0].y,k[0].z]), Array([k[1].x,k[1].y,k[1].z]), Array([k[2].x,k[2].y,k[2].z])] }
                        return row
                    }
                    try JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted).write(to: output.appendingPathComponent("poses.json"))
                    print("Recovered \(rows.count) camera poses")
                case .modelFile(let url): print("Model \(url.path)")
                default: break
                }
            case .requestError(_, let error): print("Reconstruction error: \(error)"); failed = true
            case .invalidSample(let id, let reason): print("Invalid sample \(id): \(reason)")
            case .skippedSample(let id): print("Skipped sample \(id)")
            case .processingComplete:
                print("Processing complete; success=\(!failed)")
                if failed { exit(1) }
                return
            case .processingCancelled: exit(2)
            default: print(event.localizedDescription)
            }
        }
    }
}
